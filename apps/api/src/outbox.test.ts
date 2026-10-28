import { randomUUID } from "node:crypto";
import { HoldResponse, OrderView, PaymentAccepted } from "@seat-booking/shared";
import { afterAll, describe, expect, inject, it } from "vitest";
import { authHeaders, newPerformance, newSignedInUserIds } from "../test/fixtures.js";
import { buildApp } from "./app.js";
import { createPool } from "./db/pool.js";
import { FakePaymentProvider } from "./fake-pay.js";

// 업무 이벤트 outbox의 넣기(DESIGN 6.8, C9). 다른 테스트 파일도 같은 DB에서 선점·주문을 만들어 outbox 행이 생기므로,
// 테스트마다 새 사용자를 만들고 그 사용자의 행만 본다.
describe("업무 이벤트 outbox", () => {
  const url = inject("databaseUrl");
  const admin = createPool({ connectionString: url });
  const pool = createPool({ connectionString: url });
  const provider = new FakePaymentProvider("outbox-test-secret");
  const app = buildApp(pool, {}, { paymentProvider: provider });
  afterAll(async () => {
    await app.close();
    await Promise.all([pool.end(), admin.end()]);
  });

  const hold = (userId: number, performanceId: number, seatIds: number[]) =>
    app.inject({ method: "POST", url: `/performances/${performanceId}/holds`, headers: authHeaders(userId), payload: { seatIds } });
  const order = (userId: number, holdId: number, key = randomUUID()) =>
    app.inject({ method: "POST", url: `/holds/${holdId}/orders`, headers: { ...authHeaders(userId), "idempotency-key": key } });
  const pay = (userId: number, orderId: number) =>
    app.inject({ method: "POST", url: `/orders/${orderId}/payments`, headers: { ...authHeaders(userId), "idempotency-key": randomUUID() }, payload: {} });

  async function eventsOf(userId: number) {
    const { rows } = await admin.query<{
      event_id: string;
      event_name: string;
      occurred_at: Date;
      ms_truncated: boolean;
      properties: Record<string, number>;
      sent_at: Date | null;
    }>(
      `select event_id, event_name, occurred_at, occurred_at = date_trunc('milliseconds', occurred_at) as ms_truncated, properties, sent_at
         from outbox_events where user_id = $1 order by id`,
      [userId],
    );
    return rows;
  }

  async function heldOrder() {
    provider.takeQueued();
    const { performanceId, seatIds } = await newPerformance(admin);
    const [userId] = await newSignedInUserIds(admin, 1);
    const held = HoldResponse.parse((await hold(userId!, performanceId, seatIds.slice(0, 2))).json());
    return { performanceId, seatIds, userId: userId!, holdId: held.holdId };
  }

  it("선점 → 주문 → 결제 성공이 이벤트를 하나씩 남기고, 시각은 ms로 잘려 엄격히 늘어난다", async () => {
    const { performanceId, userId, holdId } = await heldOrder();
    const created = OrderView.parse((await order(userId, holdId)).json());
    const { paymentId } = PaymentAccepted.parse((await pay(userId, created.orderId)).json());
    expect(await provider.flush()).toEqual([200]);

    const events = await eventsOf(userId);
    expect(events.map((e) => [e.event_name, e.properties])).toEqual([
      ["seats_held", { performanceId, holdId, seats: 2 }],
      ["order_created", { performanceId, holdId, orderId: created.orderId }],
      ["payment_succeeded", { performanceId, orderId: created.orderId, paymentId }],
    ]);
    expect(events.every((e) => e.ms_truncated && e.sent_at === null)).toBe(true);
    expect(new Set(events.map((e) => e.event_id)).size).toBe(3);
    const times = events.map((e) => e.occurred_at.getTime());
    expect(times[0]! < times[1]! && times[1]! < times[2]!).toBe(true);
  });

  it("선점이 실패하면(이미 잡힌 좌석) 트랜잭션이 되돌아가 이벤트가 없다", async () => {
    const { performanceId, seatIds } = await heldOrder();
    const [other] = await newSignedInUserIds(admin, 1);
    expect((await hold(other!, performanceId, seatIds.slice(0, 1))).statusCode).toBe(409);
    expect(await eventsOf(other!)).toEqual([]);
  });

  it("같은 선점에 다른 키로 동시에 주문해도, 같은 키로 다시 보내도 order_created는 하나다", async () => {
    const { userId, holdId } = await heldOrder();
    const key = randomUUID();
    const results = await Promise.all([order(userId, holdId, key), order(userId, holdId), order(userId, holdId)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
    expect((await order(userId, holdId, key)).statusCode).toBeGreaterThanOrEqual(200);
    expect((await eventsOf(userId)).filter((e) => e.event_name === "order_created")).toHaveLength(1);
  });

  it("같은 성공 웹훅이 두 번 와도 payment_succeeded는 하나다", async () => {
    const { userId, holdId } = await heldOrder();
    const created = OrderView.parse((await order(userId, holdId)).json());
    await pay(userId, created.orderId);
    const [webhook] = provider.takeQueued();
    const deliver = () =>
      app.inject({
        method: "POST",
        url: "/webhooks/fake-pay",
        headers: { "content-type": "application/json", "x-fake-signature": webhook!.signature },
        payload: webhook!.rawBody,
      });
    expect((await deliver()).statusCode).toBe(200);
    expect((await deliver()).statusCode).toBe(200);
    expect((await eventsOf(userId)).filter((e) => e.event_name === "payment_succeeded")).toHaveLength(1);
  });

  it("주문이 취소되거나 선점이 끝난 뒤 결제가 성공하면, 커밋되지만(환불로 감) payment_succeeded는 없다", async () => {
    const cancelled = await heldOrder();
    const cancelledOrder = OrderView.parse((await order(cancelled.userId, cancelled.holdId)).json());
    await pay(cancelled.userId, cancelledOrder.orderId);
    await admin.query("update orders set status = 'cancelled', cancel_reason = 'user' where id = $1", [cancelledOrder.orderId]);
    expect(await provider.flush()).toEqual([200]);

    const expired = await heldOrder();
    const expiredOrder = OrderView.parse((await order(expired.userId, expired.holdId)).json());
    await pay(expired.userId, expiredOrder.orderId);
    await admin.query("update holds set expires_at = now() - interval '1 second' where id = $1", [expired.holdId]);
    await admin.query("update performance_seats set hold_expires_at = now() - interval '1 second' where hold_id = $1", [expired.holdId]);
    expect(await provider.flush()).toEqual([200]);

    const { rows } = await admin.query("select status from payments where order_id = any($1::bigint[]) order by id", [
      [cancelledOrder.orderId, expiredOrder.orderId],
    ]);
    expect(rows.map((r) => r.status)).toEqual(["refund_pending", "refund_pending"]);
    for (const { userId } of [cancelled, expired]) {
      expect((await eventsOf(userId)).map((e) => e.event_name)).toEqual(["seats_held", "order_created"]);
    }
  });
});
