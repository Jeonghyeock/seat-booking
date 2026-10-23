import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, NetworkError } from "../api/client";
import { isRetryable, MAX_RETRIES, withRetry } from "./retry";

const apiError = (status: number, code?: string, retryAfter: number | null = null) =>
  new ApiError("/x", status, code ? { error: "x", code } : { error: "x" }, retryAfter);

describe("멱등 요청의 재시도", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("응답을 못 받음·503·REQUEST_IN_PROGRESS만 다시 보낸다", () => {
    expect(isRetryable(new NetworkError("/x", new Error()))).toBe(true);
    expect(isRetryable(apiError(503))).toBe(true);
    expect(isRetryable(apiError(409, "REQUEST_IN_PROGRESS"))).toBe(true);
    expect(isRetryable(apiError(409, "PAYMENT_IN_PROGRESS"))).toBe(false);
    expect(isRetryable(apiError(422, "IDEMPOTENCY_KEY_REUSED"))).toBe(false);
    expect(isRetryable(apiError(500))).toBe(false);
  });

  it("Retry-After만큼 기다렸다가 다시 보내고, 성공하면 그 값을 준다", async () => {
    const send = vi.fn().mockRejectedValueOnce(apiError(503, "PAYMENT_PROVIDER_UNAVAILABLE", 2)).mockResolvedValueOnce("ok");
    const result = withRetry(send);
    await vi.advanceTimersByTimeAsync(1999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("ok");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("세 번 다시 보내고도 안 되면 마지막 오류를 던진다", async () => {
    const send = vi.fn().mockRejectedValue(apiError(503, undefined, 1));
    const result = withRetry(send).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBeInstanceOf(ApiError);
    expect(send).toHaveBeenCalledTimes(1 + MAX_RETRIES);
  });
});
