import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../api/queries";
import { RequireAdmin } from "../../components/RequireAdmin";
import { NewPerformancePage } from "./NewPerformancePage";
import { RefundsPage } from "./RefundsPage";

type Call = { method: string; url: string; body: unknown };
function stubApi(handler: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const { status, body } = handler(call);
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

function renderAt(path: string, routes: { path: string; element: ReactNode }[]) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const venues = {
  venues: [
    {
      venueId: 1,
      name: "샘플 아트홀",
      totalSeats: 98,
      grades: [
        { grade: "VIP", seats: 20 },
        { grade: "R", seats: 36 },
      ],
    },
  ],
};
const shows = { shows: [{ showId: 7, title: "햄릿" }] };

describe("관리자 화면", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("손님에게는 권한 없음이다(권한은 서버가 지키고, 화면은 내 정보의 역할로 숨긴다)", async () => {
    stubApi(() => ({ status: 200, body: { userId: 1, email: "kim@example.com", role: "customer" } }));
    renderAt("/admin", [{ path: "/admin", element: <RequireAdmin>관리자 화면</RequireAdmin> }]);
    expect(await screen.findByRole("heading", { name: "권한 없음" })).toBeTruthy();
    expect(screen.queryByText("관리자 화면")).toBeNull();
  });

  it("회차 등록: 공연장을 고르면 등급별 가격 칸이 생기고, 판매 종료는 고치기 전까지 공연 3시간 전을 따라간다", async () => {
    stubApi(({ url }) => (url === "/api/admin/venues" ? { status: 200, body: venues } : { status: 200, body: shows }));
    const user = userEvent.setup();
    renderAt("/admin/performances/new", [{ path: "/admin/performances/new", element: <NewPerformancePage /> }]);
    await user.selectOptions(await screen.findByLabelText("공연장"), "1");
    expect(screen.getByLabelText("VIP(20석) 가격(원)")).toBeTruthy();
    expect(screen.getByLabelText("R(36석) 가격(원)")).toBeTruthy();

    const close = screen.getByLabelText("판매 종료(기본: 공연 3시간 전)") as HTMLInputElement;
    await user.type(screen.getByLabelText("공연 시작"), "2027-03-01T19:30");
    expect(close.value).toBe("2027-03-01T16:30");
    await user.clear(close);
    await user.type(close, "2027-02-28T17:00");
    await user.clear(screen.getByLabelText("공연 시작"));
    await user.type(screen.getByLabelText("공연 시작"), "2027-03-02T19:30");
    expect(close.value).toBe("2027-02-28T17:00");
  });

  it("회차 등록: 새 제목은 제목만 KST 시각과 함께 보내고, 같은 제목이면 있는 작품으로 바꿀 수 있다", async () => {
    const calls = stubApi(({ method, url }) => {
      if (url === "/api/admin/venues") return { status: 200, body: venues };
      if (url === "/api/admin/shows") return { status: 200, body: shows };
      if (method === "POST") {
        return {
          status: 422,
          body: { error: "x", code: "PERFORMANCE_INVALID", problems: [{ reason: "SHOW_TITLE_EXISTS", showId: 7 }] },
        };
      }
      return { status: 404, body: { error: "없음" } };
    });
    const user = userEvent.setup();
    renderAt("/admin/performances/new", [{ path: "/admin/performances/new", element: <NewPerformancePage /> }]);
    await user.click(await screen.findByLabelText("새 작품"));
    await user.type(screen.getByLabelText("새 작품 제목"), " 햄릿 ");
    await user.selectOptions(screen.getByLabelText("공연장"), "1");
    await user.type(screen.getByLabelText("VIP(20석) 가격(원)"), "150000");
    await user.type(screen.getByLabelText("R(36석) 가격(원)"), "0");
    await user.type(screen.getByLabelText("공연 시작"), "2027-03-01T19:30");
    await user.type(screen.getByLabelText("판매 시작"), "2027-02-01T20:00");
    await user.click(screen.getByRole("button", { name: "등록" }));

    expect(await screen.findByText("같은 제목의 작품이 이미 있습니다.")).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      show: { title: "햄릿" },
      venueId: 1,
      startsAt: "2027-03-01T19:30:00+09:00",
      salesOpenAt: "2027-02-01T20:00:00+09:00",
      salesCloseAt: "2027-03-01T16:30:00+09:00",
      prices: { VIP: 150000, R: 0 },
    });
    await user.click(screen.getByRole("button", { name: "있는 작품으로 바꾸기" }));
    expect((screen.getByLabelText("작품 고르기") as HTMLSelectElement).value).toBe("7");
  });

  it("환불 다시 시도: 되돌렸는지, 이미 대기 중이었는지를 나눠 보인다", async () => {
    let retried = 0;
    stubApi(({ method }) => {
      if (method === "POST") {
        retried++;
        return { status: 200, body: { paymentId: 5, status: "refund_pending", changed: retried === 1 } };
      }
      return {
        status: 200,
        body: {
          hasMore: false,
          payments: [
            {
              paymentId: 5,
              providerRef: null,
              orderId: 3,
              orderStatus: "cancelled",
              performanceId: 1,
              userId: 2,
              email: "kim@example.com",
              amount: 120000,
              refundAttempts: 5,
              createdAt: "2026-10-24T00:00:00.000Z",
              updatedAt: "2026-10-24T00:05:00.000Z",
            },
          ],
        },
      };
    });
    const user = userEvent.setup();
    renderAt("/admin/refunds", [{ path: "/admin/refunds", element: <RefundsPage /> }]);
    await user.click(await screen.findByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText(/환불 대기로 되돌렸습니다/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(screen.getByText(/이미 환불 대기 중입니다/)).toBeTruthy());
  });
});
