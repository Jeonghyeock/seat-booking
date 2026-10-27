import type pg from "pg";
import { newSessionToken, SESSION_TTL_SECONDS } from "../auth.js";

// 부하 측정용 데이터(DESIGN 6.6 "데이터"). API가 아니라 SQL(generate_series)로 한꺼번에 넣는다.
// 공연장 하나와 그 회차들이다.
// - S1 회차 하나: 판매 전이다(실행기가 복제한 DB에서 판매 시작을 T0로 바꾼다). 짝수 번째가 아닌 좌석(1, 3, 5…번째)을
//   presoldSeats개만큼 지난 판매처럼 선점·주문·결제·표까지 갖춰 미리 판다. 산 사람은 부하 사용자가 아닌 따로 만든 사용자다.
// - S3 회차 s3Performances개: 판매 중이고 비어 있다.
// - 지난 회차 pastPerformances개: 부하 사용자의 지난 주문·결제 historicalOrders건. 끝난 상태만 넣는다
//   (requested·refund_pending·pending·만료 전 held를 넣으면 정리 작업이 측정 중에 바꾼다).
// 모든 시각은 now(템플릿을 만든 시각)에서 정한다. 세션이 7일 뒤 만료되고 판매 기간은 39일 뒤 닫힌다.

export type LoadShape = {
  sections: number;
  rowsPerSection: number;
  seatsPerRow: number;
  s3Performances: number;
  pastPerformances: number;
  users: number;
  presoldSeats: number;
  historicalOrders: number;
};

// 2,000석, 회차 1 + 99 + 100 = 200개(performance_seats 40만 행), 사용자 5,000명, 지난 주문 5만 건.
export const LOAD_SHAPE: LoadShape = {
  sections: 4,
  rowsPerSection: 20,
  seatsPerRow: 25,
  s3Performances: 99,
  pastPerformances: 100,
  users: 5000,
  presoldSeats: 1000,
  historicalOrders: 50_000,
};

// 구역 A·B·C·D가 등급 VIP·R·S·A다.
const GRADES = ["VIP", "R", "S", "A"];
const PRICES = [150_000, 120_000, 90_000, 60_000];

export type LoadData = {
  createdAt: string;
  shape: LoadShape;
  venueId: number;
  s1PerformanceId: number;
  s3PerformanceIds: number[];
  pastPerformanceIds: number[];
  // 좌석 id 순서(구역, 열, 번호 순). 좌석 지도도 이 순서다.
  seatIds: number[];
  // 부하 사용자. tokens[i]가 userIds[i]의 세션 토큰이다.
  userIds: number[];
  tokens: string[];
  buyerIds: number[];
};

// 지난 주문을 사용자와 회차에 나누는 방법. 주문 o의 사용자는 o % users, 바퀴는 o / users다.
// 한 바퀴에서 사용자는 groups개 회차에 나뉘고, 회차 안에서 사용자마다 좌석 4개 칸을 하나씩 받는다.
// 그래서 사용자와 회차의 짝이 겹치지 않고(1인 한도), 좌석도 겹치지 않는다.
export function historyLayout(shape: LoadShape) {
  const seatCount = shape.sections * shape.rowsPerSection * shape.seatsPerRow;
  const groups = Math.ceil((4 * shape.users) / seatCount);
  const rounds = Math.ceil(shape.historicalOrders / shape.users);
  if (groups * rounds > shape.pastPerformances) {
    throw new Error(`지난 주문 ${shape.historicalOrders}건에는 지난 회차가 ${groups * rounds}개 있어야 합니다`);
  }
  if (shape.presoldSeats % 4 !== 0 || shape.presoldSeats * 2 > seatCount) {
    throw new Error("미리 팔 좌석 수는 4의 배수이고 좌석의 절반 이하여야 합니다");
  }
  return { seatCount, groups };
}

const ids = (rows: { id: number }[]) => rows.map((r) => r.id);

// 한 트랜잭션에서 넣는다. tag는 이메일과 결제사 번호에 붙여 같은 DB에 여러 번 넣어도 겹치지 않게 한다(테스트).
export async function seedLoadData(
  client: pg.ClientBase,
  shape: LoadShape,
  { now, tag }: { now: Date; tag: string },
): Promise<LoadData> {
  const { seatCount, groups } = historyLayout(shape);
  const q = <R extends pg.QueryResultRow>(text: string, params: unknown[] = []) => client.query<R>(text, params);
  const at = now.toISOString();

  await q("begin");
  try {
    const venueId = (await q<{ id: number }>("insert into venues (name) values ($1) returning id", [`부하 공연장 ${tag}`]))
      .rows[0]!.id;
    await q(
      `insert into seats (venue_id, section, row_label, seat_number, grade)
       select $1, chr(65 + sec), lpad(r::text, 2, '0'), n, ($2::text[])[sec % 4 + 1]
         from generate_series(0, $3::int - 1) sec, generate_series(1, $4::int) r, generate_series(1, $5::int) n
        order by sec, r, n`,
      [venueId, GRADES, shape.sections, shape.rowsPerSection, shape.seatsPerRow],
    );
    const seatIds = ids((await q<{ id: number }>("select id from seats where venue_id = $1 order by id", [venueId])).rows);
    if (seatIds.length !== seatCount) throw new Error("좌석 수가 맞지 않습니다");

    const showId = (await q<{ id: number }>("insert into shows (title) values ($1) returning id", [`부하 측정 공연 ${tag}`]))
      .rows[0]!.id;
    const s1PerformanceId = (
      await q<{ id: number }>(
        `insert into performances (show_id, venue_id, starts_at, sales_open_at, sales_close_at)
         values ($1, $2, $3::timestamptz + interval '40 days', $3::timestamptz + interval '30 days', $3::timestamptz + interval '39 days')
         returning id`,
        [showId, venueId, at],
      )
    ).rows[0]!.id;
    const s3PerformanceIds = ids(
      (
        await q<{ id: number }>(
          `insert into performances (show_id, venue_id, starts_at, sales_open_at, sales_close_at)
           select $1, $2, $3::timestamptz + interval '41 days' + make_interval(hours => i),
                  $3::timestamptz - interval '1 day', $3::timestamptz + interval '39 days'
             from generate_series(0, $4::int - 1) i
           returning id`,
          [showId, venueId, at, shape.s3Performances],
        )
      ).rows,
    ).sort((a, b) => a - b);
    const pastPerformanceIds = ids(
      (
        await q<{ id: number }>(
          `insert into performances (show_id, venue_id, starts_at, sales_open_at, sales_close_at)
           select $1, $2, st, st - interval '30 days', st - interval '3 hours'
             from (select $3::timestamptz - make_interval(days => i + 1) st from generate_series(0, $4::int - 1) i) past
           returning id`,
          [showId, venueId, at, shape.pastPerformances],
        )
      ).rows,
    ).sort((a, b) => a - b);
    await q(
      `insert into performance_grades (performance_id, grade, price)
       select p.id, g.grade, g.price from performances p, unnest($2::text[], $3::int[]) g(grade, price) where p.venue_id = $1`,
      [venueId, GRADES, PRICES],
    );
    await q(
      `insert into performance_seats (performance_id, seat_id)
       select p.id, s.id from performances p join seats s on s.venue_id = p.venue_id where p.venue_id = $1`,
      [venueId],
    );

    const newUsers = async (kind: string, count: number) =>
      ids(
        (
          await q<{ id: number }>(
            `insert into users (email, created_at)
             select 'load-' || $1 || '-' || $2 || '-' || g || '@load.test', $3::timestamptz - interval '200 days'
               from generate_series(1, $4::int) g order by g
             returning id`,
            [tag, kind, at, count],
          )
        ).rows,
      ).sort((a, b) => a - b);
    const userIds = await newUsers("user", shape.users);
    const buyerIds = await newUsers("buyer", shape.presoldSeats / 4);
    // 세션은 로그인을 거치지 않고 넣는다(argon2와 가입 속도 제한이 첫 병목으로 잡히지 않게). 토큰과 해시는 앱의 함수로 만든다.
    const sessions = userIds.map(() => newSessionToken());
    await q(
      `insert into sessions (token_hash, user_id, created_at, expires_at)
       select h, u, $3::timestamptz, $3::timestamptz + make_interval(secs => $4::int) from unnest($1::text[], $2::bigint[]) t(h, u)`,
      [sessions.map((s) => s.tokenHash), userIds, at, SESSION_TTL_SECONDS.customer],
    );

    // 지난 주문. mix(o에 바퀴 번호를 더한 값)로 상태를 정한다. o만 쓰면 사용자 수가 10·4·20·1000으로 나누어떨어져
    // 한 사용자의 주문이 모두 같은 상태가 된다(사용자마다 10건이 7·1·2로 섞이게).
    // mix의 70%는 paid, 10%는 사용자가 취소(결제가 늦게 성공해 환불됨, 0.1%는 refund_failed), 20%는 만료로 취소(절반은 결제 실패).
    // 주문의 5%(paid인 것)는 앞서 실패한 결제가 하나 더 있다.
    await q(
      `create temp table load_plan on commit drop as
       select o, o + o / $1::int as mix, u.id as user_id, p.id as performance_id,
              p.sales_open_at + make_interval(mins => o % 997) as created_at,
              1 + (o + o / $1::int) % 4 as n, (o % $1::int) / $2::int as k,
              case when (o + o / $1::int) % 10 < 7 then 'paid' else 'cancelled' end as status,
              case when (o + o / $1::int) % 10 = 7 then 'user' when (o + o / $1::int) % 10 >= 8 then 'expired' end as cancel_reason,
              null::bigint as hold_id, null::bigint as order_id
         from generate_series(0, $3::int - 1) o
         join unnest($4::bigint[]) with ordinality u(id, ui) on u.ui - 1 = o % $1::int
         join unnest($5::bigint[]) with ordinality pp(id, pi) on pp.pi - 1 = (o / $1::int) * $2::int + (o % $1::int) % $2::int
         join performances p on p.id = pp.id`,
      [shape.users, groups, shape.historicalOrders, userIds, pastPerformanceIds],
    );
    // S1 회차의 미리 판 좌석. 산 사람 b가 1, 3, 5, 7 + 8b번째 좌석(0부터 셈)을 산다. 판매 시작 전에 산 것으로 남는다
    // (실행기가 판매 시작을 T0로 옮긴다). 앞선 실패 결제는 없다(mix 1).
    await q(
      `insert into load_plan
       select -b, 1, u.id, $2::bigint, $3::timestamptz - interval '1 day' + make_interval(secs => b::int), 4, null, 'paid', null
         from unnest($1::bigint[]) with ordinality u(id, b)`,
      [buyerIds, s1PerformanceId, at],
    );
    await q(
      `with ins as (
         insert into holds (user_id, performance_id, expires_at, created_at)
         select user_id, performance_id, created_at + interval '5 minutes', created_at from load_plan order by o
         returning id, user_id, performance_id)
       update load_plan pl set hold_id = ins.id from ins where ins.user_id = pl.user_id and ins.performance_id = pl.performance_id`,
    );
    await q(
      `create temp table load_plan_seats on commit drop as
       select pl.o, pl.performance_id, s.id as seat_id, g.price
         from load_plan pl
         cross join lateral generate_series(0, pl.n - 1) d
         join unnest($1::bigint[]) with ordinality s(id, si)
           on s.si - 1 = case when pl.k is not null then pl.k * 4 + d else (-pl.o - 1) * 8 + 2 * d + 1 end
         join seats st on st.id = s.id
         join performance_grades g on g.performance_id = pl.performance_id and g.grade = st.grade`,
      [seatIds],
    );
    // 시각은 선점 시각 c에서 정한다. 결제 확정(c+1분)에 주문이 paid가 되고 표가 생긴다. 사용자 취소는 c+2분이고 그 뒤 환불(c+3분),
    // 만료 취소는 선점 만료(c+5분) 뒤 정리 작업이 한다.
    await q(
      `with ins as (
         insert into orders (user_id, hold_id, status, amount, cancel_reason, created_at, updated_at, paid_at)
         select pl.user_id, pl.hold_id, pl.status, a.amount, pl.cancel_reason, pl.created_at,
                pl.created_at + case pl.cancel_reason when 'user' then interval '2 minutes'
                                                      when 'expired' then interval '5 minutes 5 seconds'
                                                      else interval '1 minute' end,
                -- paid는 1분 뒤에 확정됐다(updated_at과 같다). paid 주문에는 확정 시각이 있어야 한다(orders_paid_at_set).
                case when pl.status = 'paid' then pl.created_at + interval '1 minute' end
           from load_plan pl join (select o, sum(price)::int as amount from load_plan_seats group by o) a using (o)
          order by pl.o
         returning id, hold_id)
       update load_plan pl set order_id = ins.id from ins where ins.hold_id = pl.hold_id`,
    );
    await q(
      `insert into order_items (order_id, seat_id, price)
       select pl.order_id, ps.seat_id, ps.price from load_plan pl join load_plan_seats ps using (o)`,
    );
    await q(
      `update performance_seats x set status = 'sold', hold_id = pl.hold_id, hold_expires_at = pl.created_at + interval '5 minutes'
         from load_plan pl join load_plan_seats ps using (o)
        where pl.status = 'paid' and x.performance_id = ps.performance_id and x.seat_id = ps.seat_id`,
    );
    await q(
      `insert into tickets (order_id, performance_id, seat_id, created_at)
       select pl.order_id, ps.performance_id, ps.seat_id, pl.created_at + interval '1 minute'
         from load_plan pl join load_plan_seats ps using (o) where pl.status = 'paid'`,
    );
    await q(
      `insert into payments (order_id, provider_ref, status, amount, idempotency_key, refund_attempts, created_at, updated_at)
       select o.id, v.ref, v.status, o.amount, v.key, v.attempts,
              o.created_at + make_interval(secs => v.made), o.created_at + make_interval(secs => v.done)
         from load_plan pl join orders o on o.id = pl.order_id,
         lateral (values
           ('fp_load_' || $1 || '_' || pl.o, 'succeeded', 'load-' || pl.o, 0, 30, 60, pl.status = 'paid'),
           -- 앞선 실패는 성공보다 먼저 만든 것이다(주문 화면은 가장 최근 결제를 보인다).
           ('fp_load_' || $1 || '_f' || pl.o, 'failed', 'load-failed-' || pl.o, 0, 10, 20, pl.status = 'paid' and pl.mix % 20 = 0),
           ('fp_load_' || $1 || '_' || pl.o, case when pl.mix % 1000 = 7 then 'refund_failed' else 'refunded' end, 'load-' || pl.o,
            case when pl.mix % 1000 = 7 then 5 else 0 end, 30, 180, pl.cancel_reason = 'user'),
           ('fp_load_' || $1 || '_' || pl.o, 'failed', 'load-' || pl.o, 0, 30, 40, pl.cancel_reason = 'expired' and pl.mix % 10 = 8)
         ) v(ref, status, key, attempts, made, done, keep)
        where v.keep`,
      [tag],
    );
    await q("commit");
    return {
      createdAt: at,
      shape,
      venueId,
      s1PerformanceId,
      s3PerformanceIds,
      pastPerformanceIds,
      seatIds,
      userIds,
      tokens: sessions.map((s) => s.token),
      buyerIds,
    };
  } catch (err) {
    await q("rollback");
    throw err;
  }
}
