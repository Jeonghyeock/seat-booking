import { randomBytes } from "node:crypto";
import { buildApp } from "./app.js";
import { createPool } from "./db/pool.js";
import { FakePaymentProvider } from "./fake-pay.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL이 없습니다(.env 또는 환경 변수)");

// 이 PC는 3000번을 다른 프로세스가 쓰고 있어 기본값을 3001로 둔다.
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";

// 가짜 결제사의 웹훅 서명 비밀. 서명과 확인이 이 프로세스 안에서만 일어나므로, 없으면 띄울 때마다 무작위로 만든다.
const paymentProvider = new FakePaymentProvider(process.env.FAKE_PAY_SECRET ?? randomBytes(32).toString("hex"));

const pool = createPool({ connectionString: databaseUrl });
const app = buildApp(pool, { logger: true }, { paymentProvider });
// 개발 서버에서는 웹훅을 delayMs 뒤 보내고, 받지 못하면 다시 보낸다.
paymentProvider.useTimers(app.log);
app.addHook("onClose", async () => {
  await pool.end();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port, host });
