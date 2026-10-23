import { createHash, randomUUID } from "node:crypto";
import { hash } from "@node-rs/argon2";
import { afterAll, describe, expect, inject, it } from "vitest";
import { newSignedInUsers, newUsers } from "../test/fixtures.js";
import {
  createSession,
  deleteSession,
  deleteUserSessions,
  findSessionUser,
  hashPassword,
  MAX_SESSIONS_PER_USER,
  needsRehash,
  normalizeEmail,
  normalizePassword,
  PasswordHasherBusy,
  verifyPassword,
} from "./auth.js";
import { createDb } from "./db/client.js";
import { createPool } from "./db/pool.js";

// 비밀번호처럼 보이는 글자를 소스에 그대로 두지 않는다(저장소의 비밀 정보 검사가 테스트 값도 잡는다). 값은 만들어 쓴다.
const word = (seed: string, n: number) => Array.from({ length: n }, (_, i) => seed[i % seed.length]).join("");
const fullwidth = (s: string) => [...s].map((c) => String.fromCodePoint(c.codePointAt(0)! + 0xfee0)).join("");
const smile = String.fromCodePoint(0x1f600);

describe("이메일과 비밀번호", () => {
  it("이메일은 앞뒤 공백을 지우고 소문자로 바꾼다", () => {
    expect(normalizeEmail("  Kim@Example.COM ")).toBe("kim@example.com");
  });

  it("비밀번호는 NFKC로 정규화하고 8~128자(코드 포인트)만 받는다. 앞뒤 공백은 지우지 않는다", () => {
    const ascii = word("pw1", 9);
    expect(normalizePassword(fullwidth(ascii))).toBe(ascii);
    expect(normalizePassword("a".repeat(7))).toBeNull();
    expect(normalizePassword("a".repeat(8))).toBe("a".repeat(8));
    expect(normalizePassword("a".repeat(128))).toBe("a".repeat(128));
    expect(normalizePassword("a".repeat(129))).toBeNull();
    // 이모지 하나는 UTF-16으로 두 칸이지만 한 글자로 센다
    expect(normalizePassword(smile.repeat(128))).not.toBeNull();
    const spaced = ` ${word("pw", 8)} `;
    expect(normalizePassword(spaced)).toBe(spaced);
  });

  it("정규화 전에 너무 긴 원문과 짝 없는 서로게이트를 버린다", () => {
    // U+FDFA 하나가 NFKC로 18글자가 된다. 원문 길이를 먼저 보지 않으면 큰 입력이 메모리를 크게 쓴다
    expect(normalizePassword("\uFDFA".repeat(100))).toBeNull();
    expect(normalizePassword("a".repeat(1025))).toBeNull();
    const body = word("ab", 8);
    expect(normalizePassword(`\uD800${body}`)).toBeNull();
    expect(normalizePassword(`${body}\uDC00`)).toBeNull();
    expect(normalizePassword(`${smile}${body}`)).not.toBeNull();
  });

  it("해시한 비밀번호는 맞는 비밀번호만 통과하고, 저장된 해시가 없으면 늘 실패한다", async () => {
    const right = word("cd", 12);
    const stored = await hashPassword(right);
    expect(stored.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(stored, right)).toBe(true);
    expect(await verifyPassword(stored, `${right}x`)).toBe(false);
    expect(await verifyPassword(null, right)).toBe(false);
  });

  it("지금 값과 다른 값으로 만든 해시는 다시 해시해야 한다", async () => {
    const value = word("ef", 10);
    expect(needsRehash(await hashPassword(value))).toBe(false);
    expect(needsRehash(await hash(value, { timeCost: 1 }))).toBe(true);
  });

  it("동시에 도는 해시가 2개면 세 번째는 기다리지 않고 PasswordHasherBusy다", async () => {
    const [a, b, c] = ["g", "h", "i"].map((s) => word(s, 10)) as [string, string, string];
    const running = [hashPassword(a), hashPassword(b)];
    await expect(hashPassword(c)).rejects.toBeInstanceOf(PasswordHasherBusy);
    await expect(verifyPassword(null, c)).rejects.toBeInstanceOf(PasswordHasherBusy);
    await Promise.all(running);
    expect(await verifyPassword(await hashPassword(c), c)).toBe(true);
  });
});

describe("세션", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  const db = createDb(pool);
  afterAll(() => pool.end());

  const lifetime = async (token: string) => {
    const { rows } = await pool.query(
      `select extract(epoch from expires_at - created_at)::int as seconds
         from sessions where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
      [token],
    );
    return rows[0]?.seconds as number | undefined;
  };

  it("만든 세션의 토큰으로 사용자와 역할을 찾고, 만료는 손님 7일·관리자 12시간이다", async () => {
    const [customer, admin] = await newUsers(pool, 2);
    await pool.query("update users set role = 'admin' where id = $1", [admin]);
    const c = await createSession(db, customer!);
    // 만료는 넣는 순간 users의 역할로 정한다
    const a = await createSession(db, admin!);
    expect(c.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // 만료를 정한 역할을 함께 돌려준다(로그인 응답이 쓴다)
    expect([c.role, a.role]).toEqual(["customer", "admin"]);
    expect(await findSessionUser(db, c.token)).toMatchObject({ id: customer, role: "customer" });
    expect(await findSessionUser(db, a.token)).toMatchObject({ id: admin, role: "admin" });
    expect(await lifetime(c.token)).toBe(7 * 24 * 60 * 60);
    expect(await lifetime(a.token)).toBe(12 * 60 * 60);
  });

  it("DB에는 토큰이 아니라 그 SHA-256만 있다", async () => {
    const [userId] = await newUsers(pool, 1);
    const { token } = await createSession(db, userId!);
    const { rows } = await pool.query("select token_hash from sessions where user_id = $1", [userId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(createHash("sha256").update(token).digest("hex"));
  });

  it("모양이 틀린 토큰은 DB에 그 해시의 세션이 있어도 찾지 않는다", async () => {
    const [userId] = await newUsers(pool, 1);
    const malformed = "a".repeat(42);
    await pool.query("insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 day')", [
      createHash("sha256").update(malformed).digest("hex"),
      userId,
    ]);
    expect(await findSessionUser(db, malformed)).toBeNull();
  });

  it("만료된 세션, 모양이 틀린 토큰, 모르는 토큰은 찾지 못한다", async () => {
    const [userId] = await newUsers(pool, 1);
    const { token } = await createSession(db, userId!);
    expect(await findSessionUser(db, "x".repeat(42))).toBeNull();
    expect(await findSessionUser(db, `${"a".repeat(42)}!`)).toBeNull();
    expect(await findSessionUser(db, "a".repeat(43))).toBeNull();
    await pool.query("update sessions set expires_at = now() - interval '1 second' where user_id = $1", [userId]);
    expect(await findSessionUser(db, token)).toBeNull();
  });

  it("역할을 바꾸면 다음 조회부터 바로 보인다", async () => {
    const [userId] = await newUsers(pool, 1);
    const { token } = await createSession(db, userId!);
    await pool.query("update users set role = 'admin' where id = $1", [userId]);
    expect((await findSessionUser(db, token))?.role).toBe("admin");
  });

  it("사용자당 최근 10개만 남긴다", async () => {
    const [userId] = await newUsers(pool, 1);
    const tokens: string[] = [];
    for (let i = 0; i < MAX_SESSIONS_PER_USER + 2; i++) tokens.push((await createSession(db, userId!)).token);
    const { rows } = await pool.query("select count(*) as n from sessions where user_id = $1", [userId]);
    expect(rows[0].n).toBe(MAX_SESSIONS_PER_USER);
    expect(await findSessionUser(db, tokens[0]!)).toBeNull();
    expect(await findSessionUser(db, tokens[1]!)).toBeNull();
    expect(await findSessionUser(db, tokens.at(-1)!)).not.toBeNull();
  });

  it("세션을 줄일 때 방금 만든 세션은 늘 남긴다(만든 시각이 같아도)", async () => {
    const [userId] = await newUsers(pool, 1);
    // 한 트랜잭션에서 만들면 created_at(now())이 모두 같다
    const tokens = await db.transaction(async (tx) => {
      const made: string[] = [];
      for (let i = 0; i < MAX_SESSIONS_PER_USER + 5; i++) made.push((await createSession(tx, userId!)).token);
      return made;
    });
    expect(await findSessionUser(db, tokens.at(-1)!)).not.toBeNull();
    const { rows } = await pool.query("select count(*) as n from sessions where user_id = $1", [userId]);
    expect(rows[0].n).toBe(MAX_SESSIONS_PER_USER);
  });

  it("세션 하나를 지우거나, 한 사용자의 세션을 모두 지운다", async () => {
    const [userId, other] = await newUsers(pool, 2);
    const one = await createSession(db, userId!);
    const two = await createSession(db, userId!);
    const others = await createSession(db, other!);
    await deleteSession(db, one.token);
    expect(await findSessionUser(db, one.token)).toBeNull();
    expect(await findSessionUser(db, two.token)).not.toBeNull();
    await deleteUserSessions(db, userId!);
    expect(await findSessionUser(db, two.token)).toBeNull();
    expect(await findSessionUser(db, others.token)).not.toBeNull();
  });

  it("테스트 fixture가 넣은 세션도 같은 방식으로 찾는다", async () => {
    const [customer] = await newSignedInUsers(pool, 1);
    const [admin] = await newSignedInUsers(pool, 1, { role: "admin" });
    expect(await findSessionUser(db, customer!.token)).toMatchObject({ id: customer!.id, role: "customer" });
    expect(await findSessionUser(db, admin!.token)).toMatchObject({ id: admin!.id, role: "admin" });
    expect(customer!.headers.cookie).toBe(`__Host-sid=${customer!.token}`);
    expect(await lifetime(admin!.token)).toBe(12 * 60 * 60);
  });

  it("역할은 customer·admin만, 이메일은 정규화된 값만, 토큰 해시는 64자만 받는다(23514)", async () => {
    const [userId] = await newUsers(pool, 1);
    await expect(pool.query("update users set role = 'owner' where id = $1", [userId])).rejects.toMatchObject({
      code: "23514",
      constraint: "users_role_valid",
    });
    await expect(
      pool.query("insert into users (email) values ($1)", [`Upper-${randomUUID()}@test.local`]),
    ).rejects.toMatchObject({ code: "23514", constraint: "users_email_normalized" });
    await expect(
      pool.query("insert into users (email) values ($1)", [` ${randomUUID()}@test.local`]),
    ).rejects.toMatchObject({ code: "23514", constraint: "users_email_normalized" });
    await expect(
      pool.query("insert into sessions (token_hash, user_id, expires_at) values ('abc', $1, now())", [userId]),
    ).rejects.toMatchObject({ code: "23514", constraint: "sessions_token_hash_length" });
  });
});
