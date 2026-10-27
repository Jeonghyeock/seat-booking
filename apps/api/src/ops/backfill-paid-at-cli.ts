import { createPool } from "../db/pool.js";
import { backfillPaidAt } from "./backfill-paid-at.js";

// 결제 확정 때 paid_at을 쓰는 코드가 모든 서버에 나간 뒤, CHECK를 거는 마이그레이션 전에 돌린다(DESIGN 6.7, docs/OPERATIONS.md).
// 옛 코드가 도는 동안 돌리면, 이미 훑고 지나간 낮은 id의 주문이 그 뒤에 paid가 되어 빈 채로 남는다.
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL이 없습니다(.env 또는 환경 변수)");

// 묶음 하나가 잠금을 오래 기다리거나 오래 돌지 않게 앱 쓰기와 같은 한도를 건다.
const pool = createPool({ connectionString: url, max: 1, options: "-c lock_timeout=3s -c statement_timeout=5s" });
try {
  const started = performance.now();
  const filled = await backfillPaidAt(pool);
  console.log(`paid_at 채움: ${filled}건(${Math.round(performance.now() - started)}ms)`);
  // 채운 행은 대부분 HOT가 아닌 UPDATE라 표와 인덱스가 커진다(리뷰 실험: 70만 건에 149MB → 263MB).
  if (filled > 0) console.log("많이 채웠으면 소유자로 VACUUM (ANALYZE) orders를 돌립니다");
} finally {
  await pool.end();
}
