import pg from "pg";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../src/db/migrate.js";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const TEMPLATE = "seat_booking_test_template";

// 실행마다 템플릿 DB를 새로 마이그레이션하고, 그것을 복제한 DB에서 테스트한다.
// 복제는 마이그레이션을 다시 돌리는 것보다 빨라서, 2단계부터 테스트 파일마다 DB를 따로 줄 때 쓴다.
export default async function setup(project: TestProject) {
  try {
    process.loadEnvFile(new URL("../../../.env", import.meta.url));
  } catch {
    // CI는 환경 변수로 준다.
  }
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error("DATABASE_URL이 없습니다(.env 또는 환경 변수)");

  const testDb = `seat_booking_test_${process.pid}`;
  await admin(baseUrl, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${TEMPLATE}`);
    await runMigrations(withDatabase(baseUrl, TEMPLATE));
    await client.query(`CREATE DATABASE ${testDb} TEMPLATE ${TEMPLATE}`);
  });
  project.provide("databaseUrl", withDatabase(baseUrl, testDb));

  return async () => {
    await admin(baseUrl, (client) => client.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE)`));
  };
}

async function admin(baseUrl: string, work: (client: pg.Client) => Promise<unknown>) {
  const client = new pg.Client({ connectionString: withDatabase(baseUrl, "postgres") });
  await client.connect();
  try {
    await work(client);
  } finally {
    await client.end();
  }
}

function withDatabase(url: string, database: string) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
