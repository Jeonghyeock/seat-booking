import { runMigrations } from "./migrate.js";

// 마이그레이션은 표의 주인(소유자 role)이 돌린다. 앱 role(DATABASE_URL)은 DDL 권한이 없다.
const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error("DATABASE_OWNER_URL이 없습니다(.env 또는 환경 변수)");

const applied = await runMigrations(url);
console.log(applied.length > 0 ? `마이그레이션 완료: ${applied.join(", ")}` : "마이그레이션 완료(남은 것 없음)");
