import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "./app.js";

describe("GET /health", () => {
  const pool = new pg.Pool({ connectionString: inject("databaseUrl") });
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

  it("DB에 닿지 않으면 500", async () => {
    const down = new pg.Pool({
      connectionString: "postgres://nobody:nothing@127.0.0.1:1/none",
      connectionTimeoutMillis: 1000,
    });
    const broken = buildApp(down);
    try {
      const res = await broken.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(500);
    } finally {
      await broken.close();
      await down.end();
    }
  });
});
