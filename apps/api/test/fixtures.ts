import { randomUUID } from "node:crypto";
import { AuthError } from "@seat-booking/shared";
import type pg from "pg";
import { expect } from "vitest";
import { newSessionToken, type Role, SESSION_TTL_SECONDS, sessionCookieName } from "../src/auth.js";
import { createDb } from "../src/db/client.js";
import { readSeedFile, SAMPLE_SEED, seed } from "../src/db/seed.js";

// 테스트 파일들이 한 DB를 함께 쓰므로, 테스트마다 자기 회차와 사용자를 새로 만든다.

// 샘플 공연장(98석)에 판매 중인 회차 하나를 만들고, 그 회차의 좌석 id를 순서대로 돌려준다.
// 샘플 시드의 날짜는 고정이라 날이 지나면 판매 전이나 공연 뒤가 되므로, 판매 시작은 하루 전, 판매 종료는 29일 뒤,
// 공연은 30일 뒤로 바꾼다.
export async function newPerformance(pool: pg.Pool) {
  const data = readSeedFile(SAMPLE_SEED);
  const day = 24 * 60 * 60 * 1000;
  const performance = {
    ...data.shows[0]!.performances[0]!,
    salesOpenAt: new Date(Date.now() - day).toISOString(),
    salesCloseAt: new Date(Date.now() + 29 * day).toISOString(),
    startsAt: new Date(Date.now() + 30 * day).toISOString(),
  };
  data.shows = [{ ...data.shows[0]!, performances: [performance] }];
  const { performanceIds } = await seed(createDb(pool), data);
  const performanceId = performanceIds[0]!;
  const { rows } = await pool.query<{ seat_id: number }>(
    "select seat_id from performance_seats where performance_id = $1 order by seat_id",
    [performanceId],
  );
  return { performanceId, seatIds: rows.map((r) => r.seat_id) };
}

export async function newUsers(pool: pg.Pool, count: number) {
  const { rows } = await pool.query<{ id: number }>(
    "insert into users (email) select $1 || '-' || g || '@test.local' from generate_series(1, $2) g returning id",
    [randomUUID(), count],
  );
  return rows.map((r) => r.id);
}

// 로그인한 사용자. 가입·로그인 경로(argon2)를 거치지 않고 세션 행을 직접 넣는다. 1,000명도 문장 두세 개다.
// 토큰과 해시는 앱의 세션 모듈이 만든다(해시 방식이 한 곳에만 있게). 헤더는 기본 설정(Secure 켬)의 쿠키 이름과
// CSRF 확인에 필요한 사용자 지정 헤더다(DESIGN 6.3 "테스트 인증").
export type SignedInUser = { id: number; token: string; headers: { cookie: string; "x-requested-with": "seat-booking" } };
export async function newSignedInUsers(
  pool: pg.Pool,
  count: number,
  { role = "customer" }: { role?: Role } = {},
): Promise<SignedInUser[]> {
  const ids = await newUsers(pool, count);
  if (role !== "customer") await pool.query("update users set role = $2 where id = any($1::bigint[])", [ids, role]);
  const tokens = ids.map(() => newSessionToken());
  await pool.query(
    `insert into sessions (token_hash, user_id, expires_at)
     select h, u, now() + make_interval(secs => $3) from unnest($1::text[], $2::bigint[]) as t(h, u)`,
    [tokens.map((t) => t.tokenHash), ids, SESSION_TTL_SECONDS[role]],
  );
  return ids.map((id, i) => ({
    id,
    token: tokens[i]!.token,
    headers: { cookie: `${sessionCookieName(true)}=${tokens[i]!.token}`, "x-requested-with": "seat-booking" },
  }));
}

// HTTP 테스트가 사용자를 id로 다루게 한다. 로그인한 사용자를 만들고, 그 id의 쿠키·CSRF 헤더를 authHeaders로 꺼낸다.
// 테스트 파일마다 모듈이 따로라 표도 파일마다 따로다.
const signedInHeaders = new Map<number, SignedInUser["headers"]>();
export async function newSignedInUserIds(pool: pg.Pool, count: number, options: { role?: Role } = {}) {
  const signedIn = await newSignedInUsers(pool, count, options);
  for (const user of signedIn) signedInHeaders.set(user.id, user.headers);
  return signedIn.map((user) => user.id);
}
// 테스트가 id를 number | undefined로 들고 있어 그대로 받는다. 로그인한 사용자가 아니면 던진다.
export function authHeaders(userId: number | string | undefined) {
  const headers = signedInHeaders.get(Number(userId));
  if (!headers) throw new Error(`로그인한 테스트 사용자가 아닙니다: ${userId}`);
  return headers;
}

// 로그인하지 않은 요청의 헤더들(DESIGN 6.3). 사용자 경로는 모두 401이어야 한다.
// 3단계까지 쓰던 X-User-Id 헤더는 이제 아무 뜻이 없다. 모양이 틀린 쿠키와 만료된 세션은 응답에서 쿠키를 지운다.
export async function unauthenticatedHeaders(pool: pg.Pool): Promise<Record<string, Record<string, string>>> {
  const [someone] = await newUsers(pool, 1);
  const [expired] = await newSignedInUsers(pool, 1);
  await pool.query("update sessions set expires_at = now() - interval '1 second' where user_id = $1", [expired!.id]);
  const csrf = { "x-requested-with": "seat-booking" };
  return {
    "쿠키 없음": csrf,
    "X-User-Id 헤더만": { ...csrf, "x-user-id": String(someone) },
    "모양이 틀린 쿠키": { ...csrf, cookie: `${sessionCookieName(true)}=not-a-token` },
    "만료된 세션": expired!.headers,
  };
}

export function expectUnauthenticated(
  res: { statusCode: number; json(): unknown; headers: Record<string, unknown> },
  name: string,
) {
  expect(res.statusCode, name).toBe(401);
  expect(AuthError.parse(res.json()).code, name).toBe("UNAUTHENTICATED");
  const setCookie = res.headers["set-cookie"];
  if (name === "모양이 틀린 쿠키" || name === "만료된 세션") {
    // 지우는 Set-Cookie도 구울 때와 같은 속성이어야 브라우저가 __Host- 쿠키를 지운다
    const parts = String(setCookie).split("; ");
    expect(parts[0], name).toBe(`${sessionCookieName(true)}=`);
    expect(parts, name).toEqual(expect.arrayContaining(["Max-Age=0", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"]));
    expect(String(setCookie), name).not.toMatch(/Domain=/i);
  } else {
    expect(setCookie, name).toBeUndefined();
  }
}
