import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { withDatabase } from "../db/databases.js";
import { LOAD_DATABASE, RESULTS_DIR } from "./template.js";

// 부하 중 잠금 리허설(DESIGN 6.7 "부하 중 리허설", 참고 숫자, 탐색 한 번). load:run이 S3를 도는 동안 다른 창에서 돌린다.
// 부하 DB에 소유자로 붙어 네 가지를 차례로 한다. 사이마다 쉬어, API 1초 지표(api-stats.jsonl)에서 구간을 나눠 볼 수 있게 한다.
// - A1: 보통 CREATE INDEX(performance_seats)를 연 트랜잭션에 쥔다(큰 표의 긴 빌드를 흉내 냄). 그동안 그 표의 쓰기가 막힌다.
// - A2: 같은 인덱스를 CONCURRENTLY로 만들고 지운다.
// - B1: 열린 트랜잭션(orders를 읽음) 뒤에 한도 없는 ALTER TABLE orders를 둔다. 그 뒤의 읽기·쓰기가 줄을 선다.
// - B2: 같은 것을 실행기의 lock_timeout(1초)으로 한다.
// 시작·끝 시각을 load/results/lock-events-<시각>.jsonl에 JSON 한 줄씩 쓴다.
const { values: args } = parseArgs({
  options: {
    delay: { type: "string", default: "60" },
    gap: { type: "string", default: "30" },
    hold: { type: "string", default: "5" },
  },
});
const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!ownerUrl) throw new Error("DATABASE_OWNER_URL이 없습니다(.env 또는 환경 변수)");
const [delayS, gapS, holdS] = [args.delay, args.gap, args.hold].map(Number) as [number, number, number];

mkdirSync(RESULTS_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const out = fileURLToPath(new URL(`lock-events-${stamp}.jsonl`, RESULTS_DIR));
const mark = (event: string, phase: string, extra: object = {}) => {
  const line = { event, phase, at: new Date().toISOString(), ...extra };
  appendFileSync(out, `${JSON.stringify(line)}\n`);
  console.log(JSON.stringify(line));
};
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

async function connect() {
  const client = new pg.Client({ connectionString: withDatabase(ownerUrl!, LOAD_DATABASE), application_name: "lock-rehearsal" });
  client.on("error", () => {});
  await client.connect();
  return client;
}

// 실행기가 부하 DB를 지우고 다시 복제하므로, 기다린 뒤에 붙는다(먼저 붙으면 복제 때 끊긴다).
await sleep(delayS);
const [holder, ddl] = [await connect(), await connect()];
try {

  mark("A1", "start");
  await ddl.query("begin");
  await ddl.query("create index rehearsal_plain on performance_seats (hold_expires_at)");
  mark("A1", "built");
  await sleep(holdS);
  await ddl.query("rollback");
  mark("A1", "end");
  await sleep(gapS);

  mark("A2", "start");
  await ddl.query("create index concurrently rehearsal_conc on performance_seats (hold_expires_at)");
  mark("A2", "built");
  await ddl.query("drop index concurrently rehearsal_conc");
  mark("A2", "end");
  await sleep(gapS);

  for (const [event, timeout] of [
    ["B1", "0"],
    ["B2", "1s"],
  ] as const) {
    await holder.query("begin");
    await holder.query("select id from orders limit 1");
    await ddl.query(`set lock_timeout = '${timeout}'`);
    mark(event, "start", { lockTimeout: timeout });
    const alter = ddl.query("alter table orders add column rehearsal_col int").then(
      () => "ok",
      (err: { code?: string }) => err.code ?? "error",
    );
    const early = await Promise.race([alter, sleep(holdS).then(() => null)]);
    if (early) mark(event, "alter-done", { result: early });
    await holder.query("rollback");
    const result = early ?? (await alter);
    mark(event, "end", { result });
    await ddl.query("set lock_timeout = '1s'");
    if (result === "ok") await ddl.query("alter table orders drop column rehearsal_col").catch(() => {});
    if (event === "B1") await sleep(gapS);
  }
} finally {
  await holder.end().catch(() => {});
  await ddl.end().catch(() => {});
}
console.log(`기록: ${out}`);
