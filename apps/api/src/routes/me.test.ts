import { randomUUID } from "node:crypto";
import { HoldResponse, MyPerformance, OrderView } from "@seat-booking/shared";
import { afterAll, describe, expect, inject, it } from "vitest";
import { authHeaders, expectUnauthenticated, newPerformance, newSignedInUserIds, unauthenticatedHeaders } from "../../test/fixtures.js";
import { buildApp } from "../app.js";
import { createPool } from "../db/pool.js";

describe("GET /performances/:id/me", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  const app = buildApp(pool);
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const hold = async (performanceId: number, userId: number, seatIds: number[]) =>
    HoldResponse.parse(
      (
        await app.inject({
          method: "POST",
          url: `/performances/${performanceId}/holds`,
          headers: authHeaders(userId),
          payload: { seatIds },
        })
      ).json(),
    );
  const me = (performanceId: number, userId: number) =>
    app.inject({ method: "GET", url: `/performances/${performanceId}/me`, headers: authHeaders(userId) });

  it("유효한 선점(좌석·만료 시각·붙은 주문)과 한도를 보여 주고, 만료된 선점·팔린 선점·풀린 좌석은 선점으로 보이지 않는다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const other = await newPerformance(pool);
    const [userId, stranger] = await newSignedInUserIds(pool, 2);

    const plain = await hold(performanceId, userId!, [seatIds[1]!]);
    const ordered = await hold(performanceId, userId!, [seatIds[2]!]);
    const order = OrderView.parse(
      (
        await app.inject({
          method: "POST",
          url: `/holds/${ordered.holdId}/orders`,
          headers: { ...authHeaders(userId), "idempotency-key": randomUUID() },
        })
      ).json(),
    );
    const sold = await hold(performanceId, userId!, [seatIds[0]!]);
    await pool.query("update performance_seats set status = 'sold' where hold_id = $1", [sold.holdId]);
    // 주문 취소처럼 좌석만 풀린 선점: 선점 행의 만료 시각은 미래로 남는다
    const released = await hold(performanceId, userId!, [seatIds[3]!]);
    await pool.query(
      "update performance_seats set status = 'available', hold_id = null, hold_expires_at = null where hold_id = $1",
      [released.holdId],
    );
    // 다른 사람과 다른 회차의 선점은 보이지 않는다
    await hold(performanceId, stranger!, [seatIds[5]!]);
    await hold(other.performanceId, userId!, [other.seatIds[0]!]);

    const res = await me(performanceId, userId!);
    expect(res.statusCode).toBe(200);
    const body = MyPerformance.parse(res.json());
    expect(body).toMatchObject({
      performanceId,
      limit: 4,
      heldSeats: 2,
      purchasedSeats: 1,
      remaining: 1,
      holds: [
        { holdId: plain.holdId, expiresAt: plain.expiresAt, seatIds: plain.seatIds, orderId: null },
        { holdId: ordered.holdId, expiresAt: ordered.expiresAt, seatIds: ordered.seatIds, orderId: order.orderId },
      ],
    });
    expect(Math.abs(Date.parse(body.serverTime) - Date.now())).toBeLessThan(60_000);

    // 만료되면 선점 목록과 한도에서 빠진다
    await pool.query("update performance_seats set hold_expires_at = now() - interval '1 second' where hold_id = $1", [
      plain.holdId,
    ]);
    expect(MyPerformance.parse((await me(performanceId, userId!)).json())).toMatchObject({
      heldSeats: 1,
      purchasedSeats: 1,
      remaining: 2,
      holds: [{ holdId: ordered.holdId }],
    });
  });

  it("여러 좌석의 선점은 좌석을 한 선점으로 묶어 보여 준다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [userId] = await newSignedInUserIds(pool, 1);
    const held = await hold(performanceId, userId!, [seatIds[3]!, seatIds[1]!, seatIds[2]!]);
    const body = MyPerformance.parse((await me(performanceId, userId!)).json());
    expect(body.holds).toEqual([{ holdId: held.holdId, expiresAt: held.expiresAt, seatIds: held.seatIds, orderId: null }]);
    expect(body).toMatchObject({ limit: 4, heldSeats: 3, purchasedSeats: 0, remaining: 1 });
  });

  it("로그인하지 않았으면 401, 없는 회차는 404, 선점이 없으면 빈 목록", async () => {
    const { performanceId } = await newPerformance(pool);
    const [userId] = await newSignedInUserIds(pool, 1);
    for (const [name, headers] of Object.entries(await unauthenticatedHeaders(pool))) {
      expectUnauthenticated(await app.inject({ method: "GET", url: `/performances/${performanceId}/me`, headers }), name);
    }
    expect((await me(999999999, userId!)).statusCode).toBe(404);
    expect(MyPerformance.parse((await me(performanceId, userId!)).json())).toMatchObject({
      heldSeats: 0,
      purchasedSeats: 0,
      remaining: 4,
      holds: [],
    });
  });
});
