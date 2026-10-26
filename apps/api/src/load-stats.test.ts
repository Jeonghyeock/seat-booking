import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "./app.js";
import { createDb } from "./db/client.js";
import { createPool } from "./db/pool.js";
import { FakePaymentProvider } from "./fake-pay.js";
import { createLoadStats, errorCode } from "./load-stats.js";

describe("부하 측정 지표(LOAD_STATS)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "load-stats-"));
  const pool = createPool({ connectionString: inject("databaseUrl") });
  const db = createDb(pool);
  const provider = new FakePaymentProvider("load-stats-test-secret");
  const config = { poolMax: 10, connectTimeoutMs: 0, logLevel: "info" as const, loadStatsDir: dir };
  // 타이머로는 쓰지 않고 flush를 직접 부른다.
  const stats = createLoadStats({ dir, pool, provider, config, intervalMs: 3_600_000 });
  const app = buildApp(pool, {}, { paymentProvider: provider, onServerError: stats.recordServerError });
  // 0으로 나누면 pg 오류(22012)다. 하나는 pg 오류를 그대로, 하나는 Drizzle이 싸서 던진다.
  app.get("/test/pg-error", async () => pool.query("select 1/0"));
  app.get("/test/drizzle-error", async () => db.execute(sql`select 1/0`));
  stats.attach(app);
  stats.start();
  afterAll(async () => {
    await app.close();
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  const lines = () =>
    readFileSync(path.join(dir, "api-stats.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const lastLine = () => {
    stats.flush();
    return lines().at(-1);
  };

  it("첫 줄에 설정을 쓰고, 1초 줄에 경로별 요청 수·상태·서버 처리 시간과 5xx의 오류 코드를 쓴다", async () => {
    for (let i = 0; i < 3; i++) expect((await app.inject("/health")).statusCode).toBe(200);
    expect((await app.inject("/test/pg-error")).statusCode).toBe(500);
    expect((await app.inject("/test/drizzle-error")).statusCode).toBe(500);
    expect((await app.inject("/no-such-route")).statusCode).toBe(404);
    const tick = lastLine();
    expect(lines()[0]).toMatchObject({ type: "start", pid: process.pid, config });
    expect(tick.type).toBe("tick");
    expect(tick.routes["GET /health"]).toMatchObject({ count: 3, statuses: { 200: 3 } });
    const { p50, p95, max } = tick.routes["GET /health"];
    expect(0 <= p50 && p50 <= p95 && p95 <= max).toBe(true);
    expect(tick.routes["GET /health"].errorCodes).toBeUndefined();
    expect(tick.routes["GET /test/pg-error"]).toMatchObject({ statuses: { 500: 1 }, errorCodes: { "22012": 1 } });
    expect(tick.routes["GET /test/drizzle-error"]).toMatchObject({ statuses: { 500: 1 }, errorCodes: { "22012": 1 } });
    expect(tick.routes["GET (없는 경로)"]).toMatchObject({ statuses: { 404: 1 } });
  });

  it("풀은 연결 수와 연결을 받기까지 기다린 시간을 쓴다. 단일 질의도 트랜잭션도 잰다", async () => {
    await pool.query("select 1");
    await db.transaction(async (tx) => tx.execute(sql`select 1`));
    const tick = lastLine();
    expect(tick.pool.connectWait.count).toBe(2);
    expect(tick.pool.connectErrors).toBe(0);
    expect(tick.pool.total).toBeGreaterThanOrEqual(1);
    expect(tick.pool.waiting).toBe(0);
  });

  it("Node 지표(이벤트 루프 사용률·지연, CPU, GC, 힙)를 쓴다", () => {
    const { node } = lastLine();
    expect(node.elu).toBeGreaterThanOrEqual(0);
    expect(node.elu).toBeLessThanOrEqual(1);
    for (const value of [node.cpuPct, node.loopDelayMs.p50, node.loopDelayMs.p99, node.loopDelayMs.max, node.gcMs, node.gcCount]) {
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(node.heapMb).toBeGreaterThan(0);
  });

  it("다음 줄은 지난 줄 뒤의 값만 쓴다", async () => {
    await app.inject("/health");
    lastLine();
    const tick = lastLine();
    expect(tick.routes).toEqual({});
    expect(tick.pool.connectWait).toBeNull();
    expect(tick.cleanup).toEqual([]);
  });

  it("웹훅도 경로별에 잡히고, 가짜 결제사가 보낸 수를 쓴다. 정리 작업 한 바퀴도 쓴다", async () => {
    await provider.create({ paymentId: 2_000_000_001, scenario: "success", delayMs: 0 });
    await provider.flush();
    const counts = { releasedSeats: 1, cancelledOrders: 2, refunded: 0, refundFailed: 0, reconciled: 3, deletedKeys: 0, deletedSessions: 0 };
    stats.recordCleanup(counts, 12.345);
    const tick = lastLine();
    expect(tick.routes["POST /webhooks/fake-pay"].count).toBe(1);
    expect(tick.webhooks).toEqual({ sent: 1, retried: 0, givenUp: 0 });
    expect(tick.cleanup).toEqual([{ ...counts, ms: 12.35 }]);
  });

  it("멈추면 남은 값을 쓰고, 가짜 결제사가 아는 결제를 fake-pay.json에 쓴다", async () => {
    await provider.create({ paymentId: 2_000_000_002, scenario: "fail", delayMs: 0 });
    await provider.refund(2_000_000_001);
    await app.inject("/health");
    stats.stop();
    expect(lines().at(-1).routes["GET /health"].count).toBe(1);
    expect(JSON.parse(readFileSync(path.join(dir, "fake-pay.json"), "utf8"))).toEqual([
      { paymentId: 2_000_000_001, outcome: "succeeded", refunded: true },
      { paymentId: 2_000_000_002, outcome: "failed", refunded: false },
    ]);
  });

  it("오류 코드는 cause를 따라가 처음 나온 code이고, 없으면 '없음'이다", () => {
    expect(errorCode(Object.assign(new Error("a"), { code: "57014" }))).toBe("57014");
    expect(errorCode(new Error("wrapped", { cause: Object.assign(new Error("pg"), { code: "55P03" }) }))).toBe("55P03");
    expect(errorCode(new Error("plain"))).toBe("없음");
    expect(errorCode(null)).toBe("없음");
  });
});
