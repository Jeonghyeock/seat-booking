import { createDb } from "./client.js";
import { dropDatabase, withAdminClient } from "./databases.js";
import { runMigrations } from "./migrate.js";
import { createPool } from "./pool.js";
import { readSeedFile, SAMPLE_SEED, seed, shiftSeed } from "./seed.js";

// E2E 전용 DB를 새로 만든다(DESIGN 6.5 E2E, 10장 72). Playwright가 API를 띄우기 직전에 같은 환경으로 부른다.
// 소유자 주소(DATABASE_OWNER_URL)의 DB 이름이 seat_booking_e2e가 아니면 거절한다(설정이 빠져 개발 DB를 지우지 않게).
// 지우고 만들기 → 마이그레이션 → 날짜를 지금에 맞춘 샘플 시드(판매 중인 회차가 있어야 선점할 수 있다).
const E2E_DATABASE = "seat_booking_e2e";

const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error("DATABASE_OWNER_URL이 없습니다");
if (new URL(url).pathname !== `/${E2E_DATABASE}`) throw new Error(`E2E 준비는 ${E2E_DATABASE} DB에만 합니다`);

await withAdminClient(url, async (client) => {
  await dropDatabase(client, E2E_DATABASE);
  await client.query(`CREATE DATABASE ${E2E_DATABASE}`);
});
await runMigrations(url);
const pool = createPool({ connectionString: url });
try {
  const { performanceIds } = await seed(createDb(pool), shiftSeed(readSeedFile(SAMPLE_SEED), new Date()));
  console.log(`E2E DB 준비 완료: 회차 ${performanceIds.length}개`);
} finally {
  await pool.end();
}
