import { sleep } from "k6";
import { SharedArray } from "k6/data";
import http from "k6/http";
import { Counter } from "k6/metrics";

// 부하 시나리오가 함께 쓰는 것(DESIGN 6.6 "시나리오"). 실행기(run-cli.ts)가 환경 변수로 주소와 데이터 위치를 넘긴다.

export const BASE = __ENV.BASE_URL || "http://127.0.0.1:3201";
const DATA_DIR = __ENV.DATA_DIR;
if (!DATA_DIR) throw new Error("DATA_DIR(load/results)이 없습니다");

// 큰 배열은 SharedArray로 한 번만 읽어 VU끼리 나눠 쓴다. 원소는 꺼낼 때마다 풀리므로 작은 값만 꺼낸다.
const json = (name) => JSON.parse(open(`${DATA_DIR}/${name}`));
export const cookies = new SharedArray("cookies", () => json("cookies.json"));
export const seatIds = new SharedArray("seatIds", () => json("load-data.json").seatIds);
export const s3PerformanceIds = new SharedArray("s3PerformanceIds", () => json("load-data.json").s3PerformanceIds);
const meta = new SharedArray("meta", () => {
  const data = json("load-data.json");
  return [{ s1: data.s1PerformanceId, users: data.userIds.length }];
})[0];
export const S1_PERFORMANCE = meta.s1;
export const USERS = meta.users;

// 409(좌석이 없음, 한도 등)는 이 앱에서 정상 결과다. 실패율(http_req_failed)에 넣지 않고 아래 api_errors로 코드별로 센다.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 409));

// 2xx가 아닌 응답. 태그: 경로 이름, 상태(응답이 없으면 0), 오류 코드(본문의 code).
export const apiErrors = new Counter("api_errors");
// 요약에 코드별 수가 나오게 실행기가 threshold를 걸 코드들.
export const ERROR_CODES = [
  "SEAT_UNAVAILABLE",
  "HOLD_LIMIT",
  "SALES_CLOSED",
  "PRICE_MISSING",
  "REQUEST_IN_PROGRESS",
  "ORDER_EXISTS",
  "HOLD_EXPIRED",
  "ORDER_NOT_PAYABLE",
  "PAYMENT_IN_PROGRESS",
  "PAYMENT_PROVIDER_UNAVAILABLE",
  "ORDER_NOT_CANCELLABLE",
  "none",
];

export function errorCode(res) {
  try {
    return res.json("code") || "none";
  } catch {
    return "none";
  }
}

// 요청 하나. name은 서버 LOAD_STATS의 경로 이름과 같게 둔다. discard면 본문을 받지 않는다(k6도 같은 CPU를 쓴다).
export function request(method, path, name, { cookie, body, key, discard } = {}) {
  const headers = { "x-requested-with": "seat-booking" };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (key) headers["idempotency-key"] = key;
  const res = http.request(method, `${BASE}${path}`, body === undefined ? null : JSON.stringify(body), {
    headers,
    tags: { name },
    timeout: "30s",
    responseType: discard ? "none" : "text",
  });
  if (res.status === 0 || res.status >= 300) {
    apiErrors.add(1, { name, status: String(res.status), code: discard ? "none" : errorCode(res) });
  }
  return res;
}

// 화면의 재시도 규칙(DESIGN 10장 76): 응답이 없거나 503이거나 409 REQUEST_IN_PROGRESS면
// Retry-After(없으면 1초) 뒤 같은 키와 본문으로 세 번까지 다시 보낸다.
export function withRetry(send) {
  for (let attempt = 0; ; attempt++) {
    const res = send();
    const retryable = res.status === 0 || res.status === 503 || (res.status === 409 && errorCode(res) === "REQUEST_IN_PROGRESS");
    if (!retryable || attempt >= 3) return res;
    sleep(Number(res.headers["Retry-After"]) || 1);
  }
}

export const seatMap = (performanceId, discard = false) =>
  request("GET", `/performances/${performanceId}/seats`, "GET /performances/:id/seats", { discard });
// 빈 좌석 id. 응답 JSON 전체를 풀지 않고 selector로 꺼낸다(실현성 리뷰 L4).
export const availableSeats = (res) => (res.status === 200 ? res.json('seats.#(status=="available")#.seatId') || [] : []);
export const holdParams = (cookie, performanceId, ids) => ({
  method: "POST",
  url: `${BASE}/performances/${performanceId}/holds`,
  body: JSON.stringify({ seatIds: ids }),
  params: {
    headers: { "x-requested-with": "seat-booking", cookie, "content-type": "application/json" },
    tags: { name: "POST /performances/:id/holds" },
    timeout: "30s",
  },
});
export const hold = (cookie, performanceId, ids) =>
  request("POST", `/performances/${performanceId}/holds`, "POST /performances/:id/holds", { cookie, body: { seatIds: ids } });
export const me = (cookie, performanceId) =>
  request("GET", `/performances/${performanceId}/me`, "GET /performances/:id/me", { cookie });
export function createOrder(cookie, holdId) {
  const key = crypto.randomUUID();
  return withRetry(() => request("POST", `/holds/${holdId}/orders`, "POST /holds/:id/orders", { cookie, body: {}, key }));
}
export function pay(cookie, orderId, scenario) {
  const key = crypto.randomUUID();
  return withRetry(() =>
    request("POST", `/orders/${orderId}/payments`, "POST /orders/:id/payments", { cookie, body: { scenario, delayMs: 1000 }, key }),
  );
}
export const getOrder = (cookie, orderId) => request("GET", `/orders/${orderId}`, "GET /orders/:id", { cookie });
export const cancelOrder = (cookie, orderId) =>
  request("POST", `/orders/${orderId}/cancel`, "POST /orders/:id/cancel", { cookie, body: {} });
export const myOrders = (cookie) => request("GET", "/orders", "GET /orders", { cookie });

// 주문이 paid나 cancelled가 되거나 마지막 결제가 failed가 될 때까지 화면처럼 읽는다(처음 15초는 1초마다, 그 뒤 5초마다).
export function waitForResult(cookie, orderId, maxSeconds) {
  for (let waited = 0; waited < maxSeconds; ) {
    const step = waited < 15 ? 1 : 5;
    sleep(step);
    waited += step;
    const res = getOrder(cookie, orderId);
    if (res.status !== 200) continue;
    const order = res.json();
    if (order.status !== "pending") return order.status;
    if (order.payments.length > 0 && order.payments[0].status === "failed") return "failed";
  }
  return "pending";
}

export function sleepUntil(epochMs) {
  const ms = epochMs - Date.now();
  if (ms > 0) sleep(ms / 1000);
}

// 클라이언트 쪽 기록(C2 확인 (b)·(f)). k6를 --log-format=json으로 띄우면 한 줄씩 파일에 남는다.
export const record = (event) => console.log(JSON.stringify(event));

// 시나리오(단계·예열)마다 첫 반복이 시작 시각을 남긴다. 실행기가 API·DB 표본을 단계별로 나눌 때 쓴다.
export function markPhase(exec) {
  if (exec.scenario.iterationInTest === 0) record({ ev: "phase", name: exec.scenario.name, startedAt: exec.scenario.startTime });
}
