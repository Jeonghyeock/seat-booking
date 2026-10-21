import { buildApp } from "./app.js";

// 이 PC는 3000번을 다른 프로세스가 쓰고 있어 기본값을 3001로 둔다.
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";

const app = buildApp({ logger: true });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port, host });
