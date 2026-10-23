import rateLimit from "@fastify/rate-limit";
import {
  AuthError,
  AuthUser,
  Credentials,
  EmailTaken,
  ErrorResponse,
  InvalidCredentials,
  TooManyRequests,
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

// 로그인은 IP+이메일 말고 IP 하나로도 센다. 그 상한은 IP+이메일 상한의 이 배수다.
export const LOGIN_PER_IP_FACTOR = 10;

// 가입·로그인·로그아웃(DESIGN 6.3 계정). CSRF 확인 범위 안에 등록한다. 내 정보(meRoutes)는 세션 훅 범위 안이다.
export const authRoutes: FastifyPluginAsyncZod<{ db: Db; config: AuthConfig }> = async (app, { db, config }) => {
  const cookieName = sessionCookieName(config.cookieSecure);

  // 속도 제한(10장 61). 가입은 IP당, 로그인은 IP+이메일당 분당 authRateLimitPerMinute회다. 로그인은 IP 하나로도 그 10배까지다.
  // 이메일을 바꿔 가며 보내 IP+이메일 카운터를 밀어내거나 해시 자리를 차지하는 것을 막는다. 같은 NAT 뒤 사용자를 생각해 넉넉히 둔다.
  // 저장소는 메모리라 서버마다 따로 센다. 이메일을 봐야 하므로 본문 검증 뒤 preHandler에서 센다(형식이 틀린 400은 세지 않는다).
  await app.register(rateLimit, { global: false });
  const limit = (max: number, keyOf: (request: FastifyRequest) => string) => {
    const count = app.createRateLimit({ max, timeWindow: "1 minute", keyGenerator: keyOf });
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const result = await count(request);
      if (result.isAllowed || !result.isExceeded) return;
      return reply
        .code(429)
        .header("retry-after", String(result.ttlInSeconds))
        .send({ error: `요청이 너무 많습니다. ${result.ttlInSeconds}초 뒤에 다시 시도해 주세요`, code: "TOO_MANY_REQUESTS" });
    };
  };
  const signupPerIp = limit(config.authRateLimitPerMinute, (request) => request.ip);
  const loginPerIp = limit(config.authRateLimitPerMinute * LOGIN_PER_IP_FACTOR, (request) => request.ip);
  const loginPerEmail = limit(
    config.authRateLimitPerMinute,
    (request) => `${request.ip}:${(request.body as Credentials).email}`,
  );

  // 비밀번호 해시가 밀려 있으면 503과 Retry-After다(동시 해시 2개 제한, 10장 61).
  const busy = (reply: FastifyReply) =>
    reply.code(503).header("retry-after", "1").send({ error: "잠시 뒤 다시 시도해 주세요", code: "TRY_AGAIN_LATER" });

  // 새 세션을 만들고 쿠키를 굽는다. 요청에 이미 세션 쿠키가 있으면 그 세션은 지운다(DESIGN 6.3 세션).
  // 세션을 만들 때 읽은 역할을 돌려준다. 응답은 이 역할을 쓴다(앞서 읽은 역할은 그사이 승격으로 바뀌었을 수 있다).
  async function signIn(request: FastifyRequest, reply: FastifyReply, userId: number) {
    const previous = request.cookies[cookieName];
    if (previous !== undefined) await deleteSession(db, previous);
    const { token, expiresAt, role } = await createSession(db, userId);
    reply.setCookie(cookieName, token, {
      ...sessionCookieOptions(config),
      maxAge: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    });
    return role;
  }

  app.post(
    "/auth/signup",
    {
      preHandler: signupPerIp,
      schema: {
        body: Credentials,
        response: {
          201: AuthUser,
          400: ErrorResponse,
          403: AuthError,
          409: EmailTaken,
          429: TooManyRequests,
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
        .returning({ id: users.id, email: users.email });
      if (!created) return taken();

      const role = await signIn(request, reply, created.id);
      return reply.code(201).send({ userId: created.id, email: created.email, role });
    },
  );

  app.post(
    "/auth/login",
    {
      preHandler: [loginPerIp, loginPerEmail],
      schema: {
        body: Credentials,
        response: {
          200: AuthUser,
          400: ErrorResponse,
          401: InvalidCredentials,
          403: AuthError,
          429: TooManyRequests,
          503: TryAgainLater,
        },
      },
    },
    async (request, reply) => {
      const invalid = () =>
        reply.code(401).send({ error: "이메일 또는 비밀번호가 맞지 않습니다", code: "INVALID_CREDENTIALS" });
      // 길이가 맞지 않는 비밀번호는 어떤 계정과도 맞을 수 없다. 계정이 있는지와 상관없으니 해시하지 않고 거절한다.
      const password = normalizePassword(request.body.password);
      if (password === null) return invalid();

      const [user] = await db
        .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.email, request.body.email));
      let matched: boolean;
      try {
        // 없는 이메일과 비밀번호 없는 계정도 가짜 해시로 검증해 걸리는 시간을 맞춘다.
        matched = await verifyPassword(user?.passwordHash ?? null, password);
      } catch (err) {
        if (err instanceof PasswordHasherBusy) return busy(reply);
        // 저장된 해시가 깨져 있으면 검증이 던진다. 500이면 그 계정이 있다는 것이 드러나므로 같은 401로 보내고 로그에 남긴다.
        request.log.error({ err, userId: user?.id }, "저장된 비밀번호 해시를 검증하지 못함");
        return invalid();
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
      const role = await signIn(request, reply, user.id);
      return { userId: user.id, email: user.email, role };
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
    async (request) => {
      const user = currentUser(request);
      return { userId: user.id, email: user.email, role: user.role };
    },
  );
};
