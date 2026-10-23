import { describe, expect, it } from "vitest";
import { sampleFrom, updateClock } from "./clock";

describe("서버 시계", () => {
  it("serverTime을 왕복의 가운데로 본다", () => {
    // 보낸 때 1,000, 받은 때 1,400 → 가운데 1,200. 서버 시각 5,200이면 차이 4,000
    expect(sampleFrom(new Date(5200).toISOString(), 1000, 1400)).toEqual({ offsetMs: 4000, rttMs: 400, takenAt: 1400 });
  });

  it("처음 표본은 받고, 그 뒤로는 왕복이 더 짧은 표본만 받는다", () => {
    const first = { offsetMs: 100, rttMs: 200, takenAt: 10_000 };
    expect(updateClock(null, first)).toBe(first);
    const slower = { offsetMs: 900, rttMs: 3000, takenAt: 11_000 };
    expect(updateClock(first, slower)).toBe(first);
    const faster = { offsetMs: 120, rttMs: 50, takenAt: 12_000 };
    expect(updateClock(first, faster)).toBe(faster);
  });

  it("지금 표본이 1분보다 오래됐으면 왕복이 길어도 받는다", () => {
    const old = { offsetMs: 100, rttMs: 50, takenAt: 0 };
    const later = { offsetMs: 500, rttMs: 400, takenAt: 60_001 };
    expect(updateClock(old, later)).toBe(later);
    expect(updateClock(old, { ...later, takenAt: 60_000 })).toBe(old);
  });
});
