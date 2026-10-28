import type { TestProject } from "vitest/node";
import { dropDatabase, withAdminClient, withDatabase } from "../src/db/databases.js";
import { runMigrations } from "../src/db/migrate.js";

// 테스트는 앱 role(DML만)로 돈다. DB 만들기와 마이그레이션, 소유자만 되는 일(ANALYZE, 권한 확인)은 소유자 주소로 한다(DESIGN 6.7).
declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
    isolatedDatabaseUrl: string;
    relayDatabaseUrl: string;
    ownerDatabaseUrl: string;
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
  const appUrl = process.env.DATABASE_URL;
  const baseUrl = process.env.DATABASE_OWNER_URL;
  if (!appUrl || !baseUrl) throw new Error("DATABASE_URL과 DATABASE_OWNER_URL이 없습니다(.env 또는 환경 변수)");

  const testDb = `seat_booking_test_${process.pid}`;
  // 표 전체를 훑어 바꾸는 작업(정리 작업)을 시험하는 파일만 쓰는 DB. 다른 테스트 파일이 동시에 만든 행을 건드리지 않게 따로 둔다.
  const isolatedDb = `${testDb}_isolated`;
  // outbox 릴레이 테스트만 쓰는 DB. 다른 테스트 파일이 만든 outbox 행을 보내지 않게 따로 둔다(DESIGN 6.8).
  const relayDb = `${testDb}_relay`;
  await withAdminClient(baseUrl, async (client) => {
    // 잠근 동안 템플릿을 만들고 바로 복제하므로, 다른 실행이 끼어들어 템플릿을 지우거나 바꾸지 못한다.
    await client.query("SELECT pg_advisory_lock($1)", [SETUP_LOCK]);
    try {
      await client.query(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
      await client.query(`CREATE DATABASE ${TEMPLATE}`);
      await runMigrations(withDatabase(baseUrl, TEMPLATE));
      // 강제 종료된 실행이 같은 pid로 남긴 DB가 있으면 지우고 만든다.
      for (const db of [testDb, isolatedDb, relayDb]) {
        await client.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
        await client.query(`CREATE DATABASE ${db} TEMPLATE ${TEMPLATE}`);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [SETUP_LOCK]);
    }
  });
  project.provide("databaseUrl", withDatabase(appUrl, testDb));
  project.provide("isolatedDatabaseUrl", withDatabase(appUrl, isolatedDb));
  project.provide("relayDatabaseUrl", withDatabase(appUrl, relayDb));
  project.provide("ownerDatabaseUrl", withDatabase(baseUrl, testDb));

  return async () => {
    await withAdminClient(baseUrl, async (client) => {
      for (const db of [testDb, isolatedDb, relayDb]) await dropDatabase(client, db);
    });
  };
}
