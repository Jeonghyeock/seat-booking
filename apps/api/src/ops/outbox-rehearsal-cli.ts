import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HoldResponse, OrderView } from "@seat-booking/shared";
import { buildApp } from "../app.js";
import { newSessionToken, SESSION_TTL_SECONDS, sessionCookieName } from "../auth.js";
import { createDb } from "../db/client.js";
import { dropDatabase, withAdminClient, withDatabase } from "../db/databases.js";
import { runMigrations } from "../db/migrate.js";
import { createPool } from "../db/pool.js";
import { readSeedFile, SAMPLE_SEED, seed, shiftSeed } from "../db/seed.js";
import { FakePaymentProvider } from "../fake-pay.js";
import { RESULTS_DIR } from "../load/template.js";

// outbox 연결 리허설(DESIGN 6.8, C9, event-analytics 6.9·10장 68). 두 앱을 붙여 업무 이벤트가 빠짐없이 한 번 이상 가고
// 받는 쪽에 한 번 저장되는지 본다. 받는 쪽(event-analytics)은 따로 띄운다: 새 DB(E2E 준비)와 다른 포트, 같은 쓰기 키.
//   EVENT_ANALYTICS_URL=… EVENT_ANALYTICS_WRITE_KEY=… npm run ops:outbox-rehearsal -w @seat-booking/api [-- --users 60]
// 1. 이 리허설만 쓰는 새 DB를 만든다(마이그레이션, 지금 판매 중인 샘플 회차). 부하 데이터 DB는 outbox를 거치지 않은 업무 행이 있어 쓰지 않는다.
// 2. 릴레이를 자식 프로세스로 띄운다.
// 3. 사용자마다 선점 → (75%) 주문 → (70%) 결제(성공 웹훅). 단계 사이에 생각 시간(20ms)을 둔다(받는 쪽 퍼널은 같은 ms를 빼므로).
// 4. 절반쯤에서 릴레이를 죽이고(SIGKILL) 2초 뒤 다시 띄운다.
// 5. 끝나면 보낸 행 20개의 sent_at을 지워 "받는 쪽은 저장했는데 적기를 잃은" 상태를 만든다. 릴레이가 다시 보내고, 받는 쪽은 중복으로만 센다.
// 6. 보낼 행이 0이 되면 릴레이를 멈추고 세 곳을 센다. 다르면 종료 코드 1이다. 결과는 load/results/outbox-rehearsal-<시각>.json.
const DATABASE = "seat_booking_outbox_rehearsal";
const RESENT = 20;

const args = process.argv.slice(2);
const users = Number(args[args.indexOf("--users") + 1] ?? 60) || 60;
const ownerUrl = process.env.DATABASE_OWNER_URL;
const appUrl = process.env.DATABASE_URL;
const analyticsUrl = process.env.EVENT_ANALYTICS_URL;
if (!ownerUrl || !appUrl) throw new Error("DATABASE_URL과 DATABASE_OWNER_URL이 없습니다(.env 또는 환경 변수)");
if (!analyticsUrl || !process.env.EVENT_ANALYTICS_WRITE_KEY) throw new Error("EVENT_ANALYTICS_URL과 EVENT_ANALYTICS_WRITE_KEY가 없습니다");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const started = new Date();

// 1. 새 DB
await withAdminClient(ownerUrl, async (client) => {
  await dropDatabase(client, DATABASE);
  await client.query(`CREATE DATABASE ${DATABASE}`);
});
await runMigrations(withDatabase(ownerUrl, DATABASE));
const ownerPool = createPool({ connectionString: withDatabase(ownerUrl, DATABASE) });
const { performanceIds } = await seed(createDb(ownerPool), shiftSeed(readSeedFile(SAMPLE_SEED), new Date()));
await ownerPool.end();

const dbUrl = withDatabase(appUrl, DATABASE);
const pool = createPool({ connectionString: dbUrl });
const provider = new FakePaymentProvider("outbox-rehearsal");
const app = buildApp(pool, {}, { paymentProvider: provider });

// 2. 릴레이(자식 프로세스). 바퀴마다 남기는 JSON 줄을 모은다.
const rounds: { kind: string; rows: number; inserted: number; duplicates: number; rejected: number; parked: number }[] = [];
const apiDir = fileURLToPath(new URL("../../", import.meta.url));
function startRelay(): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", "src/outbox-relay-cli.ts"], {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) if (line.startsWith("{") && line.includes('"kind"')) rounds.push(JSON.parse(line));
  });
  child.stderr!.on("data", (chunk: Buffer) => process.stderr.write(`릴레이: ${chunk}`));
  return child;
}
let relay = startRelay();
let relayRestarts = 0;

try {
  // 3. 예매 흐름. 사용자는 세션을 바로 넣는다(가입의 argon2를 거치지 않음, 테스트 픽스처와 같은 방식).
  const performanceId = performanceIds[0]!;
  const { rows: seatRows } = await pool.query<{ seat_id: string }>(
    "select seat_id from performance_seats where performance_id = $1 and status = 'available' order by seat_id",
    [performanceId],
  );
  const seatIds = seatRows.map((r) => Number(r.seat_id));
  if (seatIds.length < users) throw new Error(`좌석이 ${seatIds.length}개라 사용자 ${users}명에게 하나씩 줄 수 없습니다`);
  const { rows: userRows } = await pool.query<{ id: string }>(
    "insert into users (email) select 'rehearsal-' || g || '-' || $2 || '@test.local' from generate_series(1, $1) g returning id",
    [users, started.getTime()],
  );
  const tokens = userRows.map(() => newSessionToken());
  await pool.query(
    `insert into sessions (token_hash, user_id, expires_at)
     select h, u, now() + make_interval(secs => $3) from unnest($1::text[], $2::bigint[]) as t(h, u)`,
    [tokens.map((t) => t.tokenHash), userRows.map((r) => r.id), SESSION_TTL_SECONDS.customer],
  );
  const headersOf = (i: number) => ({ cookie: `${sessionCookieName(true)}=${tokens[i]!.token}`, "x-requested-with": "seat-booking" });

  // 사용자마다 정해진 갈래(씨앗 없이도 같은 비율이 되게 차례로 정한다)
  for (let i = 0; i < users; i++) {
    if (i === Math.floor(users / 2)) {
      relay.kill("SIGKILL");
      await sleep(2000);
      relay = startRelay();
      relayRestarts++;
    }
    const headers = headersOf(i);
    const held = await app.inject({ method: "POST", url: `/performances/${performanceId}/holds`, headers, payload: { seatIds: [seatIds[i]!] } });
    if (held.statusCode !== 201) throw new Error(`선점 실패 ${held.statusCode} ${held.body}`);
    const { holdId } = HoldResponse.parse(held.json());
    if (i % 4 === 3) continue; // 25%는 선점에서 멈춘다
    await sleep(20);
    const ordered = await app.inject({ method: "POST", url: `/holds/${holdId}/orders`, headers: { ...headers, "idempotency-key": randomUUID() } });
    if (ordered.statusCode !== 201) throw new Error(`주문 실패 ${ordered.statusCode} ${ordered.body}`);
    const { orderId } = OrderView.parse(ordered.json());
    if (i % 10 >= 7) continue; // 주문한 사람 가운데 약 30%는 결제하지 않는다
    await sleep(20);
    const paid = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/payments`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {},
    });
    if (paid.statusCode !== 202) throw new Error(`결제 실패 ${paid.statusCode} ${paid.body}`);
    await provider.flush();
  }

  // 5. 받는 쪽은 저장했는데 적기를 잃은 것처럼 만든다(보낸 행이 있을 때까지 기다린다)
  for (let i = 0; i < 300; i++) {
    const { rows } = await pool.query<{ n: number }>("select count(*)::int as n from outbox_events where sent_at is not null");
    if (rows[0]!.n >= RESENT) break;
    await sleep(100);
  }
  const { rowCount: resent } = await pool.query(
    `update outbox_events set sent_at = null where id = any(array(select id from outbox_events where sent_at is not null order by id limit $1))`,
    [RESENT],
  );

  // 6. 보낼 행이 0이 될 때까지
  for (let i = 0; ; i++) {
    const { rows } = await pool.query<{ n: number }>("select count(*)::int as n from outbox_events where sent_at is null and parked_at is null");
    if (rows[0]!.n === 0) break;
    if (i > 600) throw new Error(`보낼 행 ${rows[0]!.n}개가 60초 안에 나가지 않았습니다`);
    await sleep(100);
  }
  relay.kill("SIGTERM");

  const one = async (sql: string) => (await pool.query<{ n: number }>(sql)).rows[0]!.n;
  const business = {
    seats_held: await one("select count(*)::int as n from holds"),
    order_created: await one("select count(*)::int as n from orders"),
    payment_succeeded: await one("select count(*)::int as n from payments where status = 'succeeded'"),
  };
  const { rows: outboxRows } = await pool.query<{ event_name: string; n: number; sent: number; parked: number }>(
    `select event_name, count(*)::int as n, count(sent_at)::int as sent, count(parked_at)::int as parked
       from outbox_events group by 1 order by 1`,
  );
  const outbox = Object.fromEntries(outboxRows.map((r) => [r.event_name, r.n]));

  // 받는 쪽: 오늘의 이벤트 수(이벤트 이름별). 한 시간 단위가 아닌 시간대(Asia/Kolkata)로 물어 집계 표 없이 원본에서 센다.
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const report = await fetch(new URL("/reports/query", analyticsUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ metrics: ["events"], granularity: "total", dimensions: ["event_name"], from: day, to: day, timezone: "Asia/Kolkata" }),
  });
  if (!report.ok) throw new Error(`받는 쪽 리포트 ${report.status} ${await report.text()}`);
  const reportBody = (await report.json()) as { rows: { dimensions: { event_name: string }; events: number }[] };
  const received = Object.fromEntries(
    reportBody.rows.filter((r) => r.dimensions.event_name in business).map((r) => [r.dimensions.event_name, r.events]),
  );
  const funnel = await fetch(new URL("/funnels/query", analyticsUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ steps: ["seats_held", "order_created", "payment_succeeded"], windowMinutes: 60, from: day, to: day, timezone: "Asia/Kolkata" }),
  });
  const funnelBody = funnel.ok ? await funnel.json() : { status: funnel.status, body: await funnel.text() };

  const sum = (key: "inserted" | "duplicates" | "rejected" | "parked") => rounds.reduce((s, r) => s + r[key], 0);
  const relayTotals = { rounds: rounds.length, inserted: sum("inserted"), duplicates: sum("duplicates"), rejected: sum("rejected"), parked: sum("parked"), restarts: relayRestarts };
  const parked = outboxRows.reduce((s, r) => s + r.parked, 0);
  const problems: string[] = [];
  for (const name of Object.keys(business) as (keyof typeof business)[]) {
    if (business[name] !== outbox[name]) problems.push(`${name}: 업무 ${business[name]} ≠ outbox ${outbox[name]}`);
    if (business[name] !== received[name]) problems.push(`${name}: 업무 ${business[name]} ≠ 받은 것 ${received[name]}`);
  }
  if (parked > 0) problems.push(`보관 ${parked}`);
  if (relayTotals.duplicates < (resent ?? 0)) problems.push(`다시 보낸 ${resent}개가 중복으로 세이지 않음(${relayTotals.duplicates})`);

  const result = { startedAt: started.toISOString(), users, business, outbox, received, resent, relay: relayTotals, funnel: funnelBody, problems };
  mkdirSync(fileURLToPath(RESULTS_DIR), { recursive: true });
  const file = path.join(fileURLToPath(RESULTS_DIR), `outbox-rehearsal-${started.toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ business, outbox, received, resent, relay: relayTotals, problems }, null, 2));
  console.log(problems.length === 0 ? "합격: 세 곳의 수가 같고, 다시 보낸 것은 중복으로만 셌다" : "불합격");
  console.log(`기록: ${file}`);
  if (problems.length > 0) process.exitCode = 1;
} finally {
  relay.kill("SIGTERM");
  await app.close();
  await pool.end();
  await withAdminClient(ownerUrl, (client) => dropDatabase(client, DATABASE));
}
