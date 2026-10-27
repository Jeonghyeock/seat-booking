import pg from "pg";
import { describe, expect, inject, it, onTestFinished } from "vitest";
import { dropDatabase, withAdminClient, withDatabase } from "./databases.js";

// 잠금 리허설(DESIGN 6.7 "잠금 리허설"). 무중단 마이그레이션 규칙(CONCURRENTLY, lock_timeout 1초)이 무엇을 막고 무엇을 막지 않는지
// 대기 시간과 오류 코드로 남긴다. CONCURRENTLY는 같은 DB의 모든 옛 트랜잭션을 기다리므로, 공유 테스트 DB가 아니라 따로 만든 DB에서 한다.
const ownerUrl = inject("ownerDatabaseUrl");

async function freshTable() {
  const name = `seat_booking_locks_${process.pid}`;
  await withAdminClient(ownerUrl, async (client) => {
    await dropDatabase(client, name);
    await client.query(`CREATE DATABASE ${name}`);
  });
  onTestFinished(() => withAdminClient(ownerUrl, (client) => dropDatabase(client, name)));
  const url = withDatabase(ownerUrl, name);
  const setup = await connect(url);
  await setup.query("create table t (id int primary key, v int); insert into t select g, g from generate_series(1, 1000) g");
  await setup.end();
  return url;
}

async function connect(url: string) {
  const client = new pg.Client({ connectionString: url });
  client.on("error", () => {});
  await client.connect();
  onTestFinished(() => client.end().catch(() => {}));
  return client;
}

const backendPid = async (client: pg.Client) =>
  (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(url: string, sql: string) {
  const probe = await connect(url);
  for (let i = 0; i < 100; i++) {
    if ((await probe.query(sql)).rows.length > 0) return;
    await sleep(50);
  }
  throw new Error(`기다리던 상태가 되지 않았습니다: ${sql}`);
}

// 앱 쓰기처럼 잠금을 limit만 기다리는 문장. 걸린 시간과 오류 코드를 준다.
async function timed(client: pg.Client, sql: string, limit: string) {
  await client.query(`set lock_timeout = '${limit}'`);
  const started = Date.now();
  const code = await client.query(sql).then(
    () => "ok",
    (err: { code?: string }) => err.code,
  );
  return { code, ms: Date.now() - started };
}

describe("잠금 리허설", () => {
  it("A. 보통 CREATE INDEX는 만드는 동안 그 표의 쓰기를 막고, CONCURRENTLY는 기다리는 동안에도 막지 않는다", { timeout: 20_000 }, async () => {
    const url = await freshTable();
    const [builder, writer, old] = [await connect(url), await connect(url), await connect(url)];
    // 문장이 돌고 있는 연결에는 질의를 더 보낼 수 없어 미리 받는다
    const builderPid = await backendPid(builder);

    // 큰 표의 긴 빌드를 흉내 내려고, 보통 CREATE INDEX를 연 트랜잭션 안에 둔다(SHARE 잠금을 커밋까지 쥔다)
    await builder.query("begin");
    await builder.query("create index t_v_plain on t (v)");
    expect(await timed(writer, "update t set v = v + 1 where id = 1", "500ms")).toMatchObject({ code: "55P03" });
    await builder.query("rollback");

    // CONCURRENTLY는 열린 쓰기 트랜잭션이 끝나길 기다린다. 그동안 같은 표의 쓰기는 바로 된다
    await old.query("begin");
    await old.query("update t set v = v where id = 2");
    const building = builder.query("create index concurrently t_v_conc on t (v)").catch((err: { code?: string }) => err.code);
    // 확인 질의는 클러스터 전체를 보므로 이 연결과 단계로 좁힌다
    await waitUntil(
      url,
      `select 1 from pg_stat_progress_create_index where pid = ${builderPid} and phase = 'waiting for writers before build'`,
    );
    const write = await timed(writer, "update t set v = v + 1 where id = 1", "500ms");
    expect(write.code).toBe("ok");
    expect(write.ms).toBeLessThan(400);
    await old.query("commit");
    expect(await building).toMatchObject({ command: "CREATE" });
  });

  it("B. 열린 트랜잭션 뒤에서 기다리는 ALTER는 그 뒤의 읽기까지 막는다(잠금 줄). lock_timeout 1초면 1초 뒤 물러나 읽기가 지나간다", { timeout: 20_000 }, async () => {
    const url = await freshTable();
    const [holder, migration, reader] = [await connect(url), await connect(url), await connect(url)];
    const migrationPid = await backendPid(migration);
    await holder.query("begin");
    await holder.query("select count(*) from t");
    const queued = `select 1 from pg_stat_activity where pid = ${migrationPid} and wait_event_type = 'Lock'`;

    // 한도 없는 ALTER: 그 뒤의 읽기가 앱의 잠금 한도(여기서는 500ms)에 걸린다
    await migration.query("set lock_timeout = 0");
    const alter = migration.query("alter table t add column w int").catch((err: { code?: string }) => err.code);
    await waitUntil(url, queued);
    expect(await timed(reader, "select count(*) from t", "500ms")).toMatchObject({ code: "55P03" });
    await holder.query("rollback");
    expect(await alter).toMatchObject({ command: "ALTER" });

    // 실행기의 1초 한도: ALTER가 1초 뒤 물러나고, 그 뒤에 줄 섰던 읽기(앱 쓰기 한도 3초)는 그때 지나간다
    await holder.query("begin");
    await holder.query("select count(*) from t");
    await migration.query("set lock_timeout = '1s'");
    const bounded = migration.query("alter table t add column x int").catch((err: { code?: string }) => err.code);
    await waitUntil(url, queued);
    const read = await timed(reader, "select count(*) from t", "3s");
    expect(await bounded).toBe("55P03");
    expect(read.code).toBe("ok");
    expect(read.ms).toBeGreaterThan(500);
    expect(read.ms).toBeLessThan(2_500);
    await holder.query("rollback");
  });
});
