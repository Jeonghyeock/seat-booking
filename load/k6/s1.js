import { sleep } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import {
  availableSeats,
  cookies,
  createOrder,
  errorCode,
  hold,
  holdParams,
  markPhase,
  pay,
  record,
  S1_PERFORMANCE,
  seatIds,
  seatMap,
  sleepUntil,
  waitForResult,
} from "./lib.js";

// S1 오픈 러시(C2, DESIGN 6.6). VU 하나가 사용자 하나이고 한 번만 돈다.
// 1. 판매 전 WARMUP_S초 동안 무작위 시각에 지도를 한 번 읽어 연결을 연다(한꺼번에 첫 연결을 열면 이 PC에서 대부분 거절된다).
// 2. T0(판매 시작)부터 1초 안의 무작위 시각에 첫 선점을 보낸다.
// 3. 409 SEAT_UNAVAILABLE이면 지도를 다시 읽고 다른 좌석으로 세 번까지 다시 한다.
// 4. 선점하면 주문하고 결제한다. 결제 결과를 화면처럼 기다린다. 일부는 결제하지 않고 떠난다.

const firstHold = new Trend("s1_first_hold", true);
const holdSuccess = new Counter("s1_hold_success");
const outcomes = new Counter("s1_outcome");

const MODE = __ENV.S1_MODE || "uniform"; // uniform | hot
const T0 = Number(__ENV.T0);
const WARMUP_MS = Number(__ENV.S1_WARMUP_S || 60) * 1000;
// 좋은 좌석: 공연장 좌석 순서(구역 A 앞줄부터)의 앞 10%. hot이면 70%가 여기서 고른다.
const HOT_COUNT = Math.ceil(seatIds.length * 0.1);
const MAX_ATTEMPTS = 4;

// 결제 시나리오를 섞는다(10장 20). 나머지 85%는 success.
const PAYMENT_MIX = [
  ["fail", 0.05],
  ["duplicate", 0.03],
  ["out_of_order", 0.03],
  ["early", 0.02],
  ["lost", 0.02],
];

function paymentScenario() {
  let r = Math.random();
  for (const [scenario, share] of PAYMENT_MIX) {
    if (r < share) return scenario;
    r -= share;
  }
  return "success";
}

function sample(list, n) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

let hotSeats;
function pick(available) {
  if (!hotSeats) {
    hotSeats = new Set();
    for (let i = 0; i < HOT_COUNT; i++) hotSeats.add(seatIds[i]);
  }
  const n = 1 + Math.floor(Math.random() * 4);
  let pool = available;
  if (MODE === "hot" && Math.random() < 0.7) {
    const hot = available.filter((id) => hotSeats.has(id));
    if (hot.length > 0) pool = hot;
  }
  return sample(pool, Math.min(n, pool.length));
}

export function s1() {
  markPhase(exec);
  const user = exec.vu.idInTest - 1;
  const cookie = cookies[user];
  // 사용자 5%는 두 탭에서 누르듯 선점을 동시에 서너 번 보낸다(같은 좌석과 다른 좌석).
  const multiTab = user % 20 === 0;

  sleepUntil(T0 - WARMUP_MS + Math.random() * (WARMUP_MS - 5000));
  let available = availableSeats(seatMap(S1_PERFORMANCE));
  sleepUntil(T0 + Math.random() * 1000);

  let held;
  let notOpenRetries = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (available.length === 0) {
      record({ ev: "gave_up", user, reason: "no_seats", attempt });
      outcomes.add(1, { outcome: "no_seats" });
      return;
    }
    const seats = pick(available);
    const started = Date.now();
    let responses;
    if (multiTab && attempt === 1) {
      const tabs = [seats, seats, pick(available)];
      if (Math.random() < 0.5) tabs.push(pick(available));
      responses = http.batch(tabs.map((ids) => holdParams(cookie, S1_PERFORMANCE, ids))).map((res, i) => ({ res, ids: tabs[i] }));
    } else {
      responses = [{ res: hold(cookie, S1_PERFORMANCE, seats), ids: seats }];
    }
    const elapsed = Date.now() - started;
    const codes = responses.map(({ res }) => (res.status === 201 ? null : errorCode(res)));
    // T0 직전에 닿았다(PC 시계와 DB 시계의 차이). 시도로 세지 않고 잠깐 뒤 다시 보낸다(5초까지).
    if (!held && codes.every((code) => code === "SALES_CLOSED") && notOpenRetries < 25) {
      notOpenRetries++;
      attempt--;
      sleep(0.2);
      continue;
    }
    if (attempt === 1) firstHold.add(elapsed);
    responses.forEach(({ res, ids }, i) => {
      record({ ev: "hold", user, attempt, seats: ids, status: res.status, code: codes[i], at: started });
      if (res.status === 201 && !held) held = res.json();
    });
    if (held) {
      holdSuccess.add(1, { attempt: String(attempt) });
      break;
    }
    if (!codes.includes("SEAT_UNAVAILABLE")) {
      record({ ev: "gave_up", user, reason: "hold_rejected", attempt });
      outcomes.add(1, { outcome: "hold_rejected" });
      return;
    }
    if (attempt < MAX_ATTEMPTS) available = availableSeats(seatMap(S1_PERFORMANCE));
  }
  if (!held) {
    record({ ev: "gave_up", user, reason: "attempts", attempt: MAX_ATTEMPTS });
    outcomes.add(1, { outcome: "attempts" });
    return;
  }

  // 10%는 결제하지 않고 떠난다(반은 선점 뒤, 반은 주문 뒤). 만료와 정리 작업이 좌석을 돌려준다.
  const leave = Math.random();
  if (leave < 0.05) {
    outcomes.add(1, { outcome: "left_after_hold" });
    return;
  }
  const order = createOrder(cookie, held.holdId);
  if (order.status !== 201) {
    outcomes.add(1, { outcome: "order_failed" });
    return;
  }
  const orderId = order.json("orderId");
  if (leave < 0.1) {
    outcomes.add(1, { outcome: "left_after_order" });
    return;
  }
  const payment = pay(cookie, orderId, paymentScenario());
  if (payment.status !== 202) {
    outcomes.add(1, { outcome: "payment_rejected" });
    return;
  }
  // lost는 대사(30초 뒤)가 맞추므로 넉넉히 기다린다.
  const result = waitForResult(cookie, orderId, 90);
  outcomes.add(1, { outcome: result });
  // paid면 좌석까지 남긴다(C2 확인 (b)). 기다리다 그만둔 주문(pending)이 나중에 paid가 되는 것은 실패가 아니다.
  if (result === "paid") record({ ev: "paid", user, orderId, seatIds: held.seatIds });
  else record({ ev: "result", user, orderId, result });
}
