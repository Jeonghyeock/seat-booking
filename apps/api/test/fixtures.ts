import { randomUUID } from "node:crypto";
import type pg from "pg";
import { createDb } from "../src/db/client.js";
import { readSeedFile, SAMPLE_SEED, seed } from "../src/db/seed.js";

// 테스트 파일들이 한 DB를 함께 쓰므로, 테스트마다 자기 회차와 사용자를 새로 만든다.

// 샘플 공연장(98석)에 판매 중인 회차 하나를 만들고, 그 회차의 좌석 id를 순서대로 돌려준다.
// 샘플 시드의 날짜는 고정이라 날이 지나면 판매 전이나 공연 뒤가 되므로, 판매 시작은 하루 전, 공연은 30일 뒤로 바꾼다.
export async function newPerformance(pool: pg.Pool) {
  const data = readSeedFile(SAMPLE_SEED);
  const day = 24 * 60 * 60 * 1000;
  const performance = {
    ...data.shows[0]!.performances[0]!,
    salesOpenAt: new Date(Date.now() - day).toISOString(),
    startsAt: new Date(Date.now() + 30 * day).toISOString(),
  };
  data.shows = [{ ...data.shows[0]!, performances: [performance] }];
  const { performanceIds } = await seed(createDb(pool), data);
  const performanceId = performanceIds[0]!;
  const { rows } = await pool.query<{ seat_id: number }>(
    "select seat_id from performance_seats where performance_id = $1 order by seat_id",
    [performanceId],
  );
  return { performanceId, seatIds: rows.map((r) => r.seat_id) };
}

export async function newUsers(pool: pg.Pool, count: number) {
  const { rows } = await pool.query<{ id: number }>(
    "insert into users (email) select $1 || '-' || g || '@test.local' from generate_series(1, $2) g returning id",
    [randomUUID(), count],
  );
  return rows.map((r) => r.id);
}
