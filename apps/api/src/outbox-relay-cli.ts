import { parseArgs } from "node:util";
import pg from "pg";
import {
  BACKOFF_SECONDS,
  deleteOldSent,
  httpSend,
  pgStore,
  relayRound,
  tryRelayLock,
  unpark,
} from "./outbox-relay.js";

// outbox 릴레이(DESIGN 6.8). API 서버와 따로 도는 프로세스다. 앱 role로 접속한다(outbox는 DML뿐).
//   npm run outbox:relay -w @seat-booking/api [-- --once | --unpark]
// --once: 한 바퀴만 돈다(테스트·리허설). --unpark: 보관한 행을 되살리고 끝낸다.
// 바퀴마다 한 줄(JSON)을 남긴다: 고른 행, 받는 쪽의 inserted·duplicates·rejected, 보관한 수. 다시 보낸 것은 duplicates로 보인다.
const { values } = parseArgs({ options: { once: { type: "boolean", default: false }, unpark: { type: "boolean", default: false } } });

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error("DATABASE_URL이 없습니다(.env 또는 환경 변수)");

// 전용 연결 하나를 프로세스 내내 쥔다. 릴레이 하나만 돌게 하는 advisory lock이 이 연결에 붙어 있으므로,
// 연결에 오류가 나거나 끊기면 잠금도 풀린 것이라 바로 끝낸다.
let stopping = false;
const client = new pg.Client({ connectionString: dbUrl, application_name: "seat-booking-outbox-relay", keepAlive: true });
client.on("error", (err) => {
  console.error(`DB 연결 오류로 멈춥니다: ${err.message}`);
  process.exit(1);
});
client.on("end", () => {
  if (!stopping) {
    console.error("DB 연결이 끊겨 멈춥니다");
    process.exit(1);
  }
});
await client.connect();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  if (values.unpark) {
    console.log(`보관한 행 ${await unpark(client)}개를 되살렸습니다`);
  } else {
    const url = process.env.EVENT_ANALYTICS_URL;
    const writeKey = process.env.EVENT_ANALYTICS_WRITE_KEY;
    if (!url || !writeKey) throw new Error("EVENT_ANALYTICS_URL과 EVENT_ANALYTICS_WRITE_KEY가 없습니다(.env 또는 환경 변수)");
    if (!(await tryRelayLock(client))) {
      console.log("다른 릴레이가 돌고 있어 끝냅니다");
    } else {
      process.on("SIGINT", () => (stopping = true));
      process.on("SIGTERM", () => (stopping = true));
      const store = pgStore(client);
      const send = httpSend({ url, writeKey });
      let backoffs = 0;
      let lastCleanup = 0;
      while (!stopping) {
        if (Date.now() - lastCleanup >= 3_600_000) {
          const deleted = await deleteOldSent(client);
          if (deleted > 0) console.log(JSON.stringify({ at: new Date().toISOString(), deletedOldSent: deleted }));
          lastCleanup = Date.now();
        }
        const round = await relayRound(store, send);
        if (round.kind !== "idle") console.log(JSON.stringify({ at: new Date().toISOString(), ...round }));
        if (round.kind === "stop") {
          console.error("받는 쪽이 401입니다. 쓰기 키(EVENT_ANALYTICS_WRITE_KEY)를 고친 뒤 다시 띄웁니다");
          process.exitCode = 1;
          break;
        }
        if (values.once) break;
        if (round.kind === "backoff") {
          await sleep(BACKOFF_SECONDS[Math.min(backoffs, BACKOFF_SECONDS.length - 1)]! * 1000);
          backoffs++;
        } else {
          backoffs = 0;
          if (round.kind === "idle") await sleep(1000);
        }
      }
    }
  }
} finally {
  stopping = true;
  await client.end();
}
