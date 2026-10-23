import type { FastifyReply, FastifyRequest } from "fastify";
import { findSessionUser, type SessionUser, sessionCookieName } from "../auth.js";
import type { Db } from "../db/client.js";

declare module "fastify" {
  interface FastifyRequest {
    // 로그인한 사용자. 사용자 경로의 훅만 채운다(DESIGN 6.3). 그 밖의 경로에서는 null이다.
    user: SessionUser | null;
  }
  interface FastifyInstance {
    // 세션 훅 범위에 등록된 경로. 테스트가 모두 401인지 확인한다(새 경로가 401을 다른 스키마로 선언해 code가 지워지는 것을 잡는다).
    userRoutes: { method: string; url: string }[];
  }
}

// 인증 설정(DESIGN 6.3 설정). 기본값은 buildApp이 채운다.
// cookieSecure: 켜면 쿠키에 Secure를 붙이고 이름을 __Host-sid로 한다. 기본은 켬이라 운영에 안전하다.
// allowedOrigins: 상태를 바꾸는 요청의 Origin 허용 목록. 기본은 빈 목록(Origin을 보내는 브라우저 요청은 모두 거절).
// authRateLimitPerMinute: 가입·로그인의 분당 허용 수(IP당, 로그인은 IP+이메일).
export type AuthConfig = { cookieSecure: boolean; allowedOrigins: string[]; authRateLimitPerMinute: number };

// 세션 쿠키를 굽고 지울 때 쓰는 속성. 브라우저는 이름·도메인·경로로 쿠키를 가리고, __Host- 쿠키는 Secure와 Path=/가 없는
// Set-Cookie를 버린다. 그래서 지울 때도 구울 때와 같은 속성을 쓴다.
export const sessionCookieOptions = (config: AuthConfig) =>
  ({ path: "/", httpOnly: true, sameSite: "lax", secure: config.cookieSecure }) as const;

// 사용자 경로의 onRequest 훅. 세션 쿠키로 사용자를 찾아 request.user에 둔다. 사용자 신원은 이 훅에서만 정한다.
// 없거나 만료된 세션이면 401 UNAUTHENTICATED이고, 보낸 쿠키는 같은 이름·속성으로 지운다.
// onRequest라 본문을 풀기 전이고, 401이 본문 검증(400)보다 먼저 난다.
export function requireUser(db: Db, config: AuthConfig) {
  const name = sessionCookieName(config.cookieSecure);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[name];
    const user = token === undefined ? null : await findSessionUser(db, token);
    if (!user) {
      if (token !== undefined) reply.clearCookie(name, sessionCookieOptions(config));
      return reply.code(401).send({ error: "로그인이 필요합니다", code: "UNAUTHENTICATED" });
    }
    request.user = user;
  };
}

// 사용자 경로에서 로그인한 사용자. 훅이 채웠으므로 늘 있다.
export function currentUser(request: FastifyRequest): SessionUser {
  if (!request.user) throw new Error("사용자 경로가 아닌 곳에서 currentUser를 불렀습니다");
  return request.user;
}

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const CSRF_HEADER = "x-requested-with";
export const CSRF_HEADER_VALUE = "seat-booking";

// 상태를 바꾸는 요청의 CSRF 확인(DESIGN 6.3 CSRF, 10장 58). 사용자·인증·관리자 경로를 가진 범위에 onRequest로 건다.
// 1. Sec-Fetch-Site가 cross-site면 거절한다. 없으면(브라우저가 아닌 도구) 넘어간다.
// 2. Origin이 있으면 허용 목록과 정확히 같아야 한다. "null"도 있는 값이라 거절한다.
// 3. X-Requested-With: seat-booking이 있어야 한다. 다른 사이트의 폼은 헤더를 붙일 수 없고, fetch가 붙이면 preflight가 막힌다.
// 세션 확인보다 먼저라 DB를 보지 않고 거절한다.
export function csrfGuard(config: AuthConfig) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!STATE_CHANGING.has(request.method)) return;
    const { origin } = request.headers;
    const allowed =
      request.headers["sec-fetch-site"] !== "cross-site" &&
      (origin === undefined || config.allowedOrigins.includes(origin)) &&
      request.headers[CSRF_HEADER] === CSRF_HEADER_VALUE;
    if (!allowed) return reply.code(403).send({ error: "요청을 거절했습니다", code: "CSRF_REJECTED" });
  };
}
