import { runMigrations } from "./migrate.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL이 없습니다(.env 또는 환경 변수)");

const applied = await runMigrations(url);
console.log(applied.length > 0 ? `마이그레이션 완료: ${applied.join(", ")}` : "마이그레이션 완료(남은 것 없음)");
