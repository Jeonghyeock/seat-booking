import { useCallback, useState } from "react";

// 고른 좌석(화면 상태). 로그인하러 갔다 와도 남게 회차별로 sessionStorage에 둔다(DESIGN 6.5 서버 상태와 화면 상태).
const PREFIX = "seats:";
const nameOf = (performanceId: number) => `${PREFIX}${performanceId}`;

function read(performanceId: number): number[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(nameOf(performanceId)) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is number => Number.isInteger(v)) : [];
  } catch {
    return [];
  }
}

function write(performanceId: number, seatIds: number[]) {
  try {
    if (seatIds.length === 0) sessionStorage.removeItem(nameOf(performanceId));
    else sessionStorage.setItem(nameOf(performanceId), JSON.stringify(seatIds));
  } catch {
    // 쓸 수 없는 창이면 이 화면 안에서만 남는다
  }
}

// 바꾸는 함수는 값이나 "앞 값 → 새 값"을 받는다. await 뒤처럼 앞 값이 낡았을 수 있는 곳은 함수로 바꾼다.
export function useSelection(performanceId: number) {
  const [selected, setSelected] = useState(() => read(performanceId));
  const update = useCallback(
    (next: number[] | ((previous: number[]) => number[])) => {
      setSelected((previous) => {
        const value = typeof next === "function" ? next(previous) : next;
        write(performanceId, value);
        return value;
      });
    },
    [performanceId],
  );
  return [selected, update] as const;
}

// 로그아웃할 때 지운다.
export function clearSelections() {
  try {
    for (const name of Object.keys(sessionStorage)) if (name.startsWith(PREFIX)) sessionStorage.removeItem(name);
  } catch {
    // 쓸 수 없는 창
  }
}
