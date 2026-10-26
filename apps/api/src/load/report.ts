import { existsSync, readFileSync } from "node:fs";
import type pg from "pg";
import { checkInvariants, checkLeftovers, compareClientPaid, compareProvider, seatCounts } from "./checks.js";
import type { StatsSnapshot } from "./samplers.js";

// 측정 한 번의 파일을 읽어 단계별 요약과 C2 판정을 만든다(DESIGN 6.6 "지표와 표본", "합격 확인(C2)").

export const readJsonLines = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as T)
    : [];

// k6를 --log-format=json으로 띄우면 console.log 한 줄이 {"source":"console","msg":"…"}다. msg가 시나리오가 남긴 JSON이다.
export type K6Event =
  | { ev: "phase"; name: string; startedAt: number }
  | { ev: "hold"; user: number; attempt: number; seats: number[]; status: number; code: string | null; at: number; answeredAt: number }
  | { ev: "paid"; user: number; orderId: number; seatIds: number[] }
  | { ev: "result"; user: number; orderId: number; result: string }
  | { ev: "gave_up"; user: number; reason: string; attempt: number };

export function readK6Events(file: string): K6Event[] {
  const events: K6Event[] = [];
  for (const line of readJsonLines<{ source?: string; msg?: string }>(file)) {
    if (line.source !== "console" || !line.msg) continue;
    try {
      events.push(JSON.parse(line.msg) as K6Event);
    } catch {
      // 시나리오가 남긴 것이 아닌 줄
    }
  }
  return events;
}

export type Phase = { name: string; start: number; end: number };

// 시나리오 이름과 길이(초)로 단계의 시각을 정한다. 시작은 k6가 남긴 표시(첫 반복의 시나리오 시작 시각)다.
export function phasesFrom(events: K6Event[], seconds: Record<string, number>): Phase[] {
  const phases: Phase[] = [];
  for (const event of events) {
    if (event.ev !== "phase" || phases.some((p) => p.name === event.name)) continue;
    const length = seconds[event.name];
    phases.push({ name: event.name, start: event.startedAt, end: length ? event.startedAt + length * 1000 : Number.POSITIVE_INFINITY });
  }
  return phases.sort((a, b) => a.start - b.start);
}

type Tick = {
  type: string;
  at: string;
  ms?: number;
  pool: { total: number; idle: number; waiting: number; connectWait: { p95: number; max: number; count: number } | null; connectErrors: number; newConnections: number };
  node: { elu: number; cpuPct: number; loopDelayMs: { p50: number; p99: number; max: number }; gcMs: number; heapMb: number };
  routes: Record<string, { count?: number; p50?: number; p95?: number; max?: number; statuses: Record<string, number>; errorCodes?: Record<string, number>; aborted?: number }>;
  webhooks: { sent: number; retried: number; givenUp: number };
  cleanup: { ms: number }[];
};
type CpuLine = { at: string; totalPct: number; postgresPct: number; k6Pct: number; nodePctByPid: Record<string, number> };
type ActivityLine = { at: string; samples: number; byState: Record<string, number>; byWait: Record<string, number> };

// 1초 줄의 at은 그 창이 끝난 시각이다. 창 전체가 단계 안에 든 줄만 쓴다(단계 앞뒤의 1초가 섞이지 않게).
const within = (at: string, phase: Phase, windowMs = 1000) => {
  const end = Date.parse(at);
  return end - windowMs >= phase.start && end <= phase.end;
};
const mean = (values: number[]) => (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100 : null);
const maxOf = (values: number[]) => (values.length ? Math.max(...values) : null);
const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
};
const sumBy = (rows: Record<string, number>[]) => {
  const total: Record<string, number> = {};
  for (const row of rows) for (const [k, v] of Object.entries(row)) total[k] = (total[k] ?? 0) + v;
  return total;
};

// API 1초 줄을 단계로 묶는다. 경로별 서버 p95는 1초 줄마다의 p95의 가운데 값과 최대다(1초 p95를 합쳐 전체 p95를 낼 수는 없다).
// 그래서 k6 p95와 바로 견주지 않는다. k6 p95가 서버의 1초 p95 최대보다도 훨씬 크면 Fastify에 닿기 전에 기다린 것으로 본다.
export function summarizeApi(ticks: Tick[], phase: Phase) {
  const rows = ticks.filter((t) => t.type === "tick" && within(t.at, phase, t.ms ?? 1000));
  const routes: Record<string, unknown> = {};
  const names = new Set(rows.flatMap((t) => Object.keys(t.routes)));
  for (const name of names) {
    const per = rows.map((t) => t.routes[name]).filter((r) => r !== undefined);
    routes[name] = {
      count: per.reduce((a, r) => a + (r.count ?? 0), 0),
      p95Median: median(per.flatMap((r) => (r.p95 === undefined ? [] : [r.p95]))),
      p95Max: maxOf(per.flatMap((r) => (r.p95 === undefined ? [] : [r.p95]))),
      statuses: sumBy(per.map((r) => r.statuses)),
      errorCodes: sumBy(per.map((r) => r.errorCodes ?? {})),
      aborted: per.reduce((a, r) => a + (r.aborted ?? 0), 0),
    };
  }
  return {
    seconds: rows.length,
    eluMean: mean(rows.map((t) => t.node.elu)),
    eluMax: maxOf(rows.map((t) => t.node.elu)),
    cpuPctMean: mean(rows.map((t) => t.node.cpuPct)),
    loopDelayP99Max: maxOf(rows.map((t) => t.node.loopDelayMs.p99)),
    gcMsPerSecond: mean(rows.map((t) => t.node.gcMs)),
    poolWaitingMax: maxOf(rows.map((t) => t.pool.waiting)),
    connectWaitP95Max: maxOf(rows.flatMap((t) => (t.pool.connectWait ? [t.pool.connectWait.p95] : []))),
    connectErrors: rows.reduce((a, t) => a + t.pool.connectErrors, 0),
    webhooks: sumBy(rows.map((t) => t.webhooks)),
    cleanupRounds: rows.reduce((a, t) => a + t.cleanup.length, 0),
    cleanupMsMax: maxOf(rows.flatMap((t) => t.cleanup.map((c) => c.ms))),
    routes,
  };
}

// 프로세스 값은 한 코어를 100으로 본 %, 전체(totalPct)는 모든 논리 프로세서를 100으로 본 %다.
// API의 PID가 표본에 없으면 0이 아니라 null이다.
export function summarizeCpu(lines: CpuLine[], phase: Phase, apiPid: number, logicalProcessors = 20) {
  const rows = lines.filter((l) => within(l.at, phase));
  const api = rows.flatMap((l) => {
    const value = l.nodePctByPid[String(apiPid)];
    return value === undefined ? [] : [value];
  });
  return {
    samples: rows.length,
    totalPctMean: mean(rows.map((l) => l.totalPct)),
    apiSamples: api.length,
    apiPctMean: mean(api),
    apiPctMax: maxOf(api),
    postgresPctMean: mean(rows.map((l) => l.postgresPct)),
    k6PctMean: mean(rows.map((l) => l.k6Pct)),
    k6PctMax: maxOf(rows.map((l) => l.k6Pct)),
    // 측정과 상관없는 프로세스가 쓴 CPU(한 코어 = 100).
    othersPctMean: mean(
      rows.map((l) => l.totalPct * logicalProcessors - (l.nodePctByPid[String(apiPid)] ?? 0) - l.postgresPct - l.k6Pct),
    ),
  };
}

// 단계가 무효인 이유(DESIGN 6.6): 버린 반복, k6가 제 코어를 거의 다 씀, 다른 프로세스가 한 코어 넘게 씀.
export function phaseProblems(
  k6: { dropped: number } | null,
  cpu: { k6PctMax: number | null; othersPctMean: number | null },
  k6Cores: number,
) {
  const problems: string[] = [];
  if (k6 && k6.dropped > 0) problems.push(`버린 반복 ${k6.dropped}`);
  if (cpu.k6PctMax !== null && cpu.k6PctMax >= 90 * k6Cores) problems.push(`k6 CPU 최대 ${cpu.k6PctMax}%(코어 ${k6Cores}개)`);
  if (cpu.othersPctMean !== null && cpu.othersPctMean > 100) problems.push(`다른 프로세스 CPU 평균 ${cpu.othersPctMean}%`);
  return problems;
}

export function summarizeActivity(lines: ActivityLine[], phase: Phase) {
  const rows = lines.filter((l) => within(l.at, phase));
  const avg = (pick: (l: ActivityLine) => Record<string, number>) => {
    const total = sumBy(rows.map(pick));
    return Object.fromEntries(Object.entries(total).map(([k, v]) => [k, Math.round((v / Math.max(rows.length, 1)) * 100) / 100]));
  };
  return { seconds: rows.length, byState: avg((l) => l.byState), byWait: avg((l) => l.byWait) };
}

// k6 요약에서 시나리오 하나의 숫자. threshold를 건 하위 지표만 있다(main.js).
export function summarizeK6(summary: { metrics: Record<string, { values: Record<string, number> }> }, scenario: string) {
  const metric = (name: string) => summary.metrics[name]?.values;
  const duration = metric(`http_req_duration{scenario:${scenario}}`);
  const routes: Record<string, unknown> = {};
  const errors: Record<string, number> = {};
  for (const [name, value] of Object.entries(summary.metrics)) {
    const route = name.match(new RegExp(`^http_req_duration\\{scenario:${scenario},name:(.+)\\}$`));
    if (route && value.values.count) {
      routes[route[1]!] = { count: value.values.count, p50: value.values.med, p95: value.values["p(95)"], p99: value.values["p(99)"], max: value.values.max };
    }
    const error = name.match(new RegExp(`^api_errors\\{scenario:${scenario},(code|status):(.+)\\}$`));
    if (error && value.values.count) errors[`${error[1]}:${error[2]}`] = value.values.count;
  }
  return {
    requests: metric(`http_reqs{scenario:${scenario}}`)?.count ?? 0,
    p50: duration?.med ?? null,
    p95: duration?.["p(95)"] ?? null,
    p99: duration?.["p(99)"] ?? null,
    max: duration?.max ?? null,
    dropped: metric(`dropped_iterations{scenario:${scenario}}`)?.count ?? 0,
    connectingMax: metric(`http_req_connecting{scenario:${scenario}}`)?.max ?? null,
    routes,
    errors,
  };
}

export function diffStats(before: StatsSnapshot, after: StatsSnapshot) {
  const num = (v: unknown) => Number(v ?? 0);
  const tables = after.tables.map((row) => {
    const prev = before.tables.find((t) => t.relname === row.relname) ?? {};
    const delta = (key: string) => num(row[key]) - num(prev[key]);
    return {
      table: row.relname,
      seqScan: delta("seq_scan"),
      seqTupRead: delta("seq_tup_read"),
      idxScan: delta("idx_scan"),
      updates: delta("n_tup_upd"),
      hotUpdates: delta("n_tup_hot_upd"),
      deadTuples: num(row.n_dead_tup),
      autovacuum: delta("autovacuum_count"),
      autoanalyze: delta("autoanalyze_count"),
    };
  });
  const db = (key: string) => num(after.database[key]) - num(before.database[key]);
  return {
    tables: tables.filter((t) => t.seqScan || t.idxScan || t.updates || t.deadTuples),
    deadlocks: db("deadlocks"),
    rollbacks: db("xact_rollback"),
    tempFiles: db("temp_files"),
    blocksRead: db("blks_read"),
    blocksHit: db("blks_hit"),
    // PG 17부터 num_timed는 건너뛴(할 일이 없던) 예약 checkpoint도 센다. 실제로 한 것은 num_done이다.
    checkpoints: num(after.checkpointer.num_done) - num(before.checkpointer.num_done),
  };
}

// k6 기록에서 선점 응답을 나눈다. 201과 경합의 409(SEAT_UNAVAILABLE·HOLD_LIMIT)만 예상한 결과다.
// 응답이 없는 것(0, 시간 초과·끊김)은 서버에서 성공했을 수도 있어 실패가 아니라 "알 수 없음"으로 센다.
export function holdResponses(events: K6Event[]) {
  let unexpected = 0;
  let unknown = 0;
  for (const e of events) {
    if (e.ev !== "hold") continue;
    if (e.status === 0) unknown++;
    else if (e.status === 201) continue;
    else if (!(e.status === 409 && (e.code === "SEAT_UNAVAILABLE" || e.code === "HOLD_LIMIT"))) unexpected++;
  }
  return { unexpected, unknown };
}

// API 1초 줄의 23505(유효한 표 중복 등 DB 제약), 웹훅 5xx, 그 밖의 5xx.
export function serverErrors(ticks: Tick[]) {
  let uniqueViolations = 0;
  let webhook5xx = 0;
  let other5xx = 0;
  for (const tick of ticks) {
    if (tick.type !== "tick") continue;
    for (const [name, route] of Object.entries(tick.routes)) {
      uniqueViolations += route.errorCodes?.["23505"] ?? 0;
      for (const [status, count] of Object.entries(route.statuses)) {
        if (Number(status) < 500) continue;
        if (name === "POST /webhooks/fake-pay") webhook5xx += count;
        else other5xx += count;
      }
    }
  }
  return { uniqueViolations, webhook5xx, other5xx };
}

type C2Parts = {
  invariants: Record<string, number>;
  leftovers: Record<string, number>;
  clientFailures: Record<string, number>;
  provider: Record<string, number>;
  server: { uniqueViolations: number; webhook5xx: number; other5xx: number };
  deadlocks: number;
  holds: { unexpected: number; unknown: number };
  liveness: { neverPicked: number; gaveUpNoSeats: number };
  users: number;
  outcomes: number;
  soldDuringRun: number;
  k6Exit: number | null;
  apiExit: number | null | "timeout";
};

// C2 판정. 실패한 이유를 모두 돌려주고, 이유가 없어야 통과다. 아무것도 팔지 않거나 k6·API가 실패해도 통과하지 않게
// 판매 수, 사용자마다 결과가 있는지, 예상하지 않은 선점 응답, 프로세스 종료 코드를 함께 본다(DB를 쓰지 않아 테스트한다).
export function judgeC2(parts: C2Parts) {
  const reasons: string[] = [];
  const nonZero = (label: string, counts: Record<string, number>) => {
    for (const [name, count] of Object.entries(counts)) if (count !== 0) reasons.push(`${label} ${name} ${count}`);
  };
  nonZero("불변식", parts.invariants);
  nonZero("남은 일", parts.leftovers);
  nonZero("클라이언트 대조", parts.clientFailures);
  nonZero("결제사 대조", parts.provider);
  nonZero("서버", parts.server);
  if (parts.deadlocks !== 0) reasons.push(`교착 ${parts.deadlocks}`);
  if (parts.holds.unexpected !== 0) reasons.push(`예상하지 않은 선점 응답 ${parts.holds.unexpected}`);
  // (f) 아무도 고르지 않은 빈 좌석(측정 내내 비어 있던 좌석)이 남았는데, 지도에 빈 좌석이 없다며 포기한 사용자가 있으면
  // 지도가 빈 좌석을 보여 주지 않은 것이다. 네 번 다 다른 사람에게 져서 포기한 것은 경합의 결과라 실패가 아니다.
  if (parts.liveness.neverPicked > 0 && parts.liveness.gaveUpNoSeats > 0) {
    reasons.push(`살아 있지 않음: 고르지 않은 빈 좌석 ${parts.liveness.neverPicked}, 좌석이 없다며 포기 ${parts.liveness.gaveUpNoSeats}`);
  }
  if (parts.soldDuringRun === 0) reasons.push("측정 중에 팔린 좌석이 없음");
  if (parts.outcomes !== parts.users) reasons.push(`결과를 남긴 사용자 ${parts.outcomes}/${parts.users}`);
  if (parts.k6Exit !== 0) reasons.push(`k6 종료 코드 ${parts.k6Exit}`);
  if (parts.apiExit !== 0) reasons.push(`API 종료 ${parts.apiExit}`);
  return { passed: reasons.length === 0, reasons };
}

// C2 판정에 쓸 DB 쪽 값을 모은다(S1 회차).
export async function collectC2(
  pool: pg.Pool,
  input: {
    performanceId: number;
    userIds: number[];
    events: K6Event[];
    providerPayments: { paymentId: number; outcome: "succeeded" | "failed"; refunded: boolean }[];
  },
) {
  const { performanceId, userIds, events, providerPayments } = input;
  const invariants = await checkInvariants(pool, [performanceId]);
  const leftovers = await checkLeftovers(pool, [performanceId]);
  const seats = await seatCounts(pool, performanceId);
  const clientPaid = events.flatMap((e) => (e.ev === "paid" ? [{ orderId: e.orderId, seatIds: e.seatIds }] : []));
  const clientGaveUp = events.flatMap((e) => (e.ev === "result" && e.result === "pending" ? [e.orderId] : []));
  const client = await compareClientPaid(pool, { performanceId, userIds, clientPaid, clientGaveUp });
  const provider = await compareProvider(pool, { performanceId, userIds, providerPayments });
  const { rows } = await pool.query<{ seat_id: number }>(
    "select seat_id from performance_seats where performance_id = $1 and status = 'available'",
    [performanceId],
  );
  const picked = new Set(events.flatMap((e) => (e.ev === "hold" ? e.seats : [])));
  const gaveUp = (reason: string) => events.filter((e) => e.ev === "gave_up" && e.reason === reason).length;
  return {
    invariants,
    leftovers,
    seats,
    client,
    provider,
    liveness: {
      available: rows.length,
      neverPicked: rows.filter((r) => !picked.has(Number(r.seat_id))).length,
      gaveUpNoSeats: gaveUp("no_seats"),
      gaveUpAfterAttempts: gaveUp("attempts"),
      gaveUpMapFailed: gaveUp("map_failed"),
      gaveUpRejected: gaveUp("hold_rejected"),
    },
    paidByClient: clientPaid.length,
  };
}
