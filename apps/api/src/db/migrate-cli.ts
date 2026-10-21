import { runMigrations } from "./migrate.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL이 없습니다(.env 또는 환경 변수)");

await runMigrations(url);
console.log("마이그레이션 완료");
