import { randomBytes } from "node:crypto";
import { buildApp } from "./app.js";
import { startCleanupLoop } from "./cleanup.js";
import { loadAuthConfig, loadServerConfig, loadTrustProxy } from "./config.js";
import { createDb } from "./db/client.js";
import { createPool } from "./db/pool.js";
import { FakePaymentProvider } from "./fake-pay.js";
import { createLoadStats } from "./load-stats.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL이 없습니다(.env 또는 환경 변수)");

// 이 PC는 3000번을 다른 프로세스가 쓰고 있어 기본값을 3001로 둔다.
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";

// 가짜 결제사의 웹훅 서명 비밀. 서명과 확인이 이 프로세스 안에서만 일어나므로, 없거나 비어 있으면 띄울 때마다 무작위로 만든다.
const paymentProvider = new FakePaymentProvider(process.env.FAKE_PAY_SECRET || randomBytes(32).toString("hex"));

// 화면의 origin(APP_ORIGIN), 쿠키 Secure(COOKIE_SECURE), 가입·로그인 분당 허용 수(DESIGN 6.3 설정).
const auth = loadAuthConfig(process.env);
// 프록시 뒤에서 요청한 쪽 IP를 읽는 방법(TRUST_PROXY). 속도 제한이 이 IP로 센다.
const trustProxy = loadTrustProxy(process.env);
// 풀 크기(DB_POOL_MAX), 연결 대기 한도(DB_CONNECT_TIMEOUT_MS), 로그 수준(LOG_LEVEL), 부하 측정 지표(LOAD_STATS, DESIGN 6.6).
const server = loadServerConfig(process.env);

// application_name으로 부하 측정의 표본기가 API의 연결을 가려낸다.
const pool = createPool({
  connectionString: databaseUrl,
  max: server.poolMax,
  connectionTimeoutMillis: server.connectTimeoutMs,
  application_name: "seat-booking-api",
});
const stats = server.loadStatsDir
  ? createLoadStats({ dir: server.loadStatsDir, pool, provider: paymentProvider, config: server })
  : null;
const app = buildApp(
  pool,
  { logger: { level: server.logLevel }, trustProxy },
  { paymentProvider, auth, onServerError: stats?.recordServerError },
);
app.log.info({ ...auth, trustProxy }, "인증 설정");
app.log.info(server, "서버 설정");
if (auth.allowedOrigins.length === 0) {
  app.log.warn("APP_ORIGIN이 비어 있습니다. 브라우저가 보내는 상태 변경 요청(Origin이 붙음)은 모두 403입니다");
}
// 개발 서버에서는 웹훅을 delayMs 뒤 보내고, 받지 못하면 다시 보낸다.
paymentProvider.useTimers(app.log);
// 정리 작업(만료 선점 풀기, 주문 취소, 환불, 대사, 멱등 키 지우기)을 10초마다 돌린다.
const stopCleanup = startCleanupLoop(createDb(pool), paymentProvider, app.log, undefined, stats?.recordCleanup);
if (stats) {
  stats.attach(app);
  stats.start();
}
app.addHook("onClose", async () => {
  await stopCleanup();
  stats?.stop();
  await pool.end();
});

const shutdown = () => {
  void app.close().then(() => process.exit(0));
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, shutdown);
// 부하 실행기가 IPC 채널로 띄운 경우에만 켠다(DESIGN 6.6). Windows에는 SIGTERM이 없어, 실행기가 이 메시지로 앱을 닫는다.
if (process.send) {
  process.on("message", (message) => {
    if (message === "shutdown") shutdown();
  });
}

await app.listen({ port, host });
