import type { OrderStatusInput } from "@seat-booking/shared";

// 주문과 결제의 조합 → 화면(DESIGN 6.2 표, 6.5 주문 화면의 상태, 10장 69). 주문 화면과 내 예매가 같은 함수를 쓴다.
// now는 서버 시각이다. 만료는 화면이 정하지 않는다. 서버는 선점이 지난 pending을 정리 작업 전이라도 cancelled(expired)로 준다.

export type OrderMain =
  // pending, 결제 마감 전, 확인 중인 결제 없음 → 결제하기(남은 시간). lastFailed면 "결제 실패, 다시 시도".
  | { kind: "pay"; payBy: number; lastFailed: boolean }
  // pending, 결제 마감 뒤 → 결제 마감. 선점이 끝날 때까지 "좌석 다시 선택"만.
  | { kind: "payClosed" }
  // 확인 중인 결제(requested)가 있다 → "결제 확인 중". cancelled면 "결제됐다면 자동 환불"이고, 끝난 상태가 아니다(paid가 될 수 있다, C3).
  | { kind: "confirming"; cancelled: boolean }
  | { kind: "paid" }
  | { kind: "cancelled"; reason: "user" | "expired" };

export type RefundLine = {
  paymentId: number;
  amount: number;
  status: "refund_pending" | "refunded" | "refund_failed";
  updatedAt: string;
};

export type OrderScreen = { main: OrderMain; refunds: RefundLine[] };

const isRefund = (status: string): status is RefundLine["status"] =>
  status === "refund_pending" || status === "refunded" || status === "refund_failed";

export function orderScreen(order: OrderStatusInput, now: number): OrderScreen {
  // 결제는 최신순이다. 환불은 결제마다 한 줄이다(앞 결제가 늦게 성공한 경우, 중복 결제, 취소 뒤 성공).
  const refunds = order.payments
    .filter((p): p is typeof p & { status: RefundLine["status"] } => isRefund(p.status))
    .map((p) => ({ paymentId: p.paymentId, amount: p.amount, status: p.status, updatedAt: p.updatedAt }));
  return { main: mainOf(order, now), refunds };
}

function mainOf(order: OrderStatusInput, now: number): OrderMain {
  if (order.status === "paid") return { kind: "paid" };
  if (order.payments.some((p) => p.status === "requested")) return { kind: "confirming", cancelled: order.status === "cancelled" };
  if (order.status === "cancelled") return { kind: "cancelled", reason: order.cancelReason ?? "user" };
  const payBy = Date.parse(order.payBy);
  if (now < payBy) return { kind: "pay", payBy, lastFailed: order.payments[0]?.status === "failed" };
  return { kind: "payClosed" };
}

// 주문을 다시 읽는 간격(밀리초, false면 멈춘다). 응답과 지금 시각으로 정한다(202를 본 적이 없어도 같다, DESIGN 6.5 주문 화면).
// - 확인 중인 결제가 있으면 1초, 그 결제가 15초를 넘으면 5초(유실은 대사 30초, 결제사 장애로 대사가 멈춰도 5초에 머문다).
// - pending이고 결제 마감 전이면 마감 때 한 번 읽고, 마감 뒤에는 상태가 바뀔 때까지 2초(서버가 만료를 알려 줄 때까지).
// - 그 밖(paid, cancelled)에는 멈춘다.
export const FAST_POLL_MS = 1000;
export const SLOW_POLL_MS = 5000;
export const SLOW_AFTER_MS = 15_000;
export const EXPIRY_POLL_MS = 2000;

export function orderRefetchInterval(order: OrderStatusInput, now: number): number | false {
  const requested = order.payments.find((p) => p.status === "requested");
  if (requested && order.status !== "paid") {
    return now - Date.parse(requested.createdAt) < SLOW_AFTER_MS ? FAST_POLL_MS : SLOW_POLL_MS;
  }
  if (order.status !== "pending") return false;
  const untilPayBy = Date.parse(order.payBy) - now;
  return untilPayBy > 0 ? Math.max(FAST_POLL_MS, untilPayBy) : EXPIRY_POLL_MS;
}

// 한 줄 상태(내 예매 목록, 머리말).
export function orderStatusLabel({ main, refunds }: OrderScreen): string {
  const base = {
    pay: "결제 대기",
    payClosed: "결제 마감",
    confirming: "결제 확인 중",
    paid: "예매 완료",
    cancelled: main.kind === "cancelled" && main.reason === "expired" ? "시간 초과" : "취소됨",
  }[main.kind];
  if (refunds.some((r) => r.status === "refund_failed")) return `${base} · 환불 지연`;
  if (refunds.some((r) => r.status === "refund_pending")) return `${base} · 환불 중`;
  if (refunds.length > 0) return `${base} · 환불 완료`;
  return base;
}
