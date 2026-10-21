import { createPool } from "./pool.js";
import { afterAll, describe, expect, inject, it } from "vitest";

describe("첫 마이그레이션", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  afterAll(() => pool.end());

  it("venues·seats 테이블을 만든다", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name in ('venues', 'seats')`,
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual(["seats", "venues"]);
  });

  it("같은 공연장의 같은 자리를 두 번 넣으면 unique 위반(23505)", async () => {
    const venue = await pool.query<{ id: string }>(
      "insert into venues (name) values ('테스트 홀') returning id",
    );
    const insertSeat = () =>
      pool.query(
        `insert into seats (venue_id, section, row_label, seat_number, grade)
         values ($1, 'A', '1', 1, 'R')`,
        [venue.rows[0]!.id],
      );
    await insertSeat();
    await expect(insertSeat()).rejects.toMatchObject({ code: "23505" });
  });
});
