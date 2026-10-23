import { createPool } from "./db/pool.js";
import { afterAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "./app.js";

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
});
