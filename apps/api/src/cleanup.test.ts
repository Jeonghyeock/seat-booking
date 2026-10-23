import { randomUUID } from "node:crypto";
import { HoldResponse, OrderView, PaymentAccepted, PaymentProviderUnavailable } from "@seat-booking/shared";
import { afterAll, describe, expect, inject, it, vi } from "vitest";
import { newPerformance, newSignedInUsers, newUsers } from "../test/fixtures.js";
import { buildApp } from "./app.js";
import {
  cancelExpiredOrders,
  deleteExpiredSessions,
  deleteOldIdempotencyKeys,
  reconcilePayments,
  refundPayments,
  releaseExpiredSeats,
  runCleanup,
  startCleanupLoop,
} from "./cleanup.js";
import { createDb } from "./db/client.js";
import { createPool } from "./db/pool.js";
import { FakePaymentProvider } from "./fake-pay.js";

// 정리 작업은 표 전체를 훑어 바꾸므로, 다른 테스트 파일과 함께 쓰지 않는 DB에서 돌린다(global-setup).
describe("정리 작업", () => {
  const url = inject("isolatedDatabaseUrl");
  const admin = createPool({ connectionString: url });
  // 잠금을 기다리는 앱 연결만 골라 보려고 이름을 붙인다.
  const pool = createPool({ connectionString: url, application_name: "cleanup-test" });
  const provider = new FakePaymentProvider("cleanup-test-secret");
  const app = buildApp(pool, {}, { paymentProvider: provider });
  const db = createDb(pool);
  const log = { warn: vi.fn(), error: vi.fn() };
  afterAll(async () => {
    await app.close();
    await Promise.all([pool.end(), admin.end()]);
  });

  async function newHold(seatCount = 2) {
    const { performanceId, seatIds } = await newPerformance(admin);
    const [userId] = await newUsers(admin, 1);
    const res = await app.inject({
      method: "POST",
      url: `/performances/${performanceId}/holds`,
      headers: { "x-user-id": String(userId) },
      payload: { seatIds: seatIds.slice(0, seatCount) },
    });
    return { performanceId, seatIds, userId: userId!, hold: HoldResponse.parse(res.json()) };
  }
  async function newOrder(seatCount = 2) {
    provider.takeQueued();
    const held = await newHold(seatCount);
    const res = await app.inject({
      method: "POST",
      url: `/holds/${held.hold.holdId}/orders`,
      headers: { "x-user-id": String(held.userId), "idempotency-key": randomUUID() },
    });
    return { ...held, order: OrderView.parse(res.json()) };
  }
  const pay = (orderId: number, userId: number, body: object = {}, key = randomUUID()) =>
    app.inject({
      method: "POST",
      url: `/orders/${orderId}/payments`,
      headers: { "x-user-id": String(userId), "idempotency-key": key },
      payload: body,
    });
  const accepted = async (res: ReturnType<typeof pay>) => {
    const r = await res;
    expect(r.statusCode, r.body).toBe(202);
    return PaymentAccepted.parse(r.json());
  };
  const expireHold = async (holdId: number) => {
    await admin.query("update holds set expires_at = now() - interval '1 second' where id = $1", [holdId]);
    await admin.query(
      "update performance_seats set hold_expires_at = now() - interval '1 second' where hold_id = $1 and status = 'held'",
      [holdId],
    );
  };
  const agePayment = (paymentId: number) =>
    admin.query("update payments set created_at = now() - interval '31 seconds' where id = $1", [paymentId]);
  const seatStatuses = async (performanceId: number, seatIds: number[]) =>
    (
      await admin.query(
        "select status from performance_seats where performance_id = $1 and seat_id = any($2::bigint[]) order by seat_id",
        [performanceId, seatIds],
      )
    ).rows.map((r) => r.status as string);
  async function orderState(orderId: number) {
    const { rows } = await admin.query(
      `select o.status, o.cancel_reason,
              (select coalesce(json_agg(p.status order by p.id), '[]') from payments p where p.order_id = o.id) as payments,
              (select count(*) from tickets t where t.order_id = o.id and t.status = 'valid') as tickets
         from orders o where o.id = $1`,
      [orderId],
    );
    return rows[0] as { status: string; cancel_reason: string | null; payments: string[]; tickets: number };
  }
  async function waitForLockWaiters(count: number) {
    for (let i = 0; i < 300; i++) {
      const { rows } = await admin.query(
        `select count(*) as n from pg_stat_activity
          where datname = current_database() and application_name = 'cleanup-test' and wait_event_type = 'Lock'`,
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

  it("1. 만료된 선점 좌석을 빈 좌석으로 되돌린다. 만료 전·팔린 좌석은 그대로이고, 다른 트랜잭션이 쥔 좌석은 건너뛰었다가 다음 번에 푼다", async () => {
    const expired = await newHold(2);
    const fresh = await newHold(1);
    const sold = await newHold(1);
    await expireHold(expired.hold.holdId);
    await admin.query("update performance_seats set status = 'sold', hold_expires_at = now() - interval '1 second' where hold_id = $1", [
      sold.hold.holdId,
    ]);

    const [first, second] = expired.hold.seatIds;
    await withHolder(
      "select 1 from performance_seats where performance_id = $1 and seat_id = $2 for update",
      [expired.performanceId, second],
      async (release) => {
        await releaseExpiredSeats(db);
        expect(await seatStatuses(expired.performanceId, [first!, second!])).toEqual(["available", "held"]);
        await release();
      },
    );
    await releaseExpiredSeats(db);
    expect(await seatStatuses(expired.performanceId, expired.hold.seatIds)).toEqual(["available", "available"]);
    const { rows } = await admin.query(
      "select count(*) as n from performance_seats where performance_id = $1 and (hold_id is not null or hold_expires_at is not null) and status = 'available'",
      [expired.performanceId],
    );
    expect(rows[0].n).toBe(0);
    expect(await seatStatuses(fresh.performanceId, fresh.hold.seatIds)).toEqual(["held"]);
    expect(await seatStatuses(sold.performanceId, sold.hold.seatIds)).toEqual(["sold"]);
  });

  it("2. 선점이 만료된 pending 주문을 cancelled(expired)로 바꾸고, 다른 트랜잭션이 쥔 주문은 건너뛴다", async () => {
    const expired = await newOrder(1);
    const locked = await newOrder(1);
    const fresh = await newOrder(1);
    await expireHold(expired.hold.holdId);
    await expireHold(locked.hold.holdId);

    await withHolder("select 1 from orders where id = $1 for no key update", [locked.order.orderId], async (release) => {
      await cancelExpiredOrders(db);
      expect(await orderState(expired.order.orderId)).toMatchObject({ status: "cancelled", cancel_reason: "expired" });
      expect((await orderState(locked.order.orderId)).status).toBe("pending");
      await release();
    });
    await cancelExpiredOrders(db);
    expect(await orderState(locked.order.orderId)).toMatchObject({ status: "cancelled", cancel_reason: "expired" });
    expect((await orderState(fresh.order.orderId)).status).toBe("pending");
  });

  it("C3 정리가 먼저: 좌석이 풀린 뒤 성공 웹훅이 오면 좌석을 팔지 않고 환불로 가고, 환불 작업이 refunded로 바꾼다", async () => {
    const { userId, order, hold, performanceId } = await newOrder(2);
    const payment = await accepted(pay(order.orderId, userId));
    await expireHold(hold.holdId);

    const counts = await runCleanup(db, provider, log);
    expect(counts.releasedSeats).toBeGreaterThanOrEqual(2);
    expect(await seatStatuses(performanceId, hold.seatIds)).toEqual(["available", "available"]);
    expect(await orderState(order.orderId)).toMatchObject({ status: "cancelled", cancel_reason: "expired" });

    expect(await provider.flush()).toEqual([200]);
    expect((await orderState(order.orderId)).payments).toEqual(["refund_pending"]);
    expect(await seatStatuses(performanceId, hold.seatIds)).toEqual(["available", "available"]);

    await runCleanup(db, provider, log);
    expect(await orderState(order.orderId)).toMatchObject({ payments: ["refunded"], tickets: 0 });
    expect(provider.isRefunded(payment.paymentId)).toBe(true);
  });

  it("C3 확정이 먼저: 확정이 좌석과 주문을 쥔 사이 만료가 지나도 정리는 건너뛰고, 확정이 끝나면 팔린 좌석이라 대상이 아니다", async () => {
    const { userId, order, hold, performanceId } = await newOrder(2);
    await accepted(pay(order.orderId, userId));

    // 표를 넣지 못하게 막아, 확정이 좌석을 sold로 바꾸고 주문을 잡은 채 기다리게 한다
    await withHolder("lock table tickets in exclusive mode", [], async (release) => {
      // 확정이 만료 전에 좌석을 보도록, 만료를 1초 뒤로 당긴 다음 곧바로 보낸다
      const { rows: expiry } = await admin.query<{ at: Date }>(
        "update holds set expires_at = now() + interval '1 second' where id = $1 returning expires_at as at",
        [hold.holdId],
      );
      await admin.query("update performance_seats set hold_expires_at = $2 where hold_id = $1", [hold.holdId, expiry[0]!.at]);
      const delivered = provider.flush();
      await waitForLockWaiters(1);
      while ((await admin.query("select now() > $1 as passed", [expiry[0]!.at])).rows[0].passed !== true) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await releaseExpiredSeats(db);
      await cancelExpiredOrders(db);
      // 커밋 전이라 다른 연결에는 아직 held·pending으로 보이지만, 정리는 쥔 행을 건너뛰었다
      expect(await seatStatuses(performanceId, hold.seatIds)).toEqual(["held", "held"]);
      expect((await orderState(order.orderId)).status).toBe("pending");
      await release();
      expect(await delivered).toEqual([200]);
    });

    await releaseExpiredSeats(db);
    await cancelExpiredOrders(db);
    expect(await orderState(order.orderId)).toMatchObject({ status: "paid", payments: ["succeeded"], tickets: 2 });
    expect(await seatStatuses(performanceId, hold.seatIds)).toEqual(["sold", "sold"]);
  });

  it("C3 만료가 먼저 지남: 확정이 만료를 보고 환불로 가면 좌석은 held로 남고, 다음 정리 작업이 풀고 환불한다", async () => {
    const { userId, order, hold, performanceId } = await newOrder(2);
    const payment = await accepted(pay(order.orderId, userId));
    await expireHold(hold.holdId);
    expect(await provider.flush()).toEqual([200]);
    expect(await orderState(order.orderId)).toMatchObject({ status: "cancelled", cancel_reason: "expired", payments: ["refund_pending"] });
    expect(await seatStatuses(performanceId, hold.seatIds)).toEqual(["held", "held"]);

    await runCleanup(db, provider, log);
    expect(await seatStatuses(performanceId, hold.seatIds)).toEqual(["available", "available"]);
    expect((await orderState(order.orderId)).payments).toEqual(["refunded"]);
    expect(provider.isRefunded(payment.paymentId)).toBe(true);
  });

  it("3. 환불: 결제사가 모르는 결제는 시도 횟수를 늘리고 다섯 번째에 refund_failed다. 결제사에 닿지 않으면 횟수를 늘리지 않는다", async () => {
    const { order } = await newOrder(1);
    const { rows } = await admin.query<{ id: number }>(
      "insert into payments (order_id, status, amount, idempotency_key) values ($1, 'refund_pending', $2, $3) returning id",
      [order.orderId, order.amount, randomUUID()],
    );
    const paymentId = rows[0]!.id;
    const attempts = async () =>
      (await admin.query("select status, refund_attempts from payments where id = $1", [paymentId])).rows[0];

    provider.outage = "down";
    try {
      await refundPayments(db, provider, log);
    } finally {
      provider.outage = null;
    }
    expect(await attempts()).toEqual({ status: "refund_pending", refund_attempts: 0 });

    for (let i = 1; i <= 4; i++) await refundPayments(db, provider, log);
    expect(await attempts()).toEqual({ status: "refund_pending", refund_attempts: 4 });
    log.error.mockClear();
    await refundPayments(db, provider, log);
    expect(await attempts()).toEqual({ status: "refund_failed", refund_attempts: 5 });
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ paymentId }), expect.any(String));
  });

  it("3. 환불: 두 정리 작업이 겹쳐 같은 결제에 '모른다'를 받아도 시도 횟수는 한 번만 는다", async () => {
    const { order } = await newOrder(1);
    const { rows } = await admin.query<{ id: number }>(
      "insert into payments (order_id, status, amount, idempotency_key) values ($1, 'refund_pending', $2, $3) returning id",
      [order.orderId, order.amount, randomUUID()],
    );
    // 두 작업이 모두 결제를 고른 뒤 결제사의 답을 기다리게 한다
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    let waiting = 0;
    const spy = vi.spyOn(provider, "refund").mockImplementation(async () => {
      waiting++;
      await gate;
      return { kind: "unknown" };
    });
    try {
      const runs = [refundPayments(db, provider, log), refundPayments(db, provider, log)];
      while (waiting < 2) await new Promise((r) => setTimeout(r, 5));
      open();
      await Promise.all(runs);
    } finally {
      spy.mockRestore();
    }
    const { rows: after } = await admin.query("select refund_attempts from payments where id = $1", [rows[0]!.id]);
    expect(after[0].refund_attempts).toBe(1);
  });

  it("결제사에 잇달아 세 번 닿지 않으면 그 단계를 이번 바퀴에서 멈추고 경보는 몇 줄만 남긴다", async () => {
    const { order } = await newOrder(1);
    for (let i = 0; i < 6; i++) {
      await admin.query(
        "insert into payments (order_id, status, amount, idempotency_key) values ($1, 'refund_pending', $2, $3)",
        [order.orderId, order.amount, randomUUID()],
      );
    }
    const refund = vi.spyOn(provider, "refund");
    log.warn.mockClear();
    provider.outage = "down";
    let calls: number;
    try {
      await refundPayments(db, provider, log);
      calls = refund.mock.calls.length;
    } finally {
      provider.outage = null;
      refund.mockRestore();
    }
    expect(calls).toBe(3);
    expect(log.warn).toHaveBeenCalledTimes(3);
    // 다음 바퀴에는 다시 한다
    await refundPayments(db, provider, log);
    const { rows } = await admin.query("select count(*) as n from payments where order_id = $1 and refund_attempts = 1", [
      order.orderId,
    ]);
    expect(rows[0].n).toBe(6);
  });

  it("4. 대사: 30초 넘게 requested인 결제를 결제사에 물어 성공이면 확정하고 실패면 failed다. 30초가 안 된 결제는 그대로다", async () => {
    const lost = await newOrder(1);
    const lostPayment = await accepted(pay(lost.order.orderId, lost.userId, { scenario: "lost" }));
    const failed = await newOrder(1);
    const failedPayment = await accepted(pay(failed.order.orderId, failed.userId, { scenario: "fail" }));
    provider.takeQueued();
    const recent = await newOrder(1);
    await accepted(pay(recent.order.orderId, recent.userId, { scenario: "lost" }));
    await agePayment(lostPayment.paymentId);
    await agePayment(failedPayment.paymentId);

    await reconcilePayments(db, provider, log);
    expect(await orderState(lost.order.orderId)).toMatchObject({ status: "paid", payments: ["succeeded"], tickets: 1 });
    expect(await orderState(failed.order.orderId)).toMatchObject({ status: "pending", payments: ["failed"] });
    expect(await orderState(recent.order.orderId)).toMatchObject({ status: "pending", payments: ["requested"] });
  });

  it("4. 대사: 결제사가 모르는 결제는 무효로 해 두고 failed로 바꾼다. 그 뒤 같은 키로 다시 보내면 그 결제를 돌려준다", async () => {
    const { userId, order } = await newOrder(1);
    const key = randomUUID();
    provider.outage = "down";
    let paymentId: number;
    try {
      paymentId = PaymentProviderUnavailable.parse((await pay(order.orderId, userId, {}, key)).json()).paymentId;
    } finally {
      provider.outage = null;
    }
    await agePayment(paymentId);
    await reconcilePayments(db, provider, log);
    expect((await orderState(order.orderId)).payments).toEqual(["failed"]);
    expect(await provider.lookup(paymentId)).toEqual({ status: "voided" });

    expect(await accepted(pay(order.orderId, userId, {}, key))).toMatchObject({ paymentId, status: "failed" });
    expect((await orderState(order.orderId)).payments).toEqual(["failed"]);
  });

  it("4. 대사가 무효로 한 뒤 failed로 바꾸기 전에 같은 키가 다시 오면 결제사가 VOIDED로 거절해 202 requested이고, 다음 대사가 failed로 바꾼다", async () => {
    const { userId, order } = await newOrder(1);
    const key = randomUUID();
    provider.outage = "down";
    let paymentId: number;
    try {
      paymentId = PaymentProviderUnavailable.parse((await pay(order.orderId, userId, {}, key)).json()).paymentId;
    } finally {
      provider.outage = null;
    }
    // 대사의 앞 절반(결제사에서 무효로 하기)만 일어났다
    await provider.void(paymentId);
    expect(await accepted(pay(order.orderId, userId, {}, key))).toMatchObject({ paymentId, status: "requested" });
    expect(provider.takeQueued()).toEqual([]);

    await agePayment(paymentId);
    await reconcilePayments(db, provider, log);
    expect((await orderState(order.orderId)).payments).toEqual(["failed"]);
  });

  it("4. 대사: 결제사가 모른다고 답했는데 무효로 하려는 사이 결제가 만들어졌으면, 무효로 하지 않고 그 결과로 확정한다", async () => {
    const { userId, order } = await newOrder(1);
    const payment = await accepted(pay(order.orderId, userId, { scenario: "lost" }));
    await agePayment(payment.paymentId);
    // 조회 때는 아직 없었고, 무효로 하려 할 때는 결제사에 결제가 있다
    const lookup = vi.spyOn(provider, "lookup").mockResolvedValueOnce({ status: "unknown" });
    try {
      await reconcilePayments(db, provider, log);
    } finally {
      lookup.mockRestore();
    }
    expect(await orderState(order.orderId)).toMatchObject({ status: "paid", payments: ["succeeded"], tickets: 1 });
    expect(provider.isRefunded(payment.paymentId)).toBe(false);
  });

  it("4. 대사: 선점이 끝난 뒤 결제사에서 성공을 알게 되면 환불로 보내고, 다음 바퀴에 환불한다", async () => {
    const { userId, order, hold } = await newOrder(1);
    const payment = await accepted(pay(order.orderId, userId, { scenario: "lost" }));
    await agePayment(payment.paymentId);
    await expireHold(hold.holdId);
    await reconcilePayments(db, provider, log);
    expect(await orderState(order.orderId)).toMatchObject({ status: "cancelled", payments: ["refund_pending"] });
    await runCleanup(db, provider, log);
    expect((await orderState(order.orderId)).payments).toEqual(["refunded"]);
  });

  it("4. 대사: 결제사에 닿지 않으면 건너뛰고 다음 번에 맞춘다", async () => {
    const { userId, order } = await newOrder(1);
    const payment = await accepted(pay(order.orderId, userId, { scenario: "lost" }));
    await agePayment(payment.paymentId);
    provider.outage = "down";
    try {
      await reconcilePayments(db, provider, log);
    } finally {
      provider.outage = null;
    }
    expect((await orderState(order.orderId)).payments).toEqual(["requested"]);
    await reconcilePayments(db, provider, log);
    expect(await orderState(order.orderId)).toMatchObject({ status: "paid", payments: ["succeeded"] });
  });

  it("6. 만료된 세션을 지우고, 만료 전 세션은 남긴다", async () => {
    const [expired, fresh] = await newSignedInUsers(admin, 2);
    await admin.query("update sessions set expires_at = now() - interval '1 second' where user_id = $1", [expired!.id]);
    // 주기 실행에도 이 단계가 들어 있다
    expect((await runCleanup(db, provider, log)).deletedSessions).toBeGreaterThanOrEqual(1);
    await deleteExpiredSessions(db);
    const { rows } = await admin.query("select user_id from sessions where user_id = any($1::bigint[])", [
      [expired!.id, fresh!.id],
    ]);
    expect(rows.map((r) => r.user_id)).toEqual([fresh!.id]);
  });

  it("5. 24시간 지난 멱등 키를 지우고, 그보다 새 키는 남긴다", async () => {
    const [userId] = await newUsers(admin, 1);
    const insertKey = (key: string, age: string) =>
      admin.query(
        `insert into idempotency_keys (user_id, route, key, request_hash, owner_token, created_at, updated_at)
         values ($1, 'TEST', $2, 'h', gen_random_uuid(), now() - $3::interval, now() - $3::interval)`,
        [userId, key, age],
      );
    const old = randomUUID();
    const recent = randomUUID();
    await insertKey(old, "25 hours");
    await insertKey(recent, "23 hours");
    await deleteOldIdempotencyKeys(db);
    const { rows } = await admin.query("select key from idempotency_keys where user_id = $1", [userId]);
    expect(rows.map((r) => r.key)).toEqual([recent]);
  });

  it("주기 실행은 정해 둔 간격마다 정리 작업을 돌리고, 멈추면 더 돌지 않는다", async () => {
    const { hold, performanceId } = await newHold(1);
    await expireHold(hold.holdId);
    const stop = startCleanupLoop(db, provider, log, 20);
    try {
      for (let i = 0; i < 100 && (await seatStatuses(performanceId, hold.seatIds))[0] !== "available"; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(await seatStatuses(performanceId, hold.seatIds)).toEqual(["available"]);
    } finally {
      await stop();
    }
    const after = await newHold(1);
    await expireHold(after.hold.holdId);
    await new Promise((r) => setTimeout(r, 100));
    expect(await seatStatuses(after.performanceId, after.hold.seatIds)).toEqual(["held"]);
  });
});
