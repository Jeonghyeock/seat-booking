import type { ZodType, z } from "zod";
import { recordServerTime } from "../lib/clock";

// 모든 API 요청을 보내는 곳(DESIGN 6.5 API 클라이언트).
// - 모든 요청에 X-Requested-With를 붙인다(CSRF, DESIGN 6.3). 같은 origin이라 쿠키는 fetch 기본값으로 간다.
// - Content-Type은 본문이 있을 때만 붙인다. 본문 없는 POST에 application/json을 붙이면 API가 400이다.
// - 2xx는 그 경로의 응답 스키마로 파싱한다. 어긋나면 화면 버그다.
// - 4xx·5xx는 ApiError로 던진다. 화면이 그 경로의 오류 스키마(HoldConflict 등)로 본문을 가른다.

export const API_PREFIX = "/api";

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
    // Retry-After(초). 503·429·REQUEST_IN_PROGRESS에 붙는다.
    readonly retryAfterSeconds: number | null,
  ) {
    super(`${status} ${path}`);
  }

  get code(): string | undefined {
    if (typeof this.body === "object" && this.body !== null && "code" in this.body) return String(this.body.code);
    return undefined;
  }

  // 본문의 사람이 읽는 문구(API의 error).
  get serverMessage(): string | undefined {
    if (typeof this.body === "object" && this.body !== null && "error" in this.body) return String(this.body.error);
    return undefined;
  }
}

// 응답을 받지 못했다(연결 끊김 등). 요청이 서버에서 처리됐는지 모른다.
export class NetworkError extends Error {
  override name = "NetworkError";
  constructor(
    readonly path: string,
    readonly cause: unknown,
  ) {
    super(`network ${path}`);
  }
}

type Options<S extends ZodType> = {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  schema: S;
};

export type ApiResult<T> = {
  data: T;
  // 멱등 키로 다시 보내 처음 응답을 그대로 받았다(10장 37). 본문을 캐시에 넣지 말고 그 주문을 다시 읽는다.
  replayed: boolean;
};

export async function apiRequest<S extends ZodType>(path: string, options: Options<S>): Promise<ApiResult<z.infer<S>>> {
  const { method = "GET", body, headers = {}, schema } = options;
  const sentAt = Date.now();
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${path}`, {
      method,
      headers: {
        "x-requested-with": "seat-booking",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    throw new NetworkError(path, err);
  }
  const receivedAt = Date.now();
  const replayed = res.headers.get("idempotent-replayed") === "true";
  const json = await readJson(res);

  // serverTime이 있는 응답(오류 본문의 SALES_CLOSED 포함)으로 시계를 맞춘다. 다시 보낸 응답은 처음 응답의 옛 시각이다.
  if (!replayed && typeof json === "object" && json !== null && "serverTime" in json && typeof json.serverTime === "string") {
    recordServerTime(json.serverTime, sentAt, receivedAt);
  }
  if (!res.ok) throw new ApiError(path, res.status, json, parseRetryAfter(res.headers.get("retry-after")));
  return { data: schema.parse(json), replayed };
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  return Number(value);
}
