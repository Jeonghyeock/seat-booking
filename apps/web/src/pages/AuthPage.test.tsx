import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../api/queries";
import { AuthPage } from "./AuthPage";

// 경로 → 응답. 부른 순서대로 기록한다.
function stubApi(routes: Record<string, { status: number; body: unknown }>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${url}`;
      calls.push(key);
      const route = routes[key] ?? { status: 404, body: { error: "없음" } };
      return new Response(JSON.stringify(route.body), { status: route.status });
    }),
  );
  return calls;
}

function renderAt(path: string, mode: "login" | "signup") {
  const router = createMemoryRouter(
    [
      { path: "/login", element: <AuthPage mode="login" /> },
      { path: "/signup", element: <AuthPage mode="signup" /> },
      { path: "/performances/:id", element: <p>좌석 지도 화면</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, mode };
}

describe("가입·로그인", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("가입은 비밀번호 규칙(8~128자)을 먼저 보고, 어기면 보내지 않는다", async () => {
    const calls = stubApi({ "GET /api/auth/me": { status: 401, body: { error: "x", code: "UNAUTHENTICATED" } } });
    const user = userEvent.setup();
    renderAt("/signup", "signup");
    await user.type(screen.getByLabelText("이메일"), "kim@example.com");
    await user.type(screen.getByLabelText("비밀번호"), "short");
    await user.click(screen.getByRole("button", { name: "가입" }));
    expect((await screen.findByRole("alert")).textContent).toBe("비밀번호는 8~128자여야 합니다.");
    expect(calls).not.toContain("POST /api/auth/signup");
  });

  it("로그인이 틀리면 폼에 보이고 로그인 화면에 머문다(전역 인증 규칙을 타지 않는다)", async () => {
    stubApi({
      "GET /api/auth/me": { status: 401, body: { error: "x", code: "UNAUTHENTICATED" } },
      "POST /api/auth/login": { status: 401, body: { error: "x", code: "INVALID_CREDENTIALS" } },
    });
    const user = userEvent.setup();
    const { router } = renderAt("/login?next=%2Fperformances%2F3", "login");
    await user.type(screen.getByLabelText("이메일"), "kim@example.com");
    await user.type(screen.getByLabelText("비밀번호"), "wrong-pass");
    await user.click(screen.getByRole("button", { name: "로그인" }));
    expect(await screen.findByText("이메일 또는 비밀번호가 맞지 않습니다.")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("로그인하면 next로 돌아간다. 바깥 주소인 next는 받지 않는다", async () => {
    stubApi({
      "GET /api/auth/me": { status: 401, body: { error: "x", code: "UNAUTHENTICATED" } },
      "POST /api/auth/login": { status: 200, body: { userId: 1, email: "kim@example.com", role: "customer" } },
    });
    const user = userEvent.setup();
    const { router } = renderAt("/login?next=%2Fperformances%2F3", "login");
    await user.type(screen.getByLabelText("이메일"), "kim@example.com");
    await user.type(screen.getByLabelText("비밀번호"), "a-good-pass");
    await user.click(screen.getByRole("button", { name: "로그인" }));
    expect(await screen.findByText("좌석 지도 화면")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/performances/3");
  });
});
