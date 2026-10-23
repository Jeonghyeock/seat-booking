import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../api/queries";
import { SeatMapPage } from "./SeatMapPage";

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const seat = (seatId: number, number: number, status: "available" | "held" | "sold" = "available") => ({
  seatId,
  section: "1층",
  row: "A",
  number,
  grade: "R",
  price: 120000,
  status,
});
const seatMap = (statuses: Record<number, "available" | "held" | "sold"> = {}) => ({
  performance: {
    id: 1,
    showTitle: "뮤지컬 〈샘플〉",
    venueName: "샘플 아트홀",
    startsAt: iso(now + 30 * 86_400_000),
    salesOpenAt: iso(now - 86_400_000),
    salesCloseAt: iso(now + 29 * 86_400_000),
  },
  seats: [seat(11, 1, statuses[11]), seat(12, 2, statuses[12]), seat(13, 3, statuses[13])],
  serverTime: iso(now),
});
const me = (holds: { holdId: number; seatIds: number[]; orderId: number | null }[] = []) => ({
  performanceId: 1,
  serverTime: iso(now),
  limit: 4,
  heldSeats: holds.reduce((n, h) => n + h.seatIds.length, 0),
  purchasedSeats: 0,
  remaining: 4 - holds.reduce((n, h) => n + h.seatIds.length, 0),
  holds: holds.map((h) => ({ ...h, expiresAt: iso(now + 5 * 60_000) })),
});
const order = (orderId: number) => ({
  orderId,
  holdId: 9,
  performanceId: 1,
  status: "pending",
  cancelReason: null,
  amount: 120000,
  items: [{ seatId: 11, section: "1층", row: "A", number: 1, grade: "R", price: 120000 }],
  holdExpiresAt: iso(now + 5 * 60_000),
  payBy: iso(now + 4.5 * 60_000),
  serverTime: iso(now),
  payments: [],
  tickets: [],
});

type Handler = (method: string, url: string) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
function stubApi(handler: Handler) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const { status, body } = await handler(init?.method ?? "GET", url);
      return new Response(JSON.stringify(body), { status });
    }),
  );
}
const user1 = { userId: 1, email: "kim@example.com", role: "customer" };

function renderSeatMap() {
  const router = createMemoryRouter(
    [
      { path: "/performances/:id", element: <SeatMapPage performanceId={1} /> },
      { path: "/orders/:id", element: <p>주문 화면</p> },
    ],
    { initialEntries: ["/performances/1"] },
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("좌석 지도 화면", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("주문을 만드는 동안 내 좌석을 '다른 사람이 가져갔다'고 알리지 않고, 끝나면 주문 화면으로 간다", async () => {
    let held = false;
    stubApi(async (method, url) => {
      if (url === "/api/auth/me") return { status: 200, body: user1 };
      if (url === "/api/performances/1/seats") return { status: 200, body: seatMap(held ? { 11: "held" } : {}) };
      if (url === "/api/performances/1/me") {
        // 내 선점(/me)이 지도보다 늦게 오면, 지도만 보고는 내 좌석이 남의 선점으로 보인다
        const body = me(held ? [{ holdId: 9, seatIds: [11], orderId: null }] : []);
        await new Promise((r) => setTimeout(r, 200));
        return { status: 200, body };
      }
      if (method === "POST" && url === "/api/performances/1/holds") {
        held = true;
        return { status: 201, body: { holdId: 9, expiresAt: iso(now + 5 * 60_000), serverTime: iso(now), seatIds: [11] } };
      }
      if (method === "POST" && url === "/api/holds/9/orders") {
        await new Promise((r) => setTimeout(r, 600));
        return { status: 201, body: order(31) };
      }
      return { status: 404, body: { error: "없음" } };
    });
    const user = userEvent.setup();
    const router = renderSeatMap();
    await user.click(await screen.findByRole("button", { name: /A열 1번.*선택 가능/ }));
    await user.click(screen.getByRole("button", { name: "1석 선점하기" }));
    // 주문을 만드는 중(0.6초)에 알림이 뜨지 않는다
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.getByRole("button", { name: "선점하는 중…" })).toBeTruthy();
    expect(screen.queryByText(/그사이 선점되었거나 팔려/)).toBeNull();
    await waitFor(() => expect(router.state.location.pathname).toBe("/orders/31"));
  });

  it("선점은 됐는데 주문을 만들지 못하면 그 안내가 남고 고른 좌석을 비운다", async () => {
    let held = false;
    stubApi((method, url) => {
      if (url === "/api/auth/me") return { status: 200, body: user1 };
      if (url === "/api/performances/1/seats") return { status: 200, body: seatMap(held ? { 11: "held" } : {}) };
      if (url === "/api/performances/1/me") return { status: 200, body: me(held ? [{ holdId: 9, seatIds: [11], orderId: null }] : []) };
      if (method === "POST" && url === "/api/performances/1/holds") {
        held = true;
        return { status: 201, body: { holdId: 9, expiresAt: iso(now + 5 * 60_000), serverTime: iso(now), seatIds: [11] } };
      }
      if (method === "POST" && url === "/api/holds/9/orders") return { status: 500, body: { error: "서버 오류" } };
      return { status: 404, body: { error: "없음" } };
    });
    const user = userEvent.setup();
    renderSeatMap();
    await user.click(await screen.findByRole("button", { name: /A열 1번.*선택 가능/ }));
    await user.click(screen.getByRole("button", { name: "1석 선점하기" }));
    expect(await screen.findByText(/좌석은 선점했지만 주문을 만들지 못했습니다/)).toBeTruthy();
    // 띠가 이어서 할 일을 보이고, 지도는 그 좌석을 내 선점으로 그린다
    expect(await screen.findByRole("button", { name: "주문 이어서 만들기" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /A열 1번.*내 선점/ })).toBeTruthy();
    expect(screen.queryByText(/그사이 선점되었거나 팔려/)).toBeNull();
    expect(screen.getByText(/좌석은 선점했지만 주문을 만들지 못했습니다/)).toBeTruthy();
  });

  it("다른 사람이 먼저 선점한 좌석은 이름을 들어 알리고 고른 목록에서 뺀다", async () => {
    stubApi((method, url) => {
      if (url === "/api/auth/me") return { status: 200, body: user1 };
      if (url === "/api/performances/1/seats") return { status: 200, body: seatMap() };
      if (url === "/api/performances/1/me") return { status: 200, body: me() };
      if (method === "POST" && url === "/api/performances/1/holds") {
        return { status: 409, body: { error: "이미 선점", code: "SEAT_UNAVAILABLE", seatIds: [12] } };
      }
      return { status: 404, body: { error: "없음" } };
    });
    const user = userEvent.setup();
    renderSeatMap();
    await user.click(await screen.findByRole("button", { name: /A열 1번.*선택 가능/ }));
    await user.click(screen.getByRole("button", { name: /A열 2번.*선택 가능/ }));
    await user.click(screen.getByRole("button", { name: "2석 선점하기" }));
    expect(await screen.findByText("다른 사람이 먼저 선점했습니다: 1층 A열 2번")).toBeTruthy();
    expect(screen.getByRole("button", { name: "1석 선점하기" })).toBeTruthy();
  });
});
