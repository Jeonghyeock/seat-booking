import type { PaymentAccepted, PaymentScenario, PaymentStatus } from "@seat-booking/shared";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { FastifyBaseLogger } from "fastify";
import { type Db, type Tx, writeTransaction } from "./db/client.js";
import { holds, orders, payments, paymentWebhooks, tickets } from "./db/schema.js";
import type { CreateResult, FakePaymentProvider } from "./fake-pay.js";
import { lockUserPerformance } from "./holds.js";
import { PAY_MARGIN_SECONDS } from "./orders.js";
import { recordEvent } from "./outbox.js";

// 결제사 호출의 시간 제한(DESIGN 6.2 결제 요청 2). statement_timeout은 DB 밖의 기다림을 막지 않는다.
export const PROVIDER_TIMEOUT_MS = 3000;

export type NotPayableReason = "PAID" | "CANCELLED" | "HOLD_EXPIRED" | "TOO_CLOSE_TO_EXPIRY";
export type RequestPaymentResult =
  | { ok: true; accepted: PaymentAccepted }
  | { ok: false; code: "ORDER_NOT_PAYABLE"; orderId: number; reason: NotPayableReason }
  | { ok: false; code: "PAYMENT_IN_PROGRESS"; paymentId: number }
  | { ok: false; code: "PAYMENT_PROVIDER_UNAVAILABLE"; paymentId: number; cause: unknown };

type Logger = Pick<FastifyBaseLogger, "warn">;

// 결제 요청(DESIGN 6.2 결제 요청). 부르는 쪽이 주문이 이 사용자의 것인지 먼저 확인한다.
// 1. 트랜잭션 A: 주문 행을 잡고, 이 주문에서 같은 멱등 키로 만든 결제를 상태와 상관없이 먼저 찾는다. 있으면 새로 만들지 않는다.
//    끝난 결제(requested가 아님)면 그 결제로 202다. requested면 결제할 수 있는 주문일 때만 그 결제로 2부터 다시 한다.
//    결제 마감이 지났거나 주문이 끝났으면 결제사를 부르지 않고 ORDER_NOT_PAYABLE이다. 그 결제 행은 대사가 맞춘다(리뷰 M1).
//    다시 보낸 요청, 넘겨받은 요청, 503 뒤 같은 키에 모두 같다.
//    같은 키의 결제가 없으면 결제할 수 있는 주문인지 보고, 다른 키의 진행 중인 결제가 있으면 PAYMENT_IN_PROGRESS다.
//    결제 행(requested)을 넣고 커밋한다. 결제 id가 결제사 쪽 멱등 키다. 웹훅이 응답보다 먼저 와도 이 행이 있다.
// 2. 트랜잭션 밖에서 결제사를 부른다(3초 제한). 실패하면 PAYMENT_PROVIDER_UNAVAILABLE. 결제 행은 남고, 같은 키로 다시 보내거나
//    대사 작업이 같은 결제 id로 다시 묻는다. 결제사가 무효로 거절하면(VOIDED, 대사가 무효로 해 둠) 결제 행은 그대로다.
//    대사가 아직 failed로 바꾸기 전이면 202의 status는 requested다.
// 3. 트랜잭션 B: provider_ref를 채우고(웹훅이 먼저 채웠으면 그대로 둔다) 결제의 지금 상태로 202다.
// beforeCommit은 202를 돌려주는 트랜잭션에서 응답을 저장한다(멱등 키).
export async function requestPayment(
  db: Db,
  provider: FakePaymentProvider,
  input: { orderId: number; key: string; scenario: PaymentScenario; delayMs: number },
  beforeCommit: (tx: Tx, accepted: PaymentAccepted) => Promise<void>,
): Promise<RequestPaymentResult> {
  const { orderId, key, scenario, delayMs } = input;
  const accept = async (tx: Tx, paymentId: number, status: PaymentStatus): Promise<RequestPaymentResult> => {
    const accepted = { orderId, paymentId, status };
    await beforeCommit(tx, accepted);
    return { ok: true, accepted };
  };

  const step1 = await writeTransaction(db, async (tx): Promise<RequestPaymentResult | { call: number }> => {
    // 잠금은 따로 잡고, 시각은 다음 문장에서 본다. 잠그는 문장의 statement_timestamp()는 기다리기 전 시각일 수 있다.
    await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for("no key update");

    const [same] = await tx
      .select({ id: payments.id, status: payments.status })
      .from(payments)
      .where(and(eq(payments.orderId, orderId), eq(payments.idempotencyKey, key)));
    if (same && same.status !== "requested") return accept(tx, same.id, same.status);

    const [order] = await tx
      .select({
        status: orders.status,
        amount: orders.amount,
        holdExpired: sql<boolean>`${holds.expiresAt} < statement_timestamp()`,
        pastPayBy: sql<boolean>`statement_timestamp() > ${holds.expiresAt} - make_interval(secs => ${PAY_MARGIN_SECONDS})`,
      })
      .from(orders)
      .innerJoin(holds, eq(holds.id, orders.holdId))
      .where(eq(orders.id, orderId));
    const reason = notPayableReason(order!);
    if (reason) return { ok: false, code: "ORDER_NOT_PAYABLE", orderId, reason };
    if (same) return { call: same.id };

    // 진행 중인 결제는 주문마다 하나다(부분 unique 인덱스가 마지막 방어). 주문 행을 쥐고 있어 그사이 생기지 않는다.
    const [inProgress] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.orderId, orderId), sql`${payments.status} = 'requested'`));
    if (inProgress) return { ok: false, code: "PAYMENT_IN_PROGRESS", paymentId: inProgress.id };

    const [created] = await tx
      .insert(payments)
      .values({ orderId, amount: order!.amount, idempotencyKey: key })
      .returning({ id: payments.id });
    return { call: created!.id };
  });
  if (!("call" in step1)) return step1;
  const paymentId = step1.call;

  let created: CreateResult;
  try {
    created = await withTimeout(provider.create({ paymentId, scenario, delayMs }), PROVIDER_TIMEOUT_MS);
  } catch (cause) {
    return { ok: false, code: "PAYMENT_PROVIDER_UNAVAILABLE", paymentId, cause };
  }

  return writeTransaction(db, async (tx) => {
    if (created.kind === "created") {
      await tx
        .update(payments)
        .set({ providerRef: created.providerRef, updatedAt: sql`now()` })
        .where(and(eq(payments.id, paymentId), isNull(payments.providerRef)));
    }
    const [payment] = await tx.select({ status: payments.status }).from(payments).where(eq(payments.id, paymentId));
    return accept(tx, paymentId, payment!.status);
  });
}

function notPayableReason(order: { status: string; holdExpired: boolean; pastPayBy: boolean }): NotPayableReason | null {
  if (order.status === "paid") return "PAID";
  if (order.status === "cancelled") return "CANCELLED";
  if (order.holdExpired) return "HOLD_EXPIRED";
  if (order.pastPayBy) return "TOO_CLOSE_TO_EXPIRY";
  return null;
}

// 시간 안에 끝나지 않으면 실패로 본다. 늦게 끝나거나 실패한 원래 호출은 버린다(결제 행은 같은 키나 대사가 맞춘다).
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`결제사가 ${ms}ms 안에 답하지 않음`)), ms);
  });
  // 버린 호출이 나중에 실패해도 처리되지 않은 거부가 되지 않게 한다.
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 결제사가 보낸 이벤트. 종류는 결제사가 늘릴 수 있어 문자열로 받는다.
export type PaymentEvent = { eventId: string; paymentId: number; providerRef: string; type: string };
// duplicate는 웹훅 행에 적지 않는 응답 전용 결과다(이미 처리한 이벤트).
export type WebhookResult = "processed" | "ignored" | "unmatched" | "duplicate";

// 받은 웹훅을 반영한다(DESIGN 6.2 웹훅 받기). 웹훅 행 넣기와 처리를 한 트랜잭션에서 한다.
// 이벤트 id가 이미 있으면 처리한 이벤트다(duplicate). 처리가 되돌려지면(교착, 시간 제한, 서버 중단) 웹훅 행도 사라져
// 결제사가 다시 보낼 때 다시 처리된다. 같은 이벤트가 동시에 오면 뒤의 것은 event_id unique에서 앞의 것을 기다린 뒤 0행이다.
// body는 받은 본문 전체다. 모르는 결제의 웹훅도 본문째 남긴다.
export function handleWebhook(db: Db, event: PaymentEvent, body: object, log: Logger): Promise<WebhookResult> {
  return writeTransaction(db, async (tx) => {
    const inserted = await tx
      .insert(paymentWebhooks)
      .values({ eventId: event.eventId, paymentId: event.paymentId, type: event.type, body })
      .onConflictDoNothing()
      .returning({ eventId: paymentWebhooks.eventId });
    if (inserted.length === 0) return "duplicate";
    const result = await applyPaymentResult(tx, event, log);
    await tx.update(paymentWebhooks).set({ result }).where(eq(paymentWebhooks.eventId, event.eventId));
    return result;
  });
}

// 결제사가 알려 준 결과를 반영한다. 웹훅과 대사(정리 작업)가 같이 쓴다(DESIGN 6.2 정리 4). 부르는 쪽이 트랜잭션을 연다.
export async function applyPaymentResult(
  tx: Tx,
  event: PaymentEvent,
  log: Logger,
): Promise<Exclude<WebhookResult, "duplicate">> {
  const [payment] = await tx
    .select({ orderId: payments.orderId, providerRef: payments.providerRef })
    .from(payments)
    .where(eq(payments.id, event.paymentId));
  if (!payment) {
    log.warn({ event }, "결제 반영: 모르는 결제");
    return "unmatched";
  }
  // 결제사 번호가 이 결제의 것과 다르거나 다른 결제의 것이면 맞지 않는 웹훅이다. 채우면 provider_ref unique에 걸려
  // 처리가 계속 실패하고 웹훅이 끝없이 다시 온다(리뷰 L3).
  const [owner] = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.providerRef, event.providerRef), ne(payments.id, event.paymentId)));
  if ((payment.providerRef !== null && payment.providerRef !== event.providerRef) || owner) {
    log.warn({ event, providerRef: payment.providerRef }, "결제 반영: 결제사 번호가 맞지 않음");
    return "unmatched";
  }
  if (event.type !== "payment.succeeded" && event.type !== "payment.failed") return "ignored";

  // 결제의 order_id는 바뀌지 않아 잠그지 않고 읽었다. 잠금 순서대로 주문을 먼저 잡고, 그 뒤에 결제의 상태를 본다.
  await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, payment.orderId)).for("no key update");
  const [current] = await tx.select({ status: payments.status }).from(payments).where(eq(payments.id, event.paymentId));
  const status = current!.status;

  if (event.type === "payment.succeeded") {
    if (status === "requested") {
      await confirmPayment(tx, payment.orderId, event, log);
      return "processed";
    }
    if (status === "failed") {
      // 대사가 failed로 정한 뒤 결제사 쪽에서 늦게 성공했다. 돈을 받았으니 돌려준다.
      await setPaymentStatus(tx, event, "failed", "refund_pending");
      log.warn({ event }, "결제 반영: failed로 정한 결제에 성공이 와서 환불로 보냄");
      return "processed";
    }
    return "ignored";
  }
  if (status === "requested") {
    await setPaymentStatus(tx, event, "requested", "failed");
    return "processed";
  }
  if (status === "failed") return "ignored";
  // 결제사는 끝 상태를 바꾸지 않는다고 약속한다. 성공한 결제에 온 실패는 맞지 않는 웹훅이다.
  log.warn({ event, status }, "결제 반영: 끝난 결제에 실패가 옴");
  return "unmatched";
}

// 대사가 결제사에서 무효로 해 둔 결제(결제사가 모르는 결제)를 failed로 바꾼다. 실패 반영과 같이 주문 → 결제 순서로 잡는다.
// 그사이 웹훅이 반영했으면(requested가 아님) 그대로 둔다.
export async function failVoidedPayment(tx: Tx, paymentId: number) {
  const [payment] = await tx.select({ orderId: payments.orderId }).from(payments).where(eq(payments.id, paymentId));
  await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, payment!.orderId)).for("no key update");
  const changed = await tx
    .update(payments)
    .set({ status: "failed", updatedAt: sql`now()` })
    .where(and(eq(payments.id, paymentId), eq(payments.status, "requested")))
    .returning({ id: payments.id });
  return changed.length > 0;
}

// 결제를 from 상태일 때만 to로 바꾼다. provider_ref가 비어 있으면 웹훅의 것으로 채운다(웹훅이 결제 요청의 응답보다 먼저 옴).
// 결제 상태를 바꾸는 경로는 모두 주문 행을 먼저 잡으므로 0행일 수 없다. 0행이면 그 규칙이 깨진 것이라 던져서 되돌린다(리뷰 L4).
async function setPaymentStatus(tx: Tx, event: PaymentEvent, from: PaymentStatus, to: PaymentStatus) {
  const changed = await tx
    .update(payments)
    .set({ status: to, providerRef: sql`coalesce(${payments.providerRef}, ${event.providerRef})`, updatedAt: sql`now()` })
    .where(and(eq(payments.id, event.paymentId), eq(payments.status, from)))
    .returning({ id: payments.id });
  if (changed.length === 0) throw new Error(`결제 ${event.paymentId}가 ${from}이 아니라 ${to}로 바꾸지 못함`);
}

// 주문을 pending일 때만 바꾼다. 확정은 주문 행을 쥐고 pending을 확인했으므로 0행이면 던져서 되돌린다.
async function setOrderFromPending(tx: Tx, orderId: number, values: PgUpdateSetSource<typeof orders>) {
  const changed = await tx
    .update(orders)
    .set({ ...values, updatedAt: sql`now()` })
    .where(and(eq(orders.id, orderId), eq(orders.status, "pending")))
    .returning({ id: orders.id });
  if (changed.length === 0) throw new Error(`주문 ${orderId}가 pending이 아님`);
}

// 결제 확정(DESIGN 6.2 결제 확정). 주문 행은 부르는 쪽이 잡았고 결제는 requested다.
// 3. 주문이 pending이 아니면(취소됐거나 다른 결제로 이미 paid) 결제를 refund_pending으로. 돈은 받았지만 줄 좌석이 없다.
// 4. 사용자·회차 advisory lock. 만료된 선점을 sold로 바꾸는 확정도 1인 한도를 늘리므로 선점과 같은 줄에 선다.
// 5. 주문의 좌석을 seat_id 순서로 잠그며 같은 문장에서 확인한다(held, 이 선점, 만료 전). 만료는 advisory lock을 잡은 뒤의
//    문장 시각(statement_timestamp())으로 본다. now()로 보면 잠금을 기다리다 만료된 확정이 좌석을 팔아 한도를 넘긴다(실험 E3).
//    잠금은 따로 앞 문장에서 잡는다. 한 문장으로 합치면 statement_timestamp()가 기다리기 전 시각이 된다.
//    이 문장이 좌석 잠금을 기다리는 사이 만료가 지나도 팔 수 있다. 그 잠금을 쥔 트랜잭션도 만료 전에 시작했으므로
//    다른 사용자는 그 좌석을 가져가지 못하고, 같은 사용자의 선점은 이 확정이 쥔 advisory lock 뒤에 서 있다(리뷰 N1).
//    모두 맞으면 좌석 sold, 주문 paid, 결제 succeeded, 표 valid. 하나라도 아니면 좌석은 그대로 두고(정리 작업이 푼다)
//    주문 cancelled(expired), 결제 refund_pending. 좌석을 쥐고 있어 확인과 쓰기 사이에 바뀌지 않으므로 쓸 때 다시 보지 않는다.
async function confirmPayment(tx: Tx, orderId: number, event: PaymentEvent, log: Logger) {
  const [order] = await tx
    .select({ status: orders.status, userId: orders.userId, holdId: orders.holdId, performanceId: holds.performanceId })
    .from(orders)
    .innerJoin(holds, eq(holds.id, orders.holdId))
    .where(eq(orders.id, orderId));
  const { status, userId, holdId, performanceId } = order!;
  if (status !== "pending") {
    await setPaymentStatus(tx, event, "requested", "refund_pending");
    log.warn({ event, orderStatus: status }, "결제 반영: 끝난 주문의 결제가 성공해서 환불로 보냄");
    return;
  }

  await lockUserPerformance(tx, userId, performanceId);
  const { rows: checked } = await tx.execute<{ seat_id: number; ok: boolean }>(sql`
    select ps.seat_id,
           (ps.status = 'held' and ps.hold_id = ${holdId} and ps.hold_expires_at >= statement_timestamp()) as ok
      from order_items oi
      join performance_seats ps on ps.performance_id = ${performanceId} and ps.seat_id = oi.seat_id
     where oi.order_id = ${orderId}
     order by ps.seat_id
       for update of ps
  `);
  if (checked.length === 0 || !checked.every((s) => s.ok)) {
    await setOrderFromPending(tx, orderId, { status: "cancelled", cancelReason: "expired" });
    await setPaymentStatus(tx, event, "requested", "refund_pending");
    log.warn({ event }, "결제 반영: 선점이 끝나 확정하지 못하고 환불로 보냄");
    return;
  }

  const seatIds = checked.map((s) => s.seat_id);
  // 팔린 좌석도 선점(hold_id)과 만료 시각을 남긴다(DESIGN 10장 16).
  await tx.execute(sql`
    update performance_seats set status = 'sold'
     where performance_id = ${performanceId} and seat_id = any(${sql.param(seatIds)}::bigint[])
  `);
  // 결제 확정 시각은 updated_at과 같은 트랜잭션 시각이다(expand → contract 2, DESIGN 6.7).
  await setOrderFromPending(tx, orderId, { status: "paid", paidAt: sql`now()` });
  await setPaymentStatus(tx, event, "requested", "succeeded");
  await tx.insert(tickets).values(seatIds.map((seatId) => ({ orderId, performanceId, seatId })));
  // 업무 이벤트(DESIGN 6.8). 성공 갈래에서만 넣는다. 위의 환불 갈래들은 값으로 돌아와 커밋되지만 이벤트가 없다.
  // 웹훅과 대사가 모두 이 함수로 오지만, 주문 행을 잡고 pending일 때만 여기까지 오므로 주문마다 한 번이다.
  await recordEvent(tx, userId, { name: "payment_succeeded", properties: { performanceId, orderId, paymentId: event.paymentId } });
}
