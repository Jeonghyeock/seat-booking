import type pg from "pg";

// C2 합격 확인의 DB 쪽(DESIGN 6.6 "합격 확인(C2)"). 회차 id 목록($1)에 한정해 센다. 모두 0이어야 한다.

type Queryable = pg.Pool | pg.ClientBase;

// (a) 언제 보아도 0이어야 하는 것. 3단계 부하 실험의 불변식 일곱 가지 가운데 다섯이 여기 있고,
// 나머지 둘(만료된 pending 주문, requested 결제)은 조용해진 뒤에만 0이라 LEFTOVERS에 있다.
export const INVARIANTS = {
  // 한 좌석에 유효한 표가 둘. 부분 unique 인덱스가 막으므로, 이것이 0이 아니면 인덱스가 없어진 것이다.
  duplicateValidTickets: `
    select count(*) from (
      select 1 from tickets where performance_id = any($1) and status = 'valid'
       group by performance_id, seat_id having count(*) > 1) x`,
  soldWithoutValidTicket: `
    select count(*) from performance_seats ps
     where ps.performance_id = any($1) and ps.status = 'sold'
       and not exists (select 1 from tickets t
                        where t.performance_id = ps.performance_id and t.seat_id = ps.seat_id and t.status = 'valid')`,
  validTicketNotSold: `
    select count(*) from tickets t
      join performance_seats ps on ps.performance_id = t.performance_id and ps.seat_id = t.seat_id
     where t.performance_id = any($1) and t.status = 'valid' and ps.status <> 'sold'`,
  // 팔린 좌석은 선점 행을 남긴다(10장 16). 그 선점의 주문이 paid여야 한다.
  soldWithoutPaidOrder: `
    select count(*) from performance_seats ps
      left join orders o on o.hold_id = ps.hold_id
     where ps.performance_id = any($1) and ps.status = 'sold' and o.status is distinct from 'paid'`,
  // paid 주문인데 좌석이 그 선점으로 팔리지 않음(held로 남음 등), 성공한 결제가 하나가 아님, 유효한 표가 담은 좌석 수와 다름.
  paidOrderBroken: `
    select count(*) from orders o join holds h on h.id = o.hold_id
     where h.performance_id = any($1) and o.status = 'paid' and (
       exists (select 1 from order_items oi
                 join performance_seats ps on ps.performance_id = h.performance_id and ps.seat_id = oi.seat_id
                where oi.order_id = o.id and (ps.status <> 'sold' or ps.hold_id is distinct from o.hold_id))
       or (select count(*) from payments p where p.order_id = o.id and p.status = 'succeeded') <> 1
       or (select count(*) from tickets t where t.order_id = o.id and t.status = 'valid')
          <> (select count(*) from order_items oi where oi.order_id = o.id))`,
  // 취소된 주문에 성공한 결제(환불되지 않음), 표(결제 뒤 취소가 없어 상태와 상관없이), 그 선점으로 팔린 좌석이 남음.
  cancelledOrderBroken: `
    select count(*) from orders o join holds h on h.id = o.hold_id
     where h.performance_id = any($1) and o.status = 'cancelled' and (
       exists (select 1 from payments p where p.order_id = o.id and p.status = 'succeeded')
       or exists (select 1 from tickets t where t.order_id = o.id)
       or exists (select 1 from performance_seats ps where ps.hold_id = o.hold_id and ps.status = 'sold'))`,
  // 성공한 결제의 주문은 paid다. 결제 확정이 결제와 주문을 한 트랜잭션에서 바꾸므로 중간 상태가 보이지 않는다.
  succeededPaymentNotPaid: `
    select count(*) from payments p join orders o on o.id = p.order_id join holds h on h.id = o.hold_id
     where h.performance_id = any($1) and p.status = 'succeeded' and o.status <> 'paid'`,
  // 주문 금액은 담은 좌석 가격의 합이고, 성공한 결제의 금액은 주문 금액이다.
  amountMismatch: `
    select count(*) from orders o join holds h on h.id = o.hold_id
     where h.performance_id = any($1) and (
       o.amount <> (select coalesce(sum(oi.price), 0) from order_items oi where oi.order_id = o.id)
       or exists (select 1 from payments p where p.order_id = o.id and p.status = 'succeeded' and p.amount <> o.amount))`,
  // 좌석의 선점 만료는 선점 행의 만료와 같고, 선점은 그 좌석의 회차 것이다(6.1: 한 번 쓰고 바꾸지 않는다).
  seatHoldMismatch: `
    select count(*) from performance_seats ps join holds h on h.id = ps.hold_id
     where ps.performance_id = any($1) and (ps.hold_expires_at <> h.expires_at or h.performance_id <> ps.performance_id)`,
  // 만료 전 held 좌석인데 그 선점의 주문이 이미 끝남.
  heldForFinishedOrder: `
    select count(*) from performance_seats ps join orders o on o.hold_id = ps.hold_id
     where ps.performance_id = any($1) and ps.status = 'held' and ps.hold_expires_at >= now() and o.status <> 'pending'`,
  // 1인 한도(회차당 4석)를 넘음. 팔린 좌석과 만료 전 선점 좌석을 센다.
  overLimit: `
    select count(*) from (
      select h.user_id, h.performance_id from holds h join performance_seats ps on ps.hold_id = h.id
       where h.performance_id = any($1) and (ps.status = 'sold' or (ps.status = 'held' and ps.hold_expires_at >= now()))
       group by 1, 2 having count(*) > 4) x`,
} as const;

// (d) 조용해진 뒤 0이어야 하는 것(남은 일). 측정 중에는 0이 아닐 수 있다.
export const LEFTOVERS = {
  heldSeats: `select count(*) from performance_seats where performance_id = any($1) and status = 'held'`,
  pendingOrders: `
    select count(*) from orders o join holds h on h.id = o.hold_id where h.performance_id = any($1) and o.status = 'pending'`,
  requestedPayments: `
    select count(*) from payments p join orders o on o.id = p.order_id join holds h on h.id = o.hold_id
     where h.performance_id = any($1) and p.status = 'requested'`,
  refundPendingPayments: `
    select count(*) from payments p join orders o on o.id = p.order_id join holds h on h.id = o.hold_id
     where h.performance_id = any($1) and p.status = 'refund_pending'`,
  // 커밋된 received는 처리 결과를 적지 않은 것이다(schema.ts의 payment_webhooks).
  unprocessedWebhooks: `
    select count(*) from payment_webhooks w
      join payments p on p.id = w.payment_id join orders o on o.id = p.order_id join holds h on h.id = o.hold_id
     where h.performance_id = any($1) and w.result = 'received'`,
  processingIdempotencyKeys: `
    select count(*) from idempotency_keys k
     where k.status = 'processing' and k.user_id in (select user_id from holds where performance_id = any($1))`,
} as const;

async function count(client: Queryable, text: string, performanceIds: number[]) {
  const { rows } = await client.query<{ count: number | string }>(text, [performanceIds]);
  return Number(rows[0]!.count);
}

export async function checkInvariants(client: Queryable, performanceIds: number[]) {
  const result: Record<string, number> = {};
  for (const [name, text] of Object.entries(INVARIANTS)) result[name] = await count(client, text, performanceIds);
  return result as Record<keyof typeof INVARIANTS, number>;
}

export async function checkLeftovers(client: Queryable, performanceIds: number[]) {
  const result: Record<string, number> = {};
  for (const [name, text] of Object.entries(LEFTOVERS)) result[name] = await count(client, text, performanceIds);
  return result as Record<keyof typeof LEFTOVERS, number>;
}

export async function seatCounts(client: Queryable, performanceId: number) {
  const { rows } = await client.query<{ status: string; count: number | string }>(
    "select status, count(*) from performance_seats where performance_id = $1 group by status",
    [performanceId],
  );
  const counts = { available: 0, held: 0, sold: 0 };
  for (const row of rows) counts[row.status as keyof typeof counts] = Number(row.count);
  return counts;
}

const sameSeats = (a: number[], b: number[]) => a.length === b.length && a.every((id, i) => id === b[i]);
const sortedIds = (ids: number[]) => ids.map(Number).sort((a, b) => a - b);

// (b) 클라이언트와 대조. 부하 사용자(userIds)가 그 회차에서 paid로 받은 주문과 좌석을 DB의 paid 주문과 맞춘다.
// failures는 모두 0이어야 한다.
// - clientOnly: 클라이언트는 paid로 받았는데 DB에서는 paid가 아님. dbOnly: DB는 paid인데 클라이언트는 모름.
// - seatMismatch: 같은 주문인데 좌석이 다름. seatClaimedTwice: 서로 다른 주문이 같은 좌석을 가졌다고 믿음.
// - conflictingDuplicates: 같은 주문을 두 번 받았는데 좌석이 다름(같은 좌석이면 한 번으로 센다).
// clientGaveUp은 클라이언트가 결과를 기다리다 그만둔 주문이다. 그 뒤 대사 등으로 paid가 된 것은 실패가 아니라 따로 센다.
export async function compareClientPaid(
  client: Queryable,
  {
    performanceId,
    userIds,
    clientPaid,
    clientGaveUp = [],
  }: { performanceId: number; userIds: number[]; clientPaid: { orderId: number; seatIds: number[] }[]; clientGaveUp?: number[] },
) {
  const { rows } = await client.query<{ id: number; seat_ids: number[] }>(
    `select o.id, array_agg(oi.seat_id order by oi.seat_id) as seat_ids
       from orders o join holds h on h.id = o.hold_id join order_items oi on oi.order_id = o.id
      where h.performance_id = $1 and o.status = 'paid' and o.user_id = any($2)
      group by o.id`,
    [performanceId, userIds],
  );
  const db = new Map(rows.map((r) => [Number(r.id), sortedIds(r.seat_ids)]));
  const failures = { clientOnly: 0, dbOnly: 0, seatMismatch: 0, seatClaimedTwice: 0, conflictingDuplicates: 0 };
  const orders = new Map<number, number[]>();
  for (const { orderId, seatIds } of clientPaid) {
    const seats = sortedIds(seatIds);
    const before = orders.get(orderId);
    if (before) {
      if (!sameSeats(before, seats)) failures.conflictingDuplicates++;
      continue;
    }
    orders.set(orderId, seats);
  }
  const owner = new Map<number, number>();
  for (const [orderId, seats] of orders) {
    for (const seatId of seats) {
      if (owner.has(seatId)) failures.seatClaimedTwice++;
      owner.set(seatId, orderId);
    }
    const dbSeats = db.get(orderId);
    if (!dbSeats) failures.clientOnly++;
    else if (!sameSeats(seats, dbSeats)) failures.seatMismatch++;
  }
  const gaveUp = new Set(clientGaveUp);
  let paidAfterClientGaveUp = 0;
  for (const id of db.keys()) {
    if (orders.has(id)) continue;
    if (gaveUp.has(id)) paidAfterClientGaveUp++;
    else failures.dbOnly++;
  }
  return { failures, paidAfterClientGaveUp };
}

// (e) 결제사와 DB가 맞는지. 모두 0이어야 한다. 가짜 결제사는 측정 중에 다시 뜨지 않으므로 어긋남은 버그로만 생긴다.
// - chargedWithoutTicketOrRefund: 결제사는 돈을 받았고 돌려주지 않았는데 DB는 succeeded·refund_pending이 아님(refund_failed 포함).
// - failedButNotFailedInDb: 결제사는 실패인데 DB는 failed가 아님(돈 없이 표가 나감 등).
// - refundedButNotInDb·refundedInDbNotByProvider: 환불 여부가 서로 다름.
// - unknownToDb: 결제사만 아는 결제. unknownToProvider: 그 회차의 부하 사용자 결제 중 돈이 오간 상태인데 결제사가 모름.
export async function compareProvider(
  client: Queryable,
  {
    performanceId,
    userIds,
    providerPayments,
  }: {
    performanceId: number;
    userIds: number[];
    providerPayments: { paymentId: number; outcome: "succeeded" | "failed"; refunded: boolean }[];
  },
) {
  const { rows } = await client.query<{ id: number; status: string }>("select id, status from payments where id = any($1)", [
    providerPayments.map((p) => p.paymentId),
  ]);
  const db = new Map(rows.map((r) => [Number(r.id), r.status]));
  const result = {
    chargedWithoutTicketOrRefund: 0,
    failedButNotFailedInDb: 0,
    refundedButNotInDb: 0,
    refundedInDbNotByProvider: 0,
    unknownToDb: 0,
    unknownToProvider: 0,
  };
  for (const p of providerPayments) {
    const status = db.get(p.paymentId);
    if (status === undefined) {
      result.unknownToDb++;
      continue;
    }
    if (p.outcome === "failed" && status !== "failed") result.failedButNotFailedInDb++;
    if (p.outcome === "succeeded" && !p.refunded && !["succeeded", "refund_pending"].includes(status)) {
      result.chargedWithoutTicketOrRefund++;
    }
    if (p.refunded && status !== "refunded") result.refundedButNotInDb++;
    if (status === "refunded" && !p.refunded) result.refundedInDbNotByProvider++;
  }
  const known = new Set(providerPayments.map((p) => p.paymentId));
  const moneyMoved = await client.query<{ id: number }>(
    `select p.id from payments p join orders o on o.id = p.order_id join holds h on h.id = o.hold_id
      where h.performance_id = $1 and o.user_id = any($2) and p.status in ('succeeded', 'refund_pending', 'refunded', 'refund_failed')`,
    [performanceId, userIds],
  );
  result.unknownToProvider = moneyMoved.rows.filter((r) => !known.has(Number(r.id))).length;
  return result;
}
