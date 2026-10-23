import type { SeatMapSeat } from "@seat-booking/shared";
import { type KeyboardEvent, memo, useEffect, useMemo, useRef, useState } from "react";
import { groupSeats, isSelectable, SEAT_STATE_LABEL, type SeatState, seatState } from "../lib/seats";
import { formatWon } from "../lib/time";
import styles from "./SeatGrid.module.css";

// 좌석 지도(DESIGN 6.5 좌석 지도의 접근성).
// - 좌석은 button이고 aria-pressed로 고름을 알린다. 고를 수 없는 좌석은 disabled가 아니라 aria-disabled다(탭이 건너뛰지 않게).
// - 열마다 role="group"으로 묶고, 지도 안의 탭 정지점은 하나다(roving tabindex). 화살표·Home·End로 옮긴다.
// - 상태는 색만이 아니라 무늬·글자(범례)로도 나눈다. 등급은 옅은 바탕색과 aria-label로 나눈다.

export function seatLabel(seat: SeatMapSeat, state: SeatState) {
  const price = seat.price === null ? "가격 미정" : formatWon(seat.price);
  return `${seat.section} ${seat.row}열 ${seat.number}번, ${seat.grade} ${price}, ${SEAT_STATE_LABEL[state]}`;
}

// 글자 표시. 선점됨은 무늬(빗금)로 나누므로 글자를 두지 않는다.
const STATE_MARK: Record<SeatState, string> = {
  available: "",
  selected: "✓",
  mine: "내",
  held: "",
  sold: "×",
  unpriced: "?",
};

type Props = {
  seats: readonly SeatMapSeat[];
  selected: ReadonlySet<number>;
  mine: ReadonlySet<number>;
  // 판매 중이 아니면 고를 수 없다(지도는 보인다).
  open: boolean;
  gradeIndex: ReadonlyMap<string, number>;
  onToggle: (seatId: number) => void;
};

// 화면이 1초마다 다시 그려져도(타이머) 좌석이 바뀌지 않으면 다시 그리지 않는다. 넘기는 값은 부르는 쪽이 고정해 둔다.
export const SeatGrid = memo(function SeatGrid({ seats, selected, mine, open, gradeIndex, onToggle }: Props) {
  const sections = useMemo(() => groupSeats(seats), [seats]);
  // 화살표로 옮길 때 쓰는 열 목록(구역을 건너 이어진다).
  const rows = useMemo(() => sections.flatMap((s) => s.rows.map((r) => r.seats)), [sections]);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const moved = useRef(false);

  // 탭 정지점: 옮긴 적이 있으면 그 좌석, 없으면 처음 고를 수 있는 좌석(없으면 첫 좌석).
  const tabStop =
    focusedId !== null && seats.some((s) => s.seatId === focusedId)
      ? focusedId
      : (seats.find((s) => isSelectable(s, mine)) ?? seats[0])?.seatId;

  useEffect(() => {
    if (moved.current && focusedId !== null) buttons.current.get(focusedId)?.focus();
    moved.current = false;
  }, [focusedId]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (tabStop === undefined) return;
    const r = rows.findIndex((row) => row.some((s) => s.seatId === tabStop));
    const c = rows[r]!.findIndex((s) => s.seatId === tabStop);
    let next: SeatMapSeat | undefined;
    switch (event.key) {
      case "ArrowRight":
        next = rows[r]![c + 1];
        break;
      case "ArrowLeft":
        next = rows[r]![c - 1];
        break;
      case "ArrowDown":
        next = rows[r + 1]?.[Math.min(c, rows[r + 1]!.length - 1)];
        break;
      case "ArrowUp":
        next = rows[r - 1]?.[Math.min(c, rows[r - 1]!.length - 1)];
        break;
      case "Home":
        next = rows[r]![0];
        break;
      case "End":
        next = rows[r]!.at(-1);
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next) {
      moved.current = true;
      setFocusedId(next.seatId);
    }
  }

  return (
    <div className={styles.map} role="group" aria-label="좌석 지도" onKeyDown={onKeyDown}>
      <div className={styles.stage} aria-hidden="true">
        무대
      </div>
      {sections.map((section) => (
        <div key={section.section} className={styles.section}>
          <h2 className={styles.sectionTitle}>{section.section}</h2>
          {section.rows.map((row) => (
            <div key={row.row} role="group" aria-label={`${section.section} ${row.row}열`} className={styles.row}>
              <span className={styles.rowLabel} aria-hidden="true">
                {row.row}
              </span>
              {row.seats.map((seat) => {
                const state = seatState(seat, selected, mine);
                const selectable = open && isSelectable(seat, mine);
                return (
                  <button
                    key={seat.seatId}
                    ref={(el) => {
                      if (el) buttons.current.set(seat.seatId, el);
                      else buttons.current.delete(seat.seatId);
                    }}
                    type="button"
                    className={styles.seat}
                    data-state={state}
                    data-grade={gradeIndex.get(seat.grade) ?? 0}
                    aria-label={seatLabel(seat, state)}
                    aria-pressed={state === "selected"}
                    aria-disabled={!selectable}
                    tabIndex={seat.seatId === tabStop ? 0 : -1}
                    onFocus={() => setFocusedId(seat.seatId)}
                    onClick={() => {
                      if (selectable) onToggle(seat.seatId);
                    }}
                  >
                    <span aria-hidden="true">{STATE_MARK[state] || seat.number}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
});

// 범례. 상태와 등급(가격)을 글자로도 보인다.
export function SeatLegend({ grades }: { grades: { grade: string; price: number | null; index: number }[] }) {
  const states: SeatState[] = ["available", "selected", "mine", "held", "sold", "unpriced"];
  return (
    <div className={styles.legend}>
      <ul aria-label="좌석 상태">
        {states.map((state) => (
          <li key={state}>
            <span className={styles.swatch} data-state={state} data-grade={0} aria-hidden="true">
              {STATE_MARK[state]}
            </span>
            {SEAT_STATE_LABEL[state]}
          </li>
        ))}
      </ul>
      <ul aria-label="등급과 가격">
        {grades.map(({ grade, price, index }) => (
          <li key={grade}>
            <span className={styles.swatch} data-state="available" data-grade={index} aria-hidden="true" />
            {grade} {price === null ? "가격 미정" : formatWon(price)}
          </li>
        ))}
      </ul>
    </div>
  );
}
