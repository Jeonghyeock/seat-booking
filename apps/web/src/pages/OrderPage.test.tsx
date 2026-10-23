import type { OrderView } from "@seat-booking/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../api/queries";
import { OrderPage } from "./OrderPage";

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const baseOrder = (overrides: Partial<OrderView> = {}): OrderView => ({
  orderId: 1,
  holdId: 9,
  performanceId: 3,
  status: "pending",
  cancelReason: null,
  amount: 240000,
  items: [
    { seatId: 11, section: "1층", row: "C", number: 1, grade: "R", price: 120000 },
    { seatId: 12, section: "1층", row: "C", number: 2, grade: "R", price: 120000 },
  ],
  holdExpiresAt: iso(now + 4 * 60_000),
  payBy: iso(now + 3.5 * 60_000),
  serverTime: iso(now),
  payments: [],
  tickets: [],
  ...overrides,
});
const performances = (salesCloseAt: number) => ({
  performances: [
    {
      id: 3,
      showTitle: "뮤지컬 〈샘플〉",
      venueName: "샘플 아트홀",
      startsAt: iso(now + 30 * 86_400_000),
      salesOpenAt: iso(now - 86_400_000),
      salesCloseAt: iso(salesCloseAt),
    },
  ],
});

type Call = { method: string; url: string; init: RequestInit | undefined };
function stubApi(handler: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = { method: init?.method ?? "GET", url, init };
      calls.push(call);
      const { status, body } = handler(call);
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

function renderOrder() {
  const router = createMemoryRouter([{ path: "/orders/:id", element: <OrderPage orderId={1} /> }], {
    initialEntries: ["/orders/1"],
  });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("주문 화면", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("결제하기 → 결제 확인 중(1초마다 다시 읽음) → 예매 완료와 표", async () => {
    let phase: "pending" | "requested" | "paid" = "pending";
    const requested = { paymentId: 5, status: "requested" as const, amount: 240000, createdAt: iso(now), updatedAt: iso(now) };
    const calls = stubApi(({ method, url }) => {
      if (url === "/api/performances") return { status: 200, body: performances(now + 86_400_000) };
      if (method === "POST" && url === "/api/orders/1/payments") {
        phase = "requested";
        return { status: 202, body: { orderId: 1, paymentId: 5, status: "requested" } };
      }
      if (phase === "pending") return { status: 200, body: baseOrder() };
      if (phase === "requested") {
        phase = "paid";
        return { status: 200, body: baseOrder({ payments: [requested] }) };
      }
      return {
        status: 200,
        body: baseOrder({
          status: "paid",
          payments: [{ ...requested, status: "succeeded" }],
          tickets: [
            { ticketId: 70, seatId: 11 },
            { ticketId: 71, seatId: 12 },
          ],
        }),
      };
    });
    const user = userEvent.setup();
    renderOrder();
    await user.click(await screen.findByRole("button", { name: "240,000원 결제하기" }));
    expect(await screen.findByText(/결제를 확인하고 있습니다/, { selector: "strong" })).toBeTruthy();
    expect(await screen.findByText("예매가 완료되었습니다.", { selector: "strong" }, { timeout: 3000 })).toBeTruthy();
    // 상태가 바뀌면 화면 읽기 프로그램에 한 줄로 알린다(남은 시간은 매초 읽지 않는다)
    expect(document.querySelector("[aria-live=polite]")?.textContent).toBe("예매가 완료되었습니다.");
    expect(screen.getByText(/표 70/)).toBeTruthy();

    // 결제 요청은 멱등 키와 고른 상황을 보낸다
    const payment = calls.find((c) => c.method === "POST")!;
    expect(new Headers(payment.init?.headers).get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(String(payment.init?.body))).toEqual({ scenario: "success", delayMs: 1000 });
  });

  it("판매 종료 뒤 좌석 다시 선택은 다시 선점할 수 없다고 확인받는다", async () => {
    stubApi(({ url }) =>
      url === "/api/performances" ? { status: 200, body: performances(now - 1000) } : { status: 200, body: baseOrder() },
    );
    const user = userEvent.setup();
    renderOrder();
    await user.click(await screen.findByRole("button", { name: "좌석 다시 선택(주문 취소)" }));
    const question = await screen.findByText(/다시 선점할 수 없습니다/);
    // 확인을 열면 질문으로, 그대로 두면 다시 연 버튼으로 포커스가 간다
    await waitFor(() => expect(document.activeElement).toBe(question));
    await user.click(screen.getByRole("button", { name: "그대로 두기" }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("좌석 다시 선택(주문 취소)"));
  });

  it("시간이 초과된 주문은 좌석 다시 고르기로 간다(서버가 cancelled(expired)를 준다)", async () => {
    stubApi(({ url }) =>
      url === "/api/performances"
        ? { status: 200, body: performances(now + 86_400_000) }
        : { status: 200, body: baseOrder({ status: "cancelled", cancelReason: "expired" }) },
    );
    renderOrder();
    expect(await screen.findByText("시간이 초과되어 주문이 취소되었습니다.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "좌석 다시 고르기" }).getAttribute("href")).toBe("/performances/3");
    expect(screen.queryByRole("button", { name: /결제하기/ })).toBeNull();
  });
});
