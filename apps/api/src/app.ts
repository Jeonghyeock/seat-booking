import Fastify, { type FastifyServerOptions } from "fastify";
import type pg from "pg";

export function buildApp(pool: pg.Pool, options: FastifyServerOptions = {}) {
  const app = Fastify(options);

  // DB에 닿지 않으면 503이다. pg 오류 내용(role 이름 등)은 응답에 싣지 않고 로그에만 남긴다.
  app.get("/health", async (request, reply) => {
    try {
      await pool.query("select 1");
      return { status: "ok" };
    } catch (err) {
      request.log.error({ err }, "health: DB에 닿지 않음");
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  return app;
}
