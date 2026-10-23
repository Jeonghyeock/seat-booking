import { randomBytes } from "node:crypto";
import { HealthResponse, HealthUnavailable } from "@seat-booking/shared";
import Fastify, { type FastifyError, type FastifyServerOptions } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type pg from "pg";
import { createDb } from "./db/client.js";
import { FakePaymentProvider, SIGNATURE_HEADER } from "./fake-pay.js";
import { holdRoutes } from "./routes/holds.js";
import { orderRoutes } from "./routes/orders.js";
import { paymentRoutes } from "./routes/payments.js";
import { performanceRoutes } from "./routes/performances.js";
import { webhookRoutes } from "./routes/webhooks.js";

// paymentProvider를 넘기지 않으면 무작위 비밀로 새로 만든다. 서명하는 쪽과 확인하는 쪽이 같은 프로세스라 비밀을 밖에서 받을 필요가 없다.
export function buildApp(
  pool: pg.Pool,
  options: FastifyServerOptions = {},
  services: { paymentProvider?: FakePaymentProvider } = {},
) {
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

  // 가짜 결제사는 웹훅을 앱의 웹훅 경로로 보낸다(DESIGN 10장 42). 서명한 문자열을 그대로 보낸다.
  const paymentProvider = services.paymentProvider ?? new FakePaymentProvider(randomBytes(32).toString("hex"));
  paymentProvider.connect(async ({ rawBody, signature }) => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/fake-pay",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signature },
      payload: rawBody,
    });
    return res.statusCode;
  });
  app.register(paymentRoutes, { db, provider: paymentProvider });
  app.register(webhookRoutes, { db, provider: paymentProvider });

  return app;
}
