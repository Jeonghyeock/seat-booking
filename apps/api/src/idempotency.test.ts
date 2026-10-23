import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, inject, it } from "vitest";
import { newUsers } from "../test/fixtures.js";
import { createDb, writeTransaction } from "./db/client.js";
import { createPool } from "./db/pool.js";
import { users } from "./db/schema.js";
import { hashRequest, type IdempotencyScope, withIdempotencyKey } from "./idempotency.js";

describe("멱등 키", () => {
  const url = inject("databaseUrl");
  const pool = createPool({ connectionString: url });
  // 잠금을 기다리는 연결만 골라 보려고 이름을 붙인다.
  const appPool = createPool({ connectionString: url, application_name: "idempotency-test" });
  const db = createDb(appPool);
  afterAll(() => Promise.all([pool.end(), appPool.end()]));

  async function waitForLockWaiters(count: number) {
    for (let i = 0; i < 300; i++) {
      const { rows } = await pool.query(
        `select count(*) as n from pg_stat_activity
          where datname = current_database() and application_name = 'idempotency-test' and wait_event_type = 'Lock'`,
      );
      if (rows[0].n === count) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`잠금을 기다리는 연결이 ${count}개가 되지 않는다`);
  }

  async function newScope(): Promise<IdempotencyScope> {
    const [userId] = await newUsers(pool, 1);
    return { userId: userId!, route: "TEST", key: randomUUID(), requestHash: hashRequest({ n: 1 }) };
  }
  const keyRow = async (scope: IdempotencyScope) =>
    (
      await pool.query("select status, response_code, response_body from idempotency_keys where user_id = $1 and key = $2", [
        scope.userId,
        scope.key,
      ])
    ).rows;
  const emailExists = async (email: string) =>
    (await pool.query("select count(*) as n from users where email = $1", [email])).rows[0].n === 1;

  it("hashRequest는 키 순서가 달라도 같고, 값이 다르면 다르다", () => {
    expect(hashRequest({ a: 1, b: { c: [1, 2], d: "x" } })).toBe(hashRequest({ b: { d: "x", c: [1, 2] }, a: 1 }));
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
    expect(hashRequest({ a: [1, 2] })).not.toBe(hashRequest({ a: [2, 1] }));
  });

  it("업무 트랜잭션 안에서 응답을 저장하고, 같은 키로 다시 부르면 업무를 하지 않고 그 응답을 돌려준다", async () => {
    const scope = await newScope();
    let runs = 0;
    const work = () =>
      withIdempotencyKey(db, scope, (saveInTx) =>
        writeTransaction(db, async (tx) => {
          runs++;
          await saveInTx(tx, { statusCode: 201, body: { ok: 1 } });
          return { response: { statusCode: 201, body: { ok: 1 } }, keep: "saved" as const };
        }),
      );
    expect(await work()).toEqual({ kind: "response", response: { statusCode: 201, body: { ok: 1 } }, replayed: false });
    expect(await work()).toEqual({ kind: "response", response: { statusCode: 201, body: { ok: 1 } }, replayed: true });
    expect(runs).toBe(1);
    expect(await keyRow(scope)).toEqual([{ status: "done", response_code: 201, response_body: { ok: 1 } }]);
  });

  it("keep이 save면 업무 밖에서 응답을 저장하고, release면 키를 지워 다시 처리할 수 있게 한다", async () => {
    const saved = await newScope();
    await withIdempotencyKey(db, saved, async () => ({ response: { statusCode: 409, body: { e: 1 } }, keep: "save" }));
    expect(await keyRow(saved)).toEqual([{ status: "done", response_code: 409, response_body: { e: 1 } }]);

    const released = await newScope();
    await withIdempotencyKey(db, released, async () => ({ response: { statusCode: 409, body: {} }, keep: "release" }));
    expect(await keyRow(released)).toEqual([]);
  });

  it("업무가 예외를 던지면 키를 지우고 예외를 다시 던진다", async () => {
    const scope = await newScope();
    await expect(
      withIdempotencyKey(db, scope, async () => {
        throw new Error("업무 실패");
      }),
    ).rejects.toThrow("업무 실패");
    expect(await keyRow(scope)).toEqual([]);
  });

  it("응답을 저장해 커밋한 뒤에 예외가 나면 끝난 키를 지우지 않는다", async () => {
    const scope = await newScope();
    await expect(
      withIdempotencyKey(db, scope, async (saveInTx) => {
        await writeTransaction(db, (tx) => saveInTx(tx, { statusCode: 201, body: { ok: 1 } }));
        throw new Error("응답을 만들다 실패");
      }),
    ).rejects.toThrow("응답을 만들다 실패");
    expect(await keyRow(scope)).toEqual([{ status: "done", response_code: 201, response_body: { ok: 1 } }]);
  });

  it("응답을 저장하기 전에 다른 요청이 키를 넘겨받았으면 업무를 되돌리고, 그 요청이 저장한 응답을 돌려준다", async () => {
    const scope = await newScope();
    const email = `${randomUUID()}@test.local`;
    const outcome = await withIdempotencyKey(db, scope, (saveInTx) =>
      writeTransaction(db, async (tx) => {
        await tx.insert(users).values({ email });
        // 다른 요청이 넘겨받아 끝냈다(owner_token이 바뀌었다)
        await pool.query(
          `update idempotency_keys
              set owner_token = gen_random_uuid(), status = 'done', response_code = 201, response_body = '{"by":"other"}'
            where user_id = $1 and key = $2`,
          [scope.userId, scope.key],
        );
        await saveInTx(tx, { statusCode: 201, body: { by: "me" } });
        return { response: { statusCode: 201, body: { by: "me" } }, keep: "saved" as const };
      }),
    );
    expect(outcome).toEqual({ kind: "response", response: { statusCode: 201, body: { by: "other" } }, replayed: true });
    expect(await emailExists(email)).toBe(false);
  });

  it("넘겨받은 요청이 아직 처리 중이면 업무를 되돌리고 in_progress다. 그 요청의 키는 건드리지 않는다", async () => {
    const scope = await newScope();
    const email = `${randomUUID()}@test.local`;
    const other = randomUUID();
    const outcome = await withIdempotencyKey(db, scope, (saveInTx) =>
      writeTransaction(db, async (tx) => {
        await tx.insert(users).values({ email });
        await pool.query("update idempotency_keys set owner_token = $3 where user_id = $1 and key = $2", [
          scope.userId,
          scope.key,
          other,
        ]);
        await saveInTx(tx, { statusCode: 201, body: { by: "me" } });
        return { response: { statusCode: 201, body: { by: "me" } }, keep: "saved" as const };
      }),
    );
    expect(outcome).toEqual({ kind: "in_progress" });
    expect(await emailExists(email)).toBe(false);
    const { rows } = await pool.query("select status, owner_token from idempotency_keys where user_id = $1 and key = $2", [
      scope.userId,
      scope.key,
    ]);
    expect(rows).toEqual([{ status: "processing", owner_token: other }]);
  });

  it("오래된 처리 중 키를 세 요청이 함께 넘겨받으려 하면 하나만 넘겨받는다", async () => {
    const scope = await newScope();
    await pool.query(
      `insert into idempotency_keys (user_id, route, key, request_hash, owner_token, updated_at)
       values ($1, $2, $3, $4, gen_random_uuid(), now() - interval '2 minutes')`,
      [scope.userId, scope.route, scope.key, scope.requestHash],
    );
    let runs = 0;
    const attempt = () =>
      withIdempotencyKey(db, scope, async () => {
        runs++;
        return { response: { statusCode: 409, body: {} }, keep: "save" };
      });
    // 다른 연결이 키 행을 잡아, 세 요청이 모두 오래된 키를 본 뒤 넘겨받기 UPDATE에서 기다리게 한다
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from idempotency_keys where user_id = $1 and key = $2 for update", [
        scope.userId,
        scope.key,
      ]);
      const attempts = [attempt(), attempt(), attempt()];
      await waitForLockWaiters(3);
      await holder.query("commit");
      const outcomes = await Promise.all(attempts);
      expect(runs).toBe(1);
      expect(outcomes.filter((o) => o.kind === "response" && !o.replayed)).toHaveLength(1);
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
  });

  it("거절 응답을 저장하기 전에 다른 요청이 키를 넘겨받아 끝냈으면, 내 응답은 버리고 그 요청의 응답을 준다", async () => {
    const scope = await newScope();
    const saved = await withIdempotencyKey(db, scope, async () => {
      await pool.query(
        `update idempotency_keys
            set owner_token = gen_random_uuid(), status = 'done', response_code = 201, response_body = '{"by":"other"}'
          where user_id = $1 and key = $2`,
        [scope.userId, scope.key],
      );
      return { response: { statusCode: 409, body: { by: "me" } }, keep: "save" };
    });
    expect(saved).toEqual({ kind: "response", response: { statusCode: 201, body: { by: "other" } }, replayed: true });

    // 키를 지우려던 때 넘겨받은 요청이 아직 처리 중이면 처리 중이고, 그 요청의 키는 남는다
    const released = await newScope();
    const outcome = await withIdempotencyKey(db, released, async () => {
      await pool.query("update idempotency_keys set owner_token = gen_random_uuid() where user_id = $1 and key = $2", [
        released.userId,
        released.key,
      ]);
      return { response: { statusCode: 409, body: {} }, keep: "release" };
    });
    expect(outcome).toEqual({ kind: "in_progress" });
    expect(await keyRow(released)).toEqual([{ status: "processing", response_code: null, response_body: null }]);
  });

  it("같은 키를 다른 요청에 쓰면 key_reused이고, 처음 요청의 키는 그대로다", async () => {
    const scope = await newScope();
    await withIdempotencyKey(db, scope, async () => ({ response: { statusCode: 409, body: {} }, keep: "save" }));
    const outcome = await withIdempotencyKey(db, { ...scope, requestHash: hashRequest({ n: 2 }) }, async () => {
      throw new Error("불리면 안 된다");
    });
    expect(outcome).toEqual({ kind: "key_reused" });
    expect(await keyRow(scope)).toHaveLength(1);
  });

  it("writeTransaction 안에서는 문장 5초, 잠금 대기 3초로 제한하고, 끝나면 풀린다", async () => {
    // 연결이 하나뿐인 풀이라 끝난 뒤의 확인도 같은 연결에서 한다
    const single = createPool({ connectionString: inject("databaseUrl"), max: 1 });
    try {
      const settings = sql`select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock`;
      const read = async (run: (q: typeof settings) => Promise<{ rows: unknown[] }>) => (await run(settings)).rows[0];
      const singleDb = createDb(single);
      expect(await writeTransaction(singleDb, (tx) => read((q) => tx.execute(q)))).toEqual({ statement: "5s", lock: "3s" });
      expect(await read((q) => singleDb.execute(q))).toEqual({ statement: "0", lock: "0" });
    } finally {
      await single.end();
    }
  });
});
