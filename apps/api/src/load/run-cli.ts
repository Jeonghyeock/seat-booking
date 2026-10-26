import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPool } from "../db/pool.js";
import { checkLeftovers } from "./checks.js";
import {
  diffStats,
  type K6Event,
  phasesFrom,
  readJsonLines,
  readK6Events,
  summarizeActivity,
  summarizeApi,
  summarizeCpu,
  summarizeK6,
  verifyC2,
} from "./report.js";
import { snapshotStats, startActivitySampler } from "./samplers.js";
import { cloneLoadDatabase, readLoadData, RESULTS_DIR, setSalesOpen, verifyTemplateFiles } from "./template.js";

// 부하 측정 한 번(DESIGN 6.6). 템플릿 복제 → API 띄우기(IPC, P코어) → 표본기 → k6(E코어) → (S1이면) 조용해질 때까지 기다리기
// → API 닫기 → 요약과 C2 판정을 load/results/runs/<시각>-<이름>/에 쓴다.
// DATABASE_URL은 같은 서버의 아무 DB 주소다. 부하 DB 이름은 template.ts가 정한다.

const { values: args } = parseArgs({
  options: {
    scenarios: { type: "string" },
    label: { type: "string", default: "run" },
    pool: { type: "string", default: "10" },
    "connect-timeout": { type: "string", default: "0" },
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
const scenarios = (args.scenarios ?? "").split(",").filter(Boolean);
if (scenarios.length === 0) throw new Error("--scenarios가 없습니다(s1, s2, s3 중 쉼표로)");

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const apiDir = path.join(repoRoot, "apps/api");
const resultsDir = fileURLToPath(RESULTS_DIR);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const runDir = path.join(resultsDir, "runs", `${stamp}-${args.label}`);
mkdirSync(path.join(runDir, "api"), { recursive: true });
const PORT = 3201;
const BASE = `http://127.0.0.1:${PORT}`;

// k6는 저장소 밖에 체크섬을 확인한 zip으로 둔다(load/README.md).
const k6Path =
  process.env.K6 ?? path.join(process.env.LOCALAPPDATA ?? "", "Programs/k6-v2.3.0/k6-v2.3.0-windows-amd64/k6.exe");
const k6Version = execFileSync(k6Path, ["version"], { encoding: "utf8" });
if (!k6Version.includes("v2.3.0")) throw new Error(`k6 v2.3.0이 아닙니다: ${k6Version}`);

// P코어(효율 등급이 높은 논리 프로세서)에 API를, 나머지(E코어)에 k6를 묶는다. 묶을 수 없는 PC면 묶지 않고 적는다.
function cpuMasks() {
  const out = execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(repoRoot, "load/cpu-sets.ps1")], {
    encoding: "utf8",
  });
  const sets = out
    .trim()
    .split(/\s+/)
    .map((s) => s.split(":").map(Number) as [number, number, number]);
  const top = Math.max(...sets.map(([, , efficiency]) => efficiency));
  const performance = sets.filter(([, , e]) => e === top).map(([logical]) => logical);
  const efficient = sets.filter(([, , e]) => e !== top).map(([logical]) => logical);
  if (efficient.length === 0) return null;
  const mask = (list: number[]) => list.reduce((m, i) => m + 2 ** i, 0);
  return { api: mask(performance), k6: mask(efficient), performance, efficient };
}
const setAffinity = (pid: number, mask: number) =>
  execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).ProcessorAffinity = ${mask}`]);

const osEnv = () => ({
  SystemRoot: process.env.SystemRoot,
  PATH: process.env.PATH,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
});
const exited = (child: ChildProcess) =>
  new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth() {
  for (let i = 0; i < 150; i++) {
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

const loadUrl = await cloneLoadDatabase(baseUrl);
// 이 작업 트리의 load/results 파일이 서버의 템플릿과 같은 것에서 나왔는지 본다.
const cookies = JSON.parse(readFileSync(path.join(resultsDir, "cookies.json"), "utf8")) as string[];
await verifyTemplateFiles(loadUrl, cookies[0]!, data.userIds[0]!);
const s1Users = Number(args["s1-users"] ?? data.userIds.length);
const s1WarmupS = Number(args["s1-warmup"]);
// S1: k6가 VU를 만드는 시간 + 예열만큼 뒤를 판매 시작(T0)으로 둔다.
const t0 = scenarios.includes("s1") ? new Date(Date.now() + (30 + s1WarmupS) * 1000) : null;
if (t0) await setSalesOpen(loadUrl, data.s1PerformanceId, t0);

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
  DB_POOL_MAX: args.pool,
  DB_CONNECT_TIMEOUT_MS: args["connect-timeout"],
  LOG_LEVEL: "warn",
  LOAD_STATS: path.join(runDir, "api"),
};
const apiLog = openSync(path.join(runDir, "api/api.log"), "w");
const profile = args["cpu-prof"] ? ["--cpu-prof", `--cpu-prof-dir=${path.join(runDir, "api")}`] : [];
const api = spawn(process.execPath, [...profile, "--import", "tsx", "src/main.ts"], {
  cwd: apiDir,
  env: apiEnv,
  stdio: ["ignore", apiLog, apiLog, "ipc"],
});
const apiExit = exited(api);
if (masks) setAffinity(api.pid!, masks.api);
await waitForHealth();

const activity = await startActivitySampler(loadUrl, path.join(runDir, "db-activity.jsonl"));
const cpuSampler = spawn(
  "powershell",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(repoRoot, "load/cpu-sampler.ps1"), "-Out", path.join(runDir, "cpu.jsonl")],
  { stdio: "ignore" },
);
const before = await snapshotStats(loadUrl);

// 시나리오에 주는 값은 -e로 넘긴다(k6의 __ENV). 프로세스 환경에는 OS가 쓰는 것만 둔다.
const k6Vars = {
  BASE_URL: BASE,
  DATA_DIR: resultsDir.replace(/\\/g, "/"),
  OUT_DIR: runDir.replace(/\\/g, "/"),
  SCENARIOS: scenarios.join(","),
  T0: t0 ? String(t0.getTime()) : "",
  S1_MODE: args["s1-mode"],
  S1_USERS: String(s1Users),
  S1_WARMUP_S: String(s1WarmupS),
  S2_RATES: args["s2-rates"] ?? "",
  S2_STEP_S: args["s2-step"],
  S2_WARMUP_S: args["s2-warmup"],
  S3_RATES: args["s3-rates"] ?? "",
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
    env: { ...osEnv(), USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA },
    stdio: ["ignore", k6Out, k6Out],
  },
);
if (masks) setAffinity(k6.pid!, masks.k6);
const k6Code = await exited(k6);
const k6EndedAt = Date.now();
closeSync(k6Out);

// S1이면 조용해질 때까지 기다린다: 마지막 선점의 만료(5분), 정리 한 바퀴(10초), 대사(30초), 웹훅 재전송(31초).
const pool = createPool({ connectionString: loadUrl, max: 2, application_name: "load-runner" });
let quiet: Record<string, number> | null = null;
if (scenarios.includes("s1")) {
  for (;;) {
    quiet = await checkLeftovers(pool, [data.s1PerformanceId]);
    const waited = Date.now() - k6EndedAt;
    if ((Object.values(quiet).every((v) => v === 0) && waited >= 45_000) || waited >= 7 * 60_000) break;
    await sleep(5000);
  }
}
const after = await snapshotStats(loadUrl);

api.send("shutdown");
const apiCode = await Promise.race([apiExit, sleep(20_000).then(() => "timeout" as const)]);
if (apiCode === "timeout") api.kill();
closeSync(apiLog);
await activity.stop();
cpuSampler.kill();

// 단계별 요약.
const events = readK6Events(path.join(runDir, "k6-log.jsonl"));
const stepSeconds = (exec: "s2" | "s3") => {
  const rates = (args[`${exec}-rates`] ?? "").split(",").filter(Boolean);
  const lengths: Record<string, number> = {};
  if (Number(args[`${exec}-warmup`]) > 0) lengths[`${exec}_warmup`] = Number(args[`${exec}-warmup`]);
  rates.forEach((rate, i) => {
    lengths[`${exec}_${i + 1}_${rate}rps`] = Number(args[`${exec}-step`]);
  });
  return lengths;
};
const phases = phasesFrom(events, { ...stepSeconds("s2"), ...stepSeconds("s3") }).map((p) =>
  // S1은 길이가 정해져 있지 않다. k6가 끝날 때까지로 자른다(조용해지길 기다린 시간은 넣지 않는다).
  p.name === "s1" ? { ...p, end: k6EndedAt } : p,
);
// S1의 몰림 구간: T0부터 10초.
if (t0) phases.push({ name: "s1_burst", start: t0.getTime(), end: t0.getTime() + 10_000 });
const summaryFile = path.join(runDir, "k6-summary.json");
const k6Summary = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, "utf8")) : null;
const ticks = readJsonLines<Parameters<typeof summarizeApi>[0][number]>(path.join(runDir, "api/api-stats.jsonl"));
const cpu = readJsonLines<Parameters<typeof summarizeCpu>[0][number]>(path.join(runDir, "cpu.jsonl"));
const dbActivity = readJsonLines<Parameters<typeof summarizeActivity>[0][number]>(path.join(runDir, "db-activity.jsonl"));
const stats = diffStats(before, after);
const byPhase = phases.map((phase) => ({
  phase: phase.name,
  k6: k6Summary ? summarizeK6(k6Summary, phase.name) : null,
  api: summarizeApi(ticks, phase),
  cpu: summarizeCpu(cpu, phase, api.pid!),
  db: summarizeActivity(dbActivity, phase),
}));

let c2 = null;
if (scenarios.includes("s1")) {
  const providerFile = path.join(runDir, "api/fake-pay.json");
  c2 = await verifyC2(pool, {
    performanceId: data.s1PerformanceId,
    userIds: data.userIds,
    events,
    providerPayments: existsSync(providerFile) ? JSON.parse(readFileSync(providerFile, "utf8")) : [],
    ticks,
    deadlocks: stats.deadlocks,
  });
}
// S1 보고(DESIGN 6.6): 매진까지의 시간, 모두 답을 받기까지의 시간, 시도별 선점 성공.
let s1 = null;
if (t0) {
  const { rows } = await pool.query<{ last_ticket: Date | null; sold: string }>(
    `select max(t.created_at) as last_ticket, count(*) as sold
       from tickets t join orders o on o.id = t.order_id join holds h on h.id = o.hold_id
      where t.performance_id = $1 and h.created_at >= $2`,
    [data.s1PerformanceId, t0],
  );
  const holds = events.filter((e): e is Extract<K6Event, { ev: "hold" }> => e.ev === "hold");
  const bySuccessAttempt: Record<string, number> = {};
  for (const e of holds) if (e.status === 201) bySuccessAttempt[e.attempt] = (bySuccessAttempt[e.attempt] ?? 0) + 1;
  const lastHold = Math.max(...holds.map((e) => e.at), t0.getTime());
  s1 = {
    t0: t0.toISOString(),
    soldDuringRun: Number(rows[0]!.sold),
    lastTicketAfterT0Ms: rows[0]!.last_ticket ? rows[0]!.last_ticket.getTime() - t0.getTime() : null,
    lastHoldSentAfterT0Ms: lastHold - t0.getTime(),
    holdAttempts: holds.length,
    holdSuccessByAttempt: bySuccessAttempt,
    gaveUp: events.filter((e) => e.ev === "gave_up").length,
    firstHold: k6Summary?.metrics?.s1_first_hold?.values ?? null,
  };
}
await pool.end();

const report = {
  label: args.label,
  startedAt: started.toISOString(),
  args,
  pinned: masks ? { api: masks.performance, k6: masks.efficient } : "묶지 않음(코어 종류가 하나)",
  k6Exit: k6Code,
  apiExit: apiCode,
  apiPid: api.pid,
  quiet,
  stats,
  phases: byPhase,
  s1,
  c2,
};
writeFileSync(path.join(runDir, "run.json"), JSON.stringify(report, null, 1));

const lines = [`# ${args.label} (${started.toISOString()})`, "", `풀 ${args.pool}, k6 종료 ${k6Code}, API 종료 ${apiCode}`, ""];
for (const p of byPhase) {
  const k = p.k6;
  lines.push(
    `- ${p.phase}: k6 요청 ${k?.requests ?? "-"}, p50 ${k?.p50?.toFixed(1) ?? "-"}ms, p95 ${k?.p95?.toFixed(1) ?? "-"}ms, ` +
      `버린 반복 ${k?.dropped ?? "-"} | ELU 평균 ${p.api.eluMean}, API CPU ${p.cpu.apiPctMean}%, postgres ${p.cpu.postgresPctMean}%, ` +
      `k6 ${p.cpu.k6PctMean}%, 연결 대기 p95 최대 ${p.api.connectWaitP95Max}ms`,
  );
}
if (s1) {
  const first = s1.firstHold as Record<string, number> | null;
  lines.push(
    "",
    `S1: 첫 선점 p50 ${first?.med ?? "-"}ms·p95 ${first?.["p(95)"] ?? "-"}ms, 마지막 표 T0+${s1.lastTicketAfterT0Ms}ms, ` +
      `팔린 좌석 ${s1.soldDuringRun}, 시도별 선점 성공 ${JSON.stringify(s1.holdSuccessByAttempt)}, 포기 ${s1.gaveUp}`,
  );
}
if (c2) lines.push("", `C2: ${c2.passed ? "통과" : "실패"} ${JSON.stringify({ seats: c2.seats, liveness: c2.liveness })}`);
writeFileSync(path.join(runDir, "summary.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
console.log(`결과: ${runDir}`);
if (c2 && !c2.passed) process.exitCode = 1;
