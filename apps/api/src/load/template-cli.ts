import { mkdirSync, writeFileSync } from "node:fs";
import { LOAD_SHAPE } from "./data.js";
import { buildLoadTemplate, COOKIES_FILE, cookieHeaders, LOAD_DATA_FILE, loadDataFile, RESULTS_DIR } from "./template.js";

// 부하 측정용 템플릿 DB(seat_booking_load_template)를 새로 만들고, k6가 읽을 파일을 load/results에 쓴다(DESIGN 6.6 데이터).
// 소유자 주소(DATABASE_OWNER_URL)의 서버·계정을 쓰고(DB 만들기, 마이그레이션, VACUUM, ALTER TABLE), DB 이름은 template.ts가 정한다.
const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error("DATABASE_OWNER_URL이 없습니다(.env 또는 환경 변수)");

const started = performance.now();
const data = await buildLoadTemplate(url, LOAD_SHAPE);
mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(LOAD_DATA_FILE, JSON.stringify(loadDataFile(data), null, 1));
writeFileSync(COOKIES_FILE, JSON.stringify(cookieHeaders(data.tokens)));
console.log(
  `템플릿 준비 완료(${Math.round((performance.now() - started) / 1000)}초): S1 회차 ${data.s1PerformanceId}, ` +
    `S3 회차 ${data.s3PerformanceIds.length}개, 지난 회차 ${data.pastPerformanceIds.length}개, 사용자 ${data.userIds.length}명`,
);
