import type pg from "pg";

// C2 합격 확인의 DB 쪽(DESIGN 6.6 "합격 확인(C2)"). 회차 id 목록($1)에 한정해 센다. 모두 0이어야 한다.

type Queryable = pg.Pool | pg.ClientBase;

// (a) 언제 보아도 0이어야 하는 것. 3단계 부하 실험의 불변식 일곱 가지를 포함한다.
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
  // 취소된 주문에 성공한 결제(환불되지 않음), 표, 그 선점으로 팔린 좌석이 남음.
  cancelledOrderBroken: `
    select count(*) from orders o join holds h on h.id = o.hold_id
     where h.performance_id = any($1) and o.status = 'cancelled' and (
       exists (select 1 from payments p where p.order_id = o.id and p.status = 'succeeded')
       or exists (select 1 from tickets t where t.order_id = o.id and t.status = 'valid')
       or exists (select 1 from performance_seats ps where ps.hold_id = o.hold_id and ps.status = 'sold'))`,
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

// (b) 클라이언트와 대조. 부하 사용자(userIds)가 그 회차에서 paid로 받은 주문과 좌석을 DB의 paid 주문과 맞춘다.
// clientOnly: 클라이언트는 paid로 받았는데 DB에서는 paid가 아님. dbOnly: DB는 paid인데 클라이언트는 모름.
// seatMismatch: 같은 주문인데 좌석이 다름. seatClaimedTwice: 두 클라이언트 주문이 같은 좌석을 가졌다고 믿음.
export async function compareClientPaid(
  client: Queryable,
  { performanceId, userIds, clientPaid }: { performanceId: number; userIds: number[]; clientPaid: { orderId: number; seatIds: number[] }[] },
) {
  const { rows } = await client.query<{ id: number; seat_ids: number[] }>(
    `select o.id, array_agg(oi.seat_id order by oi.seat_id) as seat_ids
       from orders o join holds h on h.id = o.hold_id join order_items oi on oi.order_id = o.id
      where h.performance_id = $1 and o.status = 'paid' and o.user_id = any($2)
      group by o.id`,
    [performanceId, userIds],
  );
  const db = new Map(rows.map((r) => [Number(r.id), r.seat_ids.map(Number)]));
  const seen = new Set<number>();
  const result = { clientOnly: 0, dbOnly: 0, seatMismatch: 0, seatClaimedTwice: 0 };
  for (const { orderId, seatIds } of clientPaid) {
    for (const seatId of seatIds) {
      if (seen.has(seatId)) result.seatClaimedTwice++;
      seen.add(seatId);
    }
    const dbSeats = db.get(orderId);
    if (!dbSeats) {
      result.clientOnly++;
      continue;
    }
    const sorted = [...seatIds].sort((a, b) => a - b);
    if (sorted.length !== dbSeats.length || sorted.some((id, i) => id !== dbSeats[i])) result.seatMismatch++;
  }
  const clientIds = new Set(clientPaid.map((c) => c.orderId));
  for (const id of db.keys()) if (!clientIds.has(id)) result.dbOnly++;
  return result;
}

// (e) 결제사와 DB가 맞는지. 결제사가 succeeded로 아는 결제는 DB에서 succeeded나 환불 쪽이어야 하고,
// DB가 refunded면 결제사도 환불했어야 한다. 결제사가 모르는 결제(시드한 지난 결제)는 보지 않는다.
export async function compareProvider(
  client: Queryable,
  providerPayments: { paymentId: number; outcome: "succeeded" | "failed"; refunded: boolean }[],
) {
  const { rows } = await client.query<{ id: number; status: string }>("select id, status from payments where id = any($1)", [
    providerPayments.map((p) => p.paymentId),
  ]);
  const db = new Map(rows.map((r) => [Number(r.id), r.status]));
  const result = { chargedWithoutTicketOrRefund: 0, refundedButNotByProvider: 0, unknownToDb: 0 };
  for (const p of providerPayments) {
    const status = db.get(p.paymentId);
    if (status === undefined) {
      result.unknownToDb++;
      continue;
    }
    if (p.outcome === "succeeded" && !["succeeded", "refund_pending", "refunded", "refund_failed"].includes(status)) {
      result.chargedWithoutTicketOrRefund++;
    }
    if (status === "refunded" && !p.refunded) result.refundedButNotByProvider++;
  }
  return result;
}
