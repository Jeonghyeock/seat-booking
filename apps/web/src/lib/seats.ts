import type { MyPerformance, PerformanceSummary, SeatMapSeat } from "@seat-booking/shared";

// 좌석 지도와 선점 실패 판단(DESIGN 6.5 선점 → 주문, 10장 74). 모두 순수 함수다.

// 좌석 하나가 화면에 보이는 상태. 내 선점은 서버에서 그냥 held이므로 /me의 선점 좌석으로 가른다.
export type SeatState = "available" | "selected" | "mine" | "held" | "sold" | "unpriced";

export const SEAT_STATE_LABEL: Record<SeatState, string> = {
  available: "선택 가능",
  selected: "선택함",
  mine: "내 선점",
  held: "선점됨",
  sold: "판매됨",
  unpriced: "가격 미정",
};

export function seatState(seat: SeatMapSeat, selected: ReadonlySet<number>, mine: ReadonlySet<number>): SeatState {
  if (mine.has(seat.seatId)) return "mine";
  if (seat.status === "sold") return "sold";
  if (seat.status === "held") return "held";
  if (seat.price === null) return "unpriced";
  return selected.has(seat.seatId) ? "selected" : "available";
}

export const isSelectable = (seat: SeatMapSeat, mine: ReadonlySet<number>) =>
  seat.status === "available" && seat.price !== null && !mine.has(seat.seatId);

// 내 유효한 선점의 좌석(좌석 id → 선점).
export function mySeats(myPerformance: MyPerformance | null | undefined) {
  const bySeat = new Map<number, MyPerformance["holds"][number]>();
  for (const hold of myPerformance?.holds ?? []) for (const seatId of hold.seatIds) bySeat.set(seatId, hold);
  return bySeat;
}

// 좌석 지도를 읽을 때마다 고른 좌석을 맞춘다. 그사이 선점·판매됐거나 가격이 없어진 좌석은 뺀다.
export function reconcileSelection(selected: readonly number[], seats: readonly SeatMapSeat[], mine: ReadonlySet<number>) {
  const byId = new Map(seats.map((seat) => [seat.seatId, seat]));
  const kept: number[] = [];
  const dropped: number[] = [];
  for (const seatId of selected) {
    const seat = byId.get(seatId);
    if (seat && isSelectable(seat, mine)) kept.push(seatId);
    else dropped.push(seatId);
  }
  return { kept, dropped };
}

// 선점이 실패했을 때(네트워크·5xx·SEAT_UNAVAILABLE·HOLD_LIMIT) /me를 다시 읽은 뒤 판단한다.
// 선점은 멱등 키가 없어, 응답을 잃고 다시 누르거나 두 탭에서 고르면 내가 쥔 좌석으로 409를 받는다.
// - alreadyMine: 고른 좌석이 모두 내 유효한 선점 안에 있다. 그 선점(과 붙은 주문)으로 간다.
// - taken: 실패한 좌석 중 내 것이 아닌 좌석(seatIds). 다른 사람이 먼저 선점했다.
// - unknown: 위에 들지 않는다(네트워크 오류인데 내 선점도 없다, 한도 초과 등). 화면이 오류에 맞는 문구를 보인다.
export type HoldFailure =
  | { kind: "alreadyMine"; holdId: number; orderId: number | null }
  | { kind: "taken"; seatIds: number[] }
  | { kind: "unknown" };

export function classifyHoldFailure(
  selected: readonly number[],
  conflictSeatIds: readonly number[] | null,
  myPerformance: MyPerformance | null | undefined,
): HoldFailure {
  const mine = mySeats(myPerformance);
  const first = selected[0] === undefined ? undefined : mine.get(selected[0]);
  if (first && selected.every((seatId) => mine.has(seatId))) {
    return { kind: "alreadyMine", holdId: first.holdId, orderId: first.orderId };
  }
  const taken = (conflictSeatIds ?? []).filter((seatId) => !mine.has(seatId));
  return taken.length > 0 ? { kind: "taken", seatIds: taken } : { kind: "unknown" };
}

// 회차의 판매 상태(DESIGN 6.5 시계). now는 서버 시각(없으면 PC 시계)이다.
export type SalesState =
  | { kind: "upcoming"; opensAt: number }
  | { kind: "onSale"; closesAt: number }
  | { kind: "closed" }
  | { kind: "ended" };

export function salesState(performance: PerformanceSummary, now: number): SalesState {
  const opensAt = Date.parse(performance.salesOpenAt);
  const closesAt = Date.parse(performance.salesCloseAt);
  if (now < opensAt) return { kind: "upcoming", opensAt };
  if (now < closesAt) return { kind: "onSale", closesAt };
  return now < Date.parse(performance.startsAt) ? { kind: "closed" } : { kind: "ended" };
}

// 좌석 지도를 구역·열로 묶는다. 순서는 응답의 순서(좌석 id, 시드의 배치 순서)를 따른다(정렬 규칙에 기대지 않는다).
export function groupSeats(seats: readonly SeatMapSeat[]) {
  const sections: { section: string; rows: { row: string; seats: SeatMapSeat[] }[] }[] = [];
  for (const seat of seats) {
    let section = sections.find((s) => s.section === seat.section);
    if (!section) {
      section = { section: seat.section, rows: [] };
      sections.push(section);
    }
    let row = section.rows.find((r) => r.row === seat.row);
    if (!row) {
      row = { row: seat.row, seats: [] };
      section.rows.push(row);
    }
    row.seats.push(seat);
  }
  return sections;
}
