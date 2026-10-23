import { describe, expect, it } from "vitest";
import { clearAttempts, createOrderAttemptName, currentOrNewAttempt, payAttemptName, readAttempt, startAttempt } from "./idempotency";

describe("멱등 키 저장소", () => {
  it("새 시도는 보내기 전에 저장되고, 다시 시도하면 attempt가 하나 크다", () => {
    const name = payAttemptName(7);
    const first = startAttempt(name, { scenario: "success" });
    expect(readAttempt(name)).toEqual(first);
    expect(first.attempt).toBe(1);
    const second = startAttempt(name, { scenario: "fail" });
    expect(second.attempt).toBe(2);
    expect(second.key).not.toBe(first.key);
  });

  it("저장한 시도가 있으면 같은 키와 본문으로 이어 간다(새로고침 뒤)", () => {
    const name = createOrderAttemptName(3);
    const saved = startAttempt(name, {});
    expect(currentOrNewAttempt(name, { other: true })).toEqual(saved);
  });

  it("로그아웃하면 멱등 키만 지운다", () => {
    startAttempt(payAttemptName(1), {});
    sessionStorage.setItem("seats:1", "[1,2]");
    clearAttempts();
    expect(readAttempt(payAttemptName(1))).toBeNull();
    expect(sessionStorage.getItem("seats:1")).toBe("[1,2]");
  });
});
