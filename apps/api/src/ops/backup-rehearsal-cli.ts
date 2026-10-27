import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { dropDatabase, withAdminClient, withDatabase } from "../db/databases.js";
import { RESULTS_DIR, TEMPLATE_DATABASE } from "../load/template.js";

// 논리 백업·복구 리허설(DESIGN 6.7 "백업·복구 리허설" 1, C8 판정). 소유자로 돈다.
// 부하 템플릿을 복제한 조용한 DB를 pg_dump -Fc로 덤프하고 빈 새 DB에 pg_restore -j 4로 복구한 뒤,
// 표마다(public, drizzle) 행 수와 내용 checksum, 시퀀스마다 last_value·is_called가 같은지 본다.
// 잃는 것도 확인한다: 스냅샷 뒤의 쓰기, 실행 계획 통계, role. 만든 DB와 덤프 파일(세션 토큰 해시가 든다)은 끝에 지운다.
const SOURCE = "seat_booking_backup_src";
const RESTORED = "seat_booking_backup_dst";
const SNAPSHOT_RESTORED = "seat_booking_backup_snap";

const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!ownerUrl) throw new Error("DATABASE_OWNER_URL이 없습니다(.env 또는 환경 변수)");
const windowsBin = "C:/Program Files/PostgreSQL/18/bin";
const bin = process.env.PG_BIN ?? (existsSync(windowsBin) ? windowsBin : "");
const tool = (name: string) => (bin ? path.join(bin, name) : name);

// 비밀번호를 명령줄에 두지 않게 libpq 환경 변수로 넘긴다.
function pgEnv(database: string) {
  const u = new URL(ownerUrl!);
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: database,
    LC_MESSAGES: "C",
  };
}
function run(name: string, args: string[], database: string) {
  const started = performance.now();
  const r = spawnSync(tool(name), args, { env: pgEnv(database), encoding: "utf8" });
  const ms = Math.round(performance.now() - started);
  if (r.error) throw r.error;
  return { status: r.status, ms, stderr: r.stderr.trim() };
}

async function withClient<T>(database: string, work: (client: pg.Client) => Promise<T>) {
  const client = new pg.Client({ connectionString: withDatabase(ownerUrl!, database) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

type Fingerprint = { tables: Record<string, { rows: string; sum: string }>; sequences: Record<string, string> };
// 행 순서와 상관없는 checksum. timestamptz의 글자는 세션 설정에 따라 달라지므로 양쪽을 같은 설정으로 잰다.
async function fingerprint(database: string): Promise<Fingerprint> {
  return withClient(database, async (client) => {
    await client.query("set timezone = 'UTC'; set datestyle = 'ISO, YMD'");
    const { rows: rels } = await client.query<{ ns: string; name: string; kind: string }>(
      `select n.nspname as ns, c.relname as name, c.relkind::text as kind
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'drizzle') and c.relkind in ('r', 'S')
        order by 1, 2`,
    );
    const result: Fingerprint = { tables: {}, sequences: {} };
    for (const { ns, name, kind } of rels) {
      const id = `${client.escapeIdentifier(ns)}.${client.escapeIdentifier(name)}`;
      if (kind === "r") {
        const { rows } = await client.query<{ rows: string; sum: string }>(
          `select count(*)::text as rows, coalesce(sum(hashtextextended(t::text, 0)), 0)::text as sum from ${id} t`,
        );
        result.tables[`${ns}.${name}`] = rows[0]!;
      } else {
        const { rows } = await client.query<{ v: string }>(`select last_value || ' ' || is_called as v from ${id}`);
        result.sequences[`${ns}.${name}`] = rows[0]!.v;
      }
    }
    return result;
  });
}

function differences(a: Fingerprint, b: Fingerprint, { sequences = true } = {}) {
  const diffs: string[] = [];
  for (const key of new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])) {
    if (JSON.stringify(a.tables[key]) !== JSON.stringify(b.tables[key])) diffs.push(`표 ${key}`);
  }
  if (sequences) {
    for (const key of new Set([...Object.keys(a.sequences), ...Object.keys(b.sequences)])) {
      if (a.sequences[key] !== b.sequences[key]) diffs.push(`시퀀스 ${key}`);
    }
  }
  return diffs;
}

// 통계가 있는지(pg_stats 행 수)와 좌석 지도의 재고 조회가 추정한 행 수.
async function planStats(database: string) {
  return withClient(database, async (client) => {
    const stats = await client.query<{ n: number }>("select count(*)::int as n from pg_stats where schemaname = 'public'");
    const { rows } = await client.query<{ "QUERY PLAN": [{ Plan: { "Plan Rows": number } }] }>(
      "explain (format json) select * from performance_seats where performance_id = 1",
    );
    const actual = await client.query<{ n: number }>("select count(*)::int as n from performance_seats where performance_id = 1");
    return { pgStats: stats.rows[0]!.n, estimated: rows[0]!["QUERY PLAN"][0].Plan["Plan Rows"], actual: actual.rows[0]!.n };
  });
}

const work = mkdtempSync(path.join(tmpdir(), "seat-booking-backup-"));
const report: Record<string, unknown> = { at: new Date().toISOString() };
try {
  await withAdminClient(ownerUrl, async (client) => {
    const { rows } = await client.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname = $1", [
      TEMPLATE_DATABASE,
    ]);
    if (rows[0]!.n > 0) throw new Error(`템플릿(${TEMPLATE_DATABASE})에 연결이 있습니다. 복제할 수 없습니다`);
    for (const db of [SOURCE, RESTORED, SNAPSHOT_RESTORED]) await dropDatabase(client, db);
    // 템플릿은 부하 측정의 기준이라(통계·토큰 파일이 짝) 쓰지 않고, 복제본에서 덤프한다.
    await client.query(`CREATE DATABASE ${SOURCE} TEMPLATE ${TEMPLATE_DATABASE} STRATEGY FILE_COPY`);
  });
  const source = await fingerprint(SOURCE);

  // 1. 덤프 → 빈 DB에 복구 → 대조(C8)
  const dumpFile = path.join(work, "source.dump");
  const dump = run("pg_dump", ["-Fc", "-f", dumpFile], SOURCE);
  if (dump.status !== 0) throw new Error(`pg_dump 실패: ${dump.stderr}`);
  await withAdminClient(ownerUrl, (client) => client.query(`CREATE DATABASE ${RESTORED}`));
  const restore = run("pg_restore", ["-j", "4", "-d", RESTORED, dumpFile], "postgres");
  const restored = await fingerprint(RESTORED);
  const diffs = differences(source, restored);
  report.c8 = {
    pass: restore.status === 0 && diffs.length === 0,
    tables: Object.keys(source.tables).length,
    rows: Object.values(source.tables).reduce((n, t) => n + Number(t.rows), 0),
    sequences: Object.keys(source.sequences).length,
    diffs,
    dumpBytes: statSync(dumpFile).size,
    dumpMs: dump.ms,
    restoreMs: restore.ms,
    restoreStatus: restore.status,
    restoreStderr: restore.stderr,
  };

  // 2. 통계는 기본값으로는 덤프에 담기지 않는다. 복구본은 템플릿의 autovacuum_enabled = false도 이어받는다.
  const beforeAnalyze = await planStats(RESTORED);
  await withClient(RESTORED, (client) => client.query("analyze"));
  report.statistics = {
    source: await planStats(SOURCE),
    restoredBeforeAnalyze: beforeAnalyze,
    restoredAfterAnalyze: await planStats(RESTORED),
    autovacuumOffTables: await withClient(RESTORED, async (client) =>
      Number(
        (await client.query("select count(*) as n from pg_class where reloptions @> array['autovacuum_enabled=false']")).rows[0].n,
      ),
    ),
  };

  // 3. 스냅샷 뒤의 쓰기는 백업에 없다. 우연한 시점에 기대지 않게, 내보낸 스냅샷으로 덤프한다.
  const exporter = new pg.Client({ connectionString: withDatabase(ownerUrl, SOURCE) });
  await exporter.connect();
  try {
    await exporter.query("begin isolation level repeatable read");
    const snapshot = (await exporter.query<{ id: string }>("select pg_export_snapshot() as id")).rows[0]!.id;
    const changed = await withClient(SOURCE, async (client) => {
      const inserted = await client.query<{ id: number }>("insert into venues (name) values ('백업 뒤에 넣은 공연장') returning id");
      const updated = await client.query<{ id: number }>(
        "update venues set name = name || ' (백업 뒤에 고침)' where id = (select min(id) from venues) returning id",
      );
      return { inserted: inserted.rows[0]!.id, updated: updated.rows[0]!.id };
    });
    const snapFile = path.join(work, "snapshot.dump");
    const snapDump = run("pg_dump", ["-Fc", `--snapshot=${snapshot}`, "-f", snapFile], SOURCE);
    await exporter.query("commit");
    if (snapDump.status !== 0) throw new Error(`스냅샷 pg_dump 실패: ${snapDump.stderr}`);
    await withAdminClient(ownerUrl, (client) => client.query(`CREATE DATABASE ${SNAPSHOT_RESTORED}`));
    run("pg_restore", ["-d", SNAPSHOT_RESTORED, snapFile], "postgres");
    const seen = await withClient(SNAPSHOT_RESTORED, async (client) => ({
      inserted: (await client.query("select 1 from venues where id = $1", [changed.inserted])).rowCount,
      updated: (await client.query("select 1 from venues where id = $1 and name like '%(백업 뒤에 고침)'", [changed.updated])).rowCount,
    }));
    // 시퀀스는 스냅샷을 따르지 않고 덤프하는 순간의 값이다. 그래서 위 대조는 조용한 DB에서만 한다.
    const snapSeq = (await fingerprint(SNAPSHOT_RESTORED)).sequences["public.venues_id_seq"];
    report.snapshot = {
      pass: seen.inserted === 0 && seen.updated === 0,
      insertedRowInBackup: seen.inserted,
      updatedRowInBackup: seen.updated,
      venuesSeqInBackup: snapSeq,
      venuesSeqAtSnapshot: source.sequences["public.venues_id_seq"],
    };
  } finally {
    await exporter.end().catch(() => {});
  }

  // 4. role은 DB 백업에 없다. 비슈퍼유저는 비밀번호 없이만 globals를 받을 수 있다.
  const globalsFile = path.join(work, "globals.sql");
  const globals = run("pg_dumpall", ["--globals-only", "--no-role-passwords", "-f", globalsFile], "postgres");
  const globalsText = globals.status === 0 ? readFileSync(globalsFile, "utf8") : "";
  report.globals = {
    status: globals.status,
    roles: [...globalsText.matchAll(/^CREATE ROLE (\S+);/gm)].map((m) => m[1]),
    hasPasswords: /PASSWORD '/.test(globalsText),
    withPasswords: run("pg_dumpall", ["--globals-only", "-f", path.join(work, "globals-pw.sql")], "postgres").status,
  };
} finally {
  await withAdminClient(ownerUrl, async (client) => {
    for (const db of [SOURCE, RESTORED, SNAPSHOT_RESTORED]) await dropDatabase(client, db);
  });
  rmSync(work, { recursive: true, force: true });
}

mkdirSync(RESULTS_DIR, { recursive: true });
const out = fileURLToPath(new URL(`backup-${String(report.at).replace(/[-:]/g, "").slice(0, 15)}.json`, RESULTS_DIR));
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`기록: ${out}`);
