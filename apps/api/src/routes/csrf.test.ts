import { randomUUID } from "node:crypto";
import { AuthError } from "@seat-booking/shared";
import { afterAll, describe, expect, inject, it } from "vitest";
import { newPerformance, newSignedInUsers } from "../../test/fixtures.js";
import { buildApp } from "../app.js";
import { loadAuthConfig, loadTrustProxy } from "../config.js";
import { createPool } from "../db/pool.js";

describe("CSRF", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  const origin = "http://localhost:5173";
  const app = buildApp(pool, {}, { auth: { allowedOrigins: [origin] } });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const login = (headers: Record<string, string>) =>
    app.inject({
      method: "POST",
      url: "/auth/login",
      headers,
      payload: { email: `${randomUUID()}@test.local`, password: randomUUID() },
    });
  const rejected = (res: { statusCode: number; headers: Record<string, unknown>; json(): unknown }, name: string) => {
    expect(res.statusCode, name).toBe(403);
    expect(AuthError.parse(res.json()).code, name).toBe("CSRF_REJECTED");
    expect(res.headers["cache-control"], name).toBe("no-store");
  };
  const marker = { "x-requested-with": "seat-booking" };

  it("사용자 지정 헤더가 없거나, 허용하지 않은 Origin, Origin: null, Sec-Fetch-Site: cross-site면 403이다", async () => {
    rejected(await login({}), "헤더 없음");
    rejected(await login({ "x-requested-with": "XMLHttpRequest" }), "다른 값");
    rejected(await login({ ...marker, origin: "https://evil.example" }), "다른 Origin");
    rejected(await login({ ...marker, origin: `${origin}/` }), "끝에 / 붙은 Origin");
    rejected(await login({ ...marker, origin: "null" }), "Origin null");
    rejected(await login({ ...marker, origin, "sec-fetch-site": "cross-site" }), "cross-site");
  });

  it("허용한 Origin(또는 Origin 없음)과 사용자 지정 헤더가 있으면 지나간다. same-site는 거절하지 않는다", async () => {
    for (const headers of [marker, { ...marker, origin }, { ...marker, origin, "sec-fetch-site": "same-origin" }, { ...marker, "sec-fetch-site": "same-site" }]) {
      expect((await login(headers)).statusCode, JSON.stringify(headers)).toBe(401);
    }
  });

  it("사용자 경로도 CSRF를 먼저 본다. 로그인했어도 헤더가 없으면 403, 로그인하지 않았으면 403이 401보다 먼저다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [user] = await newSignedInUsers(pool, 1);
    const hold = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: `/performances/${performanceId}/holds`, headers, payload: { seatIds: [seatIds[0]] } });
    rejected(await hold({ cookie: user!.headers.cookie }), "로그인했지만 헤더 없음");
    rejected(await hold({}), "로그인도 헤더도 없음");
    expect((await hold(user!.headers)).statusCode).toBe(201);
    rejected(await app.inject({ method: "POST", url: "/auth/logout" }), "로그아웃도");
  });

  it("상태를 바꾸는 경로는 웹훅 말고 모두 CSRF를 확인한다(범위 밖에 잘못 둔 경로를 잡는다)", async () => {
    await app.ready();
    const writes = app.allRoutes.filter((route) => ["POST", "PUT", "PATCH", "DELETE"].includes(route.method));
    expect(writes.map((route) => `${route.method} ${route.url}`).sort()).toEqual([
      "POST /admin/payments/:id/retry-refund",
      "POST /auth/login",
      "POST /auth/logout",
      "POST /auth/signup",
      "POST /holds/:id/orders",
      "POST /orders/:id/cancel",
      "POST /orders/:id/payments",
      "POST /performances/:id/holds",
      "POST /webhooks/fake-pay",
    ]);
    for (const route of writes) {
      if (route.url === "/webhooks/fake-pay") continue;
      rejected(await app.inject({ method: route.method as "POST", url: route.url.replace(/:id/g, "1") }), route.url);
    }
  });

  it("GET은 확인하지 않는다", async () => {
    expect((await app.inject({ method: "GET", url: "/performances" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/auth/me" })).statusCode).toBe(401);
  });
});

describe("설정 읽기", () => {
  it("APP_ORIGIN은 쉼표로 여럿이고, 끝에 /가 붙은 값은 거절한다. COOKIE_SECURE는 true/false 글자만 받는다", () => {
    expect(loadAuthConfig({ APP_ORIGIN: "http://localhost:5173, https://ticket.example", COOKIE_SECURE: "false" })).toEqual({
      allowedOrigins: ["http://localhost:5173", "https://ticket.example"],
      cookieSecure: false,
      authRateLimitPerMinute: 10,
    });
    expect(loadAuthConfig({})).toEqual({ allowedOrigins: [], cookieSecure: true, authRateLimitPerMinute: 10 });
    expect(() => loadAuthConfig({ APP_ORIGIN: "http://localhost:5173/" })).toThrow();
    expect(() => loadAuthConfig({ APP_ORIGIN: "localhost:5173" })).toThrow();
    expect(() => loadAuthConfig({ COOKIE_SECURE: "0" })).toThrow();
  });

  it("AUTH_RATE_LIMIT_PER_MINUTE는 숫자만 받는다", () => {
    expect(loadAuthConfig({ AUTH_RATE_LIMIT_PER_MINUTE: "20" }).authRateLimitPerMinute).toBe(20);
    for (const value of ["0", "0x10", "1e9", "10.5", "-1", ""]) {
      expect(() => loadAuthConfig({ AUTH_RATE_LIMIT_PER_MINUTE: value }), value).toThrow();
    }
  });

  it("TRUST_PROXY는 비우면 끄고, 프록시 주소·CIDR만 받는다. true와 숫자는 거절한다", () => {
    expect(loadTrustProxy({})).toBe(false);
    expect(loadTrustProxy({ TRUST_PROXY: " " })).toBe(false);
    expect(loadTrustProxy({ TRUST_PROXY: "127.0.0.1, 10.0.0.0/8,::1" })).toEqual(["127.0.0.1", "10.0.0.0/8", "::1"]);
    for (const value of ["true", "1", "10.0.0.0/33", "fd00::/129", "localhost", "10.0.0.1/8/1"]) {
      expect(() => loadTrustProxy({ TRUST_PROXY: value }), value).toThrow();
    }
  });
});
