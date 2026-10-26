import { randomUUID } from "node:crypto";
import { PerformanceList, SeatMap } from "@seat-booking/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb } from "../db/client.js";
import { createPool } from "../db/pool.js";
import { performanceGrades, performanceSeats, performances, seats } from "../db/schema.js";
import { readSeedFile, SAMPLE_SEED, seed } from "../db/seed.js";
import { performanceSummaries, seatMapSql, toSummary } from "./performances.js";

describe("공연 목록과 좌석 지도 API", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  const app = buildApp(pool);
  const data = readSeedFile(SAMPLE_SEED);
  let performanceIds: number[] = [];

  beforeAll(async () => {
    ({ performanceIds } = await seed(createDb(pool), data));
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("GET /performances는 시드한 회차를 작품·공연장 이름과 ISO 시각으로 돌려준다", async () => {
    const res = await app.inject({ method: "GET", url: "/performances" });
    expect(res.statusCode).toBe(200);
    const body = PerformanceList.parse(res.json());
    const mine = body.performances.filter((p) => performanceIds.includes(p.id));
    expect(mine.map((p) => p.showTitle)).toEqual(["뮤지컬 〈샘플〉", "뮤지컬 〈샘플〉", "샘플 오케스트라 송년 음악회"]);
    // 판매 종료는 회차마다 다르다(뮤지컬은 공연 전일 17시, 음악회는 공연 3시간 전)
    expect(mine.map((p) => [p.startsAt, p.salesCloseAt])).toEqual([
      ["2026-12-19T10:30:00.000Z", "2026-12-18T08:00:00.000Z"],
      ["2026-12-20T05:00:00.000Z", "2026-12-19T08:00:00.000Z"],
      ["2026-12-31T11:00:00.000Z", "2026-12-31T08:00:00.000Z"],
    ]);
    expect(mine[0]).toMatchObject({ venueName: "샘플 아트홀" });
  });

  it("GET /performances/:id/seats는 배치 순서대로 모든 좌석과 등급 가격, 상태를 돌려준다", async () => {
    const res = await app.inject({ method: "GET", url: `/performances/${performanceIds[0]}/seats` });
    expect(res.statusCode).toBe(200);
    const body = SeatMap.parse(res.json());
    const total = data.venue.rows.reduce((n, r) => n + r.seats, 0);
    expect(body.seats).toHaveLength(total);
    expect(body.seats[0]).toMatchObject({ section: "1층", row: "A", number: 1, grade: "VIP", price: 150000, status: "available" });
    const prices = Object.fromEntries(body.seats.map((s) => [s.grade, s.price]));
    expect(prices).toEqual({ VIP: 150000, R: 120000, S: 90000 });
    expect(new Set(body.seats.map((s) => s.status))).toEqual(new Set(["available"]));
    // 화면이 판매 시작·종료까지를 셀 서버 시각
    expect(Math.abs(Date.parse(body.serverTime) - Date.now())).toBeLessThan(60_000);
  });

  it("없는 회차는 404, 10진수 양의 정수가 아닌 id는 400", async () => {
    expect((await app.inject({ method: "GET", url: "/performances/999999999/seats" })).statusCode).toBe(404);
    for (const id of ["abc", "0", "-1", "1.5", "1e3", "0x10", "007", "1.0", "%20%2012", "9007199254740993"]) {
      const res = await app.inject({ method: "GET", url: `/performances/${id}/seats` });
      expect(res.statusCode, id).toBe(400);
    }
  });

  it("회차에 어떤 등급의 가격이 없으면 그 좌석은 빠지지 않고 price null로 나온다", async () => {
    const [, second] = performanceIds;
    await pool.query("delete from performance_grades where performance_id = $1 and grade = 'S'", [second]);
    const body = SeatMap.parse((await app.inject({ method: "GET", url: `/performances/${second}/seats` })).json());
    expect(body.seats).toHaveLength(data.venue.rows.reduce((n, r) => n + r.seats, 0));
    const sSeats = body.seats.filter((s) => s.grade === "S");
    expect(sSeats.length).toBeGreaterThan(0);
    expect(new Set(sSeats.map((s) => s.price))).toEqual(new Set([null]));
  });

  it("DB가 만든 좌석 지도 JSON은 행을 받아 만들던 것과 같다(빈 좌석, 만료 전·후 선점, 팔린 좌석, 가격 없음)", async () => {
    const [, , third] = performanceIds;
    // 세션 시간대를 UTC도 정각 단위도 아닌 곳으로 둔다. 시각을 UTC로 바꾸는 것이 빠지면 서버 시간대에 따라 달라지는데,
    // CI의 postgres는 UTC라 그대로는 잡히지 않는다(리뷰 실험).
    const tzPool = createPool({ connectionString: inject("databaseUrl"), options: "-c TimeZone=Asia/Kathmandu" });
    const tzApp = buildApp(tzPool);
    const db = createDb(tzPool);
    await pool.query("delete from performance_grades where performance_id = $1 and grade = 'R'", [third]);
    // 앞 좌석 행을 새 버전으로 만들어 표에서의 물리 순서를 섞는다. 정렬이 빠지면 좌석 순서가 달라진다.
    await pool.query(
      "update seats set grade = grade where id in (select seat_id from performance_seats where performance_id = $1 order by seat_id limit 3)",
      [third],
    );
    const [user] = (await pool.query<{ id: number }>("insert into users (email) values ($1) returning id", [`${randomUUID()}@test.local`])).rows;
    const seatsOf = (
      await pool.query<{ seat_id: number }>("select seat_id from performance_seats where performance_id = $1 order by seat_id limit 3", [third])
    ).rows.map((r) => r.seat_id);
    const hold = async (expires: string) =>
      (
        await pool.query<{ id: number; expires_at: Date }>(
          `insert into holds (user_id, performance_id, expires_at) values ($1, $2, date_trunc('second', now()) + $3::interval) returning id, expires_at`,
          [user!.id, third, expires],
        )
      ).rows[0]!;
    const [live, expired, sold] = [await hold("5 minutes"), await hold("-1 minute"), await hold("-1 day")];
    const mark = (seatId: number, status: string, h: { id: number; expires_at: Date }) =>
      pool.query("update performance_seats set status = $3, hold_id = $4, hold_expires_at = $5 where performance_id = $1 and seat_id = $2", [
        third,
        seatId,
        status,
        h.id,
        h.expires_at,
      ]);
    await mark(seatsOf[0]!, "held", live);
    await mark(seatsOf[1]!, "held", expired);
    await mark(seatsOf[2]!, "sold", sold);

    // 바꾸기 전의 구현: 회차 요약과 좌석 행을 Drizzle로 받아 객체로 만든다.
    const [summary] = await performanceSummaries(db).where(eq(performances.id, third!));
    const seatRows = await db
      .select({
        seatId: seats.id,
        section: seats.section,
        row: seats.rowLabel,
        number: seats.seatNumber,
        grade: seats.grade,
        price: performanceGrades.price,
        status: sql<string>`case when ${performanceSeats.status} = 'held' and ${performanceSeats.holdExpiresAt} < now()
                                 then 'available' else ${performanceSeats.status} end`,
      })
      .from(performanceSeats)
      .innerJoin(seats, eq(seats.id, performanceSeats.seatId))
      .leftJoin(
        performanceGrades,
        and(eq(performanceGrades.performanceId, performanceSeats.performanceId), eq(performanceGrades.grade, seats.grade)),
      )
      .where(eq(performanceSeats.performanceId, third!))
      .orderBy(asc(seats.id));

    try {
      const res = await tzApp.inject({ method: "GET", url: `/performances/${third}/seats` });
      expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
      // 원본 본문을 그대로 비교한다. 예전에는 zod 직렬화기가 스키마에 없는 키를 걸렀지만 이제는 DB가 만든 글자를 그대로 보내므로,
      // 키가 하나 더 나가도 여기서 잡혀야 한다(SeatMap.parse를 먼저 하면 모르는 키가 지워져 못 잡는다).
      expect(res.json()).toEqual({
        performance: toSummary(summary!),
        seats: seatRows,
        serverTime: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      });
      const body = SeatMap.parse(res.json());
      expect(body.seats.slice(0, 3).map((s) => s.status)).toEqual(["held", "available", "sold"]);
      expect(body.seats.some((s) => s.price === null)).toBe(true);
      expect(Math.abs(Date.parse(body.serverTime) - Date.now())).toBeLessThan(60_000);
    } finally {
      await tzApp.close();
      await tzPool.end();
    }
  });

  it("선점 만료가 지금과 같은 순간이면 아직 선점이다(선점할 때와 같은 조건)", async () => {
    // 되돌리는 트랜잭션이라 다른 테스트의 회차를 써도 남는 것이 없다.
    const [first] = performanceIds;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const [user] = (await client.query<{ id: number }>("insert into users (email) values ($1) returning id", [`${randomUUID()}@test.local`])).rows;
      // now()는 트랜잭션의 시작 시각이라, 같은 트랜잭션에서 만료를 now()로 두면 지도의 now()와 같다.
      const hold = (
        await client.query<{ id: number }>("insert into holds (user_id, performance_id, expires_at) values ($1, $2, now()) returning id", [
          user!.id,
          first,
        ])
      ).rows[0]!;
      await client.query(
        `update performance_seats set status = 'held', hold_id = $2, hold_expires_at = now()
          where performance_id = $1 and seat_id = (select min(seat_id) from performance_seats where performance_id = $1)`,
        [first, hold.id],
      );
      const query = new PgDialect().sqlToQuery(seatMapSql(first!));
      const { rows } = await client.query<{ body: string }>(query.sql, query.params);
      expect(SeatMap.parse(JSON.parse(rows[0]!.body)).seats[0]!.status).toBe("held");
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("좌석은 표에 놓인 순서와 상관없이 좌석 id 순서다", async () => {
    const [first] = performanceIds;
    const client = await pool.connect();
    try {
      await client.query("begin");
      // 앞 좌석 행 셋을 새 버전으로 만들어 표의 끝으로 보내고, 인덱스를 쓰지 않게 해 표에 놓인 순서대로 읽게 한다.
      await client.query(
        `update performance_seats set status = status
          where performance_id = $1 and seat_id in (select seat_id from performance_seats where performance_id = $1 order by seat_id limit 3)`,
        [first],
      );
      await client.query("set local enable_indexscan = off; set local enable_bitmapscan = off; set local enable_indexonlyscan = off");
      const query = new PgDialect().sqlToQuery(seatMapSql(first!));
      const { rows } = await client.query<{ body: string }>(query.sql, query.params);
      const ids = SeatMap.parse(JSON.parse(rows[0]!.body)).seats.map((s) => s.seatId);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("좌석이 없는 회차는 빈 배열이다", async () => {
    const { rows } = await pool.query<{ id: number }>(
      `insert into performances (show_id, venue_id, starts_at, sales_open_at, sales_close_at)
       select show_id, venue_id, starts_at + interval '777 days', sales_open_at, sales_close_at + interval '777 days'
         from performances where id = $1
       returning id`,
      [performanceIds[0]],
    );
    const res = await app.inject({ method: "GET", url: `/performances/${rows[0]!.id}/seats` });
    expect(res.statusCode).toBe(200);
    expect(SeatMap.parse(res.json()).seats).toEqual([]);
  });
});
