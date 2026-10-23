import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../api/queries";
import { startAttempt } from "../lib/idempotency";
import { Layout } from "./Layout";
import { RequireLogin } from "./RequireLogin";

describe("머리말과 로그아웃", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("로그인이 필요한 화면에서 로그아웃하면 공개 화면(공연 목록)에서 끝나고, 멱등 키와 고른 좌석을 지운다", async () => {
    let signedIn = true;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "/api/auth/logout") {
          signedIn = false;
          return new Response("{}", { status: 200 });
        }
        if (url === "/api/auth/me") {
          return signedIn
            ? new Response(JSON.stringify({ userId: 1, email: "kim@example.com", role: "customer" }), { status: 200 })
            : new Response(JSON.stringify({ error: "x", code: "UNAUTHENTICATED" }), { status: 401 });
        }
        return new Response(JSON.stringify({ error: "x", code: "UNAUTHENTICATED" }), { status: 401 });
      }),
    );
    startAttempt("idem:pay:1", {});
    sessionStorage.setItem("seats:1", "[1]");
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <Layout />,
          children: [
            { index: true, element: <h1>공연</h1> },
            { path: "my/orders", element: <RequireLogin><h1>내 예매</h1></RequireLogin> },
            { path: "login", element: <h1>로그인</h1> },
          ],
        },
      ],
      { initialEntries: ["/my/orders"] },
    );
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "로그아웃" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "로그인" })).toBeTruthy());
    expect(router.state.location.pathname).toBe("/");
    expect(calls).toContain("POST /api/auth/logout");
    expect(sessionStorage.getItem("idem:pay:1")).toBeNull();
    expect(sessionStorage.getItem("seats:1")).toBeNull();
  });
});
