import { randomUUID } from "node:crypto";
import { HoldResponse, MyPerformance, OrderNotCancellable, OrderView, PaymentAccepted } from "@seat-booking/shared";
import { afterAll, describe, expect, inject, it } from "vitest";
import { newPerformance, newUsers } from "../../test/fixtures.js";
import { buildApp } from "../app.js";
import { createPool } from "../db/pool.js";
import { FakePaymentProvider } from "../fake-pay.js";

describe("POST /orders/:id/cancel", () => {
  const url = inject("databaseUrl");
  const admin = createPool({ connectionString: url });
  // 잠금을 기다리는 앱 연결만 골라 보려고 이름을 붙인다.
  const pool = createPool({ connectionString: url, application_name: "cancel-test" });
  const provider = new FakePaymentProvider("cancel-test-secret");
  const app = buildApp(pool, {}, { paymentProvider: provider });
  afterAll(async () => {
    await app.close();
    await Promise.all([pool.end(), admin.end()]);
  });

  const asUser = (userId: number) => ({ "x-user-id": String(userId) });
  const hold = async (performanceId: number, userId: number, seatIds: number[]) => {
    const res = await app.inject({
      method: "POST",
      url: `/performances/${performanceId}/holds`,
      headers: asUser(userId),
      payload: { seatIds },
    });
    return res;
  };
  async function newOrder(seatCount = 2) {
    provider.takeQueued();
    const { performanceId, seatIds } = await newPerformance(admin);
    const [userId] = await newUsers(admin, 1);
    const held = HoldResponse.parse((await hold(performanceId, userId!, seatIds.slice(0, seatCount))).json());
    const order = OrderView.parse(
      (
        await app.inject({
          method: "POST",
          url: `/holds/${held.holdId}/orders`,
          headers: { ...asUser(userId!), "idempotency-key": randomUUID() },
        })
      ).json(),
    );
    return { performanceId, seatIds, userId: userId!, hold: held, order };
  }
  const cancel = (orderId: number, userId: number) =>
    app.inject({ method: "POST", url: `/orders/${orderId}/cancel`, headers: asUser(userId) });
  const pay = async (orderId: number, userId: number) => {
    const res = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/payments`,
      headers: { ...asUser(userId), "idempotency-key": randomUUID() },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(202);
    return PaymentAccepted.parse(res.json());
  };
  async function state(orderId: number) {
    const { rows } = await admin.query(
      `select o.status, o.cancel_reason,
              (select coalesce(json_agg(p.status order by p.id), '[]') from payments p where p.order_id = o.id) as payments,
              (select json_agg(ps.status order by ps.seat_id)
                 from order_items oi join holds h on h.id = o.hold_id
                 join performance_seats ps on ps.performance_id = h.performance_id and ps.seat_id = oi.seat_id
                where oi.order_id = o.id) as seats,
              (select count(*) from tickets t where t.order_id = o.id and t.status = 'valid') as tickets
         from orders o where o.id = $1`,
      [orderId],
    );
    return rows[0] as { status: string; cancel_reason: string | null; payments: string[]; seats: string[]; tickets: number };
  }
  async function waitForLockWaiters(count: number) {
    for (let i = 0; i < 300; i++) {
      const { rows } = await admin.query(
        `select count(*) as n from pg_stat_activity
          where datname = current_database() and application_name = 'cancel-test' and wait_event_type = 'Lock'`,
      );
      if (rows[0].n === count) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`잠금을 기다리는 연결이 ${count}개가 되지 않는다`);
  }
  async function withHolder(lockSql: string, params: unknown[], run: (release: () => Promise<void>) => Promise<void>) {
    const holder = await admin.connect();
    try {
      await holder.query("begin");
      await holder.query(lockSql, params);
      await run(async () => {
        await holder.query("commit");
      });
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
  }

  it("pending 주문을 취소하면 cancelled(user)이고 좌석이 풀려 다시 선점할 수 있다. 다시 취소해도 같은 결과다", async () => {
    const { userId, order, performanceId, hold: held } = await newOrder(2);
    const res = await cancel(order.orderId, userId);
    expect(res.statusCode).toBe(200);
    expect(OrderView.parse(res.json())).toMatchObject({ orderId: order.orderId, status: "cancelled", cancelReason: "user" });
    expect(await state(order.orderId)).toMatchObject({ status: "cancelled", cancel_reason: "user", seats: ["available", "available"] });
    const { rows } = await admin.query("select count(*) as n from performance_seats where hold_id = $1", [held.holdId]);
    expect(rows[0].n).toBe(0);

    // 한도에서도 빠지고, 같은 좌석을 다시 선점할 수 있다
    const me = MyPerformance.parse(
      (await app.inject({ method: "GET", url: `/performances/${performanceId}/me`, headers: asUser(userId) })).json(),
    );
    expect(me).toMatchObject({ heldSeats: 0, holds: [] });
    expect((await hold(performanceId, userId, held.seatIds)).statusCode).toBe(201);

    const again = await cancel(order.orderId, userId);
    expect(again.statusCode).toBe(200);
    expect(OrderView.parse(again.json())).toMatchObject({ status: "cancelled", cancelReason: "user" });
  });

  it("결제가 끝난 주문은 409 ORDER_NOT_CANCELLABLE이다", async () => {
    const { userId, order } = await newOrder(1);
    await pay(order.orderId, userId);
    await provider.flush();
    const res = await cancel(order.orderId, userId);
    expect(res.statusCode).toBe(409);
    expect(OrderNotCancellable.parse(res.json())).toMatchObject({ code: "ORDER_NOT_CANCELLABLE", orderId: order.orderId });
    expect(await state(order.orderId)).toMatchObject({ status: "paid", seats: ["sold"], tickets: 1 });
  });

  it("결제 확인 중에 취소하면 취소되고, 그 결제가 뒤에 성공하면 좌석을 팔지 않고 환불로 간다", async () => {
    const { userId, order } = await newOrder(2);
    await pay(order.orderId, userId);
    expect((await cancel(order.orderId, userId)).statusCode).toBe(200);
    expect(await provider.flush()).toEqual([200]);
    expect(await state(order.orderId)).toEqual({
      status: "cancelled",
      cancel_reason: "user",
      payments: ["refund_pending"],
      seats: ["available", "available"],
      tickets: 0,
    });
  });

  it("C5: 확정이 주문 행을 먼저 잡으면 취소는 그 뒤에 줄을 서고 409다", async () => {
    const { userId, order, performanceId } = await newOrder(2);
    await pay(order.orderId, userId);
    // 확정이 주문 행을 쥔 채 사용자·회차 잠금에서 기다리게 한다
    await withHolder("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`hold:${userId}:${performanceId}`], async (release) => {
      const delivered = provider.flush();
      await waitForLockWaiters(1);
      const cancelled = cancel(order.orderId, userId);
      await waitForLockWaiters(2);
      await release();
      expect(await delivered).toEqual([200]);
      expect((await cancelled).statusCode).toBe(409);
    });
    expect(await state(order.orderId)).toMatchObject({ status: "paid", payments: ["succeeded"], seats: ["sold", "sold"], tickets: 2 });
  });

  it("C5: 취소가 주문 행을 먼저 잡으면 확정은 그 뒤에 줄을 서고, 취소된 주문이라 환불로 간다", async () => {
    const { userId, order, performanceId, hold: held } = await newOrder(2);
    await pay(order.orderId, userId);
    // 취소가 주문을 바꾼 뒤 좌석을 기다리게 한다
    await withHolder(
      "select 1 from performance_seats where performance_id = $1 and seat_id = $2 for update",
      [performanceId, held.seatIds[1]],
      async (release) => {
        const cancelled = cancel(order.orderId, userId);
        await waitForLockWaiters(1);
        const delivered = provider.flush();
        await waitForLockWaiters(2);
        await release();
        expect((await cancelled).statusCode).toBe(200);
        expect(await delivered).toEqual([200]);
      },
    );
    expect(await state(order.orderId)).toEqual({
      status: "cancelled",
      cancel_reason: "user",
      payments: ["refund_pending"],
      seats: ["available", "available"],
      tickets: 0,
    });
  });

  it("선점이 이미 만료된 주문을 취소하면 이유는 expired이고, 다른 선점이 가져간 좌석은 건드리지 않는다", async () => {
    const { userId, order, performanceId, hold: held } = await newOrder(2);
    await admin.query("update holds set expires_at = now() - interval '1 second' where id = $1", [held.holdId]);
    await admin.query("update performance_seats set hold_expires_at = now() - interval '1 second' where hold_id = $1", [
      held.holdId,
    ]);
    const [other] = await newUsers(admin, 1);
    const taken = HoldResponse.parse((await hold(performanceId, other!, [held.seatIds[0]!])).json());

    expect(OrderView.parse((await cancel(order.orderId, userId)).json())).toMatchObject({
      status: "cancelled",
      cancelReason: "expired",
    });
    const { rows } = await admin.query(
      "select seat_id, status, hold_id from performance_seats where performance_id = $1 and seat_id = any($2::bigint[]) order by seat_id",
      [performanceId, held.seatIds],
    );
    expect(rows).toEqual([
      { seat_id: held.seatIds[0], status: "held", hold_id: taken.holdId },
      { seat_id: held.seatIds[1], status: "available", hold_id: null },
    ]);
  });

  it("없는 사용자 401, 남의 주문과 없는 주문 404", async () => {
    const { order } = await newOrder(1);
    const [stranger] = await newUsers(admin, 1);
    expect((await cancel(order.orderId, 999999999)).statusCode).toBe(401);
    expect((await cancel(order.orderId, stranger!)).statusCode).toBe(404);
    expect((await cancel(999999999, stranger!)).statusCode).toBe(404);
    expect((await state(order.orderId)).status).toBe("pending");
  });
});
