import Fastify, { type FastifyServerOptions } from "fastify";
import type pg from "pg";

export function buildApp(pool: pg.Pool, options: FastifyServerOptions = {}) {
  const app = Fastify(options);

  // DB에 닿지 않으면 500이다.
  app.get("/health", async () => {
    await pool.query("select 1");
    return { status: "ok" };
  });

  return app;
}
