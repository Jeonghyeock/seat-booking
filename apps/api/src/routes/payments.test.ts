import { randomUUID } from "node:crypto";
import { HoldResponse, OrderView, PaymentAccepted, PaymentConflict, PaymentProviderUnavailable } from "@seat-booking/shared";
import { afterAll, describe, expect, inject, it } from "vitest";
import { authHeaders, expectUnauthenticated, newPerformance, newSignedInUserIds, unauthenticatedHeaders } from "../../test/fixtures.js";
import { buildApp } from "../app.js";
import { createPool } from "../db/pool.js";
import { FakePaymentProvider, SIGNATURE_HEADER, signWebhook } from "../fake-pay.js";

const SECRET = "payments-test-secret";

describe("결제 요청, 웹훅, 결제 확정", () => {
  const url = inject("databaseUrl");
  const admin = createPool({ connectionString: url });
  // 잠금을 기다리는 앱 연결만 골라 보려고 이름을 붙인다.
  const pool = createPool({ connectionString: url, application_name: "payments-test" });
  const provider = new FakePaymentProvider(SECRET);
  const app = buildApp(pool, {}, { paymentProvider: provider });
  afterAll(async () => {
    await app.close();
    await Promise.all([pool.end(), admin.end()]);
  });

  // 회차·사용자·선점·주문을 만든다. 쌓인 웹훅은 비운다.
  async function newOrder(seatCount = 2) {
    provider.takeQueued();
    const { performanceId, seatIds } = await newPerformance(admin);
    const [userId] = await newSignedInUserIds(admin, 1);
    const hold = HoldResponse.parse(
      (
        await app.inject({
          method: "POST",
          url: `/performances/${performanceId}/holds`,
          headers: authHeaders(userId),
          payload: { seatIds: seatIds.slice(0, seatCount) },
        })
      ).json(),
    );
    const order = OrderView.parse(
      (
        await app.inject({
          method: "POST",
          url: `/holds/${hold.holdId}/orders`,
          headers: { ...authHeaders(userId), "idempotency-key": randomUUID() },
        })
      ).json(),
    );
    return { performanceId, seatIds, userId: userId!, hold, order };
  }

  const pay = (orderId: number, userId: number, body: object | undefined = {}, key = randomUUID()) =>
    app.inject({
      method: "POST",
      url: `/orders/${orderId}/payments`,
      headers: { ...authHeaders(userId), "idempotency-key": key },
      ...(body === undefined ? {} : { payload: body }),
    });
  const accepted = (res: Awaited<ReturnType<typeof pay>>) => {
    expect(res.statusCode, res.body).toBe(202);
    return PaymentAccepted.parse(res.json());
  };
  const conflict = (res: Awaited<ReturnType<typeof pay>>) => {
    expect(res.statusCode, res.body).toBe(409);
    return PaymentConflict.parse(res.json());
  };
  // 웹훅을 직접 보낸다. 서명한 문자열 그대로 보낸다.
  const sendWebhook = (rawBody: string, signature = signWebhook(SECRET, rawBody)) =>
    app.inject({
      method: "POST",
      url: "/webhooks/fake-pay",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signature },
      payload: rawBody,
    });
  const resultOf = (res: Awaited<ReturnType<typeof sendWebhook>>) => (res.json() as { result: string }).result;

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

  async function waitForLockWaiters(count: number, event?: string) {
    for (let i = 0; i < 300; i++) {
      const { rows } = await admin.query(
        `select count(*) as n from pg_stat_activity
          where datname = current_database() and application_name = 'payments-test' and wait_event_type = 'Lock'
            and ($1::text is null or wait_event = $1)`,
        [event ?? null],
      );
      if (rows[0].n === count) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`잠금을 기다리는 연결이 ${count}개가 되지 않는다`);
  }

  async function withHolder<T>(lockSql: string, params: unknown[], run: (release: () => Promise<void>) => Promise<T>) {
    const holder = await admin.connect();
    try {
      await holder.query("begin");
      await holder.query(lockSql, params);
      return await run(async () => {
        await holder.query("commit");
      });
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
  }

  it("결제하면 202 requested이고, 성공 웹훅을 받으면 주문 paid·결제 succeeded·좌석 sold·좌석마다 표가 생긴다", async () => {
    const { userId, order, hold } = await newOrder(2);
    const res = accepted(await pay(order.orderId, userId));
    expect(res).toMatchObject({ orderId: order.orderId, status: "requested" });
    const { rows: refs } = await admin.query("select provider_ref, amount from payments where id = $1", [res.paymentId]);
    expect(refs[0].provider_ref).toMatch(/^fp_/);
    expect(refs[0].amount).toBe(order.amount);
    expect(await state(order.orderId)).toMatchObject({ status: "pending", payments: ["requested"], seats: ["held", "held"] });

    expect(await provider.flush()).toEqual([200]);
    expect(await state(order.orderId)).toEqual({
      status: "paid",
      cancel_reason: null,
      payments: ["succeeded"],
      seats: ["sold", "sold"],
      tickets: 2,
    });
    // 팔린 좌석도 선점을 남긴다
    const { rows: seats } = await admin.query("select count(*) as n from performance_seats where hold_id = $1 and status = 'sold'", [
      hold.holdId,
    ]);
    expect(seats[0].n).toBe(2);
    const { rows: hooks } = await admin.query("select result from payment_webhooks where payment_id = $1", [res.paymentId]);
    expect(hooks).toEqual([{ result: "processed" }]);

    const view = OrderView.parse(
      (await app.inject({ method: "GET", url: `/orders/${order.orderId}`, headers: authHeaders(userId) })).json(),
    );
    expect(view).toMatchObject({ status: "paid", payments: [{ paymentId: res.paymentId, status: "succeeded" }] });
    expect(view.tickets.map((t) => t.seatId)).toEqual(hold.seatIds);
    // 결제 확정 시각은 확정한 트랜잭션의 시각이다(updated_at과 같다)
    const { rows: paid } = await admin.query("select paid_at = updated_at as same, paid_at from orders where id = $1", [order.orderId]);
    expect(paid[0].same).toBe(true);
    expect(view.paidAt).toBe(paid[0].paid_at.toISOString());
  });

  it("본문 없이 보내도 기본값(success)으로 결제한다", async () => {
    const { userId, order } = await newOrder(1);
    expect(accepted(await pay(order.orderId, userId, undefined)).status).toBe("requested");
    expect(await provider.flush()).toEqual([200]);
    expect((await state(order.orderId)).status).toBe("paid");
  });

  it("C4: 같은 키로 다시 보내면 처음 응답을 그대로 주고, 결제 행은 하나이며 결제사도 한 번만 부른다", async () => {
    const { userId, order } = await newOrder();
    const key = randomUUID();
    const first = await pay(order.orderId, userId, {}, key);
    const again = await pay(order.orderId, userId, {}, key);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.json()).toEqual(first.json());
    expect(provider.takeQueued()).toHaveLength(1);
    expect((await state(order.orderId)).payments).toEqual(["requested"]);
  });

  it("C4: 같은 키의 앞 요청이 처리 중이면 뒤 요청은 REQUEST_IN_PROGRESS이고, 결제 행은 하나다", async () => {
    const { userId, order } = await newOrder();
    const key = randomUUID();
    await withHolder("select 1 from orders where id = $1 for update", [order.orderId], async (release) => {
      const first = pay(order.orderId, userId, {}, key);
      await waitForLockWaiters(1);
      const second = await pay(order.orderId, userId, {}, key);
      expect(conflict(second).code).toBe("REQUEST_IN_PROGRESS");
      await release();
      accepted(await first);
    });
    expect((await state(order.orderId)).payments).toEqual(["requested"]);
  });

  it("다른 키의 결제가 진행 중이면 409 PAYMENT_IN_PROGRESS이고, 키를 남기지 않아 결과가 난 뒤 같은 키로 다시 결제할 수 있다", async () => {
    const { userId, order } = await newOrder();
    const first = accepted(await pay(order.orderId, userId, { scenario: "fail" }));
    const key = randomUUID();
    expect(conflict(await pay(order.orderId, userId, {}, key))).toMatchObject({
      code: "PAYMENT_IN_PROGRESS",
      paymentId: first.paymentId,
    });
    expect(await provider.flush()).toEqual([200]);
    expect(await state(order.orderId)).toMatchObject({ status: "pending", payments: ["failed"] });

    const second = accepted(await pay(order.orderId, userId, {}, key));
    expect(second.paymentId).not.toBe(first.paymentId);
    expect(await provider.flush()).toEqual([200]);
    expect(await state(order.orderId)).toMatchObject({ status: "paid", payments: ["failed", "succeeded"] });
  });

  it("결제사가 내려가 있으면 503과 Retry-After이고, 같은 키로 다시 보내면 같은 결제를 다시 묻는다", async () => {
    const { userId, order } = await newOrder();
    const key = randomUUID();
    provider.outage = "down";
    try {
      const res = await pay(order.orderId, userId, {}, key);
      expect(res.statusCode).toBe(503);
      expect(res.headers["retry-after"]).toBe("1");
      const { paymentId } = PaymentProviderUnavailable.parse(res.json());
      const { rows } = await admin.query("select status, provider_ref from payments where id = $1", [paymentId]);
      expect(rows).toEqual([{ status: "requested", provider_ref: null }]);

      provider.outage = null;
      expect(accepted(await pay(order.orderId, userId, {}, key))).toMatchObject({ paymentId, status: "requested" });
      expect((await state(order.orderId)).payments).toEqual(["requested"]);
    } finally {
      provider.outage = null;
    }
  });

  it("503 뒤 선점이 끝나고 같은 키로 다시 보내면 결제사를 부르지 않고 ORDER_NOT_PAYABLE이다", async () => {
    const { userId, order, hold } = await newOrder(1);
    const key = randomUUID();
    provider.outage = "down";
    let paymentId: number;
    try {
      paymentId = PaymentProviderUnavailable.parse((await pay(order.orderId, userId, {}, key)).json()).paymentId;
    } finally {
      provider.outage = null;
    }
    await admin.query("update holds set expires_at = now() - interval '1 second' where id = $1", [hold.holdId]);
    expect(conflict(await pay(order.orderId, userId, {}, key))).toMatchObject({ code: "ORDER_NOT_PAYABLE", reason: "HOLD_EXPIRED" });
    // 결제사에는 결제가 없고, 결제 행은 대사가 맞추도록 requested로 남는다
    expect(await provider.lookup(paymentId)).toEqual({ status: "unknown" });
    expect((await state(order.orderId)).payments).toEqual(["requested"]);
  });

  it("결제사가 결제를 만들고 응답만 잃어도, 같은 키로 다시 보내면 이중 결제 없이 그 결제다", async () => {
    const { userId, order } = await newOrder();
    const key = randomUUID();
    provider.outage = "after_create";
    try {
      expect((await pay(order.orderId, userId, {}, key)).statusCode).toBe(503);
    } finally {
      provider.outage = null;
    }
    // 그사이 결제사의 웹훅이 와서 확정됐다
    expect(await provider.flush()).toEqual([200]);
    const again = accepted(await pay(order.orderId, userId, {}, key));
    expect(again.status).toBe("succeeded");
    expect(provider.takeQueued()).toEqual([]);
    expect(await state(order.orderId)).toMatchObject({ status: "paid", payments: ["succeeded"], tickets: 2 });
  });

  it("결제사가 3초 안에 답하지 않으면 503이다", async () => {
    const { userId, order } = await newOrder(1);
    provider.outage = "hang";
    try {
      expect((await pay(order.orderId, userId)).statusCode).toBe(503);
    } finally {
      provider.outage = null;
    }
  }, 15_000);

  it("결제할 수 없는 주문은 409 ORDER_NOT_PAYABLE과 이유이고, 같은 키로 다시 보내면 같은 409다", async () => {
    const expectNotPayable = async (orderId: number, userId: number, reason: string) => {
      const key = randomUUID();
      const res = await pay(orderId, userId, {}, key);
      expect(conflict(res)).toMatchObject({ code: "ORDER_NOT_PAYABLE", orderId, reason });
      const again = await pay(orderId, userId, {}, key);
      expect(again.headers["idempotent-replayed"]).toBe("true");
      expect(again.json()).toEqual(res.json());
    };

    const paid = await newOrder(1);
    accepted(await pay(paid.order.orderId, paid.userId));
    await provider.flush();
    await expectNotPayable(paid.order.orderId, paid.userId, "PAID");

    const cancelled = await newOrder(1);
    await admin.query("update orders set status = 'cancelled', cancel_reason = 'user' where id = $1", [cancelled.order.orderId]);
    await expectNotPayable(cancelled.order.orderId, cancelled.userId, "CANCELLED");

    const expired = await newOrder(1);
    await admin.query("update holds set expires_at = now() - interval '1 second' where id = $1", [expired.hold.holdId]);
    await expectNotPayable(expired.order.orderId, expired.userId, "HOLD_EXPIRED");

    // 결제 마감(만료 30초 전)이 지났다
    const late = await newOrder(1);
    await admin.query("update holds set expires_at = now() + interval '20 seconds' where id = $1", [late.hold.holdId]);
    await expectNotPayable(late.order.orderId, late.userId, "TOO_CLOSE_TO_EXPIRY");
    expect((await state(late.order.orderId)).payments).toEqual([]);
  });

  it("early: 웹훅이 결제 요청의 응답보다 먼저 와도 결제 행이 있어 확정되고, provider_ref는 웹훅이 채운다", async () => {
    const { userId, order } = await newOrder();
    const res = accepted(await pay(order.orderId, userId, { scenario: "early" }));
    expect(res.status).toBe("succeeded");
    expect(await state(order.orderId)).toMatchObject({ status: "paid", payments: ["succeeded"], tickets: 2 });
    const { rows } = await admin.query(
      `select p.provider_ref = (w.body->>'providerRef') as same
         from payments p join payment_webhooks w on w.payment_id = p.id where p.id = $1`,
      [res.paymentId],
    );
    expect(rows).toEqual([{ same: true }]);
  });

  it("duplicate: 같은 이벤트가 두 번 오면 두 번째는 duplicate이고 표는 한 번만 생긴다", async () => {
    const { userId, order } = await newOrder();
    accepted(await pay(order.orderId, userId, { scenario: "duplicate" }));
    const [first, second] = provider.takeQueued();
    expect(resultOf(await sendWebhook(first!.rawBody))).toBe("processed");
    expect(resultOf(await sendWebhook(second!.rawBody))).toBe("duplicate");
    expect(await state(order.orderId)).toMatchObject({ status: "paid", tickets: 2 });
  });

  it("같은 이벤트가 동시에 두 번 와도 하나만 처리한다", async () => {
    const { userId, order } = await newOrder();
    accepted(await pay(order.orderId, userId));
    const [webhook] = provider.takeQueued();
    const results = await Promise.all([sendWebhook(webhook!.rawBody), sendWebhook(webhook!.rawBody)]);
    expect(results.map(resultOf).sort()).toEqual(["duplicate", "processed"]);
    expect(await state(order.orderId)).toMatchObject({ status: "paid", tickets: 2 });
  });

  it("out_of_order: 결과 뒤에 온 중간 상태 이벤트는 ignored다", async () => {
    const { userId, order } = await newOrder();
    accepted(await pay(order.orderId, userId, { scenario: "out_of_order" }));
    const [result, intermediate] = provider.takeQueued();
    expect(resultOf(await sendWebhook(result!.rawBody))).toBe("processed");
    expect(resultOf(await sendWebhook(intermediate!.rawBody))).toBe("ignored");
    expect((await state(order.orderId)).status).toBe("paid");
  });

  it("lost: 웹훅이 오지 않으면 결제는 requested로 남는다(대사가 찾는다)", async () => {
    const { userId, order } = await newOrder();
    accepted(await pay(order.orderId, userId, { scenario: "lost" }));
    expect(provider.takeQueued()).toEqual([]);
    expect(await state(order.orderId)).toMatchObject({ status: "pending", payments: ["requested"] });
  });

  it("서명이 없거나 틀리면 401이고, 서명은 받은 글자 그대로에 대해 확인한다", async () => {
    const { userId, order } = await newOrder();
    accepted(await pay(order.orderId, userId));
    const [webhook] = provider.takeQueued();
    const event = JSON.parse(webhook!.rawBody) as object;

    expect((await sendWebhook(webhook!.rawBody, "0".repeat(64))).statusCode).toBe(401);
    const noSignature = await app.inject({
      method: "POST",
      url: "/webhooks/fake-pay",
      headers: { "content-type": "application/json" },
      payload: webhook!.rawBody,
    });
    expect(noSignature.statusCode).toBe(401);
    // 같은 내용이라도 글자가 다르면 원래 서명이 맞지 않는다
    const reformatted = JSON.stringify(event, null, 2);
    expect((await sendWebhook(reformatted, webhook!.signature)).statusCode).toBe(401);
    // 공백이 다른 본문도 그 글자로 서명하면 받는다
    expect(resultOf(await sendWebhook(reformatted))).toBe("processed");
    expect((await state(order.orderId)).status).toBe("paid");
  });

  it("결제사 번호가 이 결제의 것과 다르거나 다른 결제의 것이면 unmatched이고 결제를 바꾸지 않는다", async () => {
    const event = (paymentId: number, providerRef: string) =>
      JSON.stringify({ eventId: `evt_${randomUUID()}`, paymentId, providerRef, type: "payment.succeeded" });

    const mine = await newOrder(1);
    const myPayment = accepted(await pay(mine.order.orderId, mine.userId, { scenario: "lost" }));
    expect(resultOf(await sendWebhook(event(myPayment.paymentId, "fp_other")))).toBe("unmatched");

    // provider_ref가 빈 결제에 다른 결제의 번호가 오면 채우지 않는다(unique에 걸려 처리가 계속 실패하지 않게)
    const other = await newOrder(1);
    provider.outage = "down";
    let emptyRef: number;
    try {
      emptyRef = PaymentProviderUnavailable.parse((await pay(other.order.orderId, other.userId)).json()).paymentId;
    } finally {
      provider.outage = null;
    }
    const { rows } = await admin.query("select provider_ref from payments where id = $1", [myPayment.paymentId]);
    expect(resultOf(await sendWebhook(event(emptyRef, rows[0].provider_ref)))).toBe("unmatched");

    expect((await state(mine.order.orderId)).payments).toEqual(["requested"]);
    expect((await state(other.order.orderId)).payments).toEqual(["requested"]);
  });

  it("모르는 결제의 웹훅은 200 unmatched이고 본문째 남긴다", async () => {
    const raw = JSON.stringify({ eventId: `evt_${randomUUID()}`, paymentId: 999999999, providerRef: "fp_x", type: "payment.succeeded", extra: 1 });
    expect(resultOf(await sendWebhook(raw))).toBe("unmatched");
    const { rows } = await admin.query("select result, body from payment_webhooks where body->>'eventId' = $1", [
      (JSON.parse(raw) as { eventId: string }).eventId,
    ]);
    expect(rows).toEqual([{ result: "unmatched", body: JSON.parse(raw) }]);
  });

  it("선점이 끝난 뒤 성공 웹훅이 오면 좌석을 팔지 않고 주문 cancelled(expired), 결제 refund_pending이다", async () => {
    const { userId, order, hold } = await newOrder();
    accepted(await pay(order.orderId, userId));
    await admin.query("update holds set expires_at = now() - interval '1 second' where id = $1", [hold.holdId]);
    await admin.query("update performance_seats set hold_expires_at = now() - interval '1 second' where hold_id = $1", [
      hold.holdId,
    ]);
    expect(await provider.flush()).toEqual([200]);
    expect(await state(order.orderId)).toEqual({
      status: "cancelled",
      cancel_reason: "expired",
      payments: ["refund_pending"],
      seats: ["held", "held"],
      tickets: 0,
    });
  });

  it("취소된 주문의 결제가 성공하면 refund_pending이다", async () => {
    const { userId, order } = await newOrder();
    accepted(await pay(order.orderId, userId));
    await admin.query("update orders set status = 'cancelled', cancel_reason = 'user' where id = $1", [order.orderId]);
    expect(await provider.flush()).toEqual([200]);
    expect(await state(order.orderId)).toMatchObject({ status: "cancelled", payments: ["refund_pending"], tickets: 0 });
  });

  it("failed로 정한 결제에 성공이 오면 refund_pending이고, 성공한 결제에 실패가 오면 unmatched다", async () => {
    // 결제사가 같은 결제에 늦게 보낸 다른 이벤트다(결제사 번호는 그 결제의 것)
    const event = async (paymentId: number, type: string) => {
      const { rows } = await admin.query("select provider_ref from payments where id = $1", [paymentId]);
      return JSON.stringify({ eventId: `evt_${randomUUID()}`, paymentId, providerRef: rows[0].provider_ref, type });
    };

    const failed = await newOrder(1);
    const failedPayment = accepted(await pay(failed.order.orderId, failed.userId, { scenario: "fail" }));
    await provider.flush();
    expect(resultOf(await sendWebhook(await event(failedPayment.paymentId, "payment.succeeded")))).toBe("processed");
    expect(await state(failed.order.orderId)).toMatchObject({ status: "pending", payments: ["refund_pending"] });

    const paid = await newOrder(1);
    const paidPayment = accepted(await pay(paid.order.orderId, paid.userId));
    await provider.flush();
    expect(resultOf(await sendWebhook(await event(paidPayment.paymentId, "payment.failed")))).toBe("unmatched");
    expect(await state(paid.order.orderId)).toMatchObject({ status: "paid", payments: ["succeeded"] });
  });

  it("웹훅 처리가 실패하면(잠금 대기 3초) 웹훅 행도 되돌려져, 다시 보낼 때 처리한다", async () => {
    const { userId, order } = await newOrder();
    accepted(await pay(order.orderId, userId));
    await withHolder("select 1 from orders where id = $1 for update", [order.orderId], async () => {
      expect(await provider.flush()).toEqual([500]);
    });
    const { rows } = await admin.query("select count(*) as n from payment_webhooks w join payments p on p.id = w.payment_id where p.order_id = $1", [
      order.orderId,
    ]);
    expect(rows[0].n).toBe(0);
    expect(await provider.flush()).toEqual([200]);
    expect((await state(order.orderId)).status).toBe("paid");
  }, 15_000);

  it("E3: 확정이 사용자·회차 잠금을 기다리는 사이 선점이 끝나면, 잠금을 잡은 뒤의 시각으로 보고 팔지 않는다", async () => {
    const { userId, order, hold, performanceId } = await newOrder();
    accepted(await pay(order.orderId, userId));
    const { rows: expiry } = await admin.query<{ at: Date }>(
      "update holds set expires_at = now() + interval '1 second' where id = $1 returning expires_at as at",
      [hold.holdId],
    );
    await admin.query("update performance_seats set hold_expires_at = $2 where hold_id = $1", [hold.holdId, expiry[0]!.at]);

    await withHolder(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`hold:${userId}:${performanceId}`],
      async (release) => {
        const delivered = provider.flush();
        await waitForLockWaiters(1, "advisory");
        // 전제: 확정 트랜잭션은 만료 전에 시작했다(now()로 보면 팔았을 것이다)
        const { rows: started } = await admin.query(
          `select xact_start < $1 as before_expiry from pg_stat_activity
            where datname = current_database() and application_name = 'payments-test' and wait_event = 'advisory'`,
          [expiry[0]!.at],
        );
        expect(started).toEqual([{ before_expiry: true }]);
        while ((await admin.query("select now() > $1 as passed", [expiry[0]!.at])).rows[0].passed !== true) {
          await new Promise((r) => setTimeout(r, 50));
        }
        await release();
        expect(await delivered).toEqual([200]);
      },
    );
    expect(await state(order.orderId)).toMatchObject({
      status: "cancelled",
      cancel_reason: "expired",
      payments: ["refund_pending"],
      seats: ["held", "held"],
      tickets: 0,
    });
  });

  it("E2: 확정이 주문 행을 쥔 채 기다리는 동안 다른 키의 결제 요청이 오면, 주문 행에서 줄을 서 교착 없이 PAID를 받는다", async () => {
    const { userId, order, performanceId } = await newOrder();
    accepted(await pay(order.orderId, userId));
    await withHolder(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`hold:${userId}:${performanceId}`],
      async (release) => {
        const delivered = provider.flush();
        await waitForLockWaiters(1, "advisory");
        const second = pay(order.orderId, userId);
        await waitForLockWaiters(2);
        await release();
        expect(await delivered).toEqual([200]);
        expect(conflict(await second)).toMatchObject({ code: "ORDER_NOT_PAYABLE", reason: "PAID" });
      },
    );
    expect(await state(order.orderId)).toMatchObject({ status: "paid", payments: ["succeeded"], tickets: 2 });
  });

  it("판매 종료 전에 잡은 선점은 판매 종료 뒤에도 결제해 확정할 수 있고, 새 선점은 SALES_CLOSED다", async () => {
    const { userId, order, performanceId, seatIds } = await newOrder(2);
    await admin.query("update performances set sales_close_at = now() - interval '1 second' where id = $1", [performanceId]);
    accepted(await pay(order.orderId, userId));
    expect(await provider.flush()).toEqual([200]);
    expect(await state(order.orderId)).toMatchObject({ status: "paid", seats: ["sold", "sold"], tickets: 2 });

    const [other] = await newSignedInUserIds(admin, 1);
    const res = await app.inject({
      method: "POST",
      url: `/performances/${performanceId}/holds`,
      headers: authHeaders(other),
      payload: { seatIds: [seatIds[5]] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "SALES_CLOSED", reason: "CLOSED" });
  });

  it("로그인하지 않았으면 401, 남의 주문 404이고, 키 행이 남지 않는다", async () => {
    const { order } = await newOrder(1);
    const [stranger] = await newSignedInUserIds(admin, 1);
    const key = randomUUID();
    for (const [name, headers] of Object.entries(await unauthenticatedHeaders(admin))) {
      const res = await app.inject({
        method: "POST",
        url: `/orders/${order.orderId}/payments`,
        headers: { ...headers, "idempotency-key": key },
        payload: {},
      });
      expectUnauthenticated(res, name);
    }
    expect((await pay(order.orderId, stranger!, {}, key)).statusCode).toBe(404);
    const { rows } = await admin.query("select count(*) as n from idempotency_keys where key = $1", [key]);
    expect(rows[0].n).toBe(0);
  });
});
