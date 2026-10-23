import type { OrderView } from "@seat-booking/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { type Db, type Tx, writeTransaction } from "./db/client.js";
import {
  holds,
  orderItems,
  orders,
  payments,
  performanceGrades,
  performanceSeats,
  seats,
  tickets,
} from "./db/schema.js";

// 결제 마감은 선점 만료 30초 전이다(DESIGN 10장 31).
export const PAY_MARGIN_SECONDS = 30;

export type CreateOrderFailure =
  | { code: "HOLD_EXPIRED"; expiredAt: Date }
  | { code: "ORDER_EXISTS"; orderId: number }
  | { code: "PRICE_MISSING"; seatIds: number[] };
export type CreateOrderResult = { ok: true; view: OrderView } | ({ ok: false } & CreateOrderFailure);

// 주문 하나를 화면이 받는 모양으로 읽는다(DESIGN 6.2 "화면이 받는 것").
// 선점이 만료된 pending 주문은 정리 작업이 아직 돌지 않았어도 cancelled(expired)로 보여 준다. 좌석 지도가 만료된 선점을
// 빈 좌석으로 보여 주는 것과 같다. 시각은 ISO 문자열로 바꿔 두어, 멱등 키에 저장한 응답과 돌려준 응답이 같다.
export async function loadOrderView(db: Db | Tx, orderId: number): Promise<OrderView | undefined> {
  const [order] = await db
    .select({
      orderId: orders.id,
      holdId: orders.holdId,
      performanceId: holds.performanceId,
      status: orders.status,
      cancelReason: orders.cancelReason,
      amount: orders.amount,
      holdExpiresAt: holds.expiresAt,
      holdExpired: sql<boolean>`${holds.expiresAt} < now()`,
      // tx.execute와 sql 조각은 timestamptz를 문자열로 돌려주므로, timestamptz 열의 변환으로 Date를 받는다.
      serverTime: sql`now()`.mapWith(holds.expiresAt),
    })
    .from(orders)
    .innerJoin(holds, eq(holds.id, orders.holdId))
    .where(eq(orders.id, orderId));
  if (!order) return undefined;

  const items = await db
    .select({
      seatId: orderItems.seatId,
      section: seats.section,
      row: seats.rowLabel,
      number: seats.seatNumber,
      grade: seats.grade,
      price: orderItems.price,
    })
    .from(orderItems)
    .innerJoin(seats, eq(seats.id, orderItems.seatId))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.seatId));
  const paymentRows = await db
    .select({
      paymentId: payments.id,
      status: payments.status,
      amount: payments.amount,
      createdAt: payments.createdAt,
      updatedAt: payments.updatedAt,
    })
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(desc(payments.createdAt), desc(payments.id));
  const ticketRows = await db
    .select({ ticketId: tickets.id, seatId: tickets.seatId })
    .from(tickets)
    .where(and(eq(tickets.orderId, orderId), eq(tickets.status, "valid")))
    .orderBy(asc(tickets.seatId));

  const shownExpired = order.status === "pending" && order.holdExpired;
  return {
    orderId: order.orderId,
    holdId: order.holdId,
    performanceId: order.performanceId,
    status: shownExpired ? "cancelled" : order.status,
    cancelReason: shownExpired ? "expired" : order.cancelReason,
    amount: order.amount,
    items,
    holdExpiresAt: order.holdExpiresAt.toISOString(),
    payBy: new Date(order.holdExpiresAt.getTime() - PAY_MARGIN_SECONDS * 1000).toISOString(),
    serverTime: order.serverTime.toISOString(),
    payments: paymentRows.map((p) => ({
      ...p,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    })),
    tickets: ticketRows,
  };
}

// 선점으로 주문(pending)을 만든다(DESIGN 6.2 주문 생성). 부르는 쪽이 선점이 이 사용자의 것인지 먼저 확인한다.
// 1. 이 선점의 주문이 이미 있으면 ORDER_EXISTS. 선점 하나에 주문 하나다(orders.hold_id unique).
// 2. 선점이 만료됐으면 HOLD_EXPIRED. 만료 전이면 선점의 좌석이 모두 held로 남아 있다.
//    좌석이 선점에서 빠지는 것은 만료 뒤(정리 작업이 풀거나 다른 선점이 가져감)와 주문 취소뿐이고, 취소는 1에서 걸린다.
//    그래서 좌석은 잠그지 않고 읽는다. 만료는 좌석을 읽는 문장 안에서 행마다 clock_timestamp()로 본다.
//    다른 선점이 가져간 좌석이 이 문장에 보인다면 그 커밋은 만료 뒤이고 이 문장의 스냅샷은 그 커밋 뒤라,
//    남은 좌석도 모두 만료로 빠져 HOLD_EXPIRED다. now()(트랜잭션 시작)는 스냅샷보다 이르고, statement_timestamp()도
//    "받은 메시지의 시각"이라 문장이 기다리기 전일 수 있다. 그러면 가져간 좌석만 빠진 주문이 생긴다(리뷰 L2).
// 3. 가격이 없는 좌석이 있으면 PRICE_MISSING. 선점 때 막으므로 마지막 방어다.
// 4. 좌석과 그때의 가격을 order_items에 복사하고, 그 합을 amount로 주문을 넣는다.
//    다른 키로 같은 선점의 주문을 동시에 만들면 hold_id unique에서 먼저 넣은 쪽이 끝나길 기다린다.
//    ON CONFLICT DO NOTHING이라 기다린 쪽은 오류 없이 0행을 받고, 다음 문장에서 커밋된 그 주문을 보고 ORDER_EXISTS다.
// beforeCommit은 같은 트랜잭션에서 응답을 저장한다(멱등 키). 저장이 실패하면 주문도 되돌려진다.
export function createOrder(
  db: Db,
  input: { userId: number; holdId: number },
  beforeCommit: (tx: Tx, view: OrderView) => Promise<void>,
): Promise<CreateOrderResult> {
  const { userId, holdId } = input;
  return writeTransaction(db, async (tx) => {
    const findOrder = () => tx.select({ id: orders.id }).from(orders).where(eq(orders.holdId, holdId));
    const [existing] = await findOrder();
    if (existing) return { ok: false, code: "ORDER_EXISTS", orderId: existing.id };

    const [hold] = await tx
      .select({ expiresAt: holds.expiresAt, expired: sql<boolean>`${holds.expiresAt} < statement_timestamp()` })
      .from(holds)
      .where(eq(holds.id, holdId));
    const heldSeats = hold!.expired
      ? []
      : await tx
          .select({ seatId: performanceSeats.seatId, price: performanceGrades.price })
          .from(performanceSeats)
          .innerJoin(seats, eq(seats.id, performanceSeats.seatId))
          .leftJoin(
            performanceGrades,
            and(eq(performanceGrades.performanceId, performanceSeats.performanceId), eq(performanceGrades.grade, seats.grade)),
          )
          .where(
            and(
              eq(performanceSeats.holdId, holdId),
              eq(performanceSeats.status, "held"),
              sql`${performanceSeats.holdExpiresAt} >= clock_timestamp()`,
            ),
          )
          .orderBy(asc(performanceSeats.seatId));
    if (heldSeats.length === 0) return { ok: false, code: "HOLD_EXPIRED", expiredAt: hold!.expiresAt };

    const unpriced = heldSeats.filter((s) => s.price === null).map((s) => s.seatId);
    if (unpriced.length > 0) return { ok: false, code: "PRICE_MISSING", seatIds: unpriced };
    const priced = heldSeats.map((s) => ({ seatId: s.seatId, price: s.price! }));

    const [created] = await tx
      .insert(orders)
      .values({ userId, holdId, amount: priced.reduce((sum, s) => sum + s.price, 0) })
      .onConflictDoNothing({ target: orders.holdId })
      .returning({ id: orders.id });
    if (!created) {
      const [winner] = await findOrder();
      return { ok: false, code: "ORDER_EXISTS", orderId: winner!.id };
    }
    await tx.insert(orderItems).values(priced.map((s) => ({ orderId: created.id, ...s })));

    const view = (await loadOrderView(tx, created.id))!;
    await beforeCommit(tx, view);
    return { ok: true, view };
  });
}

export type CancelOrderResult = { ok: true; view: OrderView } | { ok: false; code: "ORDER_NOT_CANCELLABLE"; orderId: number };

// 주문 취소(DESIGN 6.2 취소). 부르는 쪽이 주문이 이 사용자의 것인지 먼저 확인한다.
// 주문 행을 잡고 pending → cancelled로 바꾼 뒤, 이 선점의 held 좌석을 seat_id 순서로 잠가 빈 좌석으로 되돌린다.
// status·hold_id·hold_expires_at을 한 UPDATE에서 함께 비워 CHECK 두 개와 맞춘다. 다른 선점이 가져간 좌석(hold_id가 다름)은 건드리지 않는다.
// 이미 cancelled면 그대로 돌려준다(두 번 와도 결과가 같아 멱등 키를 받지 않는다). paid면 ORDER_NOT_CANCELLABLE.
// 선점이 이미 만료됐으면 이유는 expired다. 주문 조회가 이미 cancelled(expired)로 보여 준 것과 같게 한다.
// 진행 중인 결제(requested)가 있어도 취소한다. 그 결제가 나중에 성공하면 확정이 환불로 보낸다(화면은 취소 전에 그것을 알린다).
// C5: 결제 확정과 겹치면 둘 다 주문 행을 먼저 잡는다. 취소가 이기면 확정은 pending이 아니라 환불로 간다.
// 확정이 이기면, paid로 바꿨으면 취소는 409이고, 선점이 만료돼 cancelled(expired)로 바꿨으면 취소는 그 주문으로 200이다.
// 주문 행을 잡는 문장이 상태도 읽는다. 잠금을 기다렸다면 앞 트랜잭션이 바꾼 상태를 본다.
export function cancelOrder(db: Db, orderId: number): Promise<CancelOrderResult> {
  return writeTransaction(db, async (tx) => {
    const [order] = await tx
      .select({ status: orders.status, holdId: orders.holdId, performanceId: holds.performanceId })
      .from(orders)
      .innerJoin(holds, eq(holds.id, orders.holdId))
      .where(eq(orders.id, orderId))
      .for("no key update", { of: orders });
    const { status, holdId, performanceId } = order!;
    if (status === "paid") return { ok: false, code: "ORDER_NOT_CANCELLABLE", orderId };

    if (status === "pending") {
      await tx.execute(sql`
        update orders o
           set status = 'cancelled',
               cancel_reason = case when h.expires_at < statement_timestamp() then 'expired' else 'user' end,
               updated_at = now()
          from holds h
         where o.id = ${orderId} and h.id = o.hold_id and o.status = 'pending'
      `);
      await tx.execute(sql`
        with locked as (
          select seat_id from performance_seats
           where performance_id = ${performanceId} and hold_id = ${holdId} and status = 'held'
           order by seat_id
             for update
        )
        update performance_seats ps
           set status = 'available', hold_id = null, hold_expires_at = null
          from locked
         where ps.performance_id = ${performanceId} and ps.seat_id = locked.seat_id
      `);
    }
    return { ok: true, view: (await loadOrderView(tx, orderId))! };
  });
}
