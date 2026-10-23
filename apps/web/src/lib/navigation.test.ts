import { describe, expect, it } from "vitest";
import { loginPath, safeNext } from "./navigation";

describe("로그인 뒤 돌아갈 경로", () => {
  it("같은 사이트의 경로만 받고, 아니면 첫 화면이다", () => {
    expect(safeNext("/performances/3")).toBe("/performances/3");
    expect(safeNext("/orders/1?x=1")).toBe("/orders/1?x=1");
    for (const bad of [null, undefined, "", "https://evil.example", "//evil.example", "/\\evil.example", "/\t/evil.example", "orders/1"]) {
      expect(safeNext(bad), String(bad)).toBe("/");
    }
  });

  it("지금 경로를 next로 붙인다", () => {
    expect(loginPath("/orders/1")).toBe("/login?next=%2Forders%2F1");
  });
});
