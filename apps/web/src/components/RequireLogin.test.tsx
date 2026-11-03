import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient, queryKeys } from "../api/queries";
import { RequireAdmin } from "./RequireAdmin";
import { RequireLogin } from "./RequireLogin";

const admin = { userId: 1, email: "kim@example.com", role: "admin" };

function stubMe(respond: () => { status: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const { status, body } = respond();
      return new Response(JSON.stringify(body), { status });
    }),
  );
}

function renderGuards() {
  const client = createQueryClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RequireLogin>
          <h1>주문</h1>
        </RequireLogin>
        <RequireAdmin>
          <h1>관리</h1>
        </RequireAdmin>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

describe("로그인·관리자 화면 지킴이", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("내 정보를 이미 읽었으면, 다시 읽기가 실패해도 보던 화면을 그대로 둔다(#3 리뷰)", async () => {
    let fail = false;
    stubMe(() => (fail ? { status: 500, body: { error: "x", code: "INTERNAL" } } : { status: 200, body: admin }));
    const client = renderGuards();
    expect(await screen.findByRole("heading", { name: "주문" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "관리" })).toBeTruthy();

    fail = true; // 다른 탭에 갔다가 돌아와 다시 읽는데 서버가 5xx(재시도까지 실패)
    await client.refetchQueries({ queryKey: queryKeys.me });
    await waitFor(() => expect(client.getQueryState(queryKeys.me)?.status).toBe("error"), { timeout: 3000 });
    await act(() => new Promise((r) => setTimeout(r, 50))); // 질의 상태가 바뀐 뒤의 다시 그리기까지 기다린다
    expect(screen.getByRole("heading", { name: "주문" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "관리" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("처음부터 내 정보를 읽지 못하면 오류와 다시 불러오기를 보인다", async () => {
    stubMe(() => ({ status: 500, body: { error: "x", code: "INTERNAL" } }));
    renderGuards();
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2), { timeout: 3000 });
    expect(screen.queryByRole("heading", { name: "주문" })).toBeNull();
  });
});
