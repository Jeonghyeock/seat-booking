import type { SeatMapSeat } from "@seat-booking/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SeatGrid } from "./SeatGrid";

const seat = (seatId: number, row: string, number: number, overrides: Partial<SeatMapSeat> = {}): SeatMapSeat => ({
  seatId,
  section: "1층",
  row,
  number,
  grade: "R",
  price: 120000,
  status: "available",
  ...overrides,
});
// A열 1·2·3, B열 1·2(B2는 팔림)
const seats = [seat(1, "A", 1), seat(2, "A", 2), seat(3, "A", 3), seat(4, "B", 1), seat(5, "B", 2, { status: "sold" })];

function renderGrid(props: Partial<Parameters<typeof SeatGrid>[0]> = {}) {
  const onToggle = vi.fn();
  render(
    <SeatGrid
      seats={seats}
      selected={new Set()}
      mine={new Set()}
      open={true}
      gradeIndex={new Map([["R", 0]])}
      onToggle={onToggle}
      {...props}
    />,
  );
  return { onToggle };
}

describe("좌석 지도", () => {
  it("열마다 묶이고, 좌석 이름에 위치·등급·가격·상태가 있다", () => {
    renderGrid({ selected: new Set([2]), mine: new Set([3]) });
    expect(screen.getByRole("group", { name: "1층 A열" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1층 A열 1번, R 120,000원, 선택 가능" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /A열 2번.*선택함/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /A열 3번.*내 선점/ }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: /B열 2번.*판매됨/ }).getAttribute("aria-disabled")).toBe("true");
  });

  it("탭 정지점은 하나이고 화살표·Home·End로 옮긴다(아래 열이 짧으면 끝 좌석으로)", async () => {
    const user = userEvent.setup();
    renderGrid();
    const tabbable = screen.getAllByRole("button").filter((b) => b.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    await user.tab();
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/A열 1번/);
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/A열 3번/);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/B열 2번/);
    await user.keyboard("{Home}");
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/B열 1번/);
    await user.keyboard("{ArrowUp}{End}");
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/A열 3번/);
  });

  it("고를 수 있는 좌석은 Enter·Space·클릭으로 고르고, 고를 수 없는 좌석은 무시한다", async () => {
    const user = userEvent.setup();
    const { onToggle } = renderGrid();
    await user.tab();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onToggle).toHaveBeenNthCalledWith(1, 1);
    expect(onToggle).toHaveBeenNthCalledWith(2, 1);
    await user.click(screen.getByRole("button", { name: /B열 2번/ }));
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("판매 중이 아니면 어떤 좌석도 고를 수 없다", async () => {
    const user = userEvent.setup();
    const { onToggle } = renderGrid({ open: false });
    await user.click(screen.getByRole("button", { name: /A열 1번/ }));
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /A열 1번/ }).getAttribute("aria-disabled")).toBe("true");
  });
});
