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
    expect(mine[0]).toMatchObject({ venueName: "샘플 아트홀", startsAt: "2026-12-19T10:30:00.000Z" });
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
  });

  it("없는 회차는 404, 숫자가 아닌 id는 400", async () => {
    expect((await app.inject({ method: "GET", url: "/performances/999999999/seats" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/performances/abc/seats" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/performances/0/seats" })).statusCode).toBe(400);
  });
});
