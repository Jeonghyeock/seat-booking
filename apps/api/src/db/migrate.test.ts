import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";
import { dropDatabase, withAdminClient, withDatabase } from "./databases.js";
import { NO_TRANSACTION_MARKER, readMigrations, runMigrations } from "./migrate.js";

const repoFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const baseUrl = inject("databaseUrl");
const databases: string[] = [];
const folders: string[] = [];

afterAll(async () => {
  await withAdminClient(baseUrl, async (client) => {
    for (const db of databases) await dropDatabase(client, db);
  });
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
});

// 테스트마다 빈 DB를 따로 만든다(마이그레이션은 DB 전체를 바꾼다).
async function freshDatabase() {
  const name = `seat_booking_mig_${process.pid}_${databases.length + 1}`;
  await withAdminClient(baseUrl, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${name}`);
  });
  databases.push(name);
  return withDatabase(baseUrl, name);
}

type File = { tag: string; when: number; sql: string };
// drizzle-kit이 만드는 모양의 마이그레이션 폴더.
function folderWith(files: File[]) {
  const dir = mkdtempSync(join(tmpdir(), "seat-booking-mig-"));
  folders.push(dir);
  mkdirSync(join(dir, "meta"));
  const entries = files.map((f, idx) => ({ idx, version: "7", when: f.when, tag: f.tag, breakpoints: true }));
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries }));
  for (const f of files) writeFileSync(join(dir, `${f.tag}.sql`), f.sql);
  return dir;
}

async function connect(url: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

async function query<T extends pg.QueryResultRow>(url: string, text: string) {
  const client = await connect(url);
  try {
    return (await client.query<T>(text)).rows;
  } finally {
    await client.end();
  }
}

const records = (url: string) =>
  query<{ hash: string; created_at: string }>(url, 'select hash, created_at from "drizzle"."__drizzle_migrations" order by id');

const fast = { retryDelaysMs: [10, 10] };
const table = { tag: "0000_t", when: 100, sql: "create table t (id int primary key, v int)" };
const indexOnV = [
  NO_TRANSACTION_MARKER,
  'DROP INDEX CONCURRENTLY IF EXISTS "t_v_idx";',
  "--> statement-breakpoint",
  'CREATE UNIQUE INDEX CONCURRENTLY "t_v_idx" ON "t" ("v");',
].join("\n");
const indexState = (url: string) =>
  query<{ valid: boolean }>(url, "select indisvalid as valid from pg_index where indexrelid = 't_v_idx'::regclass");

describe("마이그레이션 실행기", () => {
  it("저장소의 마이그레이션을 모두 적용해 drizzle과 같은 기록을 남기고, 다시 돌리면 아무것도 하지 않는다", async () => {
    const url = await freshDatabase();
    const migrations = readMigrations(repoFolder);
    expect(await runMigrations(url)).toEqual(migrations.map((m) => m.tag));
    expect(await records(url)).toEqual(migrations.map((m) => ({ hash: m.hash, created_at: String(m.when) })));
    expect(await runMigrations(url)).toEqual([]);
  });

  it("drizzle로 앞부분을 적용한 DB를 이어받는다", async () => {
    const journal = JSON.parse(readFileSync(join(repoFolder, "meta", "_journal.json"), "utf8")) as {
      entries: { tag: string }[];
    };
    const dir = mkdtempSync(join(tmpdir(), "seat-booking-mig-"));
    folders.push(dir);
    mkdirSync(join(dir, "meta"));
    const head = journal.entries.slice(0, 5);
    writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: head }));
    for (const e of head) copyFileSync(join(repoFolder, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));

    const url = await freshDatabase();
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    await migrate(drizzle({ client: pool }), { migrationsFolder: dir });
    await pool.end();

    const all = readMigrations(repoFolder);
    expect(await runMigrations(url)).toEqual(all.slice(5).map((m) => m.tag));
    expect(await records(url)).toEqual(all.map((m) => ({ hash: m.hash, created_at: String(m.when) })));
  });

  it("마이그레이션마다 따로 커밋해, 실패한 것만 되돌리고 멈춘다", async () => {
    const url = await freshDatabase();
    const broken = { tag: "0001_u", when: 200, sql: "create table u (id int);\n--> statement-breakpoint\nselect 1 / 0;" };
    await expect(runMigrations(url, { folder: folderWith([table, broken]) })).rejects.toMatchObject({ code: "22012" });
    expect(await query(url, "select to_regclass('t') is not null as t, to_regclass('u') is not null as u")).toEqual([
      { t: true, u: false },
    ]);
    expect(await records(url)).toHaveLength(1);

    const fixed = { ...broken, sql: "create table u (id int)" };
    expect(await runMigrations(url, { folder: folderWith([table, fixed]) })).toEqual(["0001_u"]);
  });

  it("다른 연결이 표를 쥐고 있으면 1초씩만 기다리며 다시 하다 실패하고, 놓아 주면 다시 해서 된다", { timeout: 20_000 }, async () => {
    const url = await freshDatabase();
    await runMigrations(url, { folder: folderWith([table]) });
    const folder = folderWith([table, { tag: "0001_add", when: 200, sql: "alter table t add column w int" }]);

    const holder = await connect(url);
    try {
      await holder.query("begin");
      await holder.query("select * from t");
      const started = Date.now();
      await expect(runMigrations(url, { folder, ...fast })).rejects.toMatchObject({ code: "55P03" });
      // 세 번 시도하고 각각 1초(lock_timeout)에 멈춘다
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
      expect(Date.now() - started).toBeLessThan(6_000);
      expect(await records(url)).toHaveLength(1);

      // 첫 시도가 1초에 멈춘 뒤, 쉬는 동안 놓아 준다
      const run = runMigrations(url, { folder, retryDelaysMs: [1_500] });
      await new Promise((r) => setTimeout(r, 1_300));
      await holder.query("commit");
      expect(await run).toEqual(["0001_add"]);
    } finally {
      await holder.end();
    }
  });

  it("트랜잭션 밖 마이그레이션은 CONCURRENTLY로 인덱스를 만든다(BOM, CRLF 파일도)", async () => {
    const url = await freshDatabase();
    const sql = `﻿${indexOnV.replaceAll("\n", "\r\n")}`;
    expect(await runMigrations(url, { folder: folderWith([table, { tag: "0001_idx", when: 200, sql }]) })).toEqual([
      "0000_t",
      "0001_idx",
    ]);
    expect(await indexState(url)).toEqual([{ valid: true }]);
  });

  it("CONCURRENTLY가 실패해 INVALID 인덱스가 남으면 지울 문장을 내고 기록하지 않으며, 고친 뒤 다시 하면 된다", async () => {
    const url = await freshDatabase();
    const folder = folderWith([table, { tag: "0001_idx", when: 200, sql: indexOnV }]);
    await runMigrations(url, { folder: folderWith([table]) });
    await query(url, "insert into t values (1, 7), (2, 7)");

    const err = await runMigrations(url, { folder }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('DROP INDEX CONCURRENTLY IF EXISTS "t_v_idx";');
    expect((err as Error & { cause: { code: string } }).cause.code).toBe("23505");
    expect(await indexState(url)).toEqual([{ valid: false }]);
    expect(await records(url)).toHaveLength(1);

    await query(url, "delete from t where id = 2");
    expect(await runMigrations(url, { folder })).toEqual(["0001_idx"]);
    expect(await indexState(url)).toEqual([{ valid: true }]);
  });

  it("트랜잭션 밖 CONCURRENTLY도 열린 쓰기 트랜잭션을 1초만 기다린다", { timeout: 20_000 }, async () => {
    const url = await freshDatabase();
    const folder = folderWith([table, { tag: "0001_idx", when: 200, sql: indexOnV }]);
    await runMigrations(url, { folder: folderWith([table]) });

    const writer = await connect(url);
    try {
      await writer.query("begin");
      await writer.query("insert into t values (1, 1)");
      const err = await runMigrations(url, { folder, ...fast }).catch((e: Error) => e);
      expect((err as Error).message).toContain("INVALID 인덱스");
      expect((err as Error & { cause: { code: string } }).cause.code).toBe("55P03");
      await writer.query("commit");
    } finally {
      await writer.end();
    }
    expect(await runMigrations(url, { folder })).toEqual(["0001_idx"]);
    expect(await indexState(url)).toEqual([{ valid: true }]);
  });

  it("트랜잭션 밖 마이그레이션이 끝났어도 다른 INVALID 인덱스가 있으면 기록하지 않고 알린다", async () => {
    const url = await freshDatabase();
    await runMigrations(url, { folder: folderWith([table]) });
    // 손으로 돌리다 실패한 CONCURRENTLY가 남긴 인덱스
    await query(url, "insert into t values (1, 7), (2, 7)");
    await expect(query(url, 'CREATE UNIQUE INDEX CONCURRENTLY "t_v_idx" ON "t" ("v")')).rejects.toMatchObject({ code: "23505" });

    const other = [
      NO_TRANSACTION_MARKER,
      'DROP INDEX CONCURRENTLY IF EXISTS "t_id_idx";',
      "--> statement-breakpoint",
      'CREATE INDEX CONCURRENTLY "t_id_idx" ON "t" ("id");',
    ].join("\n");
    const folder = folderWith([table, { tag: "0001_other", when: 200, sql: other }]);
    await expect(runMigrations(url, { folder })).rejects.toThrow(
      /0001_other: INVALID 인덱스가 남아 있습니다. DROP INDEX CONCURRENTLY IF EXISTS "t_v_idx";$/,
    );
    expect(await records(url)).toHaveLength(1);
  });

  it("표시 없이 CONCURRENTLY가 있으면 DB에 손대기 전에 거절한다(주석은 상관없다)", async () => {
    const url = await freshDatabase();
    const commented = { ...table, sql: `-- 여기서는 CONCURRENTLY를 쓰지 않는다\n${table.sql}` };
    const unmarked = { tag: "0001_idx", when: 200, sql: 'CREATE INDEX CONCURRENTLY "t_v_idx" ON "t" ("v");' };
    await expect(runMigrations(url, { folder: folderWith([commented, unmarked]) })).rejects.toThrow(/0001_idx: CONCURRENTLY/);
    expect(await query(url, "select to_regclass('t') is null as no_table, to_regnamespace('drizzle') is null as no_schema")).toEqual([
      { no_table: true, no_schema: true },
    ]);
    expect(await runMigrations(url, { folder: folderWith([commented]) })).toEqual(["0000_t"]);
  });

  it("journal의 when이 늘어나지 않으면 거절한다", () => {
    expect(() => readMigrations(folderWith([table, { tag: "0001_u", when: 100, sql: "select 1" }]))).toThrow(/when이 늘어나지/);
  });

  it("마지막 기록보다 앞인데 적용되지 않은 마이그레이션이 있으면 건너뛰지 않고 실패한다", async () => {
    const url = await freshDatabase();
    const later = { tag: "0002_w", when: 300, sql: "create table w (id int)" };
    await runMigrations(url, { folder: folderWith([table, later]) });
    const merged = folderWith([table, { tag: "0001_u", when: 200, sql: "create table u (id int)" }, later]);
    await expect(runMigrations(url, { folder: merged })).rejects.toThrow(/적용되지 않은 마이그레이션이 있습니다: 0001_u/);
    expect(await query(url, "select to_regclass('u') is null as no_u")).toEqual([{ no_u: true }]);
  });

  it("실행기 둘이 함께 돌아도 마이그레이션마다 한 번씩만 적용한다", async () => {
    const url = await freshDatabase();
    const tags = readMigrations(repoFolder).map((m) => m.tag);
    const results = await Promise.all([runMigrations(url), runMigrations(url)]);
    expect(results.map((r) => r.length).sort()).toEqual([0, tags.length]);
    expect(await records(url)).toHaveLength(tags.length);
  });
});
