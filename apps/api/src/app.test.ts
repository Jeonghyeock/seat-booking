import { AuthError } from "@seat-booking/shared";
import { afterAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "./app.js";
import { createPool } from "./db/pool.js";

describe("GET /health", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  const app = buildApp(pool);
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("DB에 닿으면 200과 status ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("DB 오류로 500이 나도 응답에는 SQL이나 오류 내용이 없다", async () => {
    const down = createPool({
      connectionString: "postgres://nobody:nothing@127.0.0.1:1/none",
      connectionTimeoutMillis: 1000,
    });
    const broken = buildApp(down);
    try {
      const res = await broken.inject({ method: "GET", url: "/performances/7/seats" });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: "서버 오류" });
      expect(res.body).not.toMatch(/select|params|ECONNREFUSED/i);
    } finally {
      await broken.close();
      await down.end();
    }
  });

  it("DB에 닿지 않으면 503, 오류 내용은 응답에 없음", async () => {
    const down = createPool({
      connectionString: "postgres://nobody:nothing@127.0.0.1:1/none",
      connectionTimeoutMillis: 1000,
    });
    const broken = buildApp(down);
    try {
      const res = await broken.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: "unavailable" });
    } finally {
      await broken.close();
      await down.end();
    }
  });
});

describe("경로 범위", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  const app = buildApp(pool);
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("세션 확인은 사용자 경로에만 걸린다. 없는 경로는 401이 아니라 404이고, 공개 경로는 로그인 없이 된다", async () => {
    expect((await app.inject({ method: "POST", url: "/nope" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/orders/1/nope" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/performances" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("세션 훅 범위의 경로는 모두 로그인하지 않으면 401이고 code가 남는다", async () => {
    await app.ready();
    expect(app.userRoutes.map((r) => `${r.method} ${r.url}`).sort()).toEqual([
      "GET /auth/me",
      "GET /orders/:id",
      "GET /performances/:id/me",
      "POST /holds/:id/orders",
      "POST /orders/:id/cancel",
      "POST /orders/:id/payments",
      "POST /performances/:id/holds",
    ]);
    for (const route of app.userRoutes) {
      const res = await app.inject({
        method: route.method as "GET" | "POST",
        url: route.url.replace(/:id/g, "1"),
        headers: { "x-requested-with": "seat-booking" },
      });
      expect(res.statusCode, route.url).toBe(401);
      expect(AuthError.parse(res.json()).code, route.url).toBe("UNAUTHENTICATED");
    }
  });

  it("cookieSecure를 끄면 쿠키 이름은 sid이고 Secure 없이 지운다", async () => {
    const dev = buildApp(pool, {}, { auth: { cookieSecure: false } });
    try {
      const res = await dev.inject({ method: "GET", url: "/orders/1", headers: { cookie: "sid=not-a-token" } });
      expect(res.statusCode).toBe(401);
      expect(String(res.headers["set-cookie"])).toMatch(/^sid=;/);
      expect(String(res.headers["set-cookie"])).not.toMatch(/Secure/);
      // Secure 설정의 이름(__Host-sid)은 읽지 않는다
      const other = await dev.inject({ method: "GET", url: "/orders/1", headers: { cookie: "__Host-sid=not-a-token" } });
      expect(other.headers["set-cookie"]).toBeUndefined();
    } finally {
      await dev.close();
    }
  });
});
