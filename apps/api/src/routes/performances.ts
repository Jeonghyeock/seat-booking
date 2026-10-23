import { ErrorResponse, PerformanceList, PerformanceParams, SeatMap, type SeatStatus } from "@seat-booking/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { Db } from "../db/client.js";
import { performanceGrades, performanceSeats, performances, seats, shows, venues } from "../db/schema.js";

function performanceSummaries(db: Db) {
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

// 좌석 지도. performance_seats의 기본 키 (performance_id, seat_id)를 앞쪽 열로 써서 이 회차의 재고만 읽는다.
// 가격은 좌석의 등급으로 회차별 등급 가격을 찾아 붙인다. 가격 행이 없어도 좌석이 빠지지 않게 LEFT JOIN이다(price null).
// 순서는 좌석 id(시드의 배치 순서)라 정렬 규칙(collation)에 기대지 않는다.
// 만료된 선점은 행을 풀기 전이라도 빈 좌석으로 보여 준다(정리 작업은 3단계). 만료 조건은 선점할 때와 같다.
export function seatMapQuery(db: Db, performanceId: number) {
  return db
    .select({
      seatId: seats.id,
      section: seats.section,
      row: seats.rowLabel,
      number: seats.seatNumber,
      grade: seats.grade,
      price: performanceGrades.price,
      status: sql<SeatStatus>`case when ${performanceSeats.status} = 'held' and ${performanceSeats.holdExpiresAt} < now()
                                   then 'available' else ${performanceSeats.status} end`,
    })
    .from(performanceSeats)
    .innerJoin(seats, eq(seats.id, performanceSeats.seatId))
    .leftJoin(
      performanceGrades,
      and(eq(performanceGrades.performanceId, performanceSeats.performanceId), eq(performanceGrades.grade, seats.grade)),
    )
    .where(eq(performanceSeats.performanceId, performanceId))
    .orderBy(asc(seats.id));
}

type SummaryRow = Awaited<ReturnType<typeof performanceSummaries>>[number];
const toSummary = ({ serverTime: _, ...p }: SummaryRow) => ({
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
      const { id } = request.params;
      const [performance] = await performanceSummaries(db).where(eq(performances.id, id));
      if (!performance) return reply.code(404).send({ error: "회차를 찾을 수 없습니다" });
      const seatRows = await seatMapQuery(db, id);
      return { performance: toSummary(performance), seats: seatRows, serverTime: performance.serverTime.toISOString() };
    },
  );
};
