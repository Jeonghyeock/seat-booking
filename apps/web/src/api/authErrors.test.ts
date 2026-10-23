import { describe, expect, it } from "vitest";
import { authActionFor } from "./authErrors";
import { ApiError, NetworkError } from "./client";

const error = (path: string, status: number, code?: string) =>
  new ApiError(path, status, code === undefined ? { error: "x" } : { error: "x", code }, null);

describe("인증 오류 → 할 일", () => {
  it.each([
    ["내 정보의 401은 로그인 전", error("/auth/me", 401, "UNAUTHENTICATED"), "signedOut"],
    ["다른 경로의 401은 세션 만료", error("/orders/1", 401, "UNAUTHENTICATED"), "sessionExpired"],
    ["로그인 폼의 401은 폼이 보인다", error("/auth/login", 401, "INVALID_CREDENTIALS"), "none"],
    ["가입 폼의 409는 폼이 보인다", error("/auth/signup", 409, "EMAIL_TAKEN"), "none"],
    ["관리자 아님", error("/admin/payments", 403, "FORBIDDEN"), "forbidden"],
    ["CSRF 거절은 화면 버그", error("/holds/1/orders", 403, "CSRF_REJECTED"), "bug"],
    ["그 밖의 409", error("/performances/1/holds", 409, "SEAT_UNAVAILABLE"), "none"],
    ["네트워크 오류", new NetworkError("/orders", new Error("x")), "none"],
  ])("%s", (_name, err, action) => {
    expect(authActionFor(err)).toBe(action);
  });
});
