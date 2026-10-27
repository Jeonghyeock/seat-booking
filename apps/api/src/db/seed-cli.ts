import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { createPool } from "./pool.js";
import { readSeedFile, SAMPLE_SEED, seedInto, shiftSeed } from "./seed.js";

// 개발 DB를 샘플 데이터로 다시 채운다. 공연·좌석 관련 표를 비우고 넣으므로 개발 DB에만 쓴다.
// JSON을 먼저 읽고, 비우기와 넣기를 한 트랜잭션에서 해서 실패하면 원래 데이터가 그대로 남는다.
// 날짜는 지금에 맞춰 옮긴다(가장 이른 판매 시작이 지난 24시간 안). 약 4주 뒤 판매가 끝나면 다시 돌린다.
// id는 처음부터 다시 세지 않는다(restart identity 없음). 켜 둔 API의 가짜 결제사 메모리와 탭에 남은 멱등 키가
// 새 주문·결제의 id와 겹치지 않게 한다(DESIGN 10장 71).
// 비우기(truncate)는 표의 주인만 할 수 있어 소유자 주소로 접속한다.
const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error("DATABASE_OWNER_URL이 없습니다(.env 또는 환경 변수)");

const data = shiftSeed(readSeedFile(SAMPLE_SEED), new Date());
const pool = createPool({ connectionString: url });
try {
  const { performanceIds } = await createDb(pool).transaction(async (tx) => {
    await tx.execute(
      sql`truncate performance_seats, performance_grades, performances, shows, seats, venues cascade`,
    );
    return seedInto(tx, data);
  });
  console.log(`시드 완료: 회차 ${performanceIds.length}개`);
} finally {
  await pool.end();
}
