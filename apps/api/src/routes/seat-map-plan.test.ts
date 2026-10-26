import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, describe, expect, inject, it } from "vitest";
import { createDb } from "../db/client.js";
import { createPool } from "../db/pool.js";
import { readSeedFile, SAMPLE_SEED, seed } from "../db/seed.js";
import { seatMapSql } from "./performances.js";

type PlanNode = { "Node Type": string; "Index Name"?: string; Plans?: PlanNode[] };

function indexesUsed(node: PlanNode): string[] {
  const here = node["Index Name"] ? [node["Index Name"]] : [];
  return [...here, ...(node.Plans ?? []).flatMap(indexesUsed)];
}

// 좌석 지도 조회가 performance_seats 기본 키 인덱스를 쓰는지 실행 계획으로 확인한다.
// 표가 작으면 PostgreSQL은 인덱스 대신 표 전체를 읽는 편이 싸다고 보므로, 회차를 300개로 늘려 재고가 3만 행쯤 되게 한 뒤 본다.
describe("좌석 지도 조회의 실행 계획", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  const db = createDb(pool);
  afterAll(() => pool.end());

  it("회차 하나의 재고를 (performance_id, seat_id) 기본 키 인덱스로 찾는다", async () => {
    const { venueId, performanceIds } = await seed(db, readSeedFile(SAMPLE_SEED));
    await pool.query(
      `with more as (
         insert into performances (show_id, venue_id, starts_at, sales_open_at, sales_close_at)
         select p.show_id, p.venue_id, p.starts_at + make_interval(days => g), p.sales_open_at,
                p.sales_close_at + make_interval(days => g)
           from performances p, generate_series(1, 300) g
          where p.id = $2
         returning id
       ), grades as (
         insert into performance_grades (performance_id, grade, price)
         select more.id, pg.grade, pg.price from more, performance_grades pg where pg.performance_id = $2
       )
       insert into performance_seats (performance_id, seat_id)
       select more.id, s.id from more, seats s where s.venue_id = $1`,
      [venueId, performanceIds[0]],
    );
    await pool.query("analyze performance_seats, seats, performance_grades");

    const query = new PgDialect().sqlToQuery(seatMapSql(performanceIds[0]!));
    const { rows } = await pool.query<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
      `explain (format json) ${query.sql}`,
      query.params,
    );
    expect(indexesUsed(rows[0]!["QUERY PLAN"][0].Plan)).toContain("performance_seats_performance_id_seat_id_pk");
  });
});
