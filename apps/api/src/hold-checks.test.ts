import { type SQL, sql } from "drizzle-orm";
import { afterAll, describe, expect, inject, it } from "vitest";
import { newPerformance, newUsers } from "../test/fixtures.js";
import { createDb } from "./db/client.js";
import { createPool } from "./db/pool.js";
import { holdSeats, holdWithinTx, toHoldResult } from "./holds.js";

// 선점 트랜잭션의 확인(판매 기간 → 1인 한도 → 가격 → 좌석, DESIGN 6.1)을 트랜잭션 안에서 직접 본다.
describe("선점 확인", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  const db = createDb(pool);
  afterAll(() => pool.end());

  // before를 같은 트랜잭션에서 먼저 실행하고 선점한다. 같은 트랜잭션이라 now()가 정확히 같다.
  const holdAfter = (input: { userId: number; performanceId: number; seatIds: number[] }, ...before: SQL[]) =>
    toHoldResult(() =>
      db.transaction(async (tx) => {
        for (const statement of before) await tx.execute(statement);
        return holdWithinTx(tx, input);
      }),
    );

  it("판매 기간의 경계: now()가 판매 시작과 같으면 열려 있고, 판매 종료와 같으면 닫혀 있다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [userId] = await newUsers(pool, 1);

    const atOpen = await holdAfter(
      { userId: userId!, performanceId, seatIds: [seatIds[0]!] },
      sql`update performances set sales_open_at = now() where id = ${performanceId}`,
    );
    expect(atOpen.ok).toBe(true);

    const atClose = await holdAfter(
      { userId: userId!, performanceId, seatIds: [seatIds[1]!] },
      sql`update performances set sales_open_at = now() - interval '1 hour', sales_close_at = now() where id = ${performanceId}`,
    );
    expect(atClose).toMatchObject({ ok: false, code: "SALES_CLOSED", reason: "CLOSED" });
  });

  it("판매 기간·한도·가격으로 거절되는 요청은 좌석 잠금을 기다리지 않는다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [userId] = await newUsers(pool, 1);
    const input = { userId: userId!, performanceId, seatIds: [seatIds[0]!] };
    const shortLockWait = sql`set local lock_timeout = '200ms'`;

    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from performance_seats where performance_id = $1 and seat_id = $2 for update", [
        performanceId,
        seatIds[0],
      ]);

      // 대조: 거절할 이유가 없는 요청은 좌석 잠금을 기다리다 시간 제한(55P03)에 걸린다
      await expect(holdAfter(input, shortLockWait)).rejects.toMatchObject({ cause: { code: "55P03" } });

      expect(
        await holdAfter(
          input,
          shortLockWait,
          sql`update performances set sales_open_at = now() + interval '1 hour' where id = ${performanceId}`,
        ),
      ).toMatchObject({ code: "SALES_CLOSED" });
      expect(
        await holdAfter(input, shortLockWait, sql`delete from performance_grades where performance_id = ${performanceId}`),
      ).toMatchObject({ code: "PRICE_MISSING" });

      // 잠기지 않은 다른 좌석으로 한도를 채운다
      expect((await holdSeats(db, { ...input, seatIds: seatIds.slice(1, 5) })).ok).toBe(true);
      expect(await holdAfter(input, shortLockWait)).toMatchObject({ code: "HOLD_LIMIT" });
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
  });
});
