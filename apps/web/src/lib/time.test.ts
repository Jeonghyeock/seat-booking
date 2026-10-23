import { describe, expect, it } from "vitest";
import { defaultSalesClose, formatCountdown, formatKst, formatRemaining, formatWon, isoToKstLocal, kstLocalToIso } from "./time";

describe("시각", () => {
  it("KST 입력값에 초와 +09:00을 붙여 보낸다. 형식이 틀리거나 없는 날짜는 null이다", () => {
    expect(kstLocalToIso("2027-03-01T19:00")).toBe("2027-03-01T19:00:00+09:00");
    expect(kstLocalToIso("2027-03-01T19:00:30")).toBe("2027-03-01T19:00:30+09:00");
    expect(kstLocalToIso("2027-02-30T19:00")).toBeNull();
    expect(kstLocalToIso("2027-03-01 19:00")).toBeNull();
    expect(kstLocalToIso("")).toBeNull();
  });

  it("ISO 시각을 KST 입력값으로 되돌린다(브라우저 시간대와 상관없다)", () => {
    expect(isoToKstLocal("2027-03-01T10:00:00Z")).toBe("2027-03-01T19:00");
    expect(isoToKstLocal("2027-03-01T19:00:00+09:00")).toBe("2027-03-01T19:00");
  });

  it("판매 종료 기본값은 공연 3시간 전이고, 자정을 넘기면 전날이다", () => {
    expect(defaultSalesClose("2027-03-01T19:30")).toBe("2027-03-01T16:30");
    expect(defaultSalesClose("2027-03-01T02:00")).toBe("2027-02-28T23:00");
    expect(defaultSalesClose("잘못된 값")).toBeNull();
  });

  it("KST로 보인다", () => {
    expect(formatKst("2026-10-24T10:30:00Z")).toContain("19:30");
  });

  it("남은 시간과 금액", () => {
    expect(formatRemaining(299_001)).toBe("5:00");
    expect(formatRemaining(59_000)).toBe("0:59");
    expect(formatRemaining(-5)).toBe("0:00");
    expect(formatWon(150000)).toBe("150,000원");
    expect(formatCountdown(3 * 86_400_000 + 4 * 3_600_000 + 5)).toBe("3일 4시간");
    expect(formatCountdown(3_723_000)).toBe("1:02:03");
    expect(formatCountdown(59_000)).toBe("0:59");
  });
});
