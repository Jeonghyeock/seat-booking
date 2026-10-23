import {
  AuthUser,
  type Credentials,
  HoldResponse,
  MyOrders,
  MyPerformance,
  OrderView,
  PaymentAccepted,
  type PaymentRequest,
  PerformanceList,
  SeatMap,
} from "@seat-booking/shared";
import { z } from "zod";
import { createOrderAttemptName, currentOrNewAttempt, payAttemptName, readAttempt, startAttempt } from "../lib/idempotency";
import { withRetry } from "../lib/retry";
import { ApiError, apiRequest } from "./client";

// 경로마다 요청과 응답 스키마를 한 곳에 둔다. 화면은 이 함수만 부른다.

export const getPerformances = async () => (await apiRequest("/performances", { schema: PerformanceList })).data;
export const getSeatMap = async (performanceId: number) =>
  (await apiRequest(`/performances/${performanceId}/seats`, { schema: SeatMap })).data;
export const getMyPerformance = async (performanceId: number) =>
  (await apiRequest(`/performances/${performanceId}/me`, { schema: MyPerformance })).data;
export const getOrder = async (orderId: number) => (await apiRequest(`/orders/${orderId}`, { schema: OrderView })).data;
export const getMyOrders = async () => (await apiRequest("/orders", { schema: MyOrders })).data;

export const login = async (credentials: Credentials) =>
  (await apiRequest("/auth/login", { method: "POST", body: credentials, schema: AuthUser })).data;
export const signup = async (credentials: Credentials) =>
  (await apiRequest("/auth/signup", { method: "POST", body: credentials, schema: AuthUser })).data;
export const logout = () => apiRequest("/auth/logout", { method: "POST", schema: z.object({}) });

// 선점. 멱등 키가 없으므로 다시 보내지 않는다(실패하면 화면이 /me로 판단한다, DESIGN 10장 74).
export const createHold = async (performanceId: number, seatIds: number[]) =>
  (await apiRequest(`/performances/${performanceId}/holds`, { method: "POST", body: { seatIds }, schema: HoldResponse })).data;

// 선점으로 주문을 만든다. 키는 holdId로 저장해 두고, 같은 선점의 주문은 같은 키로 보낸다(새로고침·응답 유실 뒤 이어서).
// 이미 주문이 있으면(다른 탭, 저장한 키가 없음) ORDER_EXISTS의 orderId로 간다. 주문 id만 돌려준다(주문 화면이 다시 읽는다).
export async function createOrderFor(holdId: number): Promise<number> {
  const attempt = currentOrNewAttempt(createOrderAttemptName(holdId), {});
  try {
    const { data } = await withRetry(() =>
      apiRequest(`/holds/${holdId}/orders`, {
        method: "POST",
        headers: { "idempotency-key": attempt.key },
        schema: OrderView,
      }),
    );
    return data.orderId;
  } catch (error) {
    if (error instanceof ApiError && error.code === "ORDER_EXISTS") {
      const orderId = (error.body as { orderId?: unknown }).orderId;
      if (typeof orderId === "number") return orderId;
    }
    // 같은 키를 다른 요청에 썼다면 화면 버그다. 다음에는 새 키로 시작한다.
    if (error instanceof ApiError && error.code === "IDEMPOTENCY_KEY_REUSED") startAttempt(createOrderAttemptName(holdId), {});
    throw error;
  }
}

// 결제 요청. "결제하기"를 누를 때마다 새 시도(새 키)이고, 같은 시도의 재시도는 저장한 키와 본문 그대로다.
export async function requestPayment(orderId: number, body: PaymentRequest, { newAttempt }: { newAttempt: boolean }) {
  const name = payAttemptName(orderId);
  const attempt = newAttempt ? startAttempt(name, body) : (readAttempt(name) ?? startAttempt(name, body));
  return (
    await withRetry(() =>
      apiRequest(`/orders/${orderId}/payments`, {
        method: "POST",
        body: attempt.body,
        headers: { "idempotency-key": attempt.key },
        schema: PaymentAccepted,
      }),
    )
  ).data;
}

// 주문 취소(좌석 다시 선택). 두 번 와도 결과가 같아 키를 받지 않는다.
export const cancelOrder = async (orderId: number) =>
  (await apiRequest(`/orders/${orderId}/cancel`, { method: "POST", schema: OrderView })).data;
