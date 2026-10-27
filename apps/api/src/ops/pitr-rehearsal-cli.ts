import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { dropDatabase, withAdminClient } from "../db/databases.js";
import { RESULTS_DIR, TEMPLATE_DATABASE } from "../load/template.js";

// 물리 백업과 시점 복구 리허설(DESIGN 6.7 "백업·복구 리허설" 2, 참고). 사용자 서버의 설정·서비스는 건드리지 않고,
// 리허설 클러스터를 initdb로 만들어(127.0.0.1의 다른 포트) 한다. 끝에 모든 인스턴스와 받기를 멈추고 작업 폴더를 지운다.
// 1. 리허설 클러스터에 role 셋(소유자, 앱, 백업)을 만들고, 부하 템플릿의 논리 백업을 복구한다(다른 클러스터로의 복구).
// 2. 영구 슬롯 없는 pg_receivewal로 WAL을 받기 시작하고, 백업 role(REPLICATION만)로 pg_basebackup을 받아 바로 pg_verifybackup.
// 3. 표시 행 → 시각 T(커밋 뒤 따로 잰 clock_timestamp, 오프셋 포함) → WAL 전환 → T 뒤 쓰기 → 한 번 더 전환.
// 4. 백업 사본 둘을 복구한다. 목표 없이(모든 행)와 recovery_target_time = T(T 앞의 행만, pause). 판정은 로그와 행으로 한다.
const SRC_PORT = 55432;
const ALL_PORT = 55433;
const T_PORT = 55434;
const BS = String.fromCharCode(92);

const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!ownerUrl) throw new Error("DATABASE_OWNER_URL이 없습니다(.env 또는 환경 변수)");
const windowsBin = "C:/Program Files/PostgreSQL/18/bin";
const bin = process.env.PG_BIN ?? (existsSync(windowsBin) ? windowsBin : "");
const tool = (name: string) => (bin ? path.join(bin, name) : name);
const isWindows = process.platform === "win32";

const work = mkdtempSync(path.join(tmpdir(), "seat-booking-pitr-"));
const dir = (name: string) => path.join(work, name);
const superPassword = randomBytes(18).toString("hex");
const backupPassword = randomBytes(18).toString("hex");
const report: Record<string, unknown> = { at: new Date().toISOString() };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 비밀번호는 명령줄에 두지 않고 libpq 환경 변수로 넘긴다.
function env(user: string, password: string, port: number, database = "postgres") {
  return { ...process.env, PGHOST: "127.0.0.1", PGPORT: String(port), PGUSER: user, PGPASSWORD: password, PGDATABASE: database, LC_MESSAGES: "C" };
}
function run(name: string, args: string[], e: NodeJS.ProcessEnv = { ...process.env, LC_MESSAGES: "C" }) {
  const started = performance.now();
  const r = spawnSync(tool(name), args, { env: e, encoding: "utf8" });
  if (r.error) throw r.error;
  const result = { status: r.status, ms: Math.round(performance.now() - started), stderr: `${r.stderr}`.trim() };
  appendFileSync(dir("commands.log"), `${name} ${args.join(" ")} → ${result.status} (${result.ms}ms)\n${result.stderr}\n`);
  if (result.status !== 0) throw new Error(`${name} 실패(${result.status}): ${result.stderr.slice(0, 500)}`);
  return result;
}
const started: string[] = [];
const step = (what: string) => console.log(`[${new Date().toISOString()}] ${what}`);
function start(data: string, port: number) {
  started.push(data);
  // 띄운 서버가 출력 파이프를 물려받으면 spawnSync가 돌아오지 않는다(Windows). 서버 출력은 -l 로그로만 받는다.
  const r = spawnSync(tool("pg_ctl"), ["-D", data, "-l", `${data}.log`, "-o", `-p ${port} -c listen_addresses=127.0.0.1`, "-w", "start"], {
    env: { ...process.env, LC_MESSAGES: "C" },
    stdio: "ignore",
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`pg_ctl start 실패(${r.status}). ${data}.log를 봅니다`);
}
async function sql<T extends pg.QueryResultRow>(port: number, text: string, database = "postgres") {
  const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: superPassword, database });
  await client.connect();
  try {
    return (await client.query<T>(text)).rows;
  } finally {
    await client.end();
  }
}
async function waitFor(check: () => Promise<boolean>, what: string, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return;
    await sleep(200);
  }
  throw new Error(`${what}이(가) 되지 않았습니다`);
}

let receiver: ChildProcess | null = null;
try {
  step("부하 템플릿의 논리 백업");
  // 0. 부하 템플릿의 논리 백업(복제본에서 덤프한다. 템플릿은 측정의 기준이라 쓰지 않는다)
  const SOURCE = "seat_booking_pitr_src";
  await withAdminClient(ownerUrl, async (client) => {
    await dropDatabase(client, SOURCE);
    await client.query(`CREATE DATABASE ${SOURCE} TEMPLATE ${TEMPLATE_DATABASE} STRATEGY FILE_COPY`);
  });
  const u = new URL(ownerUrl);
  try {
    run("pg_dump", ["-Fc", "-f", dir("load.dump"), "-d", SOURCE], {
      ...process.env,
      PGHOST: u.hostname,
      PGPORT: u.port || "5432",
      PGUSER: decodeURIComponent(u.username),
      PGPASSWORD: decodeURIComponent(u.password),
    });
  } finally {
    await withAdminClient(ownerUrl, (client) => dropDatabase(client, SOURCE));
  }

  // 1. 리허설 클러스터
  step("리허설 클러스터 만들기");
  writeFileSync(dir("pw"), superPassword);
  run("initdb", ["-D", dir("src"), "-U", "postgres", "--pwfile", dir("pw"), "--auth=scram-sha-256", "--locale=C", "-E", "UTF8"]);
  rmSync(dir("pw"));
  start(dir("src"), SRC_PORT);
  await sql(
    SRC_PORT,
    `create role seat_booking login createdb password '${randomBytes(18).toString("hex")}';
     create role seat_booking_app login password '${randomBytes(18).toString("hex")}';
     grant seat_booking_app to seat_booking;
     create role seat_booking_backup login replication password '${backupPassword}';`,
  );
  // CREATE DATABASE는 여러 문장과 함께 보내면 트랜잭션 안이 되어 거부된다
  await sql(SRC_PORT, "create database seat_booking owner seat_booking");
  step("논리 백업을 리허설 클러스터에 복구");
  // role이 먼저 있어야 권한(0008)까지 복구된다
  const restore = run("pg_restore", ["-j", "4", "-d", "seat_booking", dir("load.dump")], env("postgres", superPassword, SRC_PORT));
  const counts = await sql<{ orders: string; seats: string }>(
    SRC_PORT,
    "select (select count(*) from orders)::text as orders, (select count(*) from performance_seats)::text as seats",
    "seat_booking",
  );
  report.restoredIntoRehearsalCluster = { restoreMs: restore.ms, ...counts[0] };
  // 표시 행 표. 백업에 들어갈 행을 하나 넣는다.
  await sql(
    SRC_PORT,
    "create table rehearsal_marker (id int generated always as identity primary key, note text not null); insert into rehearsal_marker (note) values ('in-base-backup')",
    "seat_booking",
  );

  // 2. WAL 받기(슬롯 없이, 백업보다 먼저) → 기본 백업 → 바로 검증(복구에 쓴 폴더는 파일이 바뀌어 검증에 실패한다)
  step("WAL 받기와 기본 백업");
  mkdirSync(dir("wal"));
  receiver = spawn(tool("pg_receivewal"), ["-D", dir("wal"), "-n", "-v"], {
    env: env("seat_booking_backup", backupPassword, SRC_PORT),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let receiverLog = "";
  receiver.stderr?.on("data", (d: Buffer) => {
    receiverLog += d.toString();
  });
  await waitFor(async () => receiverLog.includes("starting log streaming"), "pg_receivewal 시작");
  const basebackup = run(
    "pg_basebackup",
    ["-D", dir("base"), "-Fp", "-X", "stream", "-c", "fast"],
    env("seat_booking_backup", backupPassword, SRC_PORT),
  );
  const verify = run("pg_verifybackup", [dir("base")]);
  const canRead = await (async () => {
    const client = new pg.Client({ host: "127.0.0.1", port: SRC_PORT, user: "seat_booking_backup", password: backupPassword, database: "seat_booking" });
    await client.connect();
    try {
      return await client.query("select * from rehearsal_marker").then(
        () => true,
        () => false,
      );
    } finally {
      await client.end();
    }
  })();
  report.basebackup = { ms: basebackup.ms, verifyMs: verify.ms, backupRoleCanReadTables: canRead };

  // 3. 표시 행 → T → 전환 → T 뒤 쓰기 → 전환. T는 커밋 뒤 따로 잰다(트랜잭션 안의 now()는 커밋보다 앞이다).
  step("표시 행과 시각 T");
  await sql(SRC_PORT, "insert into rehearsal_marker (note) values ('before-T')", "seat_booking");
  const T = (await sql<{ t: string }>(SRC_PORT, "select clock_timestamp()::text as t"))[0]!.t;
  await sleep(1_500);
  await sql(SRC_PORT, "select pg_switch_wal()");
  await sql(SRC_PORT, "insert into rehearsal_marker (note) values ('after-T')", "seat_booking");
  const lastSegment = (await sql<{ f: string }>(SRC_PORT, "select pg_walfile_name(pg_current_wal_insert_lsn()) as f"))[0]!.f;
  await sql(SRC_PORT, "select pg_switch_wal()");
  // restore_command는 .partial을 찾지 않으므로, 마지막 쓰기가 든 세그먼트가 다 받아질 때까지 기다린다
  await waitFor(async () => existsSync(path.join(dir("wal"), lastSegment)), `${lastSegment} 받기`);
  receiver.kill();
  receiver = null;
  report.marker = { T, lastSegment };

  // 4. 사본 둘을 복구한다
  const walDir = dir("wal");
  // Windows의 copy에는 백슬래시를 두 번 적은 경로를 쓴다(슬래시는 실패하고, 목표 없는 복구는 그러면 조용히 끝난다).
  const restoreCommand = isWindows
    ? `copy "${walDir.split(BS).join(BS + BS)}${BS + BS}%f" "%p"`
    : `cp "${walDir}/%f" "%p"`;
  const recover = async (name: string, port: number, target: string | null) => {
    const data = dir(name);
    cpSync(dir("base"), data, { recursive: true });
    const conf = [`restore_command = '${restoreCommand}'`];
    if (target) conf.push(`recovery_target_time = '${target}'`, "recovery_target_action = 'pause'");
    appendFileSync(path.join(data, "postgresql.auto.conf"), `\n${conf.join("\n")}\n`);
    writeFileSync(path.join(data, "recovery.signal"), "");
    step(`${name} 복구`);
    const begun = performance.now();
    start(data, port);
    // pg_ctl의 성공은 hot standby가 연결을 받는 순간이다. 끝났는지는 따로 본다.
    await waitFor(
      async () =>
        target
          ? (await sql<{ s: string }>(port, "select pg_get_wal_replay_pause_state() as s"))[0]!.s === "paused"
          : (await sql<{ r: boolean }>(port, "select pg_is_in_recovery() as r"))[0]!.r === false,
      `${name} 복구`,
    );
    const ms = Math.round(performance.now() - begun);
    const rows = (await sql<{ note: string }>(port, "select note from rehearsal_marker order by id", "seat_booking")).map((r) => r.note);
    const log = readFileSync(`${data}.log`, "utf8");
    return {
      ms,
      rows,
      restoredLogFiles: (log.match(/restored log file/g) ?? []).length,
      stoppedBeforeCommit: /recovery stopping before commit/.test(log),
      fatal: /FATAL/.test(log),
    };
  };
  const all = await recover("rec_all", ALL_PORT, null);
  const atT = await recover("rec_t", T_PORT, T);
  report.recovery = { noTarget: all, targetT: atT };
  report.pass =
    JSON.stringify(all.rows) === JSON.stringify(["in-base-backup", "before-T", "after-T"]) &&
    JSON.stringify(atT.rows) === JSON.stringify(["in-base-backup", "before-T"]) &&
    atT.stoppedBeforeCommit;
} finally {
  receiver?.kill();
  for (const data of started.reverse()) {
    spawnSync(tool("pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], { encoding: "utf8" });
  }
  // 작업 폴더에는 비밀번호 해시와 세션 토큰 해시가 든다
  for (let attempt = 0; attempt < 10 && existsSync(work); attempt++) {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      await sleep(500);
    }
  }
  report.workRemoved = !existsSync(work);
}

mkdirSync(RESULTS_DIR, { recursive: true });
const out = fileURLToPath(new URL(`pitr-${String(report.at).replace(/[-:]/g, "").slice(0, 15)}.json`, RESULTS_DIR));
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`기록: ${out}`);
