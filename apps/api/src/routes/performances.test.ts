import { PerformanceList, SeatMap } from "@seat-booking/shared";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb } from "../db/client.js";
import { createPool } from "../db/pool.js";
import { readSeedFile, SAMPLE_SEED, seed } from "../db/seed.js";

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
});
