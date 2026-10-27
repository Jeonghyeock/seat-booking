import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type pg from "pg";
import { withDatabase } from "../db/databases.js";
import { createPool } from "../db/pool.js";
import { checkLeftovers } from "./checks.js";
import {
  collectC2,
  diffStats,
  holdResponses,
  judgeC2,
  type K6Event,
  type Phase,
  phaseProblems,
  phasesFrom,
  readJsonLines,
  readK6Events,
  serverErrors,
  summarizeActivity,
  summarizeApi,
  summarizeCpu,
  summarizeK6,
} from "./report.js";
import { snapshotStats, type StatsSnapshot, startActivitySampler } from "./samplers.js";
import { cloneLoadDatabase, LOAD_DATABASE, readLoadData, RESULTS_DIR, setSalesOpen, verifyTemplateFiles } from "./template.js";

// 부하 측정 한 번(DESIGN 6.6). 템플릿 복제 → API 띄우기(IPC, P코어) → 표본기 → k6(E코어) → (S1이면) 조용해질 때까지 기다리기
// → API 닫기 → 요약과 C2 판정을 load/results/runs/<시각>-<이름>/에 쓴다. 중간에 실패해도 자식 프로세스를 정리하고 보고서를 남긴다.
// DATABASE_URL(앱)과 DATABASE_OWNER_URL(소유자)은 같은 서버의 아무 DB 주소다. 부하 DB 이름은 template.ts가 정한다.
// 복제는 소유자로 하고, API·표본기·확인은 앱 role로 한다(표본기의 pg_stat_activity는 같은 role의 세션만 자세히 보인다).

const { values: args } = parseArgs({
  options: {
    scenarios: { type: "string" },
    label: { type: "string", default: "run" },
    // 주지 않으면 API의 기본값(config.ts)을 쓴다. 측정의 "기본"이 앱의 기본과 같게.
    pool: { type: "string" },
    "connect-timeout": { type: "string" },
    "s1-mode": { type: "string", default: "uniform" },
    "s1-users": { type: "string" },
    "s1-warmup": { type: "string", default: "60" },
    "s2-rates": { type: "string" },
    "s2-step": { type: "string", default: "60" },
    "s2-warmup": { type: "string", default: "0" },
    "s3-rates": { type: "string" },
    "s3-step": { type: "string", default: "120" },
    "s3-warmup": { type: "string", default: "0" },
    "cpu-prof": { type: "boolean", default: false },
  },
});

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL이 없습니다(.env 또는 환경 변수)");
const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!ownerUrl) throw new Error("DATABASE_OWNER_URL이 없습니다(.env 또는 환경 변수)");
const scenarios = (args.scenarios ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (scenarios.length === 0) throw new Error("--scenarios가 없습니다(s1, s2, s3 중 쉼표로)");
// S1은 사용자 i가 쿠키 i를 쓰고, 끝나면 조용해질 때까지 기다린 뒤 C2를 본다. 다른 시나리오와 섞으면 사용자와 판정이 겹친다.
if (scenarios.includes("s1") && scenarios.length > 1) throw new Error("S1은 다른 시나리오와 함께 돌리지 않습니다");

// 단계 이름은 k6(main.js)와 같은 규칙으로 만든다: <시나리오>_<번호>_<도착률>rps, 예열은 <시나리오>_warmup.
const rates = (exec: "s2" | "s3") =>
  (args[`${exec}-rates`] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
function stepSeconds(exec: "s2" | "s3") {
  const lengths: Record<string, number> = {};
  const warmup = Number(args[`${exec}-warmup`]);
  if (warmup > 0) lengths[`${exec}_warmup`] = warmup;
  rates(exec).forEach((rate, i) => {
    lengths[`${exec}_${i + 1}_${rate}rps`] = Number(args[`${exec}-step`]);
  });
  return lengths;
}

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const apiDir = path.join(repoRoot, "apps/api");
const resultsDir = fileURLToPath(RESULTS_DIR);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const runDir = path.join(resultsDir, "runs", `${stamp}-${args.label}`);
mkdirSync(path.join(runDir, "api"), { recursive: true });
const PORT = 3201;
const BASE = `http://127.0.0.1:${PORT}`;

// 자식에게는 OS가 쓰는 것만 넘긴다(.env의 다른 값이 넘어가지 않게).
const osEnv = () => ({
  SystemRoot: process.env.SystemRoot,
  PATH: process.env.PATH,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
});
const powershell = (args: string[]) => execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], { encoding: "utf8", env: osEnv() });

// k6는 저장소 밖에 체크섬을 확인한 zip으로 둔다(load/README.md).
const k6Path =
  process.env.K6 ?? path.join(process.env.LOCALAPPDATA ?? "", "Programs/k6-v2.3.0/k6-v2.3.0-windows-amd64/k6.exe");
const k6Version = execFileSync(k6Path, ["version"], { encoding: "utf8", env: osEnv() });
if (!k6Version.includes("v2.3.0")) throw new Error(`k6 v2.3.0이 아닙니다: ${k6Version}`);

// P코어(효율 등급이 높은 논리 프로세서)에 API를, 나머지(E코어)에 k6를 묶는다. 묶을 수 없는 PC면 묶지 않고 적는다.
function cpuMasks() {
  const sets = powershell(["-File", path.join(repoRoot, "load/cpu-sets.ps1")])
    .trim()
    .split(/\s+/)
    .map((s) => s.split(":").map(Number) as [number, number, number]);
  const top = Math.max(...sets.map(([, , efficiency]) => efficiency));
  const performance = sets.filter(([, , e]) => e === top).map(([logical]) => logical);
  const efficient = sets.filter(([, , e]) => e !== top).map(([logical]) => logical);
  if (efficient.length === 0) return null;
  const mask = (list: number[]) => list.reduce((m, i) => m + 2 ** i, 0);
  return { api: mask(performance), k6: mask(efficient), performance, efficient, logical: sets.length };
}
const setAffinity = (pid: number, mask: number) => powershell(["-Command", `(Get-Process -Id ${pid}).ProcessorAffinity = ${mask}`]);

const exited = (child: ChildProcess) =>
  new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(apiAlive: () => boolean) {
  for (let i = 0; i < 150 && apiAlive(); i++) {
    const ok = await fetch(`${BASE}/health`).then(
      (r) => r.status === 200,
      () => false,
    );
    if (ok) return;
    await sleep(200);
  }
  throw new Error("API가 30초 안에 뜨지 않았습니다(api/api.log)");
}

const data = readLoadData();
const masks = cpuMasks();
const started = new Date();
const s1Users = Number(args["s1-users"] ?? data.userIds.length);
if (!(s1Users > 0 && s1Users <= data.userIds.length)) throw new Error(`--s1-users는 1~${data.userIds.length}입니다`);
const s1WarmupS = Number(args["s1-warmup"]);

// 보고서에 쓸 것. 중간에 실패해도 여기까지 모은 것을 쓴다.
const report: Record<string, unknown> = {
  label: args.label,
  startedAt: started.toISOString(),
  args,
  pinned: masks ? { api: masks.performance, k6: masks.efficient } : "묶지 않음(코어 종류가 하나)",
};
const children: ChildProcess[] = [];
let activity: Awaited<ReturnType<typeof startActivitySampler>> | null = null;
let pool: pg.Pool | null = null;
let api: ChildProcess | null = null;
let apiCode: number | null | "timeout" | "not started" = "not started";
let k6Code: number | null | "killed" | "not started" = "not started";
let t0: Date | null = null;
let k6EndedAt = Date.now();
let before: StatsSnapshot | null = null;
let after: StatsSnapshot | null = null;
let baseline: Phase | null = null;

try {
  await cloneLoadDatabase(ownerUrl);
  const loadUrl = withDatabase(baseUrl, LOAD_DATABASE);
  // 이 작업 트리의 load/results 파일이 서버의 템플릿과 같은 것에서 나왔는지 본다.
  const cookies = JSON.parse(readFileSync(path.join(resultsDir, "cookies.json"), "utf8")) as string[];
  await verifyTemplateFiles(loadUrl, cookies[0]!, data.userIds[0]!);
  // S1: k6가 VU를 만드는 시간 + 예열만큼 뒤를 판매 시작(T0)으로 둔다.
  if (scenarios.includes("s1")) {
    t0 = new Date(Date.now() + (30 + s1WarmupS) * 1000);
    await setSalesOpen(loadUrl, data.s1PerformanceId, t0);
  }

  const apiEnv = {
    ...osEnv(),
    DATABASE_URL: loadUrl,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    APP_ORIGIN: "http://127.0.0.1:5173",
    COOKIE_SECURE: "false",
    AUTH_RATE_LIMIT_PER_MINUTE: "10",
    TRUST_PROXY: "",
    FAKE_PAY_SECRET: randomBytes(32).toString("hex"),
    ...(args.pool ? { DB_POOL_MAX: args.pool } : {}),
    ...(args["connect-timeout"] ? { DB_CONNECT_TIMEOUT_MS: args["connect-timeout"] } : {}),
    LOG_LEVEL: "warn",
    LOAD_STATS: path.join(runDir, "api"),
  };
  const apiLog = openSync(path.join(runDir, "api/api.log"), "w");
  const profile = args["cpu-prof"] ? ["--cpu-prof", `--cpu-prof-dir=${path.join(runDir, "api")}`] : [];
  api = spawn(process.execPath, [...profile, "--import", "tsx", "src/main.ts"], {
    cwd: apiDir,
    env: apiEnv,
    stdio: ["ignore", apiLog, apiLog, "ipc"],
  });
  children.push(api);
  closeSync(apiLog);
  // 이미 끝난 자식에게 보내면 'error'가 나고, 듣는 쪽이 없으면 실행기가 죽는다.
  api.on("error", () => undefined);
  let apiExitedAt: number | null = null;
  const apiExit = exited(api).then((code) => {
    apiExitedAt = Date.now();
    apiCode = code;
    return code;
  });
  if (masks) setAffinity(api.pid!, masks.api);
  await waitForHealth(() => apiExitedAt === null);

  activity = await startActivitySampler(loadUrl, path.join(runDir, "db-activity.jsonl"));
  children.push(
    spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(repoRoot, "load/cpu-sampler.ps1"), "-Out", path.join(runDir, "cpu.jsonl")], {
      stdio: "ignore",
      env: osEnv(),
    }),
  );
  // k6를 띄우기 전 6초: 다른 프로세스가 쉴 때 쓰는 CPU의 기준선(표본기가 뜨는 1초를 뺀다).
  baseline = { name: "baseline", start: Date.now() + 1000, end: Date.now() + 6000 };
  await sleep(6500);
  before = await snapshotStats(loadUrl);

  // 시나리오에 주는 값은 -e로 넘긴다(k6의 __ENV). Go 런타임이 E코어 수만큼만 스레드를 돌리게 GOMAXPROCS를 준다.
  const k6Vars = {
    BASE_URL: BASE,
    DATA_DIR: resultsDir.replace(/\\/g, "/"),
    OUT_DIR: runDir.replace(/\\/g, "/"),
    SCENARIOS: scenarios.join(","),
    T0: t0 ? String(t0.getTime()) : "",
    S1_MODE: args["s1-mode"],
    S1_USERS: String(s1Users),
    S1_WARMUP_S: String(s1WarmupS),
    S2_RATES: rates("s2").join(","),
    S2_STEP_S: args["s2-step"],
    S2_WARMUP_S: args["s2-warmup"],
    S3_RATES: rates("s3").join(","),
    S3_STEP_S: args["s3-step"],
    S3_WARMUP_S: args["s3-warmup"],
  };
  const k6Out = openSync(path.join(runDir, "k6.txt"), "w");
  const k6 = spawn(
    k6Path,
    [
      "run",
      "--log-format=json",
      `--log-output=file=${path.join(runDir, "k6-log.jsonl")}`,
      ...Object.entries(k6Vars).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      path.join(repoRoot, "load/k6/main.js"),
    ],
    {
      env: {
        ...osEnv(),
        USERPROFILE: process.env.USERPROFILE,
        APPDATA: process.env.APPDATA,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        ...(masks ? { GOMAXPROCS: String(masks.efficient.length) } : {}),
      },
      stdio: ["ignore", k6Out, k6Out],
    },
  );
  children.push(k6);
  closeSync(k6Out);
  if (masks) setAffinity(k6.pid!, masks.k6);
  // 측정 중에 API가 죽으면 k6를 멈추고 일찍 끝낸다.
  const first = await Promise.race([exited(k6).then((code) => ({ k6: code })), apiExit.then(() => ({ k6: "api-exited" as const }))]);
  if (first.k6 === "api-exited") {
    k6.kill();
    k6Code = "killed";
    throw new Error(`측정 중에 API가 끝났습니다(종료 ${apiCode}, api/api.log)`);
  }
  k6Code = first.k6;
  k6EndedAt = Date.now();

  // S1이면 조용해질 때까지 기다린다: 마지막 선점의 만료(5분), 정리 한 바퀴(10초), 대사(30초), 웹훅 재전송(31초).
  pool = createPool({ connectionString: loadUrl, max: 2, application_name: "load-runner" });
  if (t0) {
    for (;;) {
      const quiet = await checkLeftovers(pool, [data.s1PerformanceId]);
      report.quiet = quiet;
      const waited = Date.now() - k6EndedAt;
      if (apiExitedAt !== null) throw new Error(`조용해지길 기다리는 중에 API가 끝났습니다(종료 ${apiCode})`);
      if ((Object.values(quiet).every((v) => v === 0) && waited >= 45_000) || waited >= 7 * 60_000) break;
      await sleep(5000);
    }
  }
  after = await snapshotStats(loadUrl);

  if (api.connected) api.send("shutdown");
  const closed = await Promise.race([apiExit, sleep(20_000).then(() => "timeout" as const)]);
  if (closed === "timeout") {
    apiCode = "timeout";
    api.kill();
  }
} catch (err) {
  report.error = err instanceof Error ? err.message : String(err);
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
  await activity?.stop().catch(() => undefined);
}

// 단계별 요약.
const events = readK6Events(path.join(runDir, "k6-log.jsonl"));
const phases: Phase[] = phasesFrom(events, { ...stepSeconds("s2"), ...stepSeconds("s3") }).map((p) =>
  // S1은 길이가 정해져 있지 않다. k6가 끝날 때까지로 자른다(조용해지길 기다린 시간은 넣지 않는다).
  p.name === "s1" ? { ...p, end: k6EndedAt } : p,
);
// S1의 몰림 구간: T0부터 10초. k6 시나리오가 아니라 API·DB·CPU만 본다.
if (t0) phases.push({ name: "s1_burst", start: t0.getTime(), end: t0.getTime() + 10_000 });
const summaryFile = path.join(runDir, "k6-summary.json");
const k6Summary = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, "utf8")) : null;
const ticks = readJsonLines<Parameters<typeof summarizeApi>[0][number]>(path.join(runDir, "api/api-stats.jsonl"));
const cpu = readJsonLines<Parameters<typeof summarizeCpu>[0][number]>(path.join(runDir, "cpu.jsonl"));
const dbActivity = readJsonLines<Parameters<typeof summarizeActivity>[0][number]>(path.join(runDir, "db-activity.jsonl"));
const stats = before && after ? diffStats(before, after) : null;
const othersBaseline = baseline ? (summarizeCpu(cpu, baseline, api?.pid ?? -1, masks?.logical ?? 20).othersPctMean ?? 0) : 0;
const byPhase = phases.map((phase) => {
  const k6 = k6Summary && phase.name !== "s1_burst" ? summarizeK6(k6Summary, phase.name) : null;
  const cpuSummary = summarizeCpu(cpu, phase, api?.pid ?? -1, masks?.logical ?? 20);
  return {
    phase: phase.name,
    k6,
    api: summarizeApi(ticks, phase),
    cpu: cpuSummary,
    db: summarizeActivity(dbActivity, phase),
    problems: phaseProblems(k6, cpuSummary, masks?.efficient.length ?? 20, othersBaseline),
  };
});

// S1 보고(DESIGN 6.6). 표가 나온 시각은 결제 시나리오 lost를 대사(30초)가 맞추는 것에 끌리므로 p50·p90으로 본다.
let s1: Record<string, unknown> | null = null;
let c2: Record<string, unknown> | null = null;
if (t0 && pool && !report.error) {
  const tickets = await pool.query<{ p50: number | null; p90: number | null; sold: string }>(
    `select percentile_cont(0.5) within group (order by extract(epoch from t.created_at - $2::timestamptz) * 1000) as p50,
            percentile_cont(0.9) within group (order by extract(epoch from t.created_at - $2::timestamptz) * 1000) as p90,
            count(*) as sold
       from tickets t join orders o on o.id = t.order_id join holds h on h.id = o.hold_id
      where t.performance_id = $1 and h.created_at >= $2`,
    [data.s1PerformanceId, t0],
  );
  const holds = events.filter((e): e is Extract<K6Event, { ev: "hold" }> => e.ev === "hold");
  const bySuccessAttempt: Record<string, number> = {};
  for (const e of holds) if (e.status === 201) bySuccessAttempt[e.attempt] = (bySuccessAttempt[e.attempt] ?? 0) + 1;
  const afterT0 = (values: number[]) => (values.length ? Math.max(...values) - t0!.getTime() : null);
  const soldDuringRun = Number(tickets.rows[0]!.sold);
  s1 = {
    t0: t0.toISOString(),
    soldDuringRun,
    ticketsAfterT0Ms: { p50: tickets.rows[0]!.p50, p90: tickets.rows[0]!.p90 },
    lastHoldSuccessAfterT0Ms: afterT0(holds.filter((e) => e.status === 201).map((e) => e.answeredAt)),
    allFirstHoldsAnsweredAfterT0Ms: afterT0(holds.filter((e) => e.attempt === 1).map((e) => e.answeredAt)),
    holdAttempts: holds.length,
    holdSuccessByAttempt: bySuccessAttempt,
    firstHold: k6Summary?.metrics?.s1_first_hold?.values ?? null,
  };
  const providerFile = path.join(runDir, "api/fake-pay.json");
  const collected = await collectC2(pool, {
    performanceId: data.s1PerformanceId,
    userIds: data.userIds,
    events,
    providerPayments: existsSync(providerFile) ? JSON.parse(readFileSync(providerFile, "utf8")) : [],
  });
  const outcomes = Object.entries(k6Summary?.metrics ?? {})
    .filter(([name]) => name.startsWith("s1_outcome{scenario:s1,outcome:"))
    .reduce((sum, [, metric]) => sum + Number((metric as { values: { count?: number } }).values.count ?? 0), 0);
  const holdsJudged = holdResponses(events);
  const server = serverErrors(ticks);
  const verdict = judgeC2({
    invariants: collected.invariants,
    leftovers: collected.leftovers,
    clientFailures: collected.client.failures,
    provider: collected.provider,
    server,
    deadlocks: stats?.deadlocks ?? 0,
    holds: holdsJudged,
    liveness: collected.liveness,
    users: s1Users,
    outcomes,
    soldDuringRun,
    k6Exit: typeof k6Code === "number" ? k6Code : null,
    apiExit: typeof apiCode === "number" || apiCode === null ? apiCode : "timeout",
  });
  c2 = { ...verdict, ...collected, server, holds: holdsJudged, outcomes };
}
await pool?.end();

Object.assign(report, { k6Exit: k6Code, apiExit: apiCode, apiPid: api?.pid, othersCpuBaseline: othersBaseline, stats, phases: byPhase, s1, c2 });
writeFileSync(path.join(runDir, "run.json"), JSON.stringify(report, null, 1));

const lines = [
  `# ${args.label} (${started.toISOString()})`,
  "",
  `풀 ${args.pool ?? "기본"}, k6 종료 ${k6Code}, API 종료 ${apiCode}, checkpoint ${stats?.checkpoints ?? "-"}, 교착 ${stats?.deadlocks ?? "-"}, ` +
    `측정 전 다른 프로세스 CPU ${othersBaseline}%(한 코어 = 100)`,
];
if (report.error) lines.push("", `실패: ${report.error}`);
lines.push("");
for (const p of byPhase) {
  const k = p.k6;
  const k6Part = k
    ? `k6 요청 ${k.requests}, p50 ${k.p50?.toFixed(1) ?? "-"}ms, p95 ${k.p95?.toFixed(1) ?? "-"}ms, 버린 반복 ${k.dropped} | `
    : "";
  lines.push(
    `- ${p.phase}: ${k6Part}ELU 평균 ${p.api.eluMean}·최대 ${p.api.eluMax}, API CPU ${p.cpu.apiPctMean}%, postgres ${p.cpu.postgresPctMean}%, ` +
      `k6 ${p.cpu.k6PctMean}%(최대 ${p.cpu.k6PctMax}%), 연결 대기 p95 최대 ${p.api.connectWaitP95Max}ms` +
      (p.problems.length ? ` | 무효: ${p.problems.join(", ")}` : ""),
  );
}
if (s1) {
  const first = s1.firstHold as Record<string, number> | null;
  const tickets = s1.ticketsAfterT0Ms as { p50: number | null; p90: number | null };
  lines.push(
    "",
    `S1: 첫 선점 p50 ${first?.med ?? "-"}ms·p95 ${first?.["p(95)"] ?? "-"}ms, 첫 선점 응답이 모두 온 시각 T0+${s1.allFirstHoldsAnsweredAfterT0Ms}ms, ` +
      `마지막 선점 성공 T0+${s1.lastHoldSuccessAfterT0Ms}ms, 표 p50 T0+${Math.round(tickets.p50 ?? 0)}ms·p90 T0+${Math.round(tickets.p90 ?? 0)}ms, ` +
      `팔린 좌석 ${s1.soldDuringRun}, 시도별 선점 성공 ${JSON.stringify(s1.holdSuccessByAttempt)}`,
  );
}
if (c2) {
  lines.push("", `C2: ${c2.passed ? "통과" : "실패"}${(c2.reasons as string[]).length ? ` (${(c2.reasons as string[]).join("; ")})` : ""}`);
  lines.push(`좌석 ${JSON.stringify(c2.seats)}, 살아 있는지 ${JSON.stringify(c2.liveness)}`);
}
writeFileSync(path.join(runDir, "summary.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
console.log(`결과: ${runDir}`);
if (report.error || (c2 && !c2.passed) || (k6Code !== 0 && k6Code !== "not started")) process.exitCode = 1;
