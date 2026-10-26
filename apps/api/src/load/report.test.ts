import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diffStats, phasesFrom, readK6Events, summarizeActivity, summarizeApi, summarizeCpu, summarizeK6 } from "./report.js";

const at = (ms: number) => new Date(ms).toISOString();
const tick = (ms: number, overrides: Record<string, unknown> = {}) => ({
  type: "tick",
  at: at(ms),
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

  it("API 1초 줄은 단계 안의 것만 묶는다. 경로별 서버 p95는 1초 p95의 가운데 값과 최대다", () => {
    const route = (p95: number, statuses: Record<string, number>, extra: Record<string, unknown> = {}) => ({
      routes: { "GET /x": { count: 10, p50: 1, p95, max: p95 + 1, statuses, ...extra } },
    });
    const ticks = [
      tick(500, route(100, { 200: 10 })),
      tick(1000, { ...route(1, { 200: 10 }), node: { elu: 0.2, cpuPct: 20, loopDelayMs: { p50: 0, p99: 3, max: 4 }, gcMs: 2, heapMb: 1 } }),
      tick(2000, route(3, { 200: 9, 500: 1 }, { errorCodes: { "57014": 1 }, aborted: 2 })),
      tick(3000, route(5, { 200: 10 })),
      tick(4000, route(1000, { 200: 10 })),
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

  it("CPU와 DB 표본도 단계 안의 것만 묶고, API는 그 PID의 값을 쓴다", () => {
    const cpu = [1000, 2000, 5000].map((ms, i) => ({
      at: at(ms),
      totalPct: 10 * (i + 1),
      postgresPct: 5,
      k6Pct: 20 * (i + 1),
      nodePctByPid: { "42": 50 * (i + 1), "7": 99 },
    }));
    expect(summarizeCpu(cpu, { name: "p", start: 1000, end: 3000 }, 42)).toEqual({
      totalPctMean: 15,
      apiPctMean: 75,
      apiPctMax: 100,
      postgresPctMean: 5,
      k6PctMean: 30,
      k6PctMax: 40,
    });
    const activity = [1000, 2000].map((ms, i) => ({
      at: at(ms),
      samples: 5,
      byState: { active: i + 1, idle: 4 },
      byWait: (i === 0 ? { "active Lock:advisory": 2 } : {}) as Record<string, number>,
    }));
    expect(summarizeActivity(activity, { name: "p", start: 0, end: 3000 })).toEqual({
      seconds: 2,
      byState: { active: 1.5, idle: 4 },
      byWait: { "active Lock:advisory": 1 },
    });
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

  it("표 통계는 뒤에서 앞을 빼고, 바뀐 것이 없는 표는 뺀다", () => {
    const snapshot = (n: number) => ({
      at: "",
      tables: [
        { relname: "performance_seats", seq_scan: n, idx_scan: 10 * n, n_tup_upd: 100 * n, n_tup_hot_upd: 0, n_dead_tup: 100 * n },
        { relname: "venues", seq_scan: 1, idx_scan: 0, n_tup_upd: 0, n_tup_hot_upd: 0, n_dead_tup: 0 },
      ],
      indexes: [],
      database: { deadlocks: n, xact_rollback: 2 * n, temp_files: 0, blks_read: n, blks_hit: 1000 * n },
      checkpointer: { num_timed: n, num_requested: 0 },
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
