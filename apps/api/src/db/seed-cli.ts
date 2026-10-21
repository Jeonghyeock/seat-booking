import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { createPool } from "./pool.js";
import { readSeedFile, SAMPLE_SEED, seedInto } from "./seed.js";

// 개발 DB를 샘플 데이터로 다시 채운다. 공연·좌석 관련 표를 비우고 넣으므로 개발 DB에만 쓴다.
// JSON을 먼저 읽고, 비우기와 넣기를 한 트랜잭션에서 해서 실패하면 원래 데이터가 그대로 남는다.
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL이 없습니다(.env 또는 환경 변수)");

const data = readSeedFile(SAMPLE_SEED);
const pool = createPool({ connectionString: url });
try {
  const { performanceIds } = await createDb(pool).transaction(async (tx) => {
    await tx.execute(
      sql`truncate performance_seats, performance_grades, performances, shows, seats, venues restart identity cascade`,
    );
    return seedInto(tx, data);
  });
  console.log(`시드 완료: 회차 ${performanceIds.length}개`);
} finally {
  await pool.end();
}
