import { SEAT_LIMIT_PER_USER } from "@seat-booking/shared";
import { sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { holds } from "./db/schema.js";
import type { Tx } from "./db/seed.js";

// 선점 유지 시간(DESIGN 10장 2).
export const HOLD_TTL_SECONDS = 5 * 60;

export type HoldInput = { userId: number; performanceId: number; seatIds: number[] };
export type HoldFailure = "SEAT_UNAVAILABLE" | "HOLD_LIMIT";
type HoldSuccess = { ok: true; holdId: number; expiresAt: Date; seatIds: number[] };
export type HoldResult = HoldSuccess | { ok: false; code: HoldFailure };

// 트랜잭션을 되돌리려고 던지는 예외. 트랜잭션 밖에서 결과로 바꾼다.
class Rejected extends Error {
  constructor(readonly code: HoldFailure) {
    super(code);
  }
}

// 사용자가 이 회차에 쥐고 있는 유효한 선점 좌석 수. 만료됐거나 다른 사람이 다시 선점한 좌석은 세지 않는다.
// 선점 행(holds)은 만료돼도 남으므로 좌석 재고 행에서 센다.
export async function countActiveHolds(tx: Tx, userId: number, performanceId: number) {
  const { rows } = await tx.execute<{ n: number }>(sql`
    select count(*) as n
      from holds h
      join performance_seats ps on ps.hold_id = h.id
     where h.user_id = ${userId} and h.performance_id = ${performanceId}
       and ps.status = 'held' and ps.hold_expires_at >= now()
  `);
  return rows[0]!.n;
}

// 트랜잭션 안에서 한도를 확인하고 좌석을 선점한다. 실패하면 Rejected를 던져 트랜잭션을 되돌린다.
// 1. 지금 쥔 좌석 수와 담은 좌석 수의 합이 1인 한도를 넘으면 HOLD_LIMIT.
// 2. 선점 행을 넣는다. 만료 시각은 DB 시계로 정한다.
// 3. 한 문장에서 좌석을 좌석 id 순서로 잠그고(locked), 빈 좌석이거나 만료된 선점인 좌석만 바꾼다.
//    잠금 순서가 요청마다 같아서 여러 좌석을 잠가도 교착이 생기지 않는다.
//    다른 요청이 쥔 좌석이면 그 트랜잭션이 끝날 때까지 기다린 뒤, 바뀐 행 값으로 조건을 다시 본다.
//    now()는 트랜잭션을 시작한 시각이다. 잠금을 오래 기다리는 사이 만료된 선점은 아직 유효해 보여 409가 날 수 있다(안전한 쪽으로 틀린다).
// 4. 바뀐 좌석이 담은 수보다 적으면 SEAT_UNAVAILABLE. 2의 선점 행도 함께 되돌려진다.
// 1의 확인은 같은 사용자의 다른 요청과 겹치면 둘 다 통과할 수 있다. 부르는 쪽이 사용자 단위로 줄을 세워야 한다(holdSeats).
export async function holdWithinTx(tx: Tx, { userId, performanceId, seatIds }: HoldInput): Promise<HoldSuccess> {
  const held = await countActiveHolds(tx, userId, performanceId);
  if (held + seatIds.length > SEAT_LIMIT_PER_USER) throw new Rejected("HOLD_LIMIT");

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
  if (rows.length < seatIds.length) throw new Rejected("SEAT_UNAVAILABLE");

  return {
    ok: true,
    holdId: hold!.id,
    expiresAt: hold!.expiresAt,
    seatIds: rows.map((r) => r.seat_id).sort((a, b) => a - b),
  };
}

// 트랜잭션을 돌리고, 되돌리려고 던진 Rejected를 실패 결과로 바꾼다.
export async function settle(run: () => Promise<HoldSuccess>): Promise<HoldResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof Rejected) return { ok: false, code: err.code };
    throw err;
  }
}

// 담은 좌석을 전부 선점하거나 하나도 선점하지 않는다(DESIGN 6.1).
// 같은 사용자·회차의 요청은 트랜잭션 단위 advisory lock으로 줄을 세운다. 앞 요청이 커밋한 뒤에야 다음 요청이 좌석 수를 센다(C6).
// 이 잠금은 좌석 잠금보다 먼저 잡는다. 잠금 순서가 "사용자 → 좌석 id 순" 하나뿐이라 교착이 생기지 않는다.
export function holdSeats(db: Db, input: HoldInput): Promise<HoldResult> {
  return settle(() =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`hold:${input.userId}:${input.performanceId}`}, 0))`,
      );
      return holdWithinTx(tx, input);
    }),
  );
}
