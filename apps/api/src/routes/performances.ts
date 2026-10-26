import { ErrorResponse, PerformanceList, PerformanceParams, SeatMap } from "@seat-booking/shared";
import { asc, eq, type SQL, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { Db, Tx } from "../db/client.js";
import { performances, shows, venues } from "../db/schema.js";

// 회차 요약(작품·공연장·시각)과 서버 시각. 관리자 판매 현황도 쓴다.
export function performanceSummaries(db: Db | Tx) {
  return db
    .select({
      id: performances.id,
      showTitle: shows.title,
      venueName: venues.name,
      startsAt: performances.startsAt,
      salesOpenAt: performances.salesOpenAt,
      salesCloseAt: performances.salesCloseAt,
      // 좌석 지도가 함께 주는 서버 시각. sql 조각은 timestamptz를 문자열로 돌려주므로 timestamptz 열의 변환으로 Date를 받는다.
      serverTime: sql`now()`.mapWith(performances.startsAt),
    })
    .from(performances)
    .innerJoin(shows, eq(shows.id, performances.showId))
    .innerJoin(venues, eq(venues.id, performances.venueId));
}

// 시각은 toSummary·toISOString과 같은 모양(UTC, 밀리초, Z)으로 쓴다.
const isoUtc = (value: SQL) => sql`to_char(${value} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// 좌석 지도. 응답 전체를 PostgreSQL이 JSON 글자 하나로 만든다. 모양은 SeatMap과 같다(테스트가 SeatMap으로 검증한다).
// 6단계 기준선에서 2,000석 지도 한 번에 Node가 약 4ms를 썼고, 대부분이 2,000행을 받아 객체로 바꾸고(pg 파싱·Drizzle 매핑)
// 다시 검증·직렬화하는 데 들었다. Node 한 스레드가 먼저 차서 초당 250건에서 꺾였다(DESIGN 6.6, PROGRESS 6단계).
// - performance_seats의 기본 키 (performance_id, seat_id)를 앞쪽 열로 써서 이 회차의 재고만 읽는다.
// - 가격은 좌석의 등급으로 회차별 등급 가격을 찾아 붙인다. 가격 행이 없어도 좌석이 빠지지 않게 LEFT JOIN이다(price null).
// - 순서는 좌석 id(시드의 배치 순서)라 정렬 규칙(collation)에 기대지 않는다.
// - 만료된 선점은 행을 풀기 전이라도 빈 좌석으로 보여 준다. 만료 조건은 선점할 때와 같다.
// - 회차 요약과 좌석이 한 문장이라 serverTime과 상태가 같은 시각을 본다.
export function seatMapSql(performanceId: number) {
  return sql`
    select json_build_object(
             'performance', (select row_to_json(x) from (
                select p.id, sh.title as "showTitle", v.name as "venueName",
                       ${isoUtc(sql`p.starts_at`)} as "startsAt",
                       ${isoUtc(sql`p.sales_open_at`)} as "salesOpenAt",
                       ${isoUtc(sql`p.sales_close_at`)} as "salesCloseAt") x),
             'seats', coalesce((
                select json_agg(x order by x."seatId") from (
                  select s.id as "seatId", s.section, s.row_label as "row", s.seat_number as "number", s.grade, g.price,
                         case when ps.status = 'held' and ps.hold_expires_at < now() then 'available' else ps.status end as status
                    from performance_seats ps
                    join seats s on s.id = ps.seat_id
                    left join performance_grades g on g.performance_id = ps.performance_id and g.grade = s.grade
                   where ps.performance_id = p.id) x), '[]'),
             'serverTime', ${isoUtc(sql`now()`)})::text as body
      from performances p
      join shows sh on sh.id = p.show_id
      join venues v on v.id = p.venue_id
     where p.id = ${performanceId}`;
}

// 회차가 없으면 null.
export async function seatMapJson(db: Db, performanceId: number): Promise<string | null> {
  const { rows } = await db.execute<{ body: string }>(seatMapSql(performanceId));
  return rows[0]?.body ?? null;
}

type SummaryRow = Awaited<ReturnType<typeof performanceSummaries>>[number];
export const toSummary = ({ serverTime: _, ...p }: SummaryRow) => ({
  ...p,
  startsAt: p.startsAt.toISOString(),
  salesOpenAt: p.salesOpenAt.toISOString(),
  salesCloseAt: p.salesCloseAt.toISOString(),
});

export const performanceRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get("/performances", { schema: { response: { 200: PerformanceList } } }, async () => {
    const rows = await performanceSummaries(db).orderBy(asc(performances.startsAt), asc(performances.id));
    return { performances: rows.map(toSummary) };
  });

  app.get(
    "/performances/:id/seats",
    { schema: { params: PerformanceParams, response: { 200: SeatMap, 404: ErrorResponse } } },
    async (request, reply) => {
      const body = await seatMapJson(db, request.params.id);
      if (body === null) return reply.code(404).send({ error: "회차를 찾을 수 없습니다" });
      // 이미 JSON 글자라 그대로 보낸다. Content-Type을 정한 문자열은 Fastify가 직렬화(zod 검증·JSON.stringify)하지 않는다.
      // 응답 스키마(SeatMap)는 계약으로 남기고, 모양은 테스트가 SeatMap으로 검증한다.
      return reply.type("application/json; charset=utf-8").send(body as unknown as SeatMap);
    },
  );
};
