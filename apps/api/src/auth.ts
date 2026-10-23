import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { PASSWORD_MAX_INPUT_LENGTH } from "@seat-booking/shared";
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

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

// 정규화 전에 볼 원문 길이(UTF-16 칸)의 상한은 본문 스키마와 같은 PASSWORD_MAX_INPUT_LENGTH(1,024)다.
// NFKC는 글자 하나를 최대 18배로 늘리므로(U+FDFA) 긴 입력을 먼저 버린다. 줄이기도 해서(한글 자모 셋이 한 글자) 128보다 넉넉히 둔다.
// 짝이 없는 서로게이트. argon2로 넘길 때 U+FFFD로 바뀌어 서로 다른 비밀번호가 같은 해시로 통과한다.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// NFKC로 정규화한 비밀번호. 길이(코드 포인트 수)가 맞지 않거나 원문이 너무 길거나 깨진 글자가 있으면 null이다.
// 앞뒤 공백은 지우지 않는다. 나중에 정규화를 바꾸면 옛 해시가 맞지 않으므로 처음부터 정한다.
export function normalizePassword(password: string): string | null {
  if (password.length > PASSWORD_MAX_INPUT_LENGTH || LONE_SURROGATE.test(password)) return null;
  const normalized = password.normalize("NFKC");
  const length = [...normalized].length;
  return length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH ? normalized : null;
}

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
// 만료는 넣는 순간의 역할로 정한다. 호출자가 앞서 읽은 역할을 쓰면, 그사이 관리자로 올린 사용자가 7일짜리 세션을 받는다.
// 사용자 행은 FOR SHARE로 읽는다. 관리자로 올리는 트랜잭션(역할 바꾸기 + 세션 모두 지우기)과 겹치면 그것이 끝난 뒤의 역할로 정한다.
// 잠그지 않으면 문장을 시작할 때의 역할(손님)로 7일짜리 세션을 만들고, 그 세션은 승격이 세션을 지운 뒤에 들어가 남는다.
export async function createSession(db: Db | Tx, userId: number) {
  const { token, tokenHash } = newSessionToken();
  const ttl = sql`case (select role from users where id = ${userId} for share)
                    when 'admin' then ${SESSION_TTL_SECONDS.admin}::int else ${SESSION_TTL_SECONDS.customer}::int end`;
  const [created] = await db
    .insert(sessions)
    .values({ tokenHash, userId, expiresAt: sql`now() + make_interval(secs => ${ttl})` })
    .returning({ expiresAt: sessions.expiresAt });
  await db.execute(sql`
    delete from sessions
     where user_id = ${userId}
       and token_hash <> ${tokenHash}
       and token_hash not in (
         select token_hash from sessions where user_id = ${userId} and token_hash <> ${tokenHash}
          order by created_at desc, token_hash
          limit ${MAX_SESSIONS_PER_USER - 1}
       )
  `);
  return { token, expiresAt: created!.expiresAt };
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
