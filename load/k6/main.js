import { ERROR_CODES } from "./lib.js";

export { s1 } from "./s1.js";
export { s2 } from "./s2.js";
export { s3 } from "./s3.js";

// 부하 시나리오의 입구(DESIGN 6.6). 실행기(run-cli.ts)가 환경 변수로 무엇을 얼마나 돌릴지 정한다.
// SCENARIOS=s1,s2,s3 중 몇 개.
// S2_RATES·S3_RATES: 초당 도착률. 쉼표로 여러 개면 단계로 올린다(꺾이는 점 찾기).
// S2_STEP_S·S3_STEP_S: 단계마다 초. S2_WARMUP_S·S3_WARMUP_S: 첫 도착률로 먼저 돌리는 예열 초(요약에서 따로 나온다).
// 단계와 예열을 시나리오로 나눠, 예열을 뺀 단계마다의 백분위를 요약에서 바로 읽는다.

const ROUTES = {
  s1: ["GET /performances/:id/seats", "POST /performances/:id/holds", "POST /holds/:id/orders", "POST /orders/:id/payments", "GET /orders/:id"],
  s2: ["GET /performances/:id/seats"],
  s3: [
    "GET /performances/:id/me",
    "POST /performances/:id/holds",
    "POST /holds/:id/orders",
    "POST /orders/:id/payments",
    "GET /orders/:id",
    "POST /orders/:id/cancel",
    "GET /orders",
  ],
};
const OUTCOMES = {
  s1: ["paid", "pending", "failed", "cancelled", "no_seats", "hold_rejected", "attempts", "left_after_hold", "left_after_order", "order_failed", "payment_rejected"],
  s3: ["paid", "pending", "failed", "cancelled", "hold_failed", "order_failed", "payment_rejected", "cancel_failed"],
};
// 한 반복이 걸리는 시간의 어림(초). 미리 만들어 둘 VU 수를 정한다.
const ITERATION_SECONDS = { s2: 0.2, s3: 4 };

const list = (value) => (value || "").split(",").map((s) => s.trim()).filter(Boolean);
const selected = list(__ENV.SCENARIOS);
if (selected.length === 0) throw new Error("SCENARIOS가 없습니다(s1, s2, s3)");

const scenarios = {};
const thresholds = {};
const surface = (metric) => {
  thresholds[metric] = ["count>=0"];
};
const surfaceTrend = (metric) => {
  thresholds[metric] = ["max>=0"];
};

function addScenario(name, exec, config) {
  scenarios[name] = { ...config, exec, tags: { flow: exec } };
  surface(`http_reqs{scenario:${name}}`);
  surfaceTrend(`http_req_duration{scenario:${name}}`);
  surfaceTrend(`http_req_connecting{scenario:${name}}`);
  for (const route of ROUTES[exec]) surfaceTrend(`http_req_duration{scenario:${name},name:${route}}`);
  for (const code of ERROR_CODES) surface(`api_errors{scenario:${name},code:${code}}`);
  for (const status of ["0", "500", "503"]) surface(`api_errors{scenario:${name},status:${status}}`);
  for (const outcome of OUTCOMES[exec] || []) surface(`${exec}_outcome{scenario:${name},outcome:${outcome}}`);
  if (config.executor === "constant-arrival-rate") surface(`dropped_iterations{scenario:${name}}`);
}

// 일정 도착률 단계들. 예열이 있으면 첫 도착률로 먼저 돈다. 시나리오마다 반복 번호가 0부터라 S3에는 OFFSET을 준다.
function arrivalSteps(exec) {
  const key = exec.toUpperCase();
  const rates = list(__ENV[`${key}_RATES`]).map(Number);
  if (rates.length === 0 || rates.some((r) => !(r > 0))) throw new Error(`${key}_RATES가 없거나 잘못됐습니다`);
  const step = Number(__ENV[`${key}_STEP_S`] || 60);
  const warmup = Number(__ENV[`${key}_WARMUP_S`] || 0);
  const phases = warmup > 0 ? [{ name: `${exec}_warmup`, rate: rates[0], seconds: warmup }] : [];
  rates.forEach((rate, i) => phases.push({ name: `${exec}_${i + 1}_${rate}rps`, rate, seconds: step }));
  let start = 0;
  let offset = 0;
  for (const { name, rate, seconds } of phases) {
    const maxVUs = Math.min(4000, Math.ceil(rate * ITERATION_SECONDS[exec] * 5) + 50);
    addScenario(name, exec, {
      executor: "constant-arrival-rate",
      rate,
      timeUnit: "1s",
      duration: `${seconds}s`,
      startTime: `${start}s`,
      preAllocatedVUs: Math.min(maxVUs, Math.ceil(rate * ITERATION_SECONDS[exec] * 1.5) + 10),
      maxVUs,
      gracefulStop: "30s",
      env: { OFFSET: String(offset) },
    });
    start += seconds;
    // 한 단계의 반복은 도착률 × 시간을 넘지 않는다.
    offset += rate * seconds;
  }
}

for (const exec of selected) {
  if (exec === "s1") {
    const users = Number(__ENV.S1_USERS);
    if (!(users > 0)) throw new Error("S1_USERS가 없습니다");
    addScenario("s1", "s1", { executor: "per-vu-iterations", vus: users, iterations: 1, maxDuration: "20m", gracefulStop: "30s" });
    surfaceTrend("s1_first_hold");
    for (const attempt of ["1", "2", "3", "4"]) surface(`s1_hold_success{attempt:${attempt}}`);
  } else if (exec === "s2" || exec === "s3") {
    arrivalSteps(exec);
  } else {
    throw new Error(`모르는 시나리오: ${exec}`);
  }
}

export const options = {
  scenarios,
  thresholds,
  summaryTrendStats: ["avg", "min", "med", "p(95)", "p(99)", "max", "count"],
};

export function handleSummary(data) {
  const out = __ENV.OUT_DIR;
  const lines = [];
  for (const name of Object.keys(scenarios)) {
    const duration = data.metrics[`http_req_duration{scenario:${name}}`];
    const reqs = data.metrics[`http_reqs{scenario:${name}}`];
    const dropped = data.metrics[`dropped_iterations{scenario:${name}}`];
    if (!duration) continue;
    lines.push(
      `${name}: 요청 ${reqs ? reqs.values.count : 0}, p50 ${duration.values.med.toFixed(1)}ms, ` +
        `p95 ${duration.values["p(95)"].toFixed(1)}ms, 버린 반복 ${dropped ? dropped.values.count : 0}`,
    );
  }
  const result = { stdout: `${lines.join("\n")}\n` };
  if (out) result[`${out}/k6-summary.json`] = JSON.stringify(data, null, 1);
  return result;
}
