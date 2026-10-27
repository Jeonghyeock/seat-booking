import { readFileSync } from "node:fs";
import path from "node:path";

// 부하 중 잠금 리허설의 요약(DESIGN 6.7 "부하 중 리허설"). load:run의 API 1초 지표와 load:lock-events의 기록을 맞춰,
// 이벤트마다 그 구간(시작부터 끝 2초 뒤까지)과 바로 앞 13초(기준)의 요청 수, 5xx, 가장 느린 요청을 표로 낸다.
// 쓰는 법: npm run load:lock-report -w @seat-booking/api -- <결과 폴더> <lock-events 파일>
type RouteTick = { count: number; p95: number; max: number; statuses: Record<string, number> };
type Tick = { type: string; at: string; routes: Record<string, RouteTick> };
type Mark = { event: string; phase: string; at: string; result?: string };

const [runDir, eventsFile] = process.argv.slice(2);
if (!runDir || !eventsFile) throw new Error("결과 폴더와 lock-events 파일을 줍니다");

const ticks = readFileSync(path.join(runDir, "api", "api-stats.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Tick)
  .filter((t) => t.type === "tick");
const marks = readFileSync(eventsFile, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Mark);

// 1초 지표 줄은 그 앞 1초를 담는다. (from, to] 안에 끝나는 줄을 모은다.
function summarize(from: number, to: number) {
  const inside = ticks.filter((t) => Date.parse(t.at) > from && Date.parse(t.at) <= to);
  let requests = 0;
  let errors = 0;
  let worst = { ms: 0, route: "-" };
  for (const t of inside) {
    for (const [route, r] of Object.entries(t.routes)) {
      requests += r.count;
      errors += Object.entries(r.statuses)
        .filter(([status]) => status.startsWith("5"))
        .reduce((n, [, c]) => n + c, 0);
      if (r.max > worst.ms) worst = { ms: r.max, route };
    }
  }
  return { seconds: inside.length, requests, errors, worst };
}

const at = (event: string, phase: string) => {
  const mark = marks.find((m) => m.event === event && m.phase === phase);
  if (!mark) throw new Error(`${event} ${phase} 기록이 없습니다`);
  return Date.parse(mark.at);
};

console.log("| 이벤트 | 구간 | 초 | 요청 | 5xx | 가장 느린 요청(ms) | 그 경로 | 결과 |");
console.log("|---|---|---|---|---|---|---|---|");
for (const event of [...new Set(marks.map((m) => m.event))]) {
  const start = at(event, "start");
  const end = at(event, "end");
  const result = marks.find((m) => m.event === event && m.result)?.result ?? "";
  for (const [label, s] of [
    ["기준(앞 13초)", summarize(start - 15_000, start - 2_000)],
    ["이벤트", summarize(start, end + 2_000)],
  ] as const) {
    console.log(
      `| ${event} | ${label} | ${s.seconds} | ${s.requests} | ${s.errors} | ${Math.round(s.worst.ms)} | ${s.worst.route} | ${label === "이벤트" ? result : ""} |`,
    );
  }
}
