import { randomUUID } from "node:crypto";
import { HoldResponse, MyOrders, OrderView } from "@seat-booking/shared";
import { afterAll, describe, expect, inject, it } from "vitest";
import {
  authHeaders,
  expectUnauthenticated,
  newPerformance,
  newSignedInUserIds,
  unauthenticatedHeaders,
} from "../../test/fixtures.js";
import { buildApp } from "../app.js";
import { createPool } from "../db/pool.js";
import { MY_ORDERS_PAGE_SIZE } from "../orders.js";

describe("내 예매(GET /orders)", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  const app = buildApp(pool);
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const myOrders = async (userId: number) => {
    const res = await app.inject({ method: "GET", url: "/orders", headers: authHeaders(userId) });
    expect(res.statusCode, res.body).toBe(200);
    return MyOrders.parse(res.json());
  };

  // 회차마다 1인 한도가 있으므로 주문마다 새 회차에서 좌석 하나를 선점하고 주문을 만든다.
  async function newOrder(userId: number) {
    const { performanceId, seatIds } = await newPerformance(pool);
    const hold = HoldResponse.parse(
      (
        await app.inject({
          method: "POST",
          url: `/performances/${performanceId}/holds`,
          headers: authHeaders(userId),
          payload: { seatIds: [seatIds[0]] },
        })
      ).json(),
    );
    return OrderView.parse(
      (
        await app.inject({
          method: "POST",
          url: `/holds/${hold.holdId}/orders`,
          headers: { ...authHeaders(userId), "idempotency-key": randomUUID() },
        })
      ).json(),
    );
  }
  const insertPayment = (orderId: number, status: string, amount: number) =>
    pool.query("insert into payments (order_id, status, amount, idempotency_key) values ($1, $2, $3, $4)", [
      orderId,
      status,
      amount,
      randomUUID(),
    ]);
  const expireHold = async (order: OrderView) => {
    await pool.query("update holds set expires_at = now() - interval '1 second' where id = $1", [order.holdId]);
    await pool.query("update performance_seats set hold_expires_at = now() - interval '1 second' where hold_id = $1", [
      order.holdId,
    ]);
  };
  const cancel = async (order: OrderView, userId: number) =>
    expect(
      (await app.inject({ method: "POST", url: `/orders/${order.orderId}/cancel`, headers: authHeaders(userId) })).statusCode,
    ).toBe(200);

  it("로그인하지 않았으면 401이다", async () => {
    for (const [name, headers] of Object.entries(await unauthenticatedHeaders(pool))) {
      expectUnauthenticated(await app.inject({ method: "GET", url: "/orders", headers }), name);
    }
  });

  it("결제 대기·결제 완료·돈이 움직였을 수 있는 취소 주문만, 최근 것부터, 보이는 상태로 준다", async () => {
    const [userId, other] = await newSignedInUserIds(pool, 2);
    const pending = await newOrder(userId!);
    const paid = await newOrder(userId!);
    await pool.query("update orders set status = 'paid' where id = $1", [paid.orderId]);
    await pool.query("update performance_seats set status = 'sold' where hold_id = $1", [paid.holdId]);
    await insertPayment(paid.orderId, "succeeded", paid.amount);
    const cancelledNoPayment = await newOrder(userId!);
    await cancel(cancelledNoPayment, userId!);
    const cancelledFailed = await newOrder(userId!);
    await insertPayment(cancelledFailed.orderId, "failed", cancelledFailed.amount);
    await cancel(cancelledFailed, userId!);
    const refunding = await newOrder(userId!);
    await cancel(refunding, userId!);
    await insertPayment(refunding.orderId, "failed", refunding.amount);
    await insertPayment(refunding.orderId, "refund_pending", refunding.amount);
    const expiredNoPayment = await newOrder(userId!);
    await expireHold(expiredNoPayment);
    const expiredRequested = await newOrder(userId!);
    await insertPayment(expiredRequested.orderId, "requested", expiredRequested.amount);
    await expireHold(expiredRequested);
    // 다른 사용자의 주문은 보이지 않는다
    await newOrder(other!);

    const { orders, hasMore, serverTime } = await myOrders(userId!);
    expect(hasMore).toBe(false);
    expect(Math.abs(Date.parse(serverTime) - Date.now())).toBeLessThan(60_000);
    expect(orders.map((o) => [o.orderId, o.status, o.cancelReason])).toEqual([
      [expiredRequested.orderId, "cancelled", "expired"],
      [refunding.orderId, "cancelled", "user"],
      [paid.orderId, "paid", null],
      [pending.orderId, "pending", null],
    ]);

    const first = orders.find((o) => o.orderId === refunding.orderId)!;
    expect(first).toMatchObject({ performanceId: refunding.performanceId, amount: refunding.amount, seatCount: 1 });
    expect(first.performance.id).toBe(refunding.performanceId);
    // 결제는 최신순이다(주문 조회와 같다)
    expect(first.payments.map((p) => p.status)).toEqual(["refund_pending", "failed"]);
    const shown = orders.find((o) => o.orderId === pending.orderId)!;
    expect(Date.parse(shown.holdExpiresAt) - Date.parse(shown.payBy)).toBe(30_000);
    // 주문 조회와 같은 값이다
    const view = OrderView.parse(
      (await app.inject({ method: "GET", url: `/orders/${pending.orderId}`, headers: authHeaders(userId) })).json(),
    );
    expect(shown).toMatchObject({
      status: view.status,
      cancelReason: view.cancelReason,
      amount: view.amount,
      holdExpiresAt: view.holdExpiresAt,
      payBy: view.payBy,
      payments: view.payments,
    });
  });

  it("주문이 없으면 빈 목록이고, 100개를 넘으면 최근 100개와 hasMore다", async () => {
    const [empty, many] = await newSignedInUserIds(pool, 2);
    expect(await myOrders(empty!)).toMatchObject({ orders: [], hasMore: false });

    const { performanceId } = await newPerformance(pool);
    await pool.query(
      `with h as (
         insert into holds (user_id, performance_id, expires_at)
         select $1, $2, now() + interval '5 minutes' from generate_series(1, $3) returning id
       )
       insert into orders (user_id, hold_id, status, amount) select $1, id, 'paid', 1000 from h`,
      [many, performanceId, MY_ORDERS_PAGE_SIZE + 1],
    );
    const { orders, hasMore } = await myOrders(many!);
    expect(orders).toHaveLength(MY_ORDERS_PAGE_SIZE);
    expect(hasMore).toBe(true);
    const ids = orders.map((o) => o.orderId);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });
});
