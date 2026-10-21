import { randomUUID } from "node:crypto";
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

  // 다른 테스트 파일이 같은 DB에 공연장을 넣으므로, 이 테스트만 쓰는 이름으로 센다
  const venuesNamed = async (name: string) =>
    (await pool.query<{ n: number }>("select count(*) as n from venues where name = $1", [name])).rows[0]!.n;

  it("가격이 빠진 등급이 있으면 넣기 전에 실패한다", async () => {
    const broken = structuredClone(data);
    broken.venue.name = "가격 누락 홀";
    delete broken.shows[0]!.performances[0]!.prices.S;
    await expect(seed(db, broken)).rejects.toThrow(/가격이 없는 등급: S/);
    expect(await venuesNamed("가격 누락 홀")).toBe(0);
  });

  it("넣는 도중에 실패하면 앞서 넣은 공연장·좌석까지 되돌린다", async () => {
    // 공연장과 좌석을 넣은 뒤, 회차를 넣을 때 check 제약(판매 시작 < 공연 시작)에 걸린다
    const broken = structuredClone(data);
    broken.venue.name = "롤백 홀";
    const p = broken.shows[0]!.performances[0]!;
    p.salesOpenAt = p.startsAt;
    await expect(seed(db, broken)).rejects.toMatchObject({ cause: { code: "23514" } });
    expect(await venuesNamed("롤백 홀")).toBe(0);
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

  async function newHold(performanceId: number) {
    const user = await pool.query<{ id: number }>("insert into users (email) values ($1) returning id", [
      `${randomUUID()}@test.local`,
    ]);
    const hold = await pool.query<{ id: number }>(
      "insert into holds (user_id, performance_id, expires_at) values ($1, $2, now() + interval '5 minutes') returning id",
      [user.rows[0]!.id, performanceId],
    );
    return hold.rows[0]!.id;
  }

  // check 제약이 여럿이면 PostgreSQL은 이름의 알파벳 순서로 검사한다. 어느 제약에 걸렸는지 이름까지 확인한다.
  it("판매 상태는 available·held·sold만 된다(23514)", async () => {
    const { performanceIds } = await onePerformance();
    const holdId = await newHold(performanceIds[0]!);
    await expect(
      pool.query(
        "update performance_seats set status = 'reserved', hold_id = $2, hold_expires_at = now() where performance_id = $1",
        [performanceIds[0], holdId],
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "performance_seats_status_valid" });
  });

  it("빈 좌석에만 선점이 없다(23514)", async () => {
    const { performanceIds } = await onePerformance();
    const holdId = await newHold(performanceIds[0]!);
    await expect(
      pool.query("update performance_seats set status = 'held' where performance_id = $1", [performanceIds[0]]),
    ).rejects.toMatchObject({ code: "23514", constraint: "performance_seats_hold_matches_status" });
    await expect(
      pool.query("update performance_seats set hold_id = $2, hold_expires_at = now() where performance_id = $1", [
        performanceIds[0],
        holdId,
      ]),
    ).rejects.toMatchObject({ code: "23514", constraint: "performance_seats_hold_matches_status" });
  });

  it("선점 id와 선점 만료 시각은 함께 있거나 함께 없다(23514)", async () => {
    const { performanceIds } = await onePerformance();
    const holdId = await newHold(performanceIds[0]!);
    await expect(
      pool.query("update performance_seats set status = 'held', hold_id = $2 where performance_id = $1", [
        performanceIds[0],
        holdId,
      ]),
    ).rejects.toMatchObject({ code: "23514", constraint: "performance_seats_hold_fields_together" });
  });

  it("선점한 좌석은 팔린 뒤에도 선점을 가리킨다", async () => {
    const { performanceIds } = await onePerformance();
    const holdId = await newHold(performanceIds[0]!);
    await pool.query(
      "update performance_seats set status = 'held', hold_id = $2, hold_expires_at = now() where performance_id = $1",
      [performanceIds[0], holdId],
    );
    await expect(
      pool.query("update performance_seats set status = 'sold' where performance_id = $1", [performanceIds[0]]),
    ).resolves.toMatchObject({ rowCount: 98 });
  });

  it("없는 선점이나 사용자를 가리킬 수 없다(23503)", async () => {
    const { performanceIds } = await onePerformance();
    await expect(
      pool.query(
        "update performance_seats set status = 'held', hold_id = 999999999, hold_expires_at = now() where performance_id = $1",
        [performanceIds[0]],
      ),
    ).rejects.toMatchObject({ code: "23503", constraint: "performance_seats_hold_id_holds_id_fk" });
    await expect(
      pool.query("insert into holds (user_id, performance_id, expires_at) values (999999999, $1, now())", [
        performanceIds[0],
      ]),
    ).rejects.toMatchObject({ code: "23503", constraint: "holds_user_id_users_id_fk" });
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
