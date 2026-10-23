import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resetClock, serverNow } from "../lib/clock";
import { ApiError, apiRequest, NetworkError } from "./client";

const okSchema = z.object({ ok: z.literal(true) });

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async () => new Response(body === undefined ? "" : JSON.stringify(body), { status, headers }));
}
const sentInit = (fetchMock: ReturnType<typeof respond>) => (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
const sentHeaders = (fetchMock: ReturnType<typeof respond>) => new Headers(sentInit(fetchMock).headers);

describe("API 클라이언트", () => {
  beforeEach(() => resetClock());
  afterEach(() => vi.unstubAllGlobals());

  it("모든 요청에 X-Requested-With를 붙이고, Content-Type은 본문이 있을 때만 붙인다", async () => {
    const withBody = respond(200, { ok: true });
    vi.stubGlobal("fetch", withBody);
    await apiRequest("/holds", { method: "POST", body: { seatIds: [1] }, schema: okSchema });
    expect(withBody).toHaveBeenCalledWith("/api/holds", expect.objectContaining({ method: "POST", body: '{"seatIds":[1]}' }));
    expect(sentHeaders(withBody).get("x-requested-with")).toBe("seat-booking");
    expect(sentHeaders(withBody).get("content-type")).toBe("application/json");

    const withoutBody = respond(200, { ok: true });
    vi.stubGlobal("fetch", withoutBody);
    await apiRequest("/orders/1/cancel", { method: "POST", schema: okSchema });
    expect(sentHeaders(withoutBody).get("x-requested-with")).toBe("seat-booking");
    expect(sentHeaders(withoutBody).has("content-type")).toBe(false);
    expect(sentInit(withoutBody)).not.toHaveProperty("body");
  });

  it("2xx는 응답 스키마로 파싱하고, 어긋나면 던진다", async () => {
    vi.stubGlobal("fetch", respond(200, { ok: true }));
    expect((await apiRequest("/x", { schema: okSchema })).data).toEqual({ ok: true });
    vi.stubGlobal("fetch", respond(200, { ok: "yes" }));
    await expect(apiRequest("/x", { schema: okSchema })).rejects.toBeInstanceOf(z.ZodError);
  });

  it("4xx·5xx는 status·code·본문·Retry-After를 담은 ApiError다", async () => {
    vi.stubGlobal("fetch", respond(503, { error: "잠시 뒤", code: "PAYMENT_PROVIDER_UNAVAILABLE", paymentId: 7 }, { "retry-after": "1" }));
    const error = await apiRequest("/orders/1/payments", { method: "POST", schema: okSchema }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503, path: "/orders/1/payments", retryAfterSeconds: 1, code: "PAYMENT_PROVIDER_UNAVAILABLE" });
    expect((error as ApiError).serverMessage).toBe("잠시 뒤");
  });

  it("응답을 받지 못하면 NetworkError다(서버에서 처리됐는지 모른다)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(apiRequest("/x", { schema: okSchema })).rejects.toBeInstanceOf(NetworkError);
  });

  it("serverTime이 있는 응답으로 시계를 맞춘다. 다시 보낸 응답(Idempotent-Replayed)은 쓰지 않고 replayed로 알린다", async () => {
    const schema = z.object({ serverTime: z.string() });
    const ahead = new Date(Date.now() + 60_000).toISOString();
    vi.stubGlobal("fetch", respond(201, { serverTime: ahead }, { "idempotent-replayed": "true" }));
    expect((await apiRequest("/holds/1/orders", { method: "POST", body: {}, schema })).replayed).toBe(true);
    expect(Math.abs(serverNow() - Date.now())).toBeLessThan(1000);

    vi.stubGlobal("fetch", respond(200, { serverTime: ahead }));
    expect((await apiRequest("/orders/1", { schema })).replayed).toBe(false);
    expect(serverNow() - Date.now()).toBeGreaterThan(59_000);
  });

  it("오류 본문의 serverTime(SALES_CLOSED)으로도 시계를 맞춘다", async () => {
    const ahead = new Date(Date.now() + 30_000).toISOString();
    vi.stubGlobal("fetch", respond(409, { error: "판매 전", code: "SALES_CLOSED", serverTime: ahead }));
    await expect(apiRequest("/performances/1/holds", { method: "POST", body: {}, schema: okSchema })).rejects.toBeInstanceOf(ApiError);
    expect(serverNow() - Date.now()).toBeGreaterThan(29_000);
  });
});
