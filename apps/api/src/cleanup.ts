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
// 결제사가 모른다고 답한 환불을 모두 몇 번 해 볼지. 이 번째에도 모르면 refund_failed다(10장 35).
export const MAX_REFUND_ATTEMPTS = 5;
export const KEEP_IDEMPOTENCY_KEYS_HOURS = 24;
// 결제사에 이만큼 잇달아 닿지 않으면 그 단계를 이번 바퀴에서 멈춘다. 결제마다 시간 제한만큼 기다리고 로그를 남기지 않게.
// 첫 실패에 멈추면, 늘 실패하는 결제 하나가 맨 앞에 있을 때 뒤의 결제가 끝내 처리되지 않는다.
export const MAX_PROVIDER_FAILURES_PER_STEP = 3;

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

// 결제사에 잇달아 닿지 않은 횟수를 센다. 정해 둔 횟수가 되면 경보 한 줄을 남기고 그 단계를 멈추게 한다.
function providerFailures(step: string, log: Logger) {
  let inARow = 0;
  return {
    succeeded() {
      inARow = 0;
    },
    // 멈춰야 하면 true.
    failed(err: unknown, paymentId: number, remaining: number) {
      inARow++;
      if (inARow < MAX_PROVIDER_FAILURES_PER_STEP) {
        log.warn({ err, paymentId }, `${step}: 결제사에 닿지 않음`);
        return false;
      }
      log.warn({ err, remaining }, `${step}: 결제사에 ${inARow}번 잇달아 닿지 않아 이번 바퀴를 멈춤`);
      return true;
    },
  };
}

// 3. 환불. refund_pending 결제를 잠그지 않고 고르고, 트랜잭션 밖에서 결제사에 환불을 요청한다(결제 id가 환불의 멱등 키).
// 성공하면 새 트랜잭션에서 refund_pending일 때만 refunded로 바꾼다. 결제사를 부른 뒤 바꾸기 전에 죽어도 다음 번에 다시 부르면 된다.
// 결제사가 그 결제를 모르면 시도 횟수를 늘리고, 다섯 번째면 refund_failed로 바꾸고 경보 로그를 남긴다(관리자가 다시 시도한다).
// 횟수는 고를 때 읽은 값일 때만 늘린다. 두 정리 작업이 겹치거나 관리자가 다시 시도하게 되돌린 뒤 묵은 답이 와도 한 번만 센다.
// 결제사에 닿지 않으면 횟수를 늘리지 않고 다음 번에 다시 한다.
export async function refundPayments(db: Db, provider: FakePaymentProvider, log: Logger) {
  const { rows: pending } = await db.execute<{ id: number; refund_attempts: number }>(sql`
    select id, refund_attempts from payments where status = 'refund_pending' order by created_at limit ${BATCH}
  `);
  const failures = providerFailures("환불", log);
  let refunded = 0;
  let failed = 0;
  for (const [i, { id, refund_attempts: attempts }] of pending.entries()) {
    let result: RefundResult;
    try {
      result = await withTimeout(provider.refund(id), PROVIDER_TIMEOUT_MS);
      failures.succeeded();
    } catch (err) {
      if (failures.failed(err, id, pending.length - i - 1)) break;
      continue;
    }
    try {
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
           where id = ${id} and status = 'refund_pending' and refund_attempts = ${attempts}
          returning status
        `),
      );
      if (rows[0]?.status === "refund_failed") {
        failed++;
        log.error({ paymentId: id }, "환불: 결제사가 결제를 몰라 다섯 번째에도 실패, refund_failed");
      }
    } catch (err) {
      log.warn({ err, paymentId: id }, "환불: 결과를 적지 못함, 다음 번에 다시");
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
  const failures = providerFailures("대사", log);
  let reconciled = 0;
  for (const [i, { id }] of stale.entries()) {
    let found: LookupResult;
    try {
      found = await withTimeout(provider.lookup(id), PROVIDER_TIMEOUT_MS);
      if (found.status === "unknown") {
        const voided = await withTimeout(provider.void(id), PROVIDER_TIMEOUT_MS);
        found = voided.kind === "voided" ? { status: "voided" } : { status: voided.status, providerRef: voided.providerRef };
      }
      failures.succeeded();
    } catch (err) {
      if (failures.failed(err, id, stale.length - i - 1)) break;
      continue;
    }
    try {
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
      log.warn({ err, paymentId: id }, "대사: 결과를 반영하지 못함, 다음 번에 다시");
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

// 다섯 단계를 한 번 돈다. 한 단계가 실패해도 다음 단계는 돈다.
// DB만 쓰는 단계(1, 2, 5)를 먼저 돌아, 결제사가 느려도 이번 바퀴에 끝낸다.
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
  await step("멱등 키 지우기", async () => {
    counts.deletedKeys = await deleteOldIdempotencyKeys(db);
  });
  await step("환불", async () => {
    const { refunded, failed } = await refundPayments(db, provider, log);
    counts.refunded = refunded;
    counts.refundFailed = failed;
  });
  await step("대사", async () => {
    counts.reconciled = await reconcilePayments(db, provider, log);
  });
  return counts;
}

// 서버를 띄우는 main.ts에서만 켠다(buildApp은 켜지 않는다). 테스트는 함수를 직접 부른다.
// 앞 번이 끝나지 않았으면 이번은 건너뛴다. 멈추는 함수는 진행 중인 바퀴가 끝날 때까지 기다린다(풀을 닫기 전에 부른다).
export function startCleanupLoop(db: Db, provider: FakePaymentProvider, log: Logger, intervalMs = 10_000) {
  let current: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (current) return;
    current = runCleanup(db, provider, log).finally(() => {
      current = undefined;
    });
  }, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await current;
  };
}
