import { randomUUID } from "node:crypto";
import { hash } from "@node-rs/argon2";
import { AuthError, AuthUser, TooManyRequests } from "@seat-booking/shared";
import { afterAll, describe, expect, inject, it } from "vitest";
import { newSignedInUsers, newUsers } from "../../test/fixtures.js";
import { buildApp } from "../app.js";
import { hashPassword, verifyPassword } from "../auth.js";
import { createPool } from "../db/pool.js";
import { LOGIN_PER_IP_FACTOR } from "./auth.js";

// 비밀번호처럼 보이는 글자를 소스에 그대로 두지 않는다(저장소의 비밀 정보 검사가 테스트 값도 잡는다). 값은 만들어 쓴다.
const secret = (n = 12) => randomUUID().replace(/-/g, "").slice(0, n);
const csrf = { "x-requested-with": "seat-booking" };

describe("가입·로그인·로그아웃·내 정보", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  // 속도 제한은 따로 시험한다. 여기서는 넉넉히 둔다.
  const app = buildApp(pool, {}, { auth: { authRateLimitPerMinute: 1000 } });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, headers: { ...csrf, ...headers }, payload });
  const email = () => `${randomUUID()}@test.local`;
  const cookieOf = (res: { headers: Record<string, unknown> }) => {
    const setCookie = String(res.headers["set-cookie"]);
    return { header: setCookie.split(";")[0]!, parts: setCookie.split("; ") };
  };
  const me = (cookie: string) => app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });

  it("가입하면 손님으로 만들고 바로 로그인한다. 쿠키는 __Host-sid, HttpOnly, Secure, SameSite=Lax, 7일이다", async () => {
    const address = email();
    const pw = secret();
    const res = await post("/auth/signup", { email: `  ${address.toUpperCase()} `, password: pw });
    expect(res.statusCode).toBe(201);
    const body = AuthUser.parse(res.json());
    expect(body).toMatchObject({ email: address, role: "customer" });
    expect(res.headers["cache-control"]).toBe("no-store");

    const { header, parts } = cookieOf(res);
    expect(header).toMatch(/^__Host-sid=[A-Za-z0-9_-]{43}$/);
    expect(parts).toEqual(expect.arrayContaining(["Path=/", "HttpOnly", "Secure", "SameSite=Lax"]));
    const maxAge = Number(parts.find((p) => p.startsWith("Max-Age="))!.split("=")[1]);
    expect(maxAge).toBeGreaterThan(7 * 24 * 60 * 60 - 60);
    expect(maxAge).toBeLessThanOrEqual(7 * 24 * 60 * 60);

    expect(AuthUser.parse((await me(header)).json())).toEqual(body);
    const { rows } = await pool.query("select password_hash from users where id = $1", [body.userId]);
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it("이미 있는 이메일(대소문자만 달라도)과 비밀번호 없는 옛 계정은 409 EMAIL_TAKEN이고 넘겨받지 않는다", async () => {
    const address = email();
    expect((await post("/auth/signup", { email: address, password: secret() })).statusCode).toBe(201);
    const again = await post("/auth/signup", { email: address.toUpperCase(), password: secret() });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "EMAIL_TAKEN" });

    const [old] = await newUsers(pool, 1);
    const { rows } = await pool.query("select email from users where id = $1", [old]);
    const takeover = await post("/auth/signup", { email: rows[0].email, password: secret() });
    expect(takeover.statusCode).toBe(409);
    const after = await pool.query("select password_hash from users where id = $1", [old]);
    expect(after.rows[0].password_hash).toBeNull();
  });

  it("같은 이메일로 동시에 가입해도 하나만 201이고 나머지는 409다", async () => {
    const address = email();
    const results = await Promise.all([secret(), secret()].map((pw) => post("/auth/signup", { email: address, password: pw })));
    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409]);
    const { rows } = await pool.query("select count(*)::int as n from users where email = $1", [address]);
    expect(rows[0].n).toBe(1);
  });

  it("비밀번호가 8~128자가 아니거나 이메일 형식이 틀리면 400이다", async () => {
    expect((await post("/auth/signup", { email: email(), password: secret(7) })).statusCode).toBe(400);
    expect((await post("/auth/signup", { email: email(), password: "x".repeat(129) })).statusCode).toBe(400);
    expect((await post("/auth/signup", { email: email(), password: "x".repeat(1025) })).statusCode).toBe(400);
    expect((await post("/auth/signup", { email: "not-an-email", password: secret() })).statusCode).toBe(400);
    expect((await post("/auth/login", { email: "not-an-email", password: secret() })).statusCode).toBe(400);
  });

  it("맞는 이메일·비밀번호로 로그인하면 새 세션이다. 틀린 비밀번호·없는 이메일·비밀번호 없는 계정은 모두 같은 401이다", async () => {
    const address = email();
    const pw = secret();
    await post("/auth/signup", { email: address, password: pw });

    const ok = await post("/auth/login", { email: address.toUpperCase(), password: pw });
    expect(ok.statusCode).toBe(200);
    expect(AuthUser.parse(ok.json()).email).toBe(address);
    expect(ok.headers["cache-control"]).toBe("no-store");

    const [old] = await newUsers(pool, 1);
    const { rows } = await pool.query("select email from users where id = $1", [old]);
    const failures = [
      await post("/auth/login", { email: address, password: `${pw}x` }),
      await post("/auth/login", { email: email(), password: pw }),
      await post("/auth/login", { email: rows[0].email, password: pw }),
      await post("/auth/login", { email: address, password: secret(7) }),
    ];
    for (const res of failures) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "이메일 또는 비밀번호가 맞지 않습니다", code: "INVALID_CREDENTIALS" });
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("저장된 해시가 깨져 있어도 500이 아니라 같은 401이다(계정이 있다는 것이 드러나지 않게)", async () => {
    const [userId] = await newUsers(pool, 1);
    const broken = "not-a-phc";
    await pool.query("update users set password_hash = $2 where id = $1", [userId, broken]);
    const { rows } = await pool.query("select email from users where id = $1", [userId]);
    const res = await post("/auth/login", { email: rows[0].email, password: secret() });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("로그인하면 보낸 쿠키의 옛 세션은 지운다", async () => {
    const address = email();
    const pw = secret();
    const first = cookieOf(await post("/auth/signup", { email: address, password: pw })).header;
    const second = cookieOf(await post("/auth/login", { email: address, password: pw }, { cookie: first })).header;
    expect((await me(first)).statusCode).toBe(401);
    expect((await me(second)).statusCode).toBe(200);
  });

  it("옛 값으로 만든 해시는 로그인할 때 지금 값으로 다시 해시한다", async () => {
    const [userId] = await newUsers(pool, 1);
    const pw = secret();
    await pool.query("update users set password_hash = $2 where id = $1", [userId, await hash(pw, { timeCost: 1 })]);
    const { rows } = await pool.query("select email from users where id = $1", [userId]);
    expect((await post("/auth/login", { email: rows[0].email, password: pw })).statusCode).toBe(200);
    const after = await pool.query("select password_hash from users where id = $1", [userId]);
    expect(after.rows[0].password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it("관리자로 로그인하면 쿠키도 12시간이다", async () => {
    const [userId] = await newUsers(pool, 1);
    const pw = secret();
    await pool.query("update users set role = 'admin', password_hash = $2 where id = $1", [userId, await hashPassword(pw)]);
    const { rows } = await pool.query("select email from users where id = $1", [userId]);
    const res = await post("/auth/login", { email: rows[0].email, password: pw });
    expect(AuthUser.parse(res.json()).role).toBe("admin");
    const maxAge = Number(cookieOf(res).parts.find((p) => p.startsWith("Max-Age="))!.split("=")[1]);
    expect(maxAge).toBeGreaterThan(12 * 60 * 60 - 60);
    expect(maxAge).toBeLessThanOrEqual(12 * 60 * 60);
  });

  it("로그아웃하면 세션 행과 쿠키를 지운다. 로그인하지 않았어도 200이다", async () => {
    const [user] = await newSignedInUsers(pool, 1);
    const res = await post("/auth/logout", {}, { cookie: user!.headers.cookie });
    expect(res.statusCode).toBe(200);
    expect(cookieOf(res).parts).toEqual(expect.arrayContaining(["__Host-sid=", "Max-Age=0", "Path=/", "Secure"]));
    expect((await me(user!.headers.cookie)).statusCode).toBe(401);
    const { rows } = await pool.query("select count(*) as n from sessions where user_id = $1", [user!.id]);
    expect(rows[0].n).toBe(0);
    expect((await post("/auth/logout", {})).statusCode).toBe(200);
  });

  it("로그인하지 않았으면 내 정보는 401 UNAUTHENTICATED다. 401에도 no-store를 붙인다", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/me" });
    expect(res.statusCode).toBe(401);
    expect(AuthError.parse(res.json()).code).toBe("UNAUTHENTICATED");
    expect(res.headers["cache-control"]).toBe("no-store");
    // 다른 사용자 경로도 같다
    expect((await app.inject({ method: "GET", url: "/orders/1" })).headers["cache-control"]).toBe("no-store");
  });

  it("비밀번호 해시가 밀려 있으면 503 TRY_AGAIN_LATER와 Retry-After다", async () => {
    const address = email();
    const pw = secret();
    await post("/auth/signup", { email: address, password: pw });
    // 오래 걸리는 해시(t=100, 수백 ms)를 검증하는 일 둘로 동시 해시 2개를 채워 둔다
    const slow = await hash(secret(), { timeCost: 100 });
    const running = [verifyPassword(slow, secret()), verifyPassword(slow, secret())];
    const res = await post("/auth/login", { email: address, password: pw });
    await Promise.all(running);
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("1");
    expect(res.json()).toMatchObject({ code: "TRY_AGAIN_LATER" });
  });
});

describe("가입·로그인 속도 제한", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  const app = buildApp(pool, {}, { auth: { authRateLimitPerMinute: 3 } });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  // 시험마다 다른 IP에서 보낸다(카운터가 섞이지 않게).
  const post = (url: string, payload: object, remoteAddress: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, headers: { ...csrf, ...headers }, payload, remoteAddress });
  const email = () => `${randomUUID()}@test.local`;

  it("가입은 IP당 분당 허용 수를 넘으면 429 TOO_MANY_REQUESTS와 Retry-After다. 프록시를 믿지 않으면 X-Forwarded-For를 바꿔도 같이 센다", async () => {
    const codes = [];
    for (let i = 0; i < 4; i++) {
      const forwarded = { "x-forwarded-for": `192.0.2.${i}` };
      codes.push((await post("/auth/signup", { email: email(), password: secret() }, "10.0.0.1", forwarded)).statusCode);
    }
    expect(codes).toEqual([201, 201, 201, 429]);
    const limited = await post("/auth/signup", { email: email(), password: secret() }, "10.0.0.1");
    expect(TooManyRequests.parse(limited.json()).error).toMatch(/^요청이 너무 많습니다\. \d+초 뒤에/);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(limited.headers["cache-control"]).toBe("no-store");
  });

  it("로그인은 IP+이메일로 센다. 대소문자·공백만 다른 이메일은 같은 이메일이고, 다른 이메일은 따로 센다", async () => {
    const target = email();
    const codes = [];
    for (const variant of [target, target.toUpperCase(), `  ${target} `, target]) {
      codes.push((await post("/auth/login", { email: variant, password: secret() }, "10.0.0.2")).statusCode);
    }
    expect(codes).toEqual([401, 401, 401, 429]);
    expect((await post("/auth/login", { email: email(), password: secret() }, "10.0.0.2")).statusCode).toBe(401);
  });

  it(`로그인은 이메일을 바꿔 가며 보내도 IP 하나로 그 ${LOGIN_PER_IP_FACTOR}배까지다(해시하지 않는 짧은 비밀번호도 센다)`, async () => {
    for (let i = 0; i < 3 * LOGIN_PER_IP_FACTOR; i++) {
      expect((await post("/auth/login", { email: email(), password: secret(7) }, "10.0.0.3")).statusCode).toBe(401);
    }
    expect((await post("/auth/login", { email: email(), password: secret(7) }, "10.0.0.3")).statusCode).toBe(429);
    expect((await post("/auth/login", { email: email(), password: secret(7) }, "10.0.0.4")).statusCode).toBe(401);
  });
});

describe("프록시 뒤 속도 제한", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  const app = buildApp(pool, { trustProxy: ["10.0.0.9"] }, { auth: { authRateLimitPerMinute: 1 } });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("믿는 프록시에서 온 요청은 X-Forwarded-For의 IP로 센다", async () => {
    const signup = (forwardedFor: string) =>
      app.inject({
        method: "POST",
        url: "/auth/signup",
        headers: { ...csrf, "x-forwarded-for": forwardedFor },
        payload: { email: `${randomUUID()}@test.local`, password: secret() },
        remoteAddress: "10.0.0.9",
      });
    expect((await signup("192.0.2.1")).statusCode).toBe(201);
    expect((await signup("192.0.2.1")).statusCode).toBe(429);
    expect((await signup("192.0.2.2")).statusCode).toBe(201);
  });
});
