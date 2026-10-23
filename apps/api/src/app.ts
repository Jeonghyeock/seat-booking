import { randomBytes } from "node:crypto";
import cookie from "@fastify/cookie";
import { HealthResponse, HealthUnavailable } from "@seat-booking/shared";
import Fastify, { type FastifyError, type FastifyServerOptions } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type pg from "pg";
import { createDb } from "./db/client.js";
import { FakePaymentProvider, SIGNATURE_HEADER } from "./fake-pay.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes, meRoutes } from "./routes/auth.js";
import { holdRoutes } from "./routes/holds.js";
import { orderRoutes } from "./routes/orders.js";
import { paymentRoutes } from "./routes/payments.js";
import { performanceRoutes } from "./routes/performances.js";
import { type AuthConfig, csrfGuard, requireAdmin, requireUser } from "./routes/session.js";
import { webhookRoutes } from "./routes/webhooks.js";

// paymentProvider를 넘기지 않으면 무작위 비밀로 새로 만든다. 서명하는 쪽과 확인하는 쪽이 같은 프로세스라 비밀을 밖에서 받을 필요가 없다.
// auth를 넘기지 않으면 Secure 쿠키(__Host-sid), Origin 허용 목록 없음, 가입·로그인 분당 10회다. 운영에 안전한 기본값이다(DESIGN 6.3 설정).
export function buildApp(
  pool: pg.Pool,
  options: FastifyServerOptions = {},
  services: { paymentProvider?: FakePaymentProvider; auth?: Partial<AuthConfig> } = {},
) {
  // undefined가 넘어와도 Secure가 꺼지지 않게 값마다 기본값을 채운다.
  const authConfig: AuthConfig = {
    cookieSecure: services.auth?.cookieSecure ?? true,
    allowedOrigins: services.auth?.allowedOrigins ?? [],
    authRateLimitPerMinute: services.auth?.authRateLimitPerMinute ?? 10,
  };
  // 요청은 packages/shared의 zod 스키마로 검증하고, 응답도 같은 스키마로 직렬화한다.
  const app = Fastify(options).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookie);
  app.decorateRequest("user", null);
  app.decorate("userRoutes", [] as { method: string; url: string }[]);
  app.decorate("allRoutes", [] as { method: string; url: string }[]);
  app.decorate("adminRoutes", [] as { method: string; url: string }[]);
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) if (method !== "HEAD") app.allRoutes.push({ method, url: route.url });
  });

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
  // 상태를 바꾸는 요청을 받는 범위. CSRF를 먼저 확인하고(DB를 보지 않는다), 그 안의 사용자 범위에서 세션을 확인한다.
  // 루트에 걸지 않아 없는 경로는 404 그대로다(DESIGN 6.3 훅의 위치와 응답 순서).
  app.register(async (web) => {
    web.addHook("onRequest", csrfGuard(authConfig));
    // 쿠키로 사용자를 고르는 응답이다. 오류 응답(401·403·429)까지 캐시에 남기지 않는다.
    web.addHook("onSend", async (_request, reply) => {
      reply.header("cache-control", "no-store");
    });
    web.register(authRoutes, { db, config: authConfig });
    // 사용자 경로. 이 범위의 훅이 세션으로 사용자를 찾는다.
    web.register(async (userScope) => {
      userScope.addHook("onRequest", requireUser(db, authConfig));
      userScope.addHook("onRoute", (route) => {
        for (const method of [route.method].flat()) if (method !== "HEAD") app.userRoutes.push({ method, url: route.url });
      });
      userScope.register(meRoutes);
      userScope.register(holdRoutes, { db });
      userScope.register(orderRoutes, { db });
      userScope.register(paymentRoutes, { db, provider: paymentProvider });
    });
    // 관리자 경로(/admin). 세션 훅 뒤에 역할 훅이 관리자가 아니면 403이다. 응답 순서는 CSRF 403 → 401 → 관리자 아님 403이다.
    web.register(
      async (adminScope) => {
        adminScope.addHook("onRequest", requireUser(db, authConfig));
        adminScope.addHook("onRequest", requireAdmin);
        adminScope.addHook("onRoute", (route) => {
          for (const method of [route.method].flat()) if (method !== "HEAD") app.adminRoutes.push({ method, url: route.url });
        });
        adminScope.register(adminRoutes, { db });
      },
      { prefix: "/admin" },
    );
  });
  // 웹훅은 세션·CSRF 범위 밖이다. 결제사 서명으로 지킨다.
  app.register(webhookRoutes, { db, provider: paymentProvider });

  return app;
}
