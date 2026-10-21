import { sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { holds } from "./db/schema.js";

// 선점 유지 시간(DESIGN 10장 2).
export const HOLD_TTL_SECONDS = 5 * 60;

export type HoldInput = { userId: number; performanceId: number; seatIds: number[] };
export type HoldResult =
  | { ok: true; holdId: number; expiresAt: Date; seatIds: number[] }
  | { ok: false; code: "SEAT_UNAVAILABLE" };

class SeatUnavailable extends Error {}

// 담은 좌석을 전부 선점하거나 하나도 선점하지 않는다(DESIGN 6.1).
// 1. 선점 행을 넣는다. 만료 시각은 DB 시계로 정한다.
// 2. 한 문장에서 좌석을 좌석 id 순서로 잠그고(locked), 빈 좌석이거나 만료된 선점인 좌석만 바꾼다.
//    잠금 순서가 요청마다 같아서 여러 좌석을 잠가도 교착이 생기지 않는다.
//    다른 요청이 쥔 좌석이면 그 트랜잭션이 끝날 때까지 기다린 뒤, 바뀐 행 값으로 조건을 다시 본다.
// 3. 바뀐 좌석이 담은 수보다 적으면 예외로 트랜잭션을 되돌린다. 1의 선점 행도 함께 사라진다.
export async function holdSeats(db: Db, { userId, performanceId, seatIds }: HoldInput): Promise<HoldResult> {
  try {
    return await db.transaction(async (tx) => {
      const [hold] = await tx
        .insert(holds)
        .values({ userId, performanceId, expiresAt: sql`now() + make_interval(secs => ${HOLD_TTL_SECONDS})` })
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
      if (rows.length < seatIds.length) throw new SeatUnavailable();

      return {
        ok: true as const,
        holdId: hold!.id,
        expiresAt: hold!.expiresAt,
        seatIds: rows.map((r) => r.seat_id).sort((a, b) => a - b),
      };
    });
  } catch (err) {
    if (err instanceof SeatUnavailable) return { ok: false, code: "SEAT_UNAVAILABLE" };
    throw err;
  }
}
