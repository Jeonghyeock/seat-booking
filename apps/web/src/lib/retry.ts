import { ApiError, NetworkError } from "../api/client";

// 멱등 키가 있는 요청의 재시도(DESIGN 6.5 멱등 키, 10장 76). 같은 시도라 같은 키와 본문으로 다시 보낸다.
// 다시 보내는 것: 응답을 받지 못했을 때, 503(결제사 장애 등), 409 REQUEST_IN_PROGRESS(같은 키의 요청이 처리 중).
// Retry-After(초)만큼 기다리고, 세 번까지 한다. 그 뒤로는 화면이 주문을 다시 읽어 상태를 보인다.
export const MAX_RETRIES = 3;

export function isRetryable(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  if (!(error instanceof ApiError)) return false;
  return error.status === 503 || (error.status === 409 && error.code === "REQUEST_IN_PROGRESS");
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(send: () => Promise<T>, onRetry?: (error: unknown) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (attempt >= MAX_RETRIES || !isRetryable(error)) throw error;
      onRetry?.(error);
      const seconds = error instanceof ApiError ? (error.retryAfterSeconds ?? 1) : 1;
      await wait(seconds * 1000);
    }
  }
}
