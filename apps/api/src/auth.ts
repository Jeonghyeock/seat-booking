import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Db, Tx } from "./db/client.js";
import { sessions, USER_ROLES, users } from "./db/schema.js";

// 계정과 세션(DESIGN 6.3, 10장 55~57).

export type Role = (typeof USER_ROLES)[number];
export type SessionUser = { id: number; email: string; role: Role };

// ── 이메일과 비밀번호 ──

// 앞뒤 공백을 지우고 소문자로. 가입·로그인·관리자 명령이 같은 함수를 쓰고, DB가 CHECK로 지킨다.
// 이메일 형식 검사(zod)가 ASCII만 받으므로 JS와 PostgreSQL의 소문자 변환이 같다.
export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

// 비밀번호 규칙(NFKC 뒤 8~128자)은 가입 폼도 쓰므로 packages/shared에 있다(DESIGN 10장 77).
export { normalizePassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@seat-booking/shared";

// argon2id, OWASP 권장 최소값. 라이브러리의 기본 알고리즘이 argon2id다.
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
// 지금 값으로 만든 PHC 문자열의 앞부분. 저장된 해시가 이것으로 시작하지 않으면 로그인할 때 다시 해시한다.
const CURRENT_HASH_PREFIX = `$argon2id$v=19$m=${ARGON2.memoryCost},t=${ARGON2.timeCost},p=${ARGON2.parallelism}$`;

// 동시에 도는 해시 수. argon2는 libuv 스레드 풀(기본 4개)에서 돌아, 몰리면 DB 연결의 DNS 조회·파일 작업까지 밀린다.
// 넘으면 기다리지 않고 PasswordHasherBusy를 던진다(경로가 503과 Retry-After로 바꾼다).
export const MAX_CONCURRENT_HASHES = 2;
export class PasswordHasherBusy extends Error {
  override name = "PasswordHasherBusy";
}
let runningHashes = 0;

async function withHashSlot<T>(run: () => Promise<T>): Promise<T> {
  if (runningHashes >= MAX_CONCURRENT_HASHES) throw new PasswordHasherBusy("비밀번호 해시가 밀려 있습니다");
  runningHashes++;
  try {
    return await run();
  } finally {
    runningHashes--;
  }
}

export function hashPassword(normalizedPassword: string) {
  return withHashSlot(() => hash(normalizedPassword, ARGON2));
}

// 저장된 해시가 없으면(없는 이메일, 비밀번호가 없는 4단계 전 계정) 가짜 해시로 한 번 검증해 걸리는 시간을 맞추고 false다.
// 가짜 해시는 처음 쓸 때 지금 값으로 만든다(값을 올려도 시간이 맞는다). 만들다 실패하면 다음에 다시 만든다.
let dummyHash: Promise<string> | undefined;
export function verifyPassword(stored: string | null, normalizedPassword: string) {
  return withHashSlot(async () => {
    if (stored === null) {
      dummyHash ??= hash(randomBytes(16).toString("hex"), ARGON2).catch((err: unknown) => {
        dummyHash = undefined;
        throw err;
      });
      await verify(await dummyHash, normalizedPassword);
      return false;
    }
    return verify(stored, normalizedPassword);
  });
}

export function needsRehash(stored: string) {
  return !stored.startsWith(CURRENT_HASH_PREFIX);
}

// ── 세션 ──

export const SESSION_TTL_SECONDS: Record<Role, number> = { customer: 7 * 24 * 60 * 60, admin: 12 * 60 * 60 };
export const MAX_SESSIONS_PER_USER = 10;
// Secure로 굽는 쿠키는 __Host- 접두사를 붙인다. Domain 없이 이 호스트에만, Path=/로만 굽게 브라우저가 강제해
// 서브도메인이나 http 구간이 같은 이름의 쿠키를 심을 수 없다.
export const sessionCookieName = (secure: boolean) => (secure ? "__Host-sid" : "sid");

// 쿠키의 토큰은 무작위 32바이트의 base64url(43자)이다. 모양이 다르면 DB를 보지 않는다.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const isTokenShape = (token: string) => TOKEN_PATTERN.test(token);

// DB에는 토큰의 SHA-256만 둔다. 토큰이 무작위 256비트라 느린 해시가 필요 없다.
export function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function newSessionToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashSessionToken(token) };
}

// 세션을 만든다. 이 사용자의 세션은 방금 만든 것과 그 밖의 최근 것을 합쳐 MAX_SESSIONS_PER_USER개만 남긴다.
// 만료는 넣는 순간의 역할로 정하고, 그 역할을 함께 돌려준다(로그인 응답의 역할이 세션과 같게). 호출자가 앞서 읽은 역할을 쓰면,
// 그사이 관리자로 올린 사용자가 7일짜리 세션을 받는다.
// 사용자 행은 FOR SHARE로 읽어 세션을 넣을 때까지 쥔다. 관리자로 올리는 트랜잭션(역할 바꾸기 + 세션 모두 지우기)과 겹치면,
// 승격이 먼저면 끝나기를 기다려 관리자 역할로 만들고, 이쪽이 먼저면 승격이 이 세션까지 지운다. 잠그지 않으면 손님 역할로
// 7일짜리 세션을 만들고, 그 세션이 승격이 세션을 지운 뒤에 들어가 남는다(DESIGN 10장 64).
export async function createSession(db: Db | Tx, userId: number) {
  const { token, tokenHash } = newSessionToken();
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ role: users.role }).from(users).where(eq(users.id, userId)).for("share");
    if (!user) throw new Error(`없는 사용자의 세션을 만들려 했습니다: ${userId}`);
    const [created] = await tx
      .insert(sessions)
      .values({ tokenHash, userId, expiresAt: sql`now() + make_interval(secs => ${SESSION_TTL_SECONDS[user.role]}::int)` })
      .returning({ expiresAt: sessions.expiresAt });
    await tx.execute(sql`
      delete from sessions
       where user_id = ${userId}
         and token_hash <> ${tokenHash}
         and token_hash not in (
           select token_hash from sessions where user_id = ${userId} and token_hash <> ${tokenHash}
            order by created_at desc, token_hash
            limit ${MAX_SESSIONS_PER_USER - 1}
         )
    `);
    return { token, expiresAt: created!.expiresAt, role: user.role };
  });
}

// 쿠키의 토큰으로 만료 전 세션과 사용자를 찾는다. 역할은 요청마다 users에서 읽으므로 바꾸면 바로 적용된다.
export async function findSessionUser(db: Db | Tx, token: string): Promise<SessionUser | null> {
  if (!isTokenShape(token)) return null;
  const [found] = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashSessionToken(token)), gt(sessions.expiresAt, sql`now()`)));
  return found ?? null;
}

export async function deleteSession(db: Db | Tx, token: string) {
  if (!isTokenShape(token)) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
}

// 역할이 바뀌면 그 사용자의 세션을 모두 지운다(다시 로그인하게).
export async function deleteUserSessions(db: Db | Tx, userId: number) {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
