import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay, PerformanceObserver, performance } from "node:perf_hooks";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import type { CleanupCounts } from "./cleanup.js";
import type { ServerConfig } from "./config.js";
import type { FakePaymentProvider } from "./fake-pay.js";

// 부하 측정의 API 지표(DESIGN 6.6 "지표와 표본"). LOAD_STATS를 켠 main.ts만 쓴다.
// 1초마다 그 1초 동안의 값을 api-stats.jsonl에 JSON 한 줄로 덧붙인다. 동기로 쓰므로 프로세스가 강제로 끝나도
// 끝난 줄은 남는다(Windows의 TerminateProcess는 onClose를 돌리지 않는다). 그래서 끝에 한 번 쓰는 값에 기대지 않는다.
// 앱을 닫으면(stop) 남은 값을 쓰고, 가짜 결제사가 아는 결제를 fake-pay.json에 쓴다(합격 확인 (e)).

type RouteWindow = { times: number[]; statuses: Record<number, number>; errorCodes: Record<string, number> };
type ConnectCallback = (err: Error | undefined, client: pg.PoolClient | undefined, release: (release?: unknown) => void) => void;

const round = (value: number) => Math.round(value * 100) / 100;

// 가장 가까운 순위로 p50·p95와 최대를 구한다. 값이 없으면 null.
function summarize(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.ceil((p / 100) * sorted.length) - 1]!;
  return { count: sorted.length, p50: round(at(50)), p95: round(at(95)), max: round(sorted.at(-1)!) };
}

// 오류의 code(pg 오류면 SQLSTATE). Drizzle은 pg 오류를 cause에 싸서 던지므로 cause를 따라가며 처음 나온 것을 쓴다.
export function errorCode(err: unknown): string {
  let current = err;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth++) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === "string") return code;
    current = cause;
  }
  return "없음";
}

const routeKey = (request: FastifyRequest) => `${request.method} ${request.routeOptions.url ?? "(없는 경로)"}`;

export function createLoadStats(options: {
  dir: string;
  pool: pg.Pool;
  provider: FakePaymentProvider;
  config: ServerConfig;
  intervalMs?: number;
}) {
  const { dir, pool, provider, config, intervalMs = 1000 } = options;
  mkdirSync(dir, { recursive: true });
  const statsFile = path.join(dir, "api-stats.jsonl");

  let routes = new Map<string, RouteWindow>();
  let connectWaits: number[] = [];
  let connectErrors = 0;
  let cleanupRounds: (CleanupCounts & { ms: number })[] = [];
  let gcMs = 0;
  let gcCount = 0;
  const routeWindow = (key: string) => {
    let window = routes.get(key);
    if (!window) {
      window = { times: [], statuses: {}, errorCodes: {} };
      routes.set(key, window);
    }
    return window;
  };

  // 풀에서 연결을 받기까지 기다린 시간. 기다리는 연결 수(waitingCount)는 그 순간의 줄 길이일 뿐이라 따로 잰다.
  // pg-pool의 query도 안에서 this.connect를 부르므로, 이 하나로 트랜잭션(Drizzle)과 단일 질의를 모두 잰다.
  const connect = pool.connect.bind(pool) as unknown as (callback?: ConnectCallback) => Promise<pg.PoolClient> | undefined;
  const timedConnect = (callback?: ConnectCallback) => {
    const started = performance.now();
    const record = (failed: boolean) => {
      connectWaits.push(performance.now() - started);
      if (failed) connectErrors++;
    };
    if (callback) {
      return connect((err, client, release) => {
        record(err !== undefined);
        callback(err, client, release);
      });
    }
    return connect()!.then(
      (client) => {
        record(false);
        return client;
      },
      (err: unknown) => {
        record(true);
        throw err;
      },
    );
  };
  pool.connect = timedConnect as unknown as typeof pool.connect;

  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  const gc = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcMs += entry.duration;
      gcCount++;
    }
  });

  let lastAt = performance.now();
  let lastElu = performance.eventLoopUtilization();
  let lastCpu = process.cpuUsage();
  let lastDeliveries = { ...provider.deliveries };
  let timer: NodeJS.Timeout | undefined;

  // 지난 줄 뒤의 값을 한 줄로 쓰고 비운다.
  function flush() {
    const now = performance.now();
    const elapsedMs = now - lastAt;
    const elu = performance.eventLoopUtilization(lastElu);
    const cpu = process.cpuUsage(lastCpu);
    const deliveries = { ...provider.deliveries };
    const line = {
      type: "tick",
      at: new Date().toISOString(),
      ms: round(elapsedMs),
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
        connectWait: summarize(connectWaits),
        connectErrors,
      },
      node: {
        elu: Math.round(elu.utilization * 1000) / 1000,
        // 한 코어를 100으로 본 CPU 사용률(사용자 + 시스템).
        cpuPct: round(((cpu.user + cpu.system) / 1000 / elapsedMs) * 100),
        loopDelayMs: {
          p50: round(loopDelay.percentile(50) / 1e6),
          p99: round(loopDelay.percentile(99) / 1e6),
          max: round(loopDelay.max / 1e6),
        },
        gcMs: round(gcMs),
        gcCount,
        heapMb: round(process.memoryUsage().heapUsed / 2 ** 20),
      },
      routes: Object.fromEntries(
        [...routes].map(([key, window]) => [
          key,
          {
            ...summarize(window.times),
            statuses: window.statuses,
            ...(Object.keys(window.errorCodes).length > 0 ? { errorCodes: window.errorCodes } : {}),
          },
        ]),
      ),
      webhooks: {
        sent: deliveries.sent - lastDeliveries.sent,
        retried: deliveries.retried - lastDeliveries.retried,
        givenUp: deliveries.givenUp - lastDeliveries.givenUp,
      },
      cleanup: cleanupRounds,
    };
    appendFileSync(statsFile, `${JSON.stringify(line)}\n`);

    lastAt = now;
    lastElu = performance.eventLoopUtilization();
    lastCpu = process.cpuUsage();
    lastDeliveries = deliveries;
    routes = new Map();
    connectWaits = [];
    connectErrors = 0;
    cleanupRounds = [];
    gcMs = 0;
    gcCount = 0;
    loopDelay.reset();
  }

  return {
    // 오류 처리기가 5xx로 바꾼 오류의 code를 그 경로에 센다(buildApp의 onServerError).
    recordServerError: (request: FastifyRequest, err: unknown) => {
      const codes = routeWindow(routeKey(request)).errorCodes;
      const code = errorCode(err);
      codes[code] = (codes[code] ?? 0) + 1;
    },
    // 정리 작업 한 바퀴(startCleanupLoop의 onRound).
    recordCleanup: (counts: CleanupCounts, ms: number) => {
      cleanupRounds.push({ ...counts, ms: round(ms) });
    },
    // 앱이 준비되기 전에 부른다. 웹훅도 app.inject로 같은 훅을 지나 여기 잡힌다.
    attach(app: FastifyInstance) {
      app.addHook("onResponse", (request, reply, done) => {
        const window = routeWindow(routeKey(request));
        window.times.push(reply.elapsedTime);
        window.statuses[reply.statusCode] = (window.statuses[reply.statusCode] ?? 0) + 1;
        done();
      });
    },
    start() {
      appendFileSync(statsFile, `${JSON.stringify({ type: "start", at: new Date().toISOString(), pid: process.pid, config })}\n`);
      loopDelay.enable();
      gc.observe({ entryTypes: ["gc"] });
      lastAt = performance.now();
      lastElu = performance.eventLoopUtilization();
      lastCpu = process.cpuUsage();
      timer = setInterval(flush, intervalMs);
      timer.unref();
    },
    flush,
    stop() {
      clearInterval(timer);
      flush();
      loopDelay.disable();
      gc.disconnect();
      writeFileSync(path.join(dir, "fake-pay.json"), JSON.stringify(provider.listPayments()));
    },
  };
}
