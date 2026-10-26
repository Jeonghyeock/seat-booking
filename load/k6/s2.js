import exec from "k6/execution";
import { markPhase, s3PerformanceIds, seatMap } from "./lib.js";

// S2 좌석 지도(C7, DESIGN 6.6). 판매 중인 화면이 15초마다 지도를 다시 읽는 것을 일정 도착률로 흉내 낸다.
// 판매 중인 S3 회차 가운데 하나를 고르고, 응답 본문은 받지 않는다(k6도 같은 CPU를 쓴다). 지도는 로그인 없이 본다.
export function s2() {
  markPhase(exec);
  const id = s3PerformanceIds[Math.floor(Math.random() * s3PerformanceIds.length)];
  seatMap(id, true);
}
