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

// cookieSecure를 켜면 쿠키에 Secure를 붙이고 이름을 __Host-sid로 한다. 기본은 켬이라 운영에 안전하다.
export type AuthConfig = { cookieSecure: boolean };

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
