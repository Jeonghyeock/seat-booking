import type { MyPerformance, PerformanceSummary, SeatMapSeat } from "@seat-booking/shared";
import { describe, expect, it } from "vitest";
import { classifyHoldFailure, groupSeats, reconcileSelection, salesState, seatState } from "./seats";

const seat = (seatId: number, overrides: Partial<SeatMapSeat> = {}): SeatMapSeat => ({
  seatId,
  section: "1층",
  row: "A",
  number: seatId,
  grade: "VIP",
  price: 150000,
  status: "available",
  ...overrides,
});
const me = (holds: { holdId: number; seatIds: number[]; orderId: number | null }[]): MyPerformance => ({
  performanceId: 1,
  serverTime: "2026-10-24T00:00:00.000Z",
  limit: 4,
  heldSeats: holds.reduce((n, h) => n + h.seatIds.length, 0),
  purchasedSeats: 0,
  remaining: 4,
  holds: holds.map((h) => ({ ...h, expiresAt: "2026-10-24T00:05:00.000Z" })),
});

describe("좌석 상태", () => {
  it("내 선점은 서버의 held와 따로 보이고, 가격 없는 좌석은 고를 수 없다", () => {
    const selected = new Set([2]);
    const mine = new Set([3]);
    expect(seatState(seat(1), selected, mine)).toBe("available");
    expect(seatState(seat(2), selected, mine)).toBe("selected");
    expect(seatState(seat(3, { status: "held" }), selected, mine)).toBe("mine");
    expect(seatState(seat(4, { status: "held" }), selected, mine)).toBe("held");
    expect(seatState(seat(5, { status: "sold" }), selected, mine)).toBe("sold");
    expect(seatState(seat(6, { price: null }), selected, mine)).toBe("unpriced");
  });

  it("지도를 다시 읽으면 그사이 선점·판매·가격 없음이 된 좌석과 없어진 좌석을 고른 목록에서 뺀다", () => {
    const seats = [seat(1), seat(2, { status: "held" }), seat(3, { status: "sold" }), seat(4, { price: null })];
    expect(reconcileSelection([1, 2, 3, 4, 9], seats, new Set())).toEqual({ kept: [1], dropped: [2, 3, 4, 9] });
  });

  it("구역·열은 응답 순서대로 묶는다", () => {
    const seats = [seat(1, { section: "2층", row: "B" }), seat(2, { section: "1층", row: "A" }), seat(3, { section: "2층", row: "B" })];
    expect(groupSeats(seats).map((s) => [s.section, s.rows.map((r) => [r.row, r.seats.map((x) => x.seatId)])])).toEqual([
      ["2층", [["B", [1, 3]]]],
      ["1층", [["A", [2]]]],
    ]);
  });
});

describe("선점 실패 판단", () => {
  it("고른 좌석이 모두 내 선점이면(응답을 잃고 다시 눌렀거나 다른 탭) 그 선점으로 간다", () => {
    expect(classifyHoldFailure([5, 6], [5, 6], me([{ holdId: 9, seatIds: [5, 6], orderId: 31 }]))).toEqual({
      kind: "alreadyMine",
      holdId: 9,
      orderId: 31,
    });
    // 한도 초과(좌석 목록 없음)도 같다
    expect(classifyHoldFailure([5], null, me([{ holdId: 9, seatIds: [5, 6], orderId: null }]))).toEqual({
      kind: "alreadyMine",
      holdId: 9,
      orderId: null,
    });
  });

  it("내 것이 아닌 좌석은 다른 사람이 먼저 선점한 것이다", () => {
    expect(classifyHoldFailure([5, 7], [5, 7], me([{ holdId: 9, seatIds: [5], orderId: null }]))).toEqual({
      kind: "taken",
      seatIds: [7],
    });
    expect(classifyHoldFailure([7], [7], me([]))).toEqual({ kind: "taken", seatIds: [7] });
  });

  it("좌석 목록이 없고 내 선점도 아니면 알 수 없다(화면이 오류대로 보인다)", () => {
    expect(classifyHoldFailure([7], null, me([]))).toEqual({ kind: "unknown" });
    expect(classifyHoldFailure([7], null, null)).toEqual({ kind: "unknown" });
  });
});

describe("판매 상태", () => {
  const performance: PerformanceSummary = {
    id: 1,
    showTitle: "뮤지컬",
    venueName: "홀",
    salesOpenAt: "2026-10-24T11:00:00.000Z",
    salesCloseAt: "2026-11-20T08:00:00.000Z",
    startsAt: "2026-11-21T10:30:00.000Z",
  };
  it("판매 전·판매 중·예매 마감·공연 끝을 경계에서 가른다", () => {
    const at = (iso: string, deltaMs = 0) => Date.parse(iso) + deltaMs;
    expect(salesState(performance, at(performance.salesOpenAt, -1)).kind).toBe("upcoming");
    expect(salesState(performance, at(performance.salesOpenAt)).kind).toBe("onSale");
    expect(salesState(performance, at(performance.salesCloseAt, -1)).kind).toBe("onSale");
    expect(salesState(performance, at(performance.salesCloseAt)).kind).toBe("closed");
    expect(salesState(performance, at(performance.startsAt)).kind).toBe("ended");
  });
});
