import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

// drizzle-kit이 만든 마이그레이션 파일과 journal, 적용 기록 표는 drizzle과 같게 쓰고, 돌리는 방식만 바꾼다(DESIGN 6.7).
// drizzle의 migrator는 남은 것 전부를 한 트랜잭션에서 돌려 CONCURRENTLY를 쓸 수 없고, 하나가 실패하면 앞의 것까지 되돌아간다.

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

// 파일 첫 줄이 이것이면 트랜잭션 없이 문장을 하나씩 보낸다(CREATE INDEX CONCURRENTLY 등).
export const NO_TRANSACTION_MARKER = "-- 트랜잭션 밖";
const BREAKPOINT = "--> statement-breakpoint";
// 실행기 둘이 같은 DB에 끼어들지 않게 잡는 세션 advisory lock 번호(테스트 준비의 7_340_101과 다르다).
const MIGRATION_LOCK = 7_340_102;
// 앱 쓰기의 잠금 대기 한도(3초)보다 짧아야, 마이그레이션 뒤에 줄 선 앱 쓰기가 자기 한도에 닿지 않는다.
const LOCK_TIMEOUT = "1s";
// 잠금 대기 초과와 교착이면 잠깐 쉬고 다시 한다. 다시 할 때마다 잠금 줄이 다시 생기므로 쉬는 시간을 늘린다.
const RETRY_CODES = new Set(["55P03", "40P01"]);
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000];

export type Migration = { tag: string; when: number; hash: string; statements: string[]; noTransaction: boolean };

export function readMigrations(folder = migrationsFolder): Migration[] {
  const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  const migrations = journal.entries.map(({ tag, when }) => {
    // hash는 drizzle처럼 파일 전체의 sha256이다. 줄바꿈(체크아웃마다 다르다)에 따라 달라지므로 기록만 하고 판단에 쓰지 않는다.
    const text = readFileSync(`${folder}/${tag}.sql`).toString();
    // BOM은 PostgreSQL이 구문 오류로 받는다(편집기가 붙일 수 있다).
    const body = text.replace(/^﻿/, "");
    return {
      tag,
      when,
      hash: createHash("sha256").update(text).digest("hex"),
      statements: body.split(BREAKPOINT),
      noTransaction: body.split("\n", 1)[0]!.trim() === NO_TRANSACTION_MARKER,
    };
  });
  migrations.forEach((m, i) => {
    if (i > 0 && m.when <= migrations[i - 1]!.when) {
      throw new Error(`journal의 when이 늘어나지 않습니다: ${migrations[i - 1]!.tag} 다음의 ${m.tag}`);
    }
    // 트랜잭션 안의 CONCURRENTLY는 PostgreSQL이 25001로 거부한다. 앞 마이그레이션이 커밋된 뒤에 멈추지 않게 미리 본다.
    const code = m.statements.map((s) => s.replace(/--.*$/gm, "")).join("\n");
    if (!m.noTransaction && /\bconcurrently\b/i.test(code)) {
      throw new Error(`${m.tag}: CONCURRENTLY가 있으면 첫 줄에 "${NO_TRANSACTION_MARKER}"를 둡니다`);
    }
  });
  return migrations;
}

export async function runMigrations(connectionString: string, { folder = migrationsFolder, retryDelaysMs = RETRY_DELAYS_MS } = {}) {
  const migrations = readMigrations(folder);
  // 세션 설정과 advisory lock이 연결에 붙어 있어 풀이 아니라 연결 하나로 한다.
  // 끝에 닫고 돌아온다(템플릿 DB에 연결이 남으면 바로 뒤의 복제가 실패한다).
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await checkOwner(client);
    // 다른 실행기가 끝나길 기다린다. lock_timeout을 걸기 전에 잡아야 그 한도에 걸리지 않는다.
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    // 세션에 걸어야 트랜잭션 밖 문장(CONCURRENTLY가 기다리는 단계)에도 걸린다. 트랜잭션 밖의 SET LOCAL은 걸리지 않는다.
    await client.query(`set lock_timeout = '${LOCK_TIMEOUT}'`);
    await client.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
    await client.query(
      'CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)',
    );
    const applied: string[] = [];
    for (const m of await pendingMigrations(client, migrations)) {
      try {
        await withRetry(m, retryDelaysMs, () => (m.noTransaction ? applyWithoutTransaction(client, m) : applyInTransaction(client, m)));
      } catch (err) {
        const invalid = m.noTransaction ? await invalidIndexes(client) : [];
        if (invalid.length === 0) throw err;
        throw new Error(`${m.tag}: INVALID 인덱스가 남아 있습니다. ${dropStatements(invalid)}`, { cause: err });
      }
      applied.push(m.tag);
    }
    return applied;
  } finally {
    await client.end();
  }
}

// 슈퍼유저가 돌리면 표와 기본 권한(ALTER DEFAULT PRIVILEGES)의 주인이 슈퍼유저가 되어, 소유자가 뒤에 만든 표에 앱 권한이 붙지 않는다.
async function checkOwner(client: pg.Client) {
  const { rows } = await client.query<{ owner: boolean; superuser: boolean }>(
    `select current_user = pg_get_userbyid(d.datdba) as owner, r.rolsuper as superuser
       from pg_database d, pg_roles r
      where d.datname = current_database() and r.rolname = current_user`,
  );
  if (!rows[0]?.owner || rows[0].superuser) {
    throw new Error("마이그레이션은 DB 소유자(슈퍼유저가 아닌 role)로 돌립니다");
  }
}

// drizzle처럼 가장 큰 created_at(= journal의 when)보다 큰 것을 남은 것으로 본다.
// 그 규칙은 마지막 한 행만 보므로, 그보다 작은 when이 기록 없이 있으면(브랜치를 합치다 생김) 조용히 건너뛰지 않고 실패한다.
async function pendingMigrations(client: pg.Client, migrations: Migration[]) {
  const { rows } = await client.query<{ created_at: string | number }>('select created_at from "drizzle"."__drizzle_migrations"');
  const recorded = new Set(rows.map((r) => Number(r.created_at)));
  const last = Math.max(-1, ...recorded);
  const skipped = migrations.filter((m) => m.when <= last && !recorded.has(m.when));
  if (skipped.length > 0) {
    throw new Error(`마지막 기록보다 앞인데 적용되지 않은 마이그레이션이 있습니다: ${skipped.map((m) => m.tag).join(", ")}`);
  }
  return migrations.filter((m) => m.when > last);
}

async function withRetry(m: Migration, delaysMs: number[], work: () => Promise<void>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (!code || !RETRY_CODES.has(code) || attempt >= delaysMs.length) throw err;
      console.warn(`${m.tag}: 잠금을 얻지 못했습니다(${code}). ${delaysMs[attempt]}ms 뒤 다시 합니다(${attempt + 1}/${delaysMs.length})`);
      await new Promise((r) => setTimeout(r, delaysMs[attempt]));
    }
  }
}

const recordApplied = (client: pg.Client, m: Migration) =>
  client.query('insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values ($1, $2)', [m.hash, m.when]);

async function applyInTransaction(client: pg.Client, m: Migration) {
  await client.query("begin");
  try {
    for (const statement of m.statements) await client.query(statement);
    await recordApplied(client, m);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

// 문장마다 따로 커밋된다. 중간에 실패하면 기록이 남지 않아 다음에 파일 처음부터 다시 도므로, 문장은 다시 해도 같은 결과여야 한다.
// 실패한 CONCURRENTLY는 INVALID 인덱스를 남긴다. 계획에는 쓰이지 않으면서 쓰기마다 유지될 수 있어, 남아 있으면 기록하지 않고 실패한다.
async function applyWithoutTransaction(client: pg.Client, m: Migration) {
  for (const statement of m.statements) await client.query(statement);
  if ((await invalidIndexes(client)).length > 0) throw new Error("문장은 끝났지만 기록하기 전에 INVALID 인덱스를 찾았습니다");
  await recordApplied(client, m);
}

async function invalidIndexes(client: pg.Client) {
  const { rows } = await client.query<{ name: string }>(
    `select c.relname as name
       from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
      where not i.indisvalid and n.nspname = 'public'
      order by 1`,
  );
  return rows.map((r) => r.name);
}

const dropStatements = (names: string[]) => names.map((n) => `DROP INDEX CONCURRENTLY IF EXISTS "${n}";`).join(" ");
