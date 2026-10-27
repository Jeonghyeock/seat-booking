import pg from "pg";
import { describe, expect, inject, it, onTestFinished } from "vitest";
import { dropDatabase, withAdminClient, withDatabase } from "../db/databases.js";
import { runMigrations } from "../db/migrate.js";
import { verifyTemplateMigrations } from "./template.js";

describe("부하 템플릿의 마이그레이션 확인", () => {
  const ownerUrl = inject("ownerDatabaseUrl");

  it("마지막 마이그레이션까지 적용된 DB는 통과한다", async () => {
    await expect(verifyTemplateMigrations(ownerUrl)).resolves.toBeUndefined();
  });

  it("마지막 마이그레이션 전에 만든 템플릿이면 다시 만들라는 안내로 실패한다", async () => {
    const name = `seat_booking_tpl_${process.pid}`;
    await withAdminClient(ownerUrl, async (client) => {
      await dropDatabase(client, name);
      await client.query(`CREATE DATABASE ${name}`);
    });
    onTestFinished(() => withAdminClient(ownerUrl, (client) => dropDatabase(client, name)));
    const url = withDatabase(ownerUrl, name);
    await runMigrations(url);
    // 마지막 마이그레이션의 기록을 지워, 그 전에 만든 템플릿처럼 둔다
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(
      'delete from "drizzle"."__drizzle_migrations" where created_at = (select max(created_at) from "drizzle"."__drizzle_migrations")',
    );
    await client.end();

    await expect(verifyTemplateMigrations(url)).rejects.toThrow(/npm run load:template으로 다시 만드세요/);
  });
});
