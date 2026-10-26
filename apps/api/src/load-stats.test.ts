import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "./app.js";
import { createDb } from "./db/client.js";
import { createPool } from "./db/pool.js";
import { FakePaymentProvider } from "./fake-pay.js";
import { createLoadStats, errorCode, loopDelayMs } from "./load-stats.js";

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

  it("Node 지표(이벤트 루프 사용률·지연, CPU)는 그 줄 동안의 값이다. GC와 힙도 쓴다", async () => {
    // 타이머 콜백 안에서 200ms 동안 이벤트 루프를 막는다. 지연은 막힌 뒤 표본 타이머가 울릴 때 적히므로 한 번 양보한다.
    // 표본 타이머가 같은 단계에서 먼저 돌면 그 막힘이 지연으로 잡히지 않을 때가 있어(실험) 잡힐 때까지 몇 번 한다.
    const blockInTimer = async () => {
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          const until = performance.now() + 200;
          while (performance.now() < until);
          resolve();
        }, 5),
      );
      await new Promise((r) => setTimeout(r, 20));
    };
    let busy = lastLine().node;
    for (let attempt = 0; attempt < 5; attempt++) {
      await blockInTimer();
      busy = lastLine().node;
      if (busy.loopDelayMs.max >= 150) break;
    }
    expect(busy.elu).toBeGreaterThan(0.5);
    // 다른 테스트 파일이 CPU를 쓰면 바쁘게 돈 시간에도 CPU를 덜 받는다(전체 실행에서 47%). 누적 값이면 200을 크게 넘는다.
    expect(busy.cpuPct).toBeGreaterThan(10);
    expect(busy.cpuPct).toBeLessThan(200);
    expect(busy.loopDelayMs.max).toBeGreaterThanOrEqual(150);
    await new Promise((r) => setTimeout(r, 100));
    const idle = lastLine().node;
    expect(idle.elu).toBeLessThan(0.5);
    expect(idle.cpuPct).toBeLessThan(50);
    expect(idle.loopDelayMs.max).toBeLessThan(150);
    // 1초 줄도 표본 간격을 뺀 값을 쓰는지 본다. 빼지 않으면 쉬어도 10 이상이다. 다른 테스트 파일이 CPU를 쓰면 6ms대까지 올라
    // 5로는 흔들렸다(전체 실행 8번 중 2번).
    expect(idle.loopDelayMs.p50).toBeLessThan(10);
    for (const value of [idle.gcMs, idle.gcCount]) expect(value).toBeGreaterThanOrEqual(0);
    expect(idle.heapMb).toBeGreaterThan(0);
  });

  it("다음 줄은 지난 줄 뒤의 값만 쓴다", async () => {
    await app.inject("/health");
    lastLine();
    const tick = lastLine();
    expect(tick.routes).toEqual({});
    expect(tick.pool.connectWait).toBeNull();
    expect(tick.cleanup).toEqual([]);
    expect(tick.webhooks).toEqual({ sent: 0, retried: 0, givenUp: 0 });
  });

  it("연결을 받지 못한 것(대기 한도)을 연결 오류로 세고, 새로 맺은 연결 수를 쓴다. 그 오류의 코드는 POOL_TIMEOUT이다", async () => {
    // 한도는 새 연결을 맺는 시간에도 걸리므로, 첫 연결이 다른 테스트 파일과 겹쳐 늦어도 맺어지게 넉넉히 둔다.
    const small = createPool({ connectionString: inject("databaseUrl"), max: 1, connectionTimeoutMillis: 1000 });
    const smallDir = mkdtempSync(path.join(tmpdir(), "load-stats-small-"));
    const smallStats = createLoadStats({ dir: smallDir, pool: small, provider, config, intervalMs: 3_600_000 });
    try {
      const held = await small.connect();
      const errors = await Promise.all([small.query("select 1").catch((e: unknown) => e), small.connect().catch((e: unknown) => e)]);
      held.release();
      smallStats.flush();
      const tick = readFileSync(path.join(smallDir, "api-stats.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
      expect(tick.pool).toMatchObject({ connectErrors: 2, newConnections: 1 });
      expect(tick.pool.connectWait.count).toBe(3);
      expect(errors.map(errorCode)).toEqual(["POOL_TIMEOUT", "POOL_TIMEOUT"]);
    } finally {
      await small.end();
      rmSync(smallDir, { recursive: true, force: true });
    }
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
    expect(lastLine().webhooks).toEqual({ sent: 0, retried: 0, givenUp: 0 });
  });

  it("클라이언트가 응답 전에 끊은 요청은 aborted로 센다", async () => {
    // 끊으려면 실제 소켓이 있어야 해서, 느린 경로를 더한 앱을 따로 만들어 임의 포트로 띄운다(풀과 결제사도 따로 둔다).
    const slowDir = mkdtempSync(path.join(tmpdir(), "load-stats-slow-"));
    const slowPool = createPool({ connectionString: inject("databaseUrl") });
    const slowProvider = new FakePaymentProvider("load-stats-slow-secret");
    const slowStats = createLoadStats({ dir: slowDir, pool: slowPool, provider: slowProvider, config, intervalMs: 3_600_000 });
    const slow = buildApp(slowPool, {}, { paymentProvider: slowProvider });
    slow.get("/test/slow", async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { ok: true };
    });
    slowStats.attach(slow);
    try {
      const address = await slow.listen({ port: 0, host: "127.0.0.1" });
      await fetch(`${address}/test/slow`, { signal: AbortSignal.timeout(50) }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 400));
      slowStats.flush();
      const tick = readFileSync(path.join(slowDir, "api-stats.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
      expect(tick.routes["GET /test/slow"]).toMatchObject({ aborted: 1 });
      expect(tick.routes["GET /test/slow"].statuses).toEqual({});
    } finally {
      await slow.close();
      await slowPool.end();
      rmSync(slowDir, { recursive: true, force: true });
    }
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

  // 쉬는 줄의 지연으로 보면 다른 테스트 파일이 CPU를 쓸 때 흔들려(전체 실행 8번 중 2번 실패) 변환 함수로 본다.
  it("이벤트 루프 지연은 표본 간격(10ms)을 뺀 밀리초이고 0 아래로 내려가지 않는다", () => {
    expect(loopDelayMs(10_400_000)).toBe(0.4);
    expect(loopDelayMs(25_000_000)).toBe(15);
    expect(loopDelayMs(9_000_000)).toBe(0);
  });

  it("오류 코드는 cause를 따라가 처음 나온 code이고, 없으면 '없음'이다", () => {
    expect(errorCode(Object.assign(new Error("a"), { code: "57014" }))).toBe("57014");
    expect(errorCode(new Error("wrapped", { cause: Object.assign(new Error("pg"), { code: "55P03" }) }))).toBe("55P03");
    expect(errorCode(new Error("plain"))).toBe("없음");
    expect(errorCode(null)).toBe("없음");
  });
});
