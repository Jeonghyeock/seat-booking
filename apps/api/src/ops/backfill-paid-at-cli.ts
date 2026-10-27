import { createPool } from "../db/pool.js";
import { backfillPaidAt } from "./backfill-paid-at.js";

// 마이그레이션 0010(열 더하기) 뒤, 0011(CHECK … NOT VALID)·0012(VALIDATE) 앞에 돌린다(DESIGN 6.7, docs/OPERATIONS.md).
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL이 없습니다(.env 또는 환경 변수)");

const pool = createPool({ connectionString: url, max: 1 });
try {
  const started = performance.now();
  const filled = await backfillPaidAt(pool);
  console.log(`paid_at 채움: ${filled}건(${Math.round(performance.now() - started)}ms)`);
} finally {
  await pool.end();
}
