import { describe, expect, it } from "vitest";
import { buildCreatePerformance, type PerformanceForm, problemsToErrors } from "./performanceForm";

const form = (overrides: Partial<PerformanceForm> = {}): PerformanceForm => ({
  showMode: "existing",
  showId: "2",
  title: "",
  venueId: "1",
  prices: { VIP: "150000", R: "120000" },
  startsAt: "2027-03-01T19:30",
  salesOpenAt: "2027-02-01T20:00",
  salesCloseAt: "2027-03-01T16:30",
  ...overrides,
});

describe("회차 등록 폼", () => {
  it("KST 입력에 초와 +09:00을 붙이고, 작품은 고른 id 하나만 보낸다", () => {
    expect(buildCreatePerformance(form(), ["VIP", "R"])).toEqual({
      ok: true,
      body: {
        show: { id: 2 },
        venueId: 1,
        startsAt: "2027-03-01T19:30:00+09:00",
        salesOpenAt: "2027-02-01T20:00:00+09:00",
        salesCloseAt: "2027-03-01T16:30:00+09:00",
        prices: { VIP: 150000, R: 120000 },
      },
    });
  });

  it("새 작품이면 제목만 보낸다(앞뒤 공백을 지운다). 고른 작품 id가 남아 있어도 보내지 않는다", () => {
    const result = buildCreatePerformance(form({ showMode: "new", title: "  햄릿 " }), ["VIP", "R"]);
    expect(result.ok && result.body.show).toEqual({ title: "햄릿" });
  });

  it("API가 받지 않는 연도(UTC 2000~2099년 밖)는 던지지 않고, 다른 칸 문구와 함께 그 칸에 한국 시각으로 알린다(#2 리뷰)", () => {
    // 2000-01-01 08:00 KST 는 UTC 로 1999년이다
    const range = "한국 시각 2000-01-01 09:00부터 2100-01-01 09:00 전까지만 등록할 수 있습니다.";
    const result = buildCreatePerformance(
      form({ venueId: "", startsAt: "2100-01-01T19:00", salesOpenAt: "2000-01-01T08:00", salesCloseAt: "0026-01-01T10:00" }),
      ["VIP", "R"],
    );
    expect(result).toEqual({
      ok: false,
      errors: { venueId: "공연장을 고르세요.", startsAt: range, salesOpenAt: range, salesCloseAt: range },
    });
    expect(buildCreatePerformance(form({ salesOpenAt: "2000-01-01T09:00" }), ["VIP", "R"]).ok).toBe(true);
  });

  it("그 밖에 API 스키마가 거절하는 값도 던지지 않고 한국어 문구로 그 칸에 단다", () => {
    const long = "등".repeat(51); // 공연장 좌석의 등급 이름이 GradeName(50자)보다 길다
    const result = buildCreatePerformance(form({ prices: { [long]: "1000" } }), [long]);
    expect(result).toEqual({ ok: false, errors: { prices: "이 값으로는 등록할 수 없습니다. 입력을 확인하세요." } });
  });

  it("틀린 칸마다 문구를 준다", () => {
    const result = buildCreatePerformance(
      form({ showMode: "new", title: " ", venueId: "", startsAt: "", prices: { VIP: "-1", R: "1.5" } }),
      ["VIP", "R", "S"],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(["prices", "show", "startsAt", "venueId"]);
    expect(result.errors.prices).toMatch(/VIP, R, S$/);
  });

  it("422 problems를 칸에 붙이고, 같은 제목이면 그 작품 id를 준다", () => {
    expect(
      problemsToErrors([
        { reason: "SHOW_TITLE_EXISTS", showId: 7 },
        { reason: "SALES_WINDOW_INVALID" },
        { reason: "SALES_CLOSE_PASSED" },
        { reason: "MISSING_GRADES", grades: ["S"] },
      ]),
    ).toEqual({
      existingShowId: 7,
      errors: {
        show: "같은 제목의 작품이 이미 있습니다.",
        salesCloseAt: "판매 시작 < 판매 종료 ≤ 공연 시작이어야 합니다. 판매 종료가 이미 지났습니다.",
        prices: "가격이 없는 등급: S.",
      },
    });
  });
});
