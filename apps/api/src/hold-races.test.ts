import type pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";
import { newPerformance, newUsers } from "../test/fixtures.js";
import { createDb } from "./db/client.js";
import { createPool } from "./db/pool.js";
import { holdSeats } from "./holds.js";

// 선점 경쟁을 연결 두 개로 한 단계씩 재현한다. 요청을 한꺼번에 많이 보내면 겹치는 순서가 우연에 맡겨지지만,
// 여기서는 순서를 정해 두고 돌리므로 매번 같은 결과가 나온다. 일부러 틀린 방식은 틀린 결과가 나는 것을 확인한다(DESIGN 6.1).
describe("선점 경쟁을 한 단계씩 재현", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  afterAll(() => pool.end());

  async function withTwoClients(work: (a: pg.PoolClient, b: pg.PoolClient) => Promise<void>) {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await work(a, b);
    } finally {
      await a.query("rollback").catch(() => {});
      await b.query("rollback").catch(() => {});
      a.release();
      b.release();
    }
  }

  // pid는 잠금을 기다리기 전에 받아 둔다. 기다리는 연결에 보낸 질의는 앞 질의가 끝날 때까지 줄을 선다.
  const pidOf = async (c: pg.PoolClient) => (await c.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

  // 그 연결이 다른 트랜잭션의 잠금을 기다리기 시작할 때까지 기다린다.
  async function waitUntilBlocked(pid: number) {
    for (let i = 0; i < 300; i++) {
      const { rows } = await pool.query("select cardinality(pg_blocking_pids($1)) > 0 as blocked", [pid]);
      if (rows[0].blocked) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`${pid}가 잠금을 기다리지 않는다`);
  }

  // 실제 흐름처럼, 선점 행은 그 트랜잭션 안에서 넣는다(커밋 전에는 다른 트랜잭션에 보이지 않는다).
  async function begin(c: pg.PoolClient, userId: number, performanceId: number) {
    await c.query("begin");
    const { rows } = await c.query<{ id: number }>(
      "insert into holds (user_id, performance_id, expires_at) values ($1, $2, now() + interval '5 minutes') returning id",
      [userId, performanceId],
    );
    return rows[0]!.id;
  }

  const SET_HELD = "set status = 'held', hold_id = $3, hold_expires_at = now() + interval '5 minutes'";
  // ③ 조건부 UPDATE: 빈 좌석이거나 만료된 선점일 때만 바꾼다. 만료 시각은 같은 행에서 본다.
  const conditional = (c: pg.PoolClient, performanceId: number, seatId: number, holdId: number) =>
    c.query(
      `update performance_seats ${SET_HELD}
        where performance_id = $1 and seat_id = $2
          and (status = 'available' or (status = 'held' and hold_expires_at < now()))`,
      [performanceId, seatId, holdId],
    );

  async function holdIdOf(performanceId: number, seatId: number) {
    const { rows } = await pool.query("select hold_id from performance_seats where performance_id = $1 and seat_id = $2", [
      performanceId,
      seatId,
    ]);
    return rows[0].hold_id as number;
  }

  it("① 조회 후 수정(일부러 틀린 방식): 두 요청이 모두 빈 좌석을 읽고 둘 다 선점에 성공한다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const seat = seatIds[0]!;
    const [ua, ub] = await newUsers(pool, 2);
    const read = async (c: pg.PoolClient) =>
      (await c.query("select status from performance_seats where performance_id = $1 and seat_id = $2", [performanceId, seat]))
        .rows[0].status;
    const write = (c: pg.PoolClient, holdId: number) =>
      c.query(`update performance_seats ${SET_HELD} where performance_id = $1 and seat_id = $2`, [performanceId, seat, holdId]);

    await withTwoClients(async (a, b) => {
      const ha = await begin(a, ua!, performanceId);
      const hb = await begin(b, ub!, performanceId);
      expect(await read(a)).toBe("available");
      expect(await read(b)).toBe("available");
      expect((await write(a, ha)).rowCount).toBe(1);
      await a.query("commit");
      expect((await write(b, hb)).rowCount).toBe(1);
      await b.query("commit");

      // 둘 다 선점했다고 믿지만, 좌석에는 나중에 쓴 B의 선점만 남는다
      expect(await holdIdOf(performanceId, seat)).toBe(hb);
    });
  });

  it("③ 조건부 UPDATE: 뒤 요청은 앞 트랜잭션이 끝날 때까지 기다린 뒤, 바뀐 행으로 조건을 다시 보고 0행을 받는다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const seat = seatIds[0]!;
    const [ua, ub] = await newUsers(pool, 2);

    await withTwoClients(async (a, b) => {
      const ha = await begin(a, ua!, performanceId);
      expect((await conditional(a, performanceId, seat, ha)).rowCount).toBe(1);

      const bPid = await pidOf(b);
      const hb = await begin(b, ub!, performanceId);
      const pending = conditional(b, performanceId, seat, hb);
      await waitUntilBlocked(bPid);
      await a.query("commit");
      expect((await pending).rowCount).toBe(0);

      expect(await holdIdOf(performanceId, seat)).toBe(ha);
    });
  });

  it("만료를 다른 표에서 보는 조건(일부러 틀린 방식): 다시 볼 때 앞 트랜잭션의 선점 행이 보이지 않아 둘 다 선점한다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const seat = seatIds[0]!;
    const [ua, ub] = await newUsers(pool, 2);
    // "유효한 선점이 없으면" 바꾼다. 행의 새 값은 다시 보지만, holds는 이 문장을 시작할 때의 스냅샷으로 본다.
    const crossTable = (c: pg.PoolClient, holdId: number) =>
      c.query(
        `update performance_seats ${SET_HELD}
          where performance_id = $1 and seat_id = $2
            and (status = 'available' or (status = 'held' and not exists (
                  select 1 from holds h where h.id = performance_seats.hold_id and h.expires_at >= now())))`,
        [performanceId, seat, holdId],
      );

    await withTwoClients(async (a, b) => {
      const ha = await begin(a, ua!, performanceId);
      expect((await crossTable(a, ha)).rowCount).toBe(1);

      const bPid = await pidOf(b);
      const hb = await begin(b, ub!, performanceId);
      const pending = crossTable(b, hb);
      await waitUntilBlocked(bPid);
      await a.query("commit");
      expect((await pending).rowCount).toBe(1);
      await b.query("commit");

      expect(await holdIdOf(performanceId, seat)).toBe(hb);
    });
  });

  it("좌석을 요청에 담긴 순서대로 하나씩 잠그면(일부러 틀린 방식) 반대 순서의 두 요청이 교착(40P01)에 빠진다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [s1, s3] = [seatIds[0]!, seatIds[2]!];
    const [ua, ub] = await newUsers(pool, 2);

    await withTwoClients(async (a, b) => {
      const aPid = await pidOf(a);
      const ha = await begin(a, ua!, performanceId);
      const hb = await begin(b, ub!, performanceId);
      expect((await conditional(a, performanceId, s1, ha)).rowCount).toBe(1);
      expect((await conditional(b, performanceId, s3, hb)).rowCount).toBe(1);

      const aWaits = conditional(a, performanceId, s3, ha); // A는 B가 쥔 s3를 기다린다
      await waitUntilBlocked(aPid);
      const bWaits = conditional(b, performanceId, s1, hb); // B는 A가 쥔 s1을 기다린다 → 기다림이 고리를 이룬다

      // deadlock_timeout(기본 1초) 뒤 PostgreSQL이 한쪽을 실패시키고, 다른 쪽은 이어서 진행한다
      const results = await Promise.allSettled([aWaits, bWaits]);
      const deadlocked = results.filter((r) => r.status === "rejected" && (r.reason as { code?: string }).code === "40P01");
      expect(deadlocked).toHaveLength(1);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    });
  }, 15_000);
});

// holdSeats는 좌석을 좌석 id 순서로 잠근다(ORDER BY … FOR UPDATE). 이 순서가 실행 계획에 기대지 않는다는 것을 확인한다.
// 기본 키 인덱스로 읽으면 좌석 id 순서지만, 표를 처음부터 읽으면(Seq Scan) 행이 놓인 순서다.
describe("holdSeats는 실행 계획이 달라도 좌석 id 순서로 잠근다", () => {
  const url = inject("databaseUrl");
  const admin = createPool({ connectionString: url });
  const byIndex = createPool({
    connectionString: url,
    application_name: "hold-order-index",
    options: "-c enable_seqscan=off -c enable_bitmapscan=off",
  });
  const bySeqScan = createPool({
    connectionString: url,
    application_name: "hold-order-seqscan",
    options: "-c enable_indexscan=off -c enable_indexonlyscan=off -c enable_bitmapscan=off",
  });
  afterAll(() => Promise.all([admin.end(), byIndex.end(), bySeqScan.end()]));

  async function waitForLockWaiters(count: number) {
    for (let i = 0; i < 300; i++) {
      const { rows } = await admin.query(
        `select count(*) as n from pg_stat_activity
          where datname = current_database() and application_name like 'hold-order-%' and wait_event_type = 'Lock'`,
      );
      if (rows[0].n === count) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`잠금을 기다리는 연결이 ${count}개가 되지 않는다`);
  }

  it("두 요청이 좌석을 서로 다른 순서로 읽어도 교착 없이 하나만 선점한다", async () => {
    const { performanceId, seatIds } = await newPerformance(admin);
    const s1 = seatIds[0]!;
    const [ua, ub] = await newUsers(admin, 2);

    // 좌석 id가 가장 작은 s1을 고쳐, 새 버전이 이 회차의 다른 좌석 뒤에 놓이게 한다. 새 버전이 어디에 놓일지는
    // 페이지의 빈자리에 달려 있어서(다른 테스트가 같은 페이지를 고치면 비워진 줄 번호가 다시 쓰인다) 맨 앞이 아닐 때까지 고친다.
    // 그때 맨 앞에 놓인 좌석이 s2다. 좌석 id로는 s1 뒤지만, 표를 처음부터 읽으면 s1보다 먼저 나온다.
    let s2 = s1;
    for (let i = 0; i < 10 && s2 === s1; i++) {
      await admin.query("update performance_seats set status = status where performance_id = $1 and seat_id = $2", [
        performanceId,
        s1,
      ]);
      const first = await admin.query<{ seat_id: number }>(
        "select seat_id from performance_seats where performance_id = $1 order by ctid limit 1",
        [performanceId],
      );
      s2 = first.rows[0]!.seat_id;
    }
    expect(s2).not.toBe(s1);

    // 두 연결이 정말 다른 방법으로 읽는지 확인한다. 같은 방법이면 잠금 순서가 같아져 이 테스트는 아무것도 시험하지 못한다.
    const scanOf = async (p: pg.Pool) =>
      (
        await p.query(
          "explain select seat_id from performance_seats where performance_id = $1 and seat_id = any($2::bigint[]) for update",
          [performanceId, [s1, s2]],
        )
      ).rows
        .map((r) => r["QUERY PLAN"])
        .join("\n");
    expect(await scanOf(byIndex)).toMatch(/Index Scan using performance_seats_performance_id_seat_id_pk/);
    expect(await scanOf(bySeqScan)).toMatch(/Seq Scan on performance_seats/);

    // 세 번째 연결이 s1을 먼저 쥐어, A와 B가 기다리는 순서를 정한다.
    const holder = await admin.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from performance_seats where performance_id = $1 and seat_id = $2 for update", [
        performanceId,
        s1,
      ]);

      const a = holdSeats(createDb(byIndex), { userId: ua!, performanceId, seatIds: [s1, s2] });
      await waitForLockWaiters(1); // A는 s1에서 기다린다
      const b = holdSeats(createDb(bySeqScan), { userId: ub!, performanceId, seatIds: [s1, s2] });
      // B도 기다린다. 좌석 id 순서로 잠그면 아무것도 쥐지 않은 채 s1에서, 행 순서로 잠그면 s2를 쥔 채 s1에서 기다린다.
      // 뒤의 경우 A가 s1을 받은 뒤 s2를 기다리면서 고리가 생긴다.
      await waitForLockWaiters(2);
      await holder.query("commit");

      // 실패하면 무슨 오류인지 보이도록 SQLSTATE를 꺼낸다(Drizzle은 pg 오류를 cause에 싼다).
      const outcome = (await Promise.allSettled([a, b])).map((r) =>
        r.status === "fulfilled"
          ? r.value.ok
            ? "held"
            : r.value.code
          : ((r.reason as { cause?: { code?: string } }).cause?.code ?? String(r.reason)),
      );
      expect(outcome).toEqual(["held", "SEAT_UNAVAILABLE"]);
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
  }, 15_000);
});
