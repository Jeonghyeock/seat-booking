import type { OrderStatusInput } from "@seat-booking/shared";
import { describe, expect, it } from "vitest";
import { EXPIRY_POLL_MS, FAST_POLL_MS, orderRefetchInterval, orderScreen, orderStatusLabel, SLOW_POLL_MS } from "./orderScreen";

const T = Date.parse("2026-10-24T03:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const payBy = T + 60_000;

type Payment = OrderStatusInput["payments"][number];
const payment = (paymentId: number, status: Payment["status"], createdAt = T - 1000): Payment => ({
  paymentId,
  status,
  amount: 120000,
  createdAt: iso(createdAt),
  updatedAt: iso(createdAt + 500),
});
const order = (overrides: Partial<OrderStatusInput> = {}): OrderStatusInput => ({
  status: "pending",
  cancelReason: null,
  amount: 120000,
  holdExpiresAt: iso(payBy + 30_000),
  payBy: iso(payBy),
  payments: [],
  ...overrides,
});

describe("주문과 결제의 조합 → 화면(DESIGN 6.2 표)", () => {
  it.each([
    ["pending, 결제 마감 전, 결제 없음 → 결제하기", order(), { kind: "pay", payBy, lastFailed: false }],
    ["pending, 마지막 결제 failed → 결제 실패, 다시 시도", order({ payments: [payment(2, "failed")] }), { kind: "pay", payBy, lastFailed: true }],
    ["pending + requested → 결제 확인 중", order({ payments: [payment(2, "requested")] }), { kind: "confirming", cancelled: false }],
    ["paid → 예매 완료", order({ status: "paid", payments: [payment(2, "succeeded")] }), { kind: "paid" }],
    ["cancelled(user), 결제 없음 → 취소됨", order({ status: "cancelled", cancelReason: "user" }), { kind: "cancelled", reason: "user" }],
    [
      "cancelled(expired), failed → 시간 초과",
      order({ status: "cancelled", cancelReason: "expired", payments: [payment(2, "failed")] }),
      { kind: "cancelled", reason: "expired" },
    ],
    [
      "cancelled + requested → 결제 결과 확인 중(끝난 상태가 아니다)",
      order({ status: "cancelled", cancelReason: "expired", payments: [payment(2, "requested")] }),
      { kind: "confirming", cancelled: true },
    ],
    ["pending, 결제 마감 뒤 → 결제 마감", order({ payBy: iso(T - 1) }), { kind: "payClosed" }],
  ])("%s", (_name, input, main) => {
    expect(orderScreen(input, T).main).toEqual(main);
  });

  it("결제 마감 경계: 1ms 전에는 결제하기, 그 시각에는 결제 마감", () => {
    expect(orderScreen(order(), payBy - 1).main.kind).toBe("pay");
    expect(orderScreen(order(), payBy).main.kind).toBe("payClosed");
  });

  it("환불은 결제마다 한 줄이다(pending + 앞 결제 환불, paid + 중복 결제 환불 지연, cancelled + 환불 완료)", () => {
    const pendingRefund = orderScreen(order({ payments: [payment(3, "failed"), payment(2, "refund_pending")] }), T);
    expect(pendingRefund.main).toEqual({ kind: "pay", payBy, lastFailed: true });
    expect(pendingRefund.refunds.map((r) => [r.paymentId, r.status])).toEqual([[2, "refund_pending"]]);

    const paid = orderScreen(order({ status: "paid", payments: [payment(3, "refund_failed"), payment(2, "succeeded")] }), T);
    expect(paid.main.kind).toBe("paid");
    expect(orderStatusLabel(paid)).toBe("예매 완료 · 환불 지연");

    const cancelled = orderScreen(order({ status: "cancelled", cancelReason: "user", payments: [payment(2, "refunded")] }), T);
    expect(orderStatusLabel(cancelled)).toBe("취소됨 · 환불 완료");
  });
});

describe("주문을 다시 읽는 간격", () => {
  it("확인 중인 결제가 있으면 1초, 15초가 지나면 5초", () => {
    expect(orderRefetchInterval(order({ payments: [payment(2, "requested", T - 14_999)] }), T)).toBe(FAST_POLL_MS);
    expect(orderRefetchInterval(order({ payments: [payment(2, "requested", T - 15_000)] }), T)).toBe(SLOW_POLL_MS);
    // 취소된 주문의 확인 중인 결제도 기다린다(결제됐다면 환불)
    expect(orderRefetchInterval(order({ status: "cancelled", cancelReason: "user", payments: [payment(2, "requested")] }), T)).toBe(
      FAST_POLL_MS,
    );
  });

  it("결제 마감 전에는 마감 때 한 번, 마감 뒤에는 상태가 바뀔 때까지 2초", () => {
    expect(orderRefetchInterval(order(), payBy - 30_000)).toBe(30_000);
    expect(orderRefetchInterval(order(), payBy - 10)).toBe(FAST_POLL_MS);
    expect(orderRefetchInterval(order(), payBy)).toBe(EXPIRY_POLL_MS);
  });

  it("끝난 주문은 멈춘다", () => {
    expect(orderRefetchInterval(order({ status: "paid", payments: [payment(2, "succeeded")] }), T)).toBe(false);
    expect(orderRefetchInterval(order({ status: "cancelled", cancelReason: "expired" }), T)).toBe(false);
  });
});
