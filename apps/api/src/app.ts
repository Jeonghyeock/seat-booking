import { HealthResponse, HealthUnavailable } from "@seat-booking/shared";
import Fastify, { type FastifyServerOptions } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type pg from "pg";

export function buildApp(pool: pg.Pool, options: FastifyServerOptions = {}) {
  // 요청은 packages/shared의 zod 스키마로 검증하고, 응답도 같은 스키마로 직렬화한다.
  const app = Fastify(options).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

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

  return app;
}
