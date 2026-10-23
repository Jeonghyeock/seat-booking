import { sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { type Db, writeTransaction } from "./db/client.js";
import type { FakePaymentProvider, LookupResult, RefundResult } from "./fake-pay.js";
import { applyPaymentResult, failVoidedPayment, PROVIDER_TIMEOUT_MS, withTimeout } from "./payments.js";

// 정리 작업(DESIGN 6.2 정리 작업). 단계마다 따로 트랜잭션이고 한 번에 최대 BATCH행씩 처리한다.
// 1·2는 SKIP LOCKED라 다른 트랜잭션이 쥔 행을 기다리지 않고 건너뛴다(결제 확정이 쥔 좌석·주문은 다음 번에 본다).
// 3·4는 결제사를 부르는 동안 트랜잭션도 행 잠금도 쥐지 않는다. 대사가 결제 행을 잠근 채 주문을 기다리면 웹훅 확정과 교착한다(실험 E5).
// 부분 인덱스(WHERE status = '…')를 쓰도록 상태 값은 SQL 글자로 적는다.
export const BATCH = 500;
// 웹훅을 잃은 결제를 결제사에 다시 묻기까지(10장 31). 값은 6단계 측정 뒤 다시 정한다.
export const RECONCILE_AFTER_SECONDS = 30;
// 결제사가 모른다고 답한 환불을 몇 번 다시 해 볼지(10장 35).
export const MAX_REFUND_ATTEMPTS = 5;
export const KEEP_IDEMPOTENCY_KEYS_HOURS = 24;

type Logger = Pick<FastifyBaseLogger, "warn" | "error">;
export type CleanupCounts = {
  releasedSeats: number;
  cancelledOrders: number;
  refunded: number;
  refundFailed: number;
  reconciled: number;
  deletedKeys: number;
};

// 1. 만료된 선점 좌석을 빈 좌석으로 되돌린다. status·hold_id·hold_expires_at을 한 UPDATE에서 함께 비워 CHECK 두 개와 맞춘다.
export async function releaseExpiredSeats(db: Db) {
  return writeTransaction(db, async (tx) => {
    const { rows } = await tx.execute(sql`
      with picked as (
        select performance_id, seat_id from performance_seats
         where status = 'held' and hold_expires_at < now()
         order by hold_expires_at
         limit ${BATCH}
           for update skip locked
      )
      update performance_seats ps
         set status = 'available', hold_id = null, hold_expires_at = null
        from picked
       where ps.performance_id = picked.performance_id and ps.seat_id = picked.seat_id
      returning ps.seat_id
    `);
    return rows.length;
  });
}

// 2. 선점이 만료된 pending 주문을 cancelled(expired)로 바꾼다. 좌석은 1이 푼다.
export async function cancelExpiredOrders(db: Db) {
  return writeTransaction(db, async (tx) => {
    const { rows } = await tx.execute(sql`
      with picked as (
        select o.id from orders o
          join holds h on h.id = o.hold_id
         where o.status = 'pending' and h.expires_at < now()
         limit ${BATCH}
           for no key update of o skip locked
      )
      update orders o
         set status = 'cancelled', cancel_reason = 'expired', updated_at = now()
        from picked
       where o.id = picked.id
      returning o.id
    `);
    return rows.length;
  });
}

// 3. 환불. refund_pending 결제를 잠그지 않고 고르고, 트랜잭션 밖에서 결제사에 환불을 요청한다(결제 id가 환불의 멱등 키).
// 성공하면 새 트랜잭션에서 refund_pending일 때만 refunded로 바꾼다. 결제사를 부른 뒤 바꾸기 전에 죽어도 다음 번에 다시 부르면 된다.
// 결제사가 그 결제를 모르면 시도 횟수를 늘리고, 다섯 번째면 refund_failed로 바꾸고 경보 로그를 남긴다(관리자가 다시 시도한다).
// 결제사에 닿지 않으면 횟수를 늘리지 않고 다음 번에 다시 한다.
export async function refundPayments(db: Db, provider: FakePaymentProvider, log: Logger) {
  const { rows: pending } = await db.execute<{ id: number }>(sql`
    select id from payments where status = 'refund_pending' order by created_at limit ${BATCH}
  `);
  let refunded = 0;
  let failed = 0;
  for (const { id } of pending) {
    let result: RefundResult;
    try {
      result = await withTimeout(provider.refund(id), PROVIDER_TIMEOUT_MS);
    } catch (err) {
      log.warn({ err, paymentId: id }, "환불: 결제사에 닿지 않음");
      continue;
    }
    if (result.kind === "refunded") {
      const { rows } = await writeTransaction(db, (tx) =>
        tx.execute(sql`
          update payments set status = 'refunded', updated_at = now()
           where id = ${id} and status = 'refund_pending'
          returning id
        `),
      );
      refunded += rows.length;
      continue;
    }
    const { rows } = await writeTransaction(db, (tx) =>
      tx.execute<{ status: string }>(sql`
        update payments
           set refund_attempts = refund_attempts + 1,
               status = case when refund_attempts + 1 >= ${MAX_REFUND_ATTEMPTS} then 'refund_failed' else status end,
               updated_at = now()
         where id = ${id} and status = 'refund_pending'
        returning status
      `),
    );
    if (rows[0]?.status === "refund_failed") {
      failed++;
      log.error({ paymentId: id }, "환불: 결제사가 결제를 몰라 다섯 번 실패, refund_failed");
    }
  }
  return { refunded, failed };
}

// 4. 대사. 30초 넘게 requested인 결제를 잠그지 않고 고르고, 트랜잭션 밖에서 결제사에 묻는다.
// 결과가 있으면 새 트랜잭션에서 웹훅과 같은 함수로 반영한다(주문 → 결제, requested일 때만).
// 결제사가 모르는 결제(결제사를 부르기 전에 죽음, 결제사 장애)면 먼저 결제사에서 그 id를 무효로 해 두고 failed로 바꾼다.
// 무효로 해 두지 않으면 넘겨받은 요청이 그 뒤에 같은 id로 결제를 만들어, 돈만 받고 결제는 failed로 남을 수 있다.
// 무효로 하려는 사이 결제가 만들어졌으면(exists) 그 결과를 반영한다.
export async function reconcilePayments(db: Db, provider: FakePaymentProvider, log: Logger) {
  const { rows: stale } = await db.execute<{ id: number }>(sql`
    select id from payments
     where status = 'requested' and created_at < now() - make_interval(secs => ${RECONCILE_AFTER_SECONDS})
     order by created_at
     limit ${BATCH}
  `);
  let reconciled = 0;
  for (const { id } of stale) {
    try {
      let found: LookupResult = await withTimeout(provider.lookup(id), PROVIDER_TIMEOUT_MS);
      if (found.status === "unknown") {
        const voided = await withTimeout(provider.void(id), PROVIDER_TIMEOUT_MS);
        found = voided.kind === "voided" ? { status: "voided" } : { status: voided.status, providerRef: voided.providerRef };
      }
      if (found.status === "voided") {
        if (await writeTransaction(db, (tx) => failVoidedPayment(tx, id))) reconciled++;
        continue;
      }
      const event = {
        eventId: `reconcile:${id}`,
        paymentId: id,
        providerRef: found.providerRef,
        type: found.status === "succeeded" ? "payment.succeeded" : "payment.failed",
      };
      const result = await writeTransaction(db, (tx) => applyPaymentResult(tx, event, log));
      if (result === "processed") reconciled++;
    } catch (err) {
      log.warn({ err, paymentId: id }, "대사: 이번에는 맞추지 못함");
    }
  }
  return reconciled;
}

// 5. 24시간 지난 멱등 키를 지운다.
export async function deleteOldIdempotencyKeys(db: Db) {
  return writeTransaction(db, async (tx) => {
    const { rows } = await tx.execute(sql`
      delete from idempotency_keys
       where (user_id, route, key) in (
         select user_id, route, key from idempotency_keys
          where created_at < now() - make_interval(hours => ${KEEP_IDEMPOTENCY_KEYS_HOURS})
          limit ${BATCH}
       )
      returning key
    `);
    return rows.length;
  });
}

// 다섯 단계를 차례로 한 번 돈다. 한 단계가 실패해도 다음 단계는 돈다.
export async function runCleanup(db: Db, provider: FakePaymentProvider, log: Logger): Promise<CleanupCounts> {
  const counts: CleanupCounts = {
    releasedSeats: 0,
    cancelledOrders: 0,
    refunded: 0,
    refundFailed: 0,
    reconciled: 0,
    deletedKeys: 0,
  };
  const step = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (err) {
      log.error({ err, step: name }, "정리 작업 실패");
    }
  };
  await step("좌석 풀기", async () => {
    counts.releasedSeats = await releaseExpiredSeats(db);
  });
  await step("주문 취소", async () => {
    counts.cancelledOrders = await cancelExpiredOrders(db);
  });
  await step("환불", async () => {
    const { refunded, failed } = await refundPayments(db, provider, log);
    counts.refunded = refunded;
    counts.refundFailed = failed;
  });
  await step("대사", async () => {
    counts.reconciled = await reconcilePayments(db, provider, log);
  });
  await step("멱등 키 지우기", async () => {
    counts.deletedKeys = await deleteOldIdempotencyKeys(db);
  });
  return counts;
}

// 서버를 띄우는 main.ts에서만 켠다(buildApp은 켜지 않는다). 테스트는 함수를 직접 부른다.
// 앞 번이 끝나지 않았으면 이번은 건너뛴다. 멈추는 함수를 돌려준다.
export function startCleanupLoop(db: Db, provider: FakePaymentProvider, log: Logger, intervalMs = 10_000) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runCleanup(db, provider, log).finally(() => {
      running = false;
    });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
