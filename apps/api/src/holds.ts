import { type MyPerformance, SEAT_LIMIT_PER_USER } from "@seat-booking/shared";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { Db, Tx } from "./db/client.js";
import { holds, orders, performanceSeats, performances } from "./db/schema.js";

// 선점 유지 시간(DESIGN 10장 2).
export const HOLD_TTL_SECONDS = 5 * 60;

export type HoldInput = { userId: number; performanceId: number; seatIds: number[] };
// 409의 이유와, 화면이 다음 행동을 정할 값(DESIGN 6.2 "화면이 받는 것").
export type HoldFailure =
  | { code: "SALES_CLOSED"; reason: "NOT_OPEN" | "CLOSED"; salesOpenAt: Date; startsAt: Date; serverTime: Date }
  | { code: "HOLD_LIMIT"; limit: number; heldSeats: number; purchasedSeats: number }
  | { code: "PRICE_MISSING"; seatIds: number[] }
  | { code: "SEAT_UNAVAILABLE"; seatIds: number[] };
type HoldSuccess = { ok: true; holdId: number; expiresAt: Date; serverTime: Date; seatIds: number[] };
export type HoldResult = HoldSuccess | ({ ok: false } & HoldFailure);

// 트랜잭션을 되돌리려고 던지는 예외. 트랜잭션 밖에서 결과로 바꾼다.
class Rejected extends Error {
  constructor(readonly failure: HoldFailure) {
    super(failure.code);
  }
}

// 사용자가 이 회차에서 1인 한도에 세는 좌석 수. 유효한 선점 좌석과 팔린 좌석이다(DESIGN 6.1, 10장 18).
// 만료됐거나 다른 사람이 다시 선점한 좌석은 세지 않는다. 팔린 좌석은 선점(hold_id)과 만료 시각을 그대로 남기므로
// 만료 시각과 상관없이 센다. 선점 행(holds)은 만료돼도 남으므로 좌석 재고 행에서 센다.
export async function countLimitSeats(tx: Tx, userId: number, performanceId: number) {
  const { rows } = await tx.execute<{ held: number; purchased: number }>(sql`
    select count(*) filter (where ps.status = 'held' and ps.hold_expires_at >= now()) as held,
           count(*) filter (where ps.status = 'sold') as purchased
      from holds h
      join performance_seats ps on ps.hold_id = h.id
     where h.user_id = ${userId} and h.performance_id = ${performanceId}
  `);
  return { heldSeats: rows[0]!.held, purchasedSeats: rows[0]!.purchased };
}

// 트랜잭션 안에서 판매 기간·한도·가격을 확인하고 좌석을 선점한다. 실패하면 Rejected를 던져 트랜잭션을 되돌린다.
// 1. 판매 기간(sales_open_at <= now() < starts_at)이 아니면 SALES_CLOSED. 앱 서버의 시계가 아니라 DB 시계로 SQL에서 판단한다.
// 2. 한도에 세는 좌석 수와 담은 좌석 수의 합이 1인 한도를 넘으면 HOLD_LIMIT.
// 3. 담은 좌석 중 이 회차에 등급 가격이 없는 좌석이 있으면 PRICE_MISSING. 이 회차에 없는 좌석은 6에서 SEAT_UNAVAILABLE이 된다.
// 4. 선점 행을 넣는다. 만료 시각은 DB 시계로 정하고, 공연 시작을 넘지 않는다.
// 5. 한 문장에서 좌석을 좌석 id 순서로 잠그고(locked), 빈 좌석이거나 만료된 선점인 좌석만 바꾼다.
//    잠금 순서가 요청마다 같아서 여러 좌석을 잠가도 교착이 생기지 않는다.
//    다른 요청이 쥔 좌석이면 그 트랜잭션이 끝날 때까지 기다린 뒤, 바뀐 행 값으로 조건을 다시 본다.
//    다시 보는 것은 문장 스냅샷에서 조건이 맞았던 행뿐이다. 스냅샷에서 만료 전 held였다가 기다리는 사이 주문 취소로
//    빈 좌석이 된 좌석은 다시 보지 않아 SEAT_UNAVAILABLE이다. 취소보다 먼저 온 것과 같은 결과라 틀리지 않고, 다시 보내면 잡힌다.
// 6. 바뀐 좌석이 담은 수보다 적으면 SEAT_UNAVAILABLE과 바꾸지 못한 좌석. 4의 선점 행도 함께 되돌려진다.
// 1~3은 좌석을 잠그기 전에 끝나서, 거절될 요청이 좌석 잠금을 기다리지 않는다.
// 회차 시각과 등급 가격은 지금 바꾸는 경로가 없어 잠그지 않고 읽는다. 바꾸는 경로가 생기면 회차 행을 FOR SHARE로 읽어
// 판매 기간 확인과 만료 시각이 같은 값을 보게 한다.
// 2의 확인은 같은 사용자의 다른 요청과 겹치면 둘 다 통과할 수 있다. 부르는 쪽이 사용자 단위로 줄을 세워야 한다(holdSeats).
// now()는 트랜잭션을 시작한 시각이다. 잠금(advisory lock, 좌석)을 오래 기다리면 다음이 생긴다. 모두 좌석을 더 주는 쪽으로는 틀리지 않는다.
// - 그 사이 만료된 선점이 아직 유효해 보여 HOLD_LIMIT이나 SEAT_UNAVAILABLE이 날 수 있다.
// - 새 선점의 유지 시간이 그만큼 짧아진다. 공연 시작 직전이면 이미 지난 만료 시각(starts_at)의 선점을 받을 수 있다.
//   그 좌석은 곧바로 다른 사람이 잡을 수 있고, 결제 확정은 만료를 statement_timestamp()로 보므로 팔리지 않는다(DESIGN 6.2).
// - 판매가 열리는 순간이면 NOT_OPEN이 날 수 있다.
// - 응답의 serverTime도 이 시각이라 실제보다 이르다(화면이 시계 차이를 보정하는 값, DESIGN 6.2).
export async function holdWithinTx(tx: Tx, { userId, performanceId, seatIds }: HoldInput): Promise<HoldSuccess> {
  // tx.execute는 timestamptz를 문자열로 돌려주므로 쿼리 빌더로 읽는다. now()도 timestamptz 열의 변환으로 Date가 된다.
  const [performance] = await tx
    .select({
      salesOpenAt: performances.salesOpenAt,
      startsAt: performances.startsAt,
      serverTime: sql`now()`.mapWith(performances.startsAt),
      closed: sql<"NOT_OPEN" | "CLOSED" | null>`case when now() < ${performances.salesOpenAt} then 'NOT_OPEN'
                                                     when now() >= ${performances.startsAt} then 'CLOSED' end`,
    })
    .from(performances)
    .where(eq(performances.id, performanceId));
  const { closed, ...times } = performance!;
  if (closed) throw new Rejected({ code: "SALES_CLOSED", reason: closed, ...times });

  const counted = await countLimitSeats(tx, userId, performanceId);
  if (counted.heldSeats + counted.purchasedSeats + seatIds.length > SEAT_LIMIT_PER_USER) {
    throw new Rejected({ code: "HOLD_LIMIT", limit: SEAT_LIMIT_PER_USER, ...counted });
  }

  const { rows: unpriced } = await tx.execute<{ seat_id: number }>(sql`
    select ps.seat_id
      from performance_seats ps
      join seats s on s.id = ps.seat_id
      left join performance_grades g on g.performance_id = ps.performance_id and g.grade = s.grade
     where ps.performance_id = ${performanceId} and ps.seat_id = any(${sql.param(seatIds)}::bigint[])
       and g.price is null
     order by ps.seat_id
  `);
  if (unpriced.length > 0) throw new Rejected({ code: "PRICE_MISSING", seatIds: unpriced.map((r) => r.seat_id) });

  // 공연 시작은 위에서 읽은 Date를 넘기지 않고 SQL에서 다시 읽는다. Date는 마이크로초를 버려 만료가 공연 시작과 어긋난다.
  const [hold] = await tx
    .insert(holds)
    .values({
      userId,
      performanceId,
      expiresAt: sql`least(now() + make_interval(secs => ${HOLD_TTL_SECONDS}),
                           (select starts_at from performances where id = ${performanceId}))`,
    })
    .returning({ id: holds.id, expiresAt: holds.expiresAt });

  const { rows } = await tx.execute<{ seat_id: number }>(sql`
    with locked as (
      select seat_id from performance_seats
       where performance_id = ${performanceId} and seat_id = any(${sql.param(seatIds)}::bigint[])
       order by seat_id
         for update
    )
    update performance_seats ps
       set status = 'held',
           hold_id = ${hold!.id},
           hold_expires_at = (select expires_at from holds where id = ${hold!.id})
      from locked
     where ps.performance_id = ${performanceId}
       and ps.seat_id = locked.seat_id
       and (ps.status = 'available' or (ps.status = 'held' and ps.hold_expires_at < now()))
    returning ps.seat_id
  `);
  if (rows.length < seatIds.length) {
    const taken = new Set(rows.map((r) => r.seat_id));
    throw new Rejected({
      code: "SEAT_UNAVAILABLE",
      seatIds: seatIds.filter((id) => !taken.has(id)).sort((a, b) => a - b),
    });
  }

  return {
    ok: true,
    holdId: hold!.id,
    expiresAt: hold!.expiresAt,
    serverTime: times.serverTime,
    seatIds: rows.map((r) => r.seat_id).sort((a, b) => a - b),
  };
}

// 트랜잭션을 돌리고, 되돌리려고 던진 Rejected를 실패 결과로 바꾼다.
export async function toHoldResult(run: () => Promise<HoldSuccess>): Promise<HoldResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof Rejected) return { ok: false, ...err.failure };
    throw err;
  }
}

// 같은 사용자·회차의 선점과 결제 확정을 줄 세우는 트랜잭션 단위 advisory lock(DESIGN 6.1, 6.2 결제 확정 4).
// 팔린 좌석도 1인 한도에 들어가므로, 만료된 선점을 sold로 바꾸는 확정도 선점과 같은 줄에 선다.
// 해시가 겹치면 다른 사용자끼리 기다릴 뿐 결과는 틀리지 않는다.
export async function lockUserPerformance(tx: Tx, userId: number, performanceId: number) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`hold:${userId}:${performanceId}`}, 0))`);
}

// 담은 좌석을 전부 선점하거나 하나도 선점하지 않는다(DESIGN 6.1).
// 같은 사용자·회차의 요청은 트랜잭션 단위 advisory lock으로 줄을 세운다. 앞 요청이 커밋한 뒤에야 다음 요청이 좌석 수를 센다(C6).
// 이 잠금은 좌석 잠금보다 먼저 잡는다. 잠금 순서가 "사용자 → 좌석 id 순" 하나뿐이라 교착이 생기지 않는다.
export function holdSeats(db: Db, input: HoldInput): Promise<HoldResult> {
  return toHoldResult(() =>
    db.transaction(async (tx) => {
      await lockUserPerformance(tx, input.userId, input.performanceId);
      return holdWithinTx(tx, input);
    }),
  );
}

// 이 회차에서 내 유효한 선점과 한도(GET /performances/:id/me). 부르는 쪽이 한 스냅샷(repeatable read 트랜잭션)에서 부르고,
// 회차가 있는지도 먼저 확인한다.
// 유효한 선점은 "좌석이 이 선점으로 아직 held이고 만료 전"이다. 주문을 취소해도 holds.expires_at은 미래로 남으므로
// 선점 행이 아니라 좌석으로 거른다(DESIGN 6.2 "화면이 받는 것").
// 붙은 주문은 늘 pending이라 상태로 거르지 않는다. 주문을 paid·cancelled로 바꾸는 경로는 같은 트랜잭션에서 좌석을
// sold·available로 바꾸므로, 좌석이 이 선점으로 held이고 만료 전이면 주문은 아직 pending이다.
export async function myPerformance(tx: Tx, userId: number, performanceId: number): Promise<MyPerformance> {
  const counted = await countLimitSeats(tx, userId, performanceId);
  const rows = await tx
    .select({
      holdId: holds.id,
      expiresAt: holds.expiresAt,
      seatId: performanceSeats.seatId,
      orderId: orders.id,
    })
    .from(holds)
    .innerJoin(
      performanceSeats,
      and(
        eq(performanceSeats.holdId, holds.id),
        eq(performanceSeats.status, "held"),
        gte(performanceSeats.holdExpiresAt, sql`now()`),
      ),
    )
    .leftJoin(orders, eq(orders.holdId, holds.id))
    .where(and(eq(holds.userId, userId), eq(holds.performanceId, performanceId)))
    .orderBy(asc(holds.id), asc(performanceSeats.seatId));

  const byHold = new Map<number, MyPerformance["holds"][number]>();
  for (const r of rows) {
    const hold = byHold.get(r.holdId) ?? { holdId: r.holdId, expiresAt: r.expiresAt.toISOString(), seatIds: [], orderId: r.orderId };
    hold.seatIds.push(r.seatId);
    byHold.set(r.holdId, hold);
  }
  // tx.execute와 sql 조각은 timestamptz를 문자열로 돌려주므로, timestamptz 열의 변환으로 Date를 받는다.
  const [now] = await tx
    .select({ serverTime: sql`now()`.mapWith(performances.startsAt) })
    .from(performances)
    .where(eq(performances.id, performanceId));
  return {
    performanceId,
    serverTime: now!.serverTime.toISOString(),
    limit: SEAT_LIMIT_PER_USER,
    ...counted,
    remaining: Math.max(0, SEAT_LIMIT_PER_USER - counted.heldSeats - counted.purchasedSeats),
    holds: [...byHold.values()],
  };
}
