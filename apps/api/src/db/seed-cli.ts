import { createDb } from "./client.js";
import { createPool } from "./pool.js";
import { readSeedFile, SAMPLE_SEED, seed } from "./seed.js";

// 개발 DB를 샘플 데이터로 다시 채운다. 공연·좌석 관련 표를 비우고 넣으므로 개발 DB에만 쓴다.
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL이 없습니다(.env 또는 환경 변수)");

const pool = createPool({ connectionString: url });
try {
  await pool.query(
    "truncate performance_seats, performance_grades, performances, shows, seats, venues restart identity cascade",
  );
  const { performanceIds } = await seed(createDb(pool), readSeedFile(SAMPLE_SEED));
  console.log(`시드 완료: 회차 ${performanceIds.length}개`);
} finally {
  await pool.end();
}
