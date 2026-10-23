import { HealthResponse, HealthUnavailable } from "@seat-booking/shared";
import Fastify, { type FastifyError, type FastifyServerOptions } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type pg from "pg";
import { createDb } from "./db/client.js";
import { holdRoutes } from "./routes/holds.js";
import { orderRoutes } from "./routes/orders.js";
import { performanceRoutes } from "./routes/performances.js";

export function buildApp(pool: pg.Pool, options: FastifyServerOptions = {}) {
  // 요청은 packages/shared의 zod 스키마로 검증하고, 응답도 같은 스키마로 직렬화한다.
  const app = Fastify(options).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // 5xx는 오류 내용을 로그에만 남기고 응답에는 싣지 않는다. Drizzle 오류 메시지에는 SQL 문장과 파라미터가 들어 있다.
  // 4xx(요청 검증 실패 등)는 무엇이 틀렸는지 알려 준다.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const status = err.statusCode ?? 500;
    if (status < 500) return reply.code(status).send({ error: err.message });
    request.log.error({ err }, "처리하지 못한 오류");
    return reply.code(500).send({ error: "서버 오류" });
  });

  // DB에 닿지 않으면 503이다. pg 오류 내용(role 이름 등)은 응답에 싣지 않고 로그에만 남긴다.
  app.get(
    "/health",
    { schema: { response: { 200: HealthResponse, 503: HealthUnavailable } } },
    async (request, reply) => {
      try {
        await pool.query("select 1");
        return { status: "ok" as const };
      } catch (err) {
        request.log.error({ err }, "health: DB에 닿지 않음");
        return reply.code(503).send({ status: "unavailable" as const });
      }
    },
  );

  const db = createDb(pool);
  app.register(performanceRoutes, { db });
  app.register(holdRoutes, { db });
  app.register(orderRoutes, { db });

  return app;
}
