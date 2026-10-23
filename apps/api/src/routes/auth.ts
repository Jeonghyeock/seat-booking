import {
  AuthError,
  AuthUser,
  Credentials,
  EmailTaken,
  ErrorResponse,
  InvalidCredentials,
  TryAgainLater,
} from "@seat-booking/shared";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createSession,
  deleteSession,
  hashPassword,
  needsRehash,
  normalizePassword,
  PasswordHasherBusy,
  sessionCookieName,
  verifyPassword,
} from "../auth.js";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { type AuthConfig, currentUser, sessionCookieOptions } from "./session.js";

// 가입·로그인·로그아웃(DESIGN 6.3 계정). CSRF 확인 범위 안에 등록한다. 내 정보(meRoutes)는 세션 훅 범위 안이다.
// 응답에 Cache-Control: no-store를 붙인다(사용자 정보가 캐시에 남지 않게).
export const authRoutes: FastifyPluginAsyncZod<{ db: Db; config: AuthConfig }> = async (app, { db, config }) => {
  const cookieName = sessionCookieName(config.cookieSecure);
  app.addHook("onSend", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });

  // 로그인·가입 시도는 IP당 분당 정해진 수까지다(10장 61). 로그인은 IP+이메일로 센다(한 IP에서 여러 계정을 막지 않게).
  // 본문을 봐야 하므로 preHandler에서 센다.
  const rateLimit = (keyOf: (request: FastifyRequest) => string) => ({
    max: config.authRateLimitPerMinute,
    timeWindow: "1 minute",
    hook: "preHandler" as const,
    keyGenerator: keyOf,
  });

  // 비밀번호 해시가 밀려 있으면 503과 Retry-After다(동시 해시 2개 제한, 10장 61).
  const busy = (reply: FastifyReply) =>
    reply.code(503).header("retry-after", "1").send({ error: "잠시 뒤 다시 시도해 주세요", code: "TRY_AGAIN_LATER" });

  // 새 세션을 만들고 쿠키를 굽는다. 요청에 이미 세션 쿠키가 있으면 그 세션은 지운다(DESIGN 6.3 세션).
  async function signIn(request: FastifyRequest, reply: FastifyReply, userId: number) {
    const previous = request.cookies[cookieName];
    if (previous !== undefined) await deleteSession(db, previous);
    const { token, expiresAt } = await createSession(db, userId);
    reply.setCookie(cookieName, token, {
      ...sessionCookieOptions(config),
      maxAge: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    });
  }

  app.post(
    "/auth/signup",
    {
      config: { rateLimit: rateLimit((request) => request.ip) },
      schema: {
        body: Credentials,
        response: {
          201: AuthUser,
          400: ErrorResponse,
          403: AuthError,
          409: EmailTaken,
          429: ErrorResponse,
          503: TryAgainLater,
        },
      },
    },
    async (request, reply) => {
      const { email } = request.body;
      const password = normalizePassword(request.body.password);
      if (password === null) return reply.code(400).send({ error: "비밀번호는 8~128자여야 합니다" });
      const taken = () => reply.code(409).send({ error: "이미 가입한 이메일입니다", code: "EMAIL_TAKEN" });

      // 비밀번호가 없는 옛 계정(4단계 전)도 넘겨받지 않는다. 채우게 만들면 선점·주문을 가진 계정을 빼앗을 수 있다.
      const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (existing) return taken();
      let passwordHash: string;
      try {
        passwordHash = await hashPassword(password);
      } catch (err) {
        if (err instanceof PasswordHasherBusy) return busy(reply);
        throw err;
      }
      // 같은 이메일로 동시에 가입하면 하나만 넣는다.
      const [created] = await db
        .insert(users)
        .values({ email, passwordHash })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id, email: users.email, role: users.role });
      if (!created) return taken();

      await signIn(request, reply, created.id);
      return reply.code(201).send({ userId: created.id, email: created.email, role: created.role });
    },
  );

  app.post(
    "/auth/login",
    {
      config: {
        rateLimit: rateLimit((request) => `${request.ip}:${(request.body as Credentials | undefined)?.email ?? ""}`),
      },
      schema: {
        body: Credentials,
        response: { 200: AuthUser, 401: InvalidCredentials, 403: AuthError, 429: ErrorResponse, 503: TryAgainLater },
      },
    },
    async (request, reply) => {
      const invalid = () =>
        reply.code(401).send({ error: "이메일 또는 비밀번호가 맞지 않습니다", code: "INVALID_CREDENTIALS" });
      // 길이가 맞지 않는 비밀번호는 어떤 계정과도 맞을 수 없다. 계정이 있는지와 상관없으니 해시하지 않고 거절한다.
      const password = normalizePassword(request.body.password);
      if (password === null) return invalid();

      const [user] = await db
        .select({ id: users.id, email: users.email, role: users.role, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.email, request.body.email));
      let matched: boolean;
      try {
        // 없는 이메일과 비밀번호 없는 계정도 가짜 해시로 검증해 걸리는 시간을 맞춘다.
        matched = await verifyPassword(user?.passwordHash ?? null, password);
      } catch (err) {
        if (err instanceof PasswordHasherBusy) return busy(reply);
        throw err;
      }
      if (!user || !matched) return invalid();

      // 저장된 해시의 값이 지금 값과 다르면 다시 해시해 바꾼다. 해시가 밀려 있으면 다음 로그인에 한다.
      if (needsRehash(user.passwordHash!)) {
        try {
          const rehashed = await hashPassword(password);
          await db.update(users).set({ passwordHash: rehashed }).where(eq(users.id, user.id));
        } catch (err) {
          if (!(err instanceof PasswordHasherBusy)) throw err;
        }
      }
      await signIn(request, reply, user.id);
      return { userId: user.id, email: user.email, role: user.role };
    },
  );

  // 로그아웃은 로그인하지 않았어도 200이다. 세션 행을 지우고 쿠키를 지운다.
  app.post(
    "/auth/logout",
    { schema: { response: { 200: z.object({}), 403: AuthError } } },
    async (request, reply) => {
      const token = request.cookies[cookieName];
      if (token !== undefined) await deleteSession(db, token);
      reply.clearCookie(cookieName, sessionCookieOptions(config));
      return {};
    },
  );
};

// 내 정보. 세션 훅 범위 안에 등록한다(로그인하지 않았으면 훅이 401).
export const meRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/auth/me",
    { schema: { response: { 200: AuthUser, 401: AuthError, 403: AuthError } } },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const user = currentUser(request);
      return { userId: user.id, email: user.email, role: user.role };
    },
  );
};
