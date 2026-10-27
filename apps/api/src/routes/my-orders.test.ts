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

  const markPaid = async (order: OrderView) => {
    await pool.query("update orders set status = 'paid', paid_at = now() where id = $1", [order.orderId]);
    await pool.query("update performance_seats set status = 'sold' where hold_id = $1", [order.holdId]);
    await insertPayment(order.orderId, "succeeded", order.amount);
  };

  it("결제 대기·결제 완료·돈이 움직였을 수 있는 취소 주문만, 최근 것부터, 보이는 상태로 준다", async () => {
    const [userId, other] = await newSignedInUserIds(pool, 2);
    const pending = await newOrder(userId!);
    const paid = await newOrder(userId!);
    await markPaid(paid);
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
    // 넣는다: 취소 + 확인 중, 취소 + 환불 완료, 취소 + 환불 지연, 결제 완료 + 중복 결제 환불 중
    const cancelledRequested = await newOrder(userId!);
    await cancel(cancelledRequested, userId!);
    await insertPayment(cancelledRequested.orderId, "requested", cancelledRequested.amount);
    const refunded = await newOrder(userId!);
    await cancel(refunded, userId!);
    await insertPayment(refunded.orderId, "refunded", refunded.amount);
    const refundFailed = await newOrder(userId!);
    await cancel(refundFailed, userId!);
    await insertPayment(refundFailed.orderId, "refund_failed", refundFailed.amount);
    const paidDuplicate = await newOrder(userId!);
    await markPaid(paidDuplicate);
    await insertPayment(paidDuplicate.orderId, "refund_pending", paidDuplicate.amount);
    // 뺀다: 선점 만료 + failed만
    const expiredFailed = await newOrder(userId!);
    await insertPayment(expiredFailed.orderId, "failed", expiredFailed.amount);
    await expireHold(expiredFailed);
    // 다른 사용자의 주문은 보이지 않는다
    await newOrder(other!);

    const { orders, hasMore, serverTime } = await myOrders(userId!);
    expect(hasMore).toBe(false);
    expect(Math.abs(Date.parse(serverTime) - Date.now())).toBeLessThan(60_000);
    expect(orders.map((o) => [o.orderId, o.status, o.cancelReason])).toEqual([
      [paidDuplicate.orderId, "paid", null],
      [refundFailed.orderId, "cancelled", "user"],
      [refunded.orderId, "cancelled", "user"],
      [cancelledRequested.orderId, "cancelled", "user"],
      [expiredRequested.orderId, "cancelled", "expired"],
      [refunding.orderId, "cancelled", "user"],
      [paid.orderId, "paid", null],
      [pending.orderId, "pending", null],
    ]);
    // 결제 확정 시각은 paid 주문에만 있다
    expect(orders.filter((o) => o.paidAt !== null).map((o) => o.orderId)).toEqual([paidDuplicate.orderId, paid.orderId]);

    const first = orders.find((o) => o.orderId === refunding.orderId)!;
    expect(first).toMatchObject({ performanceId: refunding.performanceId, amount: refunding.amount, seatCount: 1 });
    expect(first.performance.id).toBe(refunding.performanceId);
    // 결제는 최신순이다(주문 조회와 같다)
    expect(first.payments.map((p) => p.status)).toEqual(["refund_pending", "failed"]);
    const shown = orders.find((o) => o.orderId === pending.orderId)!;
    expect(Date.parse(shown.holdExpiresAt) - Date.parse(shown.payBy)).toBe(30_000);
    // 목록의 주문마다 주문 조회와 같은 값이다(보이는 상태, 결제와 시각의 형식, 좌석 수)
    for (const listed of orders) {
      const view = OrderView.parse(
        (await app.inject({ method: "GET", url: `/orders/${listed.orderId}`, headers: authHeaders(userId) })).json(),
      );
      expect(listed, String(listed.orderId)).toMatchObject({
        performanceId: view.performanceId,
        status: view.status,
        cancelReason: view.cancelReason,
        amount: view.amount,
        holdExpiresAt: view.holdExpiresAt,
        payBy: view.payBy,
        payments: view.payments,
        seatCount: view.items.length,
      });
    }
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
       insert into orders (user_id, hold_id, status, amount, paid_at) select $1, id, 'paid', 1000, now() from h`,
      [many, performanceId, MY_ORDERS_PAGE_SIZE + 1],
    );
    const { orders, hasMore } = await myOrders(many!);
    expect(orders).toHaveLength(MY_ORDERS_PAGE_SIZE);
    expect(hasMore).toBe(true);
    const ids = orders.map((o) => o.orderId);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });
});
