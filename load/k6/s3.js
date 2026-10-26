import exec from "k6/execution";
import { Counter } from "k6/metrics";
import {
  cancelOrder,
  cookies,
  createOrder,
  hold,
  markPhase,
  me,
  myOrders,
  pay,
  s3PerformanceIds,
  seatIds,
  USERS,
  waitForResult,
} from "./lib.js";

// S3 지속 부하(풀 크기·시간 제한, DESIGN 6.6). 일정 도착률의 쓰기 흐름이다. 좌석 경합은 넣지 않는다(경합은 S1의 일).
// 반복 번호 i로 회차·좌석·사용자를 정한다.
// - 회차 = i mod K, 그 회차의 n = floor(i / K)번째 방문이 좌석 2n, 2n+1을 잡는다. 같은 좌석을 두 번 고르지 않는다.
// - 사용자 = i mod M. M(5,000)과 K(99)가 서로소라 i < M×K 안에서는 사용자와 회차의 짝이 겹치지 않아 1인 한도에 걸리지 않는다.
//   이웃한 반복은 사용자도 회차도 달라 같은 사용자·회차의 advisory lock으로 줄 서지 않는다.
// 단계·예열 시나리오마다 반복 번호가 0부터 시작하므로 실행기가 시나리오마다 OFFSET을 준다.
// 흐름: 내 선점 읽기 → 선점 → 주문 → 70%는 결제하고 paid까지 기다리기, 30%는 주문 취소 → 30%는 내 예매 읽기.

const outcomes = new Counter("s3_outcome");
const SEATS_PER_ITERATION = 2;

export function s3() {
  markPhase(exec);
  const i = Number(__ENV.OFFSET || 0) + exec.scenario.iterationInTest;
  const k = s3PerformanceIds.length;
  const visit = Math.floor(i / k);
  if ((visit + 1) * SEATS_PER_ITERATION > seatIds.length) {
    exec.test.abort(`S3 재고가 바닥났습니다(반복 ${i}). 도착률이나 시간을 줄이거나 회차를 늘리세요`);
  }
  const performanceId = s3PerformanceIds[i % k];
  const seats = [];
  for (let s = 0; s < SEATS_PER_ITERATION; s++) seats.push(seatIds[visit * SEATS_PER_ITERATION + s]);
  const cookie = cookies[i % USERS];

  me(cookie, performanceId);
  const held = hold(cookie, performanceId, seats);
  if (held.status !== 201) {
    outcomes.add(1, { outcome: "hold_failed" });
    return;
  }
  const order = createOrder(cookie, held.json("holdId"));
  if (order.status !== 201) {
    outcomes.add(1, { outcome: "order_failed" });
    return;
  }
  const orderId = order.json("orderId");
  if (i % 10 < 7) {
    const payment = pay(cookie, orderId, "success");
    outcomes.add(1, { outcome: payment.status === 202 ? waitForResult(cookie, orderId, 30) : "payment_rejected" });
  } else {
    const cancelled = cancelOrder(cookie, orderId);
    outcomes.add(1, { outcome: cancelled.status === 200 ? "cancelled" : "cancel_failed" });
  }
  if (i % 10 < 3) myOrders(cookie);
}
