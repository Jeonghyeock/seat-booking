import { HoldConflict, HoldResponse } from "@seat-booking/shared";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, inject, it } from "vitest";
import { newPerformance, newUsers } from "../test/fixtures.js";
import { buildApp } from "./app.js";
import { createDb, type Db } from "./db/client.js";
import { createPool } from "./db/pool.js";
import { type HoldInput, type HoldResult, holdSeats, holdWithinTx, toHoldResult } from "./holds.js";

describe("1인 좌석 한도(C6)", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  const app = buildApp(pool);
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const hold = (performanceId: number, userId: number, seatIds: number[]) =>
    app.inject({
      method: "POST",
      url: `/performances/${performanceId}/holds`,
      headers: { "x-user-id": String(userId) },
      payload: { seatIds },
    });
  const codeOf = (res: Awaited<ReturnType<typeof hold>>) =>
    res.statusCode === 201 ? 201 : HoldConflict.parse(res.json()).code;

  it("이미 쥔 좌석과 합쳐 4석을 넘으면 409 HOLD_LIMIT이고, 4석까지는 선점된다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [userId] = await newUsers(pool, 1);
    expect(codeOf(await hold(performanceId, userId!, seatIds.slice(0, 3)))).toBe(201);
    expect(HoldConflict.parse((await hold(performanceId, userId!, seatIds.slice(3, 5))).json())).toMatchObject({
      code: "HOLD_LIMIT",
      limit: 4,
      heldSeats: 3,
      purchasedSeats: 0,
    });
    expect(codeOf(await hold(performanceId, userId!, [seatIds[3]!]))).toBe(201);
    expect(codeOf(await hold(performanceId, userId!, [seatIds[4]!]))).toBe("HOLD_LIMIT");
  });

  it("만료된 선점과 다른 회차의 선점은 한도에 세지 않는다", async () => {
    const first = await newPerformance(pool);
    const second = await newPerformance(pool);
    const [userId] = await newUsers(pool, 1);
    const held = HoldResponse.parse((await hold(first.performanceId, userId!, first.seatIds.slice(0, 4))).json());

    expect(codeOf(await hold(second.performanceId, userId!, second.seatIds.slice(0, 4)))).toBe(201);

    await pool.query("update holds set expires_at = now() - interval '1 second' where id = $1", [held.holdId]);
    await pool.query("update performance_seats set hold_expires_at = now() - interval '1 second' where hold_id = $1", [
      held.holdId,
    ]);
    expect(codeOf(await hold(first.performanceId, userId!, first.seatIds.slice(4, 8)))).toBe(201);
  });

  it("팔린 좌석도 한도에 센다. 선점의 만료 시각이 지난 팔린 좌석도 센다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [userId] = await newUsers(pool, 1);
    const bought = HoldResponse.parse((await hold(performanceId, userId!, seatIds.slice(0, 3))).json());
    // 결제 확정(다음 PR) 대신 좌석을 sold로 바꾼다. 확정은 선점(hold_id)과 만료 시각을 그대로 남긴다(DESIGN 10장 16)
    await pool.query("update holds set expires_at = now() - interval '1 second' where id = $1", [bought.holdId]);
    await pool.query(
      "update performance_seats set status = 'sold', hold_expires_at = now() - interval '1 second' where hold_id = $1",
      [bought.holdId],
    );

    const over = await hold(performanceId, userId!, seatIds.slice(3, 5));
    expect(HoldConflict.parse(over.json())).toMatchObject({ code: "HOLD_LIMIT", heldSeats: 0, purchasedSeats: 3 });
    expect(codeOf(await hold(performanceId, userId!, [seatIds[3]!]))).toBe(201);
    const full = await hold(performanceId, userId!, [seatIds[4]!]);
    expect(HoldConflict.parse(full.json())).toMatchObject({ code: "HOLD_LIMIT", heldSeats: 1, purchasedSeats: 3 });

    // 다른 사용자의 팔린 좌석은 세지 않는다
    const [other] = await newUsers(pool, 1);
    expect(codeOf(await hold(performanceId, other!, seatIds.slice(4, 8)))).toBe(201);
  });

  it("C6: 한 사용자가 8개 창에서 동시에 한 석씩 선점하면 정확히 4석만 잡힌다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [userId] = await newUsers(pool, 1);
    const codes = await Promise.all(seatIds.slice(0, 8).map(async (s) => codeOf(await hold(performanceId, userId!, [s]))));
    expect(codes.filter((c) => c === 201)).toHaveLength(4);
    expect(codes.filter((c) => c === "HOLD_LIMIT")).toHaveLength(4);

    const { rows } = await pool.query(
      `select count(*) as n from performance_seats ps join holds h on h.id = ps.hold_id
        where h.user_id = $1 and ps.performance_id = $2 and ps.status = 'held'`,
      [userId, performanceId],
    );
    expect(rows[0].n).toBe(4);
  });

  it("C6: 2석씩 4개 창에서 동시에 선점하면 2개 창만 성공한다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [userId] = await newUsers(pool, 1);
    const pairs = [0, 2, 4, 6].map((i) => seatIds.slice(i, i + 2));
    const codes = await Promise.all(pairs.map(async (p) => codeOf(await hold(performanceId, userId!, p))));
    expect(codes.filter((c) => c === 201)).toHaveLength(2);
    expect(codes.filter((c) => c === "HOLD_LIMIT")).toHaveLength(2);
  });
});

// DESIGN 6.1의 세 후보와 잠금 없는 방식을 같은 장면에 넣어 비교한다.
// 장면: 사용자가 이미 2석을 쥐고 있고, 두 창에서 2석씩 더 담는다. 한도(4석)를 지키면 한 창만 성공해야 한다.
// 세 번째 연결이 사용자 행을 FOR UPDATE로 쥐고 있으면 그 행에 거는 다른 잠금이 막힌다. 그래서 창마다 기다리는 곳이 다르다.
// - 잠금 없음, SERIALIZABLE: 두 창 모두 좌석 수를 센 뒤, 선점 행을 넣을 때의 외래 키 확인(FOR KEY SHARE)에서 기다린다.
// - advisory lock: 첫 창은 잠근 뒤 세고 외래 키 확인에서, 두 번째 창은 세기 전에 advisory lock에서 기다린다.
// - 사용자 행 잠금: 두 창 모두 세기 전에 사용자 행(FOR NO KEY UPDATE)에서 기다린다.
describe("1인 한도를 지키는 방법 비교", () => {
  const url = inject("databaseUrl");
  const admin = createPool({ connectionString: url });
  const compared = createPool({ connectionString: url, application_name: "hold-limit-compare" });
  const db = createDb(compared);
  afterAll(() => Promise.all([admin.end(), compared.end()]));

  const sqlState = (err: unknown) =>
    (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;

  let serializableRetries = 0;
  const strategies: Record<string, (db: Db, input: HoldInput) => Promise<HoldResult>> = {
    "잠금 없음(일부러 틀린 방식)": (db, input) => toHoldResult(() => db.transaction((tx) => holdWithinTx(tx, input))),
    "사용자·회차 advisory lock(채택)": holdSeats,
    "사용자 행 FOR NO KEY UPDATE": (db, input) =>
      toHoldResult(() =>
        db.transaction(async (tx) => {
          // FOR UPDATE로 잠그면 다른 표의 외래 키 확인(FOR KEY SHARE)까지 막는다. 키를 바꾸지 않으므로 NO KEY UPDATE로 충분하다.
          await tx.execute(sql`select 1 from users where id = ${input.userId} for no key update`);
          return holdWithinTx(tx, input);
        }),
      ),
    "SERIALIZABLE과 재시도": async (db, input) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await toHoldResult(() => db.transaction((tx) => holdWithinTx(tx, input), { isolationLevel: "serializable" }));
        } catch (err) {
          if (sqlState(err) !== "40001" || attempt === 5) throw err;
          serializableRetries++;
        }
      }
    },
  };

  async function waitForLockWaiters(count: number) {
    for (let i = 0; i < 300; i++) {
      const { rows } = await admin.query(
        `select count(*) as n from pg_stat_activity
          where datname = current_database() and application_name = 'hold-limit-compare'
            and wait_event_type = 'Lock' and wait_event in ('advisory', 'transactionid', 'tuple')`,
      );
      if (rows[0].n === count) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`잠금을 기다리는 연결이 ${count}개가 되지 않는다`);
  }

  // 세 번째 연결이 lockSql로 무언가를 쥔 동안 두 요청을 차례로 보내고, 둘 다 기다리기 시작하면 놓아 준다.
  async function race(lockSql: string, lockParams: unknown[], run: () => [Promise<HoldResult>, () => Promise<HoldResult>]) {
    const holder = await admin.connect();
    try {
      await holder.query("begin");
      await holder.query(lockSql, lockParams);
      const [first, startSecond] = run();
      await waitForLockWaiters(1);
      const second = startSecond();
      await waitForLockWaiters(2);
      await holder.query("commit");
      return (await Promise.all([first, second])).map((r) => (r.ok ? "held" : r.code));
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
  }

  async function heldBy(userId: number, performanceId: number) {
    const { rows } = await admin.query(
      `select count(*) as n from performance_seats ps join holds h on h.id = ps.hold_id
        where h.user_id = $1 and ps.performance_id = $2 and ps.status = 'held'`,
      [userId, performanceId],
    );
    return rows[0].n as number;
  }

  it.each(Object.keys(strategies))("%s", async (name) => {
    const strategy = strategies[name]!;
    const { performanceId, seatIds } = await newPerformance(admin);
    const [userId] = await newUsers(admin, 1);
    await holdSeats(createDb(admin), { userId: userId!, performanceId, seatIds: seatIds.slice(0, 2) });
    const retriesBefore = serializableRetries;

    const outcome = await race("select 1 from users where id = $1 for update", [userId], () => [
      strategy(db, { userId: userId!, performanceId, seatIds: seatIds.slice(2, 4) }),
      () => strategy(db, { userId: userId!, performanceId, seatIds: seatIds.slice(4, 6) }),
    ]);

    if (name.startsWith("잠금 없음")) {
      // 두 창 모두 "지금 2석"을 보고 통과해 6석이 된다
      expect(outcome).toEqual(["held", "held"]);
      expect(await heldBy(userId!, performanceId)).toBe(6);
    } else if (name.startsWith("SERIALIZABLE")) {
      // 두 창 모두 통과해 진행하다 한쪽이 직렬화 실패(40001)로 되돌려지고, 다시 세어 HOLD_LIMIT가 된다.
      // 어느 쪽이 되돌려질지는 정해져 있지 않다.
      expect([...outcome].sort()).toEqual(["HOLD_LIMIT", "held"]);
      expect(await heldBy(userId!, performanceId)).toBe(4);
      expect(serializableRetries - retriesBefore).toBeGreaterThanOrEqual(1);
    } else {
      // 먼저 잠근 창이 끝난 뒤에야 다음 창이 좌석 수를 센다
      expect(outcome).toEqual(["held", "HOLD_LIMIT"]);
      expect(await heldBy(userId!, performanceId)).toBe(4);
    }
  }, 15_000);

  it("SERIALIZABLE에서는 좌석 경쟁도 재시도가 된다. READ COMMITTED의 조건부 UPDATE는 기다린 뒤 다시 보고 끝난다", async () => {
    const { performanceId, seatIds } = await newPerformance(admin);
    const [ua, ub, uc, ud] = await newUsers(admin, 4);
    const seatLock = "select 1 from performance_seats where performance_id = $1 and seat_id = $2 for update";

    const before = serializableRetries;
    const serializable = strategies["SERIALIZABLE과 재시도"]!;
    const viaSerializable = await race(seatLock, [performanceId, seatIds[0]], () => [
      serializable(db, { userId: ua!, performanceId, seatIds: [seatIds[0]!] }),
      () => serializable(db, { userId: ub!, performanceId, seatIds: [seatIds[0]!] }),
    ]);
    expect(viaSerializable).toEqual(["held", "SEAT_UNAVAILABLE"]);
    // 뒤 요청은 앞 요청이 바꾼 행을 기다린 끝에 40001을 받고, 처음부터 다시 해서 SEAT_UNAVAILABLE이 된다
    expect(serializableRetries - before).toBe(1);

    const viaReadCommitted = await race(seatLock, [performanceId, seatIds[1]], () => [
      holdSeats(db, { userId: uc!, performanceId, seatIds: [seatIds[1]!] }),
      () => holdSeats(db, { userId: ud!, performanceId, seatIds: [seatIds[1]!] }),
    ]);
    expect(viaReadCommitted).toEqual(["held", "SEAT_UNAVAILABLE"]);
    expect(serializableRetries - before).toBe(1);
  }, 15_000);
});
