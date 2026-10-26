import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  diffStats,
  holdResponses,
  judgeC2,
  type K6Event,
  phaseProblems,
  phasesFrom,
  readK6Events,
  serverErrors,
  summarizeActivity,
  summarizeApi,
  summarizeCpu,
  summarizeK6,
} from "./report.js";

const at = (ms: number) => new Date(ms).toISOString();
const tick = (ms: number, overrides: Record<string, unknown> = {}) => ({
  type: "tick",
  at: at(ms),
  ms: 1000,
  pool: { total: 10, idle: 5, waiting: 0, connectWait: { p95: 1, max: 2, count: 3 }, connectErrors: 0, newConnections: 0 },
  node: { elu: 0.5, cpuPct: 50, loopDelayMs: { p50: 0, p99: 1, max: 2 }, gcMs: 1, heapMb: 100 },
  routes: {},
  webhooks: { sent: 1, retried: 0, givenUp: 0 },
  cleanup: [],
  ...overrides,
});

describe("부하 측정 요약", () => {
  it("k6 기록에서 시나리오가 남긴 JSON만 읽는다", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "load-report-"));
    try {
      const file = path.join(dir, "k6-log.jsonl");
      const lines = [
        { level: "info", source: "console", msg: JSON.stringify({ ev: "phase", name: "s2_1_100rps", startedAt: 1000 }) },
        { level: "warning", msg: "Request Failed" },
        { level: "info", source: "console", msg: "JSON이 아닌 줄" },
        { level: "info", source: "console", msg: JSON.stringify({ ev: "paid", user: 1, orderId: 2, seatIds: [3] }) },
      ];
      writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
      expect(readK6Events(file)).toEqual([
        { ev: "phase", name: "s2_1_100rps", startedAt: 1000 },
        { ev: "paid", user: 1, orderId: 2, seatIds: [3] },
      ]);
      expect(readK6Events(path.join(dir, "없는 파일"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("단계는 첫 반복이 남긴 시작 시각과 정한 길이로 정하고, 같은 단계의 표시는 한 번만 쓴다", () => {
    const phases = phasesFrom(
      [
        { ev: "phase", name: "s2_2_200rps", startedAt: 61_000 },
        { ev: "phase", name: "s2_1_100rps", startedAt: 1000 },
        { ev: "phase", name: "s2_1_100rps", startedAt: 5000 },
        { ev: "phase", name: "s1", startedAt: 0 },
      ],
      { s2_1_100rps: 60, s2_2_200rps: 60 },
    );
    expect(phases).toEqual([
      { name: "s1", start: 0, end: Number.POSITIVE_INFINITY },
      { name: "s2_1_100rps", start: 1000, end: 61_000 },
      { name: "s2_2_200rps", start: 61_000, end: 121_000 },
    ]);
  });

  it("API 1초 줄은 창 전체가 단계 안에 든 것만 묶는다. 경로별 서버 p95는 1초 p95의 가운데 값과 최대다", () => {
    const route = (p95: number, statuses: Record<string, number>, extra: Record<string, unknown> = {}) => ({
      routes: { "GET /x": { count: 10, p50: 1, p95, max: p95 + 1, statuses, ...extra } },
    });
    const ticks = [
      // 창 0~1초는 단계(1~4초) 앞이라 뺀다.
      tick(1000, route(100, { 200: 10 })),
      tick(2000, { ...route(1, { 200: 10 }), node: { elu: 0.2, cpuPct: 20, loopDelayMs: { p50: 0, p99: 3, max: 4 }, gcMs: 2, heapMb: 1 } }),
      tick(3000, route(3, { 200: 9, 500: 1 }, { errorCodes: { "57014": 1 }, aborted: 2 })),
      tick(4000, route(5, { 200: 10 })),
      // 창 4~5초는 단계 뒤라 뺀다.
      tick(5000, route(1000, { 200: 10 })),
    ];
    const summary = summarizeApi(ticks as never, { name: "p", start: 1000, end: 4000 });
    expect(summary.seconds).toBe(3);
    expect(summary.eluMean).toBe(0.4);
    expect(summary.eluMax).toBe(0.5);
    expect(summary.loopDelayP99Max).toBe(3);
    expect(summary.webhooks).toEqual({ sent: 3, retried: 0, givenUp: 0 });
    expect(summary.routes["GET /x"]).toEqual({
      count: 30,
      p95Median: 3,
      p95Max: 5,
      statuses: { 200: 29, 500: 1 },
      errorCodes: { "57014": 1 },
      aborted: 2,
    });
  });

  it("CPU와 DB 표본도 단계 안의 것만 묶는다. API는 그 PID의 값이고, 표본에 없으면 0이 아니라 null이다", () => {
    const cpu = [2000, 3000, 6000].map((ms, i) => ({
      at: at(ms),
      totalPct: 10 * (i + 1),
      postgresPct: 5,
      k6Pct: 20 * (i + 1),
      nodePctByPid: { "42": 50 * (i + 1), "7": 99 },
    }));
    expect(summarizeCpu(cpu, { name: "p", start: 1000, end: 3000 }, 42, 20)).toEqual({
      samples: 2,
      totalPctMean: 15,
      apiSamples: 2,
      apiPctMean: 75,
      apiPctMax: 100,
      postgresPctMean: 5,
      k6PctMean: 30,
      k6PctMax: 40,
      // (전체 % × 논리 프로세서 20) − API − postgres − k6: 200−50−5−20, 400−100−5−40
      othersPctMean: 190,
    });
    expect(summarizeCpu(cpu, { name: "p", start: 1000, end: 3000 }, 43, 20)).toMatchObject({ apiSamples: 0, apiPctMean: null, apiPctMax: null });
    const activity = [2000, 3000].map((ms, i) => ({
      at: at(ms),
      samples: 5,
      byState: { active: i + 1, idle: 4 },
      byWait: (i === 0 ? { "active Lock:advisory": 2 } : {}) as Record<string, number>,
    }));
    expect(summarizeActivity(activity, { name: "p", start: 1000, end: 3000 })).toEqual({
      seconds: 2,
      byState: { active: 1.5, idle: 4 },
      byWait: { "active Lock:advisory": 1 },
    });
  });

  it("단계의 무효 이유: 버린 반복, k6가 제 코어를 거의 다 씀, 다른 프로세스가 측정 전보다 한 코어를 넘게 더 씀", () => {
    expect(phaseProblems({ dropped: 0 }, { k6PctMax: 100, othersPctMean: 250 }, 8, 200)).toEqual([]);
    expect(phaseProblems(null, { k6PctMax: null, othersPctMean: null }, 8, 200)).toEqual([]);
    expect(phaseProblems({ dropped: 3 }, { k6PctMax: 720, othersPctMean: 301 }, 8, 200)).toEqual([
      "버린 반복 3",
      "k6 CPU 최대 720%(코어 8개)",
      "다른 프로세스 CPU 평균 301%(측정 전 200%)",
    ]);
  });

  it("k6 요약에서 그 시나리오의 하위 지표만 꺼낸다", () => {
    const summary = {
      metrics: {
        "http_req_duration{scenario:s2_1_100rps}": { values: { med: 5, "p(95)": 9, "p(99)": 12, max: 20, count: 6000 } },
        "http_req_duration{scenario:s2_1_100rps,name:GET /performances/:id/seats}": {
          values: { med: 5, "p(95)": 9, "p(99)": 12, max: 20, count: 6000 },
        },
        "http_req_duration{scenario:s2_10_100rps,name:GET /other}": { values: { med: 1, "p(95)": 1, "p(99)": 1, max: 1, count: 1 } },
        "http_reqs{scenario:s2_1_100rps}": { values: { count: 6000 } },
        "dropped_iterations{scenario:s2_1_100rps}": { values: { count: 3 } },
        "http_req_connecting{scenario:s2_1_100rps}": { values: { max: 1.5 } },
        "api_errors{scenario:s2_1_100rps,status:0}": { values: { count: 2 } },
        "api_errors{scenario:s2_1_100rps,code:SEAT_UNAVAILABLE}": { values: { count: 0 } },
      },
    };
    expect(summarizeK6(summary, "s2_1_100rps")).toEqual({
      requests: 6000,
      p50: 5,
      p95: 9,
      p99: 12,
      max: 20,
      dropped: 3,
      connectingMax: 1.5,
      routes: { "GET /performances/:id/seats": { count: 6000, p50: 5, p95: 9, p99: 12, max: 20 } },
      errors: { "status:0": 2 },
    });
  });

  it("표 통계는 뒤에서 앞을 빼고, 바뀐 것이 없는 표는 뺀다. checkpoint는 실제로 한 것(num_done)만 센다", () => {
    const snapshot = (n: number) => ({
      at: "",
      tables: [
        { relname: "performance_seats", seq_scan: n, idx_scan: 10 * n, n_tup_upd: 100 * n, n_tup_hot_upd: 0, n_dead_tup: 100 * n },
        { relname: "venues", seq_scan: 1, idx_scan: 0, n_tup_upd: 0, n_tup_hot_upd: 0, n_dead_tup: 0 },
      ],
      indexes: [],
      database: { deadlocks: n, xact_rollback: 2 * n, temp_files: 0, blks_read: n, blks_hit: 1000 * n },
      // 건너뛴 예약 checkpoint도 num_timed에 들어간다.
      checkpointer: { num_timed: 10 * n, num_requested: n, num_done: n },
    });
    const diff = diffStats(snapshot(1) as never, snapshot(3) as never);
    expect(diff.tables).toEqual([
      {
        table: "performance_seats",
        seqScan: 2,
        seqTupRead: 0,
        idxScan: 20,
        updates: 200,
        hotUpdates: 0,
        deadTuples: 300,
        autovacuum: 0,
        autoanalyze: 0,
      },
    ]);
    expect(diff).toMatchObject({ deadlocks: 2, rollbacks: 4, checkpoints: 2, blocksHit: 2000 });
  });
});

describe("C2 판정", () => {
  const hold = (status: number, code: string | null): K6Event => ({
    ev: "hold",
    user: 0,
    attempt: 1,
    seats: [1],
    status,
    code,
    at: 0,
    answeredAt: 1,
  });
  const clean = {
    invariants: { overLimit: 0 },
    leftovers: { heldSeats: 0 },
    clientFailures: { dbOnly: 0 },
    provider: { unknownToDb: 0 },
    server: { uniqueViolations: 0, webhook5xx: 0, unexpected5xx: 0, retryable503: 0 },
    deadlocks: 0,
    holds: { unexpected: 0, unknown: 0 },
    liveness: { neverPicked: 0, gaveUpNoSeats: 0 },
    users: 300,
    outcomes: 300,
    soldDuringRun: 500,
    k6Exit: 0,
    apiExit: 0,
  };

  it("선점 응답은 201과 경합의 409만 예상한 결과이고, 응답이 없는 것은 알 수 없음으로 센다", () => {
    expect(
      holdResponses([
        hold(201, null),
        hold(409, "SEAT_UNAVAILABLE"),
        hold(409, "HOLD_LIMIT"),
        hold(409, "SALES_CLOSED"),
        hold(401, "none"),
        hold(500, "none"),
        hold(0, "none"),
        { ev: "gave_up", user: 0, reason: "attempts", attempt: 4 },
      ]),
    ).toEqual({ unexpected: 3, unknown: 1 });
  });

  it("서버 오류는 23505, 웹훅 5xx, 그 밖의 5xx로 나눈다", () => {
    const ticks = [
      tick(1000, { routes: { "POST /webhooks/fake-pay": { statuses: { 200: 3, 500: 1 } } } }),
      tick(2000, { routes: { "POST /performances/:id/holds": { statuses: { 201: 5, 500: 2, 503: 1 }, errorCodes: { "23505": 1 } } } }),
      { type: "start", at: at(0) },
    ];
    // 503은 다시 보내라는 응답이라 따로 센다.
    expect(serverErrors(ticks as never)).toEqual({ uniqueViolations: 1, webhook5xx: 1, unexpected5xx: 2, retryable503: 1 });
  });

  it("모두 0이고 팔렸고 사용자마다 결과가 있고 k6·API가 정상으로 끝나야 통과다", () => {
    expect(judgeC2(clean)).toEqual({ passed: true, reasons: [] });
  });

  it("거짓으로 통과하지 않는다: 아무것도 안 팔림, 선점이 401·500으로 거절됨, 결과가 빠진 사용자, k6·API 실패", () => {
    expect(judgeC2({ ...clean, soldDuringRun: 0 }).reasons).toEqual(["측정 중에 팔린 좌석이 없음"]);
    expect(judgeC2({ ...clean, holds: { unexpected: 200, unknown: 0 } }).reasons).toEqual(["예상하지 않은 선점 응답 200"]);
    expect(judgeC2({ ...clean, outcomes: 290 }).reasons).toEqual(["결과를 남긴 사용자 290/300"]);
    expect(judgeC2({ ...clean, k6Exit: 108 }).reasons).toEqual(["k6 종료 코드 108"]);
    expect(judgeC2({ ...clean, apiExit: "timeout" }).reasons).toEqual(["API 종료 timeout"]);
    expect(judgeC2({ ...clean, holds: { unexpected: 0, unknown: 3 } }).passed).toBe(true);
  });

  it("불변식·남은 일·대조·서버 오류·교착 하나라도 0이 아니면 실패다", () => {
    expect(judgeC2({ ...clean, invariants: { overLimit: 1 } }).reasons).toEqual(["불변식 overLimit 1"]);
    expect(judgeC2({ ...clean, leftovers: { heldSeats: 2 } }).reasons).toEqual(["남은 일 heldSeats 2"]);
    expect(judgeC2({ ...clean, clientFailures: { dbOnly: 1 } }).reasons).toEqual(["클라이언트 대조 dbOnly 1"]);
    expect(judgeC2({ ...clean, provider: { unknownToDb: 1 } }).reasons).toEqual(["결제사 대조 unknownToDb 1"]);
    expect(judgeC2({ ...clean, server: { uniqueViolations: 0, webhook5xx: 0, unexpected5xx: 4, retryable503: 0 } }).reasons).toEqual([
      "서버 unexpected5xx 4",
    ]);
    // 결제사 호출 시간 초과의 503(Retry-After)은 설계한 응답이라 실패가 아니다.
    expect(judgeC2({ ...clean, server: { uniqueViolations: 0, webhook5xx: 0, unexpected5xx: 0, retryable503: 7 } }).passed).toBe(true);
    expect(judgeC2({ ...clean, deadlocks: 1 }).reasons).toEqual(["교착 1"]);
  });

  it("살아 있는지: 고르지 않은 빈 좌석이 남았는데 좌석이 없다며 포기한 사용자가 있을 때만 실패다", () => {
    expect(judgeC2({ ...clean, liveness: { neverPicked: 10, gaveUpNoSeats: 0 } }).passed).toBe(true);
    expect(judgeC2({ ...clean, liveness: { neverPicked: 0, gaveUpNoSeats: 5 } }).passed).toBe(true);
    expect(judgeC2({ ...clean, liveness: { neverPicked: 10, gaveUpNoSeats: 5 } }).reasons).toEqual([
      "살아 있지 않음: 고르지 않은 빈 좌석 10, 좌석이 없다며 포기 5",
    ]);
  });
});
