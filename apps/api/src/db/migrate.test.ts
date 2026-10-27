import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, describe, expect, inject, it, onTestFinished, vi } from "vitest";
import { dropDatabase, withAdminClient, withDatabase } from "./databases.js";
import { NO_TRANSACTION_MARKER, readMigrations, runMigrations } from "./migrate.js";

const repoFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
// DB를 만들고 마이그레이션하는 것은 소유자다.
const baseUrl = inject("ownerDatabaseUrl");
const folders: string[] = [];
let created = 0;

afterAll(() => {
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
});

// 테스트마다 빈 DB를 따로 만들고(마이그레이션은 DB 전체를 바꾼다), 그 테스트가 끝나면 실패해도 지운다.
async function freshDatabase() {
  const name = `seat_booking_mig_${process.pid}_${++created}`;
  await withAdminClient(baseUrl, async (client) => {
    await dropDatabase(client, name);
    await client.query(`CREATE DATABASE ${name}`);
  });
  onTestFinished(() => withAdminClient(baseUrl, (client) => dropDatabase(client, name)));
  return withDatabase(baseUrl, name);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error("기다리던 상태가 되지 않았습니다");
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

  it("DB 소유자가 아닌 role(앱)로는 돌리지 않는다", async () => {
    const url = await freshDatabase();
    const appUrl = withDatabase(inject("databaseUrl"), new URL(url).pathname.slice(1));
    await expect(runMigrations(appUrl, { folder: folderWith([table]) })).rejects.toThrow(/DB 소유자/);
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

      // 첫 시도가 1초에 멈추면 경고를 내고 쉰다. 그 경고 때 놓아 주면, 다시 한 시도가 된다.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {
        void holder.query("commit");
      });
      try {
        expect(await runMigrations(url, { folder, retryDelaysMs: [200] })).toEqual(["0001_add"]);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    } finally {
      await holder.end();
    }
  });

  it("연결이 끊기면 프로세스를 죽이지 않고 그 오류로 실패한다", { timeout: 20_000 }, async () => {
    const url = await freshDatabase();
    await runMigrations(url, { folder: folderWith([table]) });
    const folder = folderWith([table, { tag: "0001_add", when: 200, sql: "alter table t add column w int" }]);

    const holder = await connect(url);
    try {
      await holder.query("begin");
      await holder.query("select * from t");
      const run = runMigrations(url, { folder, retryDelaysMs: [10, 10, 10, 10] }).catch((e: unknown) => e);
      // 잠금을 기다리는 실행기의 연결을 끊는다. 트랜잭션 안에서는 pg_stat_activity가 처음 본 그대로라 따로 접속해 본다.
      await waitUntil(async () => {
        const rows = await query(
          url,
          `select pg_terminate_backend(pid) from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock' and query like 'alter table%'`,
        );
        return rows.length === 1;
      });
      expect(await run).toMatchObject({ code: "57P01" });
    } finally {
      await holder.end();
    }
    expect(await records(url)).toHaveLength(1);
  });

  it("트랜잭션 밖 마이그레이션은 CONCURRENTLY로 인덱스를 만든다(BOM, CRLF 파일도)", async () => {
    const url = await freshDatabase();
    const sql = `\uFEFF${indexOnV.replaceAll("\n", "\r\n")}`;
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
    expect((err as Error).message).toContain("DROP INDEX CONCURRENTLY IF EXISTS public.t_v_idx;");
    expect((err as Error & { cause: { code: string } }).cause.code).toBe("23505");
    expect(await indexState(url)).toEqual([{ valid: false }]);
    expect(await records(url)).toHaveLength(1);

    await query(url, "delete from t where id = 2");
    expect(await runMigrations(url, { folder })).toEqual(["0001_idx"]);
    expect(await indexState(url)).toEqual([{ valid: true }]);
  });

  it("CONCURRENTLY는 열린 트랜잭션이 끝나길 1초 넘게 기다리고, 그동안 같은 표의 쓰기를 막지 않는다", { timeout: 20_000 }, async () => {
    const url = await freshDatabase();
    const folder = folderWith([table, { tag: "0001_idx", when: 200, sql: indexOnV }]);
    await runMigrations(url, { folder: folderWith([table]) });

    const writer = await connect(url);
    const app = await connect(url);
    try {
      await writer.query("begin");
      await writer.query("insert into t values (1, 1)");
      let settled = false;
      // 다시 하지 않게 해, 1초 한도가 걸렸다면 아래 1.5초 뒤에 이미 끝나 있게 한다
      const run = runMigrations(url, { folder, retryDelaysMs: [] }).finally(() => {
        settled = true;
      });
      await waitUntil(async () => (await app.query("select 1 from pg_stat_progress_create_index")).rows.length === 1);
      await sleep(1_500);
      expect(settled).toBe(false);
      // 앱 쓰기는 잠금 한도 1초 안에 된다(CONCURRENTLY의 잠금은 쓰기와 부딪히지 않는다)
      await app.query("set lock_timeout = '1s'");
      await app.query("insert into t values (2, 2)");
      await writer.query("commit");
      expect(await run).toEqual(["0001_idx"]);
    } finally {
      await writer.end();
      await app.end();
    }
    expect(await indexState(url)).toEqual([{ valid: true }]);
  });

  it("남이 지금 CONCURRENTLY로 만드는 중인 인덱스는 INVALID라도 알리지 않는다", { timeout: 20_000 }, async () => {
    const url = await freshDatabase();
    await runMigrations(url, { folder: folderWith([table]) });
    const writer = await connect(url);
    const builder = await connect(url);
    try {
      await writer.query("begin");
      await writer.query("insert into t values (1, 1)");
      // 열린 쓰기 트랜잭션을 기다리는 동안 이 인덱스는 INVALID다
      const building = builder.query('CREATE INDEX CONCURRENTLY "t_other_idx" ON "t" ("v")');
      await waitUntil(async () => (await query(url, "select 1 from pg_stat_progress_create_index")).length === 1);
      const other = [NO_TRANSACTION_MARKER, "create table u (id int)"].join("\n");
      expect(await runMigrations(url, { folder: folderWith([table, { tag: "0001_u", when: 200, sql: other }]) })).toEqual([
        "0001_u",
      ]);
      await writer.query("commit");
      await building;
    } finally {
      await writer.end();
      await builder.end();
    }
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
      /0001_other: INVALID 인덱스가 남아 있습니다. DROP INDEX CONCURRENTLY IF EXISTS public.t_v_idx;$/,
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

  it("트랜잭션 밖 마이그레이션의 한 조각에 문장이 둘이면 거절한다(한 번에 보내면 트랜잭션이 된다)", () => {
    const twoInOne = [NO_TRANSACTION_MARKER, 'DROP INDEX CONCURRENTLY IF EXISTS "t_v_idx";', 'CREATE INDEX CONCURRENTLY "t_v_idx" ON "t" ("v");'];
    expect(() => readMigrations(folderWith([table, { tag: "0001_idx", when: 200, sql: twoInOne.join("\n") }]))).toThrow(
      /0001_idx: 트랜잭션 밖 마이그레이션은 조각마다 문장 하나/,
    );
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

  it("실행기 둘이 함께 돌아도 한 번씩만 적용하고, CONCURRENTLY가 있어도 서로 막히지 않는다", async () => {
    const url = await freshDatabase();
    const folder = folderWith([table, { tag: "0001_idx", when: 200, sql: indexOnV }]);
    const results = await Promise.all([runMigrations(url, { folder }), runMigrations(url, { folder })]);
    expect(results.map((r) => r.length).sort()).toEqual([0, 2]);
    expect(await records(url)).toHaveLength(2);
    expect(await indexState(url)).toEqual([{ valid: true }]);
  });
});
