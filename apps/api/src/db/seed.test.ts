import { afterAll, describe, expect, inject, it } from "vitest";
import { createDb } from "./client.js";
import { createPool } from "./pool.js";
import { readSeedFile, SAMPLE_SEED, seed } from "./seed.js";

// 테스트 DB는 실행 하나에서 여러 테스트 파일이 함께 쓰므로, 개수는 이 테스트가 넣은 공연장·회차로 좁혀 센다.
describe("샘플 시드", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  const db = createDb(pool);
  const data = readSeedFile(SAMPLE_SEED);
  afterAll(() => pool.end());

  it("공연장 좌석으로 회차마다 재고를 만들고, 모든 좌석의 등급에 가격이 있다", async () => {
    // 다른 공연장의 좌석이 있어야, 재고를 그 공연장 좌석에서만 뽑는지 확인할 수 있다
    const other = await pool.query<{ id: number }>("insert into venues (name) values ('다른 홀') returning id");
    await pool.query(
      "insert into seats (venue_id, section, row_label, seat_number, grade) values ($1, '1층', 'A', 1, 'VIP')",
      [other.rows[0]!.id],
    );
    const { venueId, performanceIds } = await seed(db, data);
    const seatCount = data.venue.rows.reduce((n, r) => n + r.seats, 0);

    const counts = await pool.query<{ seats: number; stock: number; available: number; unpriced: number; foreign: number }>(
      `select
         (select count(*) from seats where venue_id = $1) as seats,
         (select count(*) from performance_seats where performance_id = any($2)) as stock,
         (select count(*) from performance_seats where performance_id = any($2) and status = 'available') as available,
         (select count(*) from performance_seats ps
            join seats s on s.id = ps.seat_id
            left join performance_grades g on g.performance_id = ps.performance_id and g.grade = s.grade
           where ps.performance_id = any($2) and g.price is null) as unpriced,
         (select count(*) from performance_seats ps
            join seats s on s.id = ps.seat_id
            join performances p on p.id = ps.performance_id
           where ps.performance_id = any($2) and s.venue_id <> p.venue_id) as foreign`,
      [venueId, performanceIds],
    );
    expect(counts.rows[0]).toEqual({
      seats: seatCount,
      stock: seatCount * performanceIds.length,
      available: seatCount * performanceIds.length,
      unpriced: 0,
      foreign: 0,
    });
  });

  it("가격이 빠진 등급이 있으면 아무것도 넣지 않고 실패한다", async () => {
    const before = await pool.query<{ n: number }>("select count(*) as n from venues");
    const broken = structuredClone(data);
    delete broken.shows[0]!.performances[0]!.prices.S;
    await expect(seed(db, broken)).rejects.toThrow(/가격이 없는 등급: S/);
    const after = await pool.query<{ n: number }>("select count(*) as n from venues");
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});

describe("제약 조건", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  const db = createDb(pool);
  afterAll(() => pool.end());

  async function onePerformance() {
    const data = readSeedFile(SAMPLE_SEED);
    data.shows = [{ ...data.shows[0]!, performances: [data.shows[0]!.performances[0]!] }];
    return seed(db, data);
  }

  it("판매 상태는 available·held·sold만 된다(23514)", async () => {
    const { performanceIds } = await onePerformance();
    await expect(
      pool.query("update performance_seats set status = 'reserved' where performance_id = $1", [performanceIds[0]]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("판매 시작은 공연 시작보다 앞서야 한다(23514)", async () => {
    const { performanceIds } = await onePerformance();
    await expect(
      pool.query("update performances set sales_open_at = starts_at where id = $1", [performanceIds[0]]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("가격은 0 이상이어야 한다(23514)", async () => {
    const { performanceIds } = await onePerformance();
    await expect(
      pool.query("update performance_grades set price = -1 where performance_id = $1", [performanceIds[0]]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("같은 회차에 같은 좌석 재고를 두 번 넣을 수 없다(23505)", async () => {
    const { performanceIds } = await onePerformance();
    await expect(
      pool.query(
        "insert into performance_seats (performance_id, seat_id) select performance_id, seat_id from performance_seats where performance_id = $1 limit 1",
        [performanceIds[0]],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
