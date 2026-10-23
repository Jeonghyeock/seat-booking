import pg from "pg";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../src/db/migrate.js";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
    isolatedDatabaseUrl: string;
  }
}

const TEMPLATE = "seat_booking_test_template";
// 같은 서버에서 테스트 실행 여럿이 템플릿을 동시에 지우고 만들지 않게 잡는 advisory lock 번호.
const SETUP_LOCK = 7_340_101;

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
  // 표 전체를 훑어 바꾸는 작업(정리 작업)을 시험하는 파일만 쓰는 DB. 다른 테스트 파일이 동시에 만든 행을 건드리지 않게 따로 둔다.
  const isolatedDb = `${testDb}_isolated`;
  await admin(baseUrl, async (client) => {
    // 잠근 동안 템플릿을 만들고 바로 복제하므로, 다른 실행이 끼어들어 템플릿을 지우거나 바꾸지 못한다.
    await client.query("SELECT pg_advisory_lock($1)", [SETUP_LOCK]);
    try {
      await client.query(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
      await client.query(`CREATE DATABASE ${TEMPLATE}`);
      await runMigrations(withDatabase(baseUrl, TEMPLATE));
      // 강제 종료된 실행이 같은 pid로 남긴 DB가 있으면 지우고 만든다.
      for (const db of [testDb, isolatedDb]) {
        await client.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
        await client.query(`CREATE DATABASE ${db} TEMPLATE ${TEMPLATE}`);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [SETUP_LOCK]);
    }
  });
  project.provide("databaseUrl", withDatabase(baseUrl, testDb));
  project.provide("isolatedDatabaseUrl", withDatabase(baseUrl, isolatedDb));

  return async () => {
    await admin(baseUrl, async (client) => {
      for (const db of [testDb, isolatedDb]) await client.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    });
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
