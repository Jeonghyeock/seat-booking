import { randomBytes } from "node:crypto";
import cookie from "@fastify/cookie";
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
import { type AuthConfig, requireUser } from "./routes/session.js";
import { webhookRoutes } from "./routes/webhooks.js";

// paymentProvider를 넘기지 않으면 무작위 비밀로 새로 만든다. 서명하는 쪽과 확인하는 쪽이 같은 프로세스라 비밀을 밖에서 받을 필요가 없다.
// auth를 넘기지 않으면 Secure 쿠키(__Host-sid)다. 운영에 안전한 기본값이다(DESIGN 6.3 설정).
export function buildApp(
  pool: pg.Pool,
  options: FastifyServerOptions = {},
  services: { paymentProvider?: FakePaymentProvider; auth?: Partial<AuthConfig> } = {},
) {
  // undefined가 넘어와도 Secure가 꺼지지 않게 값마다 기본값을 채운다.
  const authConfig: AuthConfig = { cookieSecure: services.auth?.cookieSecure ?? true };
  // 요청은 packages/shared의 zod 스키마로 검증하고, 응답도 같은 스키마로 직렬화한다.
  const app = Fastify(options).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookie);
  app.decorateRequest("user", null);
  app.decorate("userRoutes", [] as { method: string; url: string }[]);

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

  // 공개 경로.
  app.register(performanceRoutes, { db });
  // 사용자 경로. 이 범위의 훅이 세션으로 사용자를 찾는다(DESIGN 6.3). 루트에 걸지 않아 없는 경로는 404 그대로다.
  app.register(async (userScope) => {
    userScope.addHook("onRequest", requireUser(db, authConfig));
    userScope.addHook("onRoute", (route) => {
      for (const method of [route.method].flat()) if (method !== "HEAD") app.userRoutes.push({ method, url: route.url });
    });
    userScope.register(holdRoutes, { db });
    userScope.register(orderRoutes, { db });
    userScope.register(paymentRoutes, { db, provider: paymentProvider });
  });
  // 웹훅은 세션·CSRF 범위 밖이다. 결제사 서명으로 지킨다.
  app.register(webhookRoutes, { db, provider: paymentProvider });

  return app;
}
