import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("GET /health", () => {
  const app = buildApp();
  afterAll(() => app.close());

  it("200과 status ok를 돌려준다", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});
