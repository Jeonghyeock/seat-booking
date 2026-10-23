import { useSyncExternalStore } from "react";

// 서버 시계와 PC 시계의 차이(DESIGN 6.5 시계, 10장 75). 판단은 DB 시계로 하므로, 타이머와 카운트다운도 서버 시각으로 센다.
// 차이는 API 클라이언트가 응답을 받는 자리에서만 고친다. 캐시에 남은 옛 serverTime으로는 고치지 않는다.

export type ClockSample = { offsetMs: number; rttMs: number; takenAt: number };

// 지금 표본이 이보다 오래됐으면 왕복이 길어도 새 표본을 받는다(PC 시계가 그사이 바뀌었을 수 있다).
const MAX_SAMPLE_AGE_MS = 60_000;

// 응답 하나에서 잰 표본. serverTime은 응답이 떠나기 전에 찍히므로 왕복의 가운데를 서버 시각으로 본다.
export function sampleFrom(serverTime: string, sentAt: number, receivedAt: number): ClockSample {
  return { offsetMs: Date.parse(serverTime) - (sentAt + receivedAt) / 2, rttMs: receivedAt - sentAt, takenAt: receivedAt };
}

// 새 표본을 받을지 정한다. 왕복이 지금 표본보다 짧거나(더 정확하다) 지금 표본이 1분보다 오래됐을 때만 받는다.
// 판매 시작 순간의 느린 응답이 시계를 늦추지 않고, 1초 폴링이 타이머를 흔들지 않는다.
export function updateClock(current: ClockSample | null, sample: ClockSample): ClockSample {
  if (current === null) return sample;
  if (sample.rttMs <= current.rttMs || sample.takenAt - current.takenAt > MAX_SAMPLE_AGE_MS) return sample;
  return current;
}

let clock: ClockSample | null = null;
const listeners = new Set<() => void>();

// API 클라이언트가 serverTime이 있는 응답을 받을 때 부른다. 다시 보낸 응답(Idempotent-Replayed)은 부르지 않는다.
export function recordServerTime(serverTime: string, sentAt: number, receivedAt: number) {
  const next = updateClock(clock, sampleFrom(serverTime, sentAt, receivedAt));
  if (next === clock) return;
  clock = next;
  for (const listener of listeners) listener();
}

// 서버 시각(밀리초). 아직 표본이 없으면 PC 시계다.
export function serverNow() {
  return Date.now() + (clock?.offsetMs ?? 0);
}

// 서버 시각을 한 번이라도 받았는지(공연 목록처럼 serverTime이 없는 화면은 PC 시계로 대강 보인다).
export function useHasServerClock() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => clock !== null,
  );
}

// 테스트에서 시계를 비운다.
export function resetClock() {
  clock = null;
}
