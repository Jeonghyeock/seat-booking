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
//    좌석을 푸는 것은 만료(정리 작업)와 주문 취소뿐이고, 취소는 1에서 걸린다. 그래서 좌석은 잠그지 않고 읽는다.
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
      .select({ expiresAt: holds.expiresAt, expired: sql<boolean>`${holds.expiresAt} < now()` })
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
              sql`${performanceSeats.holdExpiresAt} >= now()`,
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
