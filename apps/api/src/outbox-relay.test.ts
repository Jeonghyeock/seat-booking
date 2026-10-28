import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, inject, it, onTestFinished } from "vitest";
import { createPool } from "./db/pool.js";
import {
  deleteOldSent,
  httpSend,
  MAX_SERVER_ERRORS,
  pgStore,
  relayRound,
  type Store,
  tryRelayLock,
  unpark,
  type WireEvent,
} from "./outbox-relay.js";

// outbox 릴레이(DESIGN 6.8, C9). 이 파일만 쓰는 DB(relayDatabaseUrl)에서 돈다. 다른 테스트 파일이 만든 outbox 행을 보내지 않게.
// 받는 쪽은 테스트 안의 가짜 수집 서버다. 실제 HTTP로 보내고, 받는 쪽처럼 (eventId, occurredAt)로 중복을 센다.

// 응답: 상태와 본문, 연결 끊기(네트워크 오류), 늦게 답하기(시간 초과)
type Reply = { status: number; body?: unknown } | { destroy: true } | { delayMs: number };
async function fakeIngest() {
  const stored = new Set<string>();
  const requests: WireEvent[][] = [];
  // 다음 요청들에 줄 응답(앞에서부터 하나씩). 비어 있으면 받는 쪽처럼 저장하고 200이다.
  const replies: ((events: WireEvent[]) => Reply)[] = [];
  const app = Fastify({ bodyLimit: 16 * 1024 * 1024 });
  app.post("/ingest", async (req, reply) => {
    const events = (req.body as { events: WireEvent[] }).events;
    requests.push(events);
    const next = replies.shift();
    if (next) {
      const r = next(events);
      if ("destroy" in r) {
        reply.hijack();
        req.raw.socket.destroy();
        return;
      }
      if ("delayMs" in r) {
        await new Promise((resolve) => setTimeout(resolve, r.delayMs));
        return reply.code(503).send({ code: "busy" });
      }
      return reply.code(r.status).send(r.body ?? { code: "test" });
    }
    let inserted = 0;
    for (const e of events) {
      const key = `${e.eventId}|${Date.parse(e.occurredAt)}`;
      if (!stored.has(key)) {
        stored.add(key);
        inserted++;
      }
    }
    return { received: events.length, inserted, duplicates: events.length - inserted, rejected: [] };
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  onTestFinished(() => app.close());
  return { url, stored, requests, replies, send: httpSend({ url, writeKey: "test-key", timeoutMs: 2000 }), close: () => app.close() };
}

describe("outbox 릴레이", () => {
  const pool = createPool({ connectionString: inject("relayDatabaseUrl") });
  afterAll(() => pool.end());
  beforeEach(async () => {
    await pool.query("delete from outbox_events");
  });

  async function addEvents(count: number) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into outbox_events (user_id, event_name, properties)
       select g, 'seats_held', jsonb_build_object('performanceId', 1, 'holdId', g, 'seats', 2) from generate_series(1, $1) g
       returning id`,
      [count],
    );
    return rows.map((r) => Number(r.id));
  }
  const rows = async () =>
    (
      await pool.query<{ id: string; sent: boolean; park_reason: string | null; attempts: number }>(
        "select id, sent_at is not null as sent, park_reason, attempts from outbox_events order by id",
      )
    ).rows.map((r) => ({ id: Number(r.id), sent: r.sent, parkReason: r.park_reason, attempts: r.attempts }));
  const store = () => pgStore(pool as unknown as pg.ClientBase);

  it("200이면 적고, 보내는 글자는 받는 쪽 계약대로다(ISO 시각, 문자열 userId, web)", async () => {
    const ingest = await fakeIngest();
    await addEvents(3);
    const round = await relayRound(store(), ingest.send);
    expect(round).toMatchObject({ kind: "sent", rows: 3, inserted: 3, duplicates: 0, parked: 0 });
    expect((await rows()).every((r) => r.sent && r.attempts === 1)).toBe(true);
    const [first] = ingest.requests[0]!;
    expect(first).toMatchObject({ userId: "1", eventName: "seats_held", platform: "web", properties: { performanceId: 1, holdId: 1, seats: 2 } });
    // 받는 쪽은 모르는 키를 거절한다(strictObject). 키가 하나 더 붙으면 모두 rejected로 보관되므로 키 집합을 고정한다
    expect(Object.keys(first!).sort()).toEqual(["eventId", "eventName", "occurredAt", "platform", "properties", "userId"]);
    expect(first!.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(first!.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(await relayRound(store(), ingest.send)).toMatchObject({ kind: "idle" });
  });

  it("A8: 보낸 뒤 적기 전에 죽으면 다음 바퀴가 같은 (eventId, occurredAt)를 다시 보내고, 받는 쪽은 중복으로 세어 한 번만 저장한다", async () => {
    const ingest = await fakeIngest();
    await addEvents(4);
    const crashing: Store = { ...store(), markSent: () => Promise.reject(new Error("적기 전에 죽음")) };
    await expect(relayRound(crashing, ingest.send)).rejects.toThrow("적기 전에 죽음");
    expect((await rows()).some((r) => r.sent)).toBe(false);

    const round = await relayRound(store(), ingest.send);
    expect(round).toMatchObject({ kind: "sent", rows: 4, inserted: 0, duplicates: 4 });
    expect(ingest.requests[1]).toEqual(ingest.requests[0]);
    expect(ingest.stored.size).toBe(4);
    expect((await rows()).every((r) => r.sent)).toBe(true);
  });

  it("503이면 아무것도 적지 않고 쉬었다가 같은 배치를 다시 보낸다", async () => {
    const ingest = await fakeIngest();
    await addEvents(2);
    ingest.replies.push(() => ({ status: 503, body: { code: "busy" } }));
    expect(await relayRound(store(), ingest.send)).toMatchObject({ kind: "backoff", reason: "503" });
    expect((await rows()).map((r) => [r.sent, r.attempts])).toEqual([
      [false, 0],
      [false, 0],
    ]);
    expect(await relayRound(store(), ingest.send)).toMatchObject({ kind: "sent", inserted: 2 });
  });

  it("연결이 끊기거나(네트워크 오류) 시간이 지나도 횟수 제한 없이 기다리고 보관하지 않는다. 받으면 모두 보낸다", async () => {
    const ingest = await fakeIngest();
    await addEvents(3);
    for (let i = 0; i < MAX_SERVER_ERRORS + 2; i++) {
      ingest.replies.push(() => ({ destroy: true }));
      expect(await relayRound(store(), ingest.send)).toMatchObject({ kind: "backoff", reason: expect.stringMatching(/^network: /) });
    }
    const slow = httpSend({ url: ingest.url, writeKey: "test-key", timeoutMs: 200 });
    ingest.replies.push(() => ({ delayMs: 1000 }));
    expect(await relayRound(store(), slow)).toMatchObject({ kind: "backoff", reason: "timeout" });
    expect((await rows()).every((r) => !r.sent && r.parkReason === null && r.attempts === 0)).toBe(true);
    expect(await relayRound(store(), ingest.send)).toMatchObject({ kind: "sent", inserted: 3 });
  });

  it("200이라도 본문이 계약과 맞지 않으면(받은 수가 다름, rejected 위치가 밖) 적지 않고 500처럼 센다", async () => {
    const ingest = await fakeIngest();
    await addEvents(2);
    ingest.replies.push(() => ({ status: 200, body: { received: 1, inserted: 1, duplicates: 0, rejected: [] } }));
    expect(await relayRound(store(), ingest.send)).toMatchObject({ kind: "backoff", reason: "http_200" });
    ingest.replies.push(() => ({ status: 200, body: { received: 2, inserted: 1, duplicates: 0, rejected: [{ index: 5, reason: "invalid" }] } }));
    expect(await relayRound(store(), ingest.send)).toMatchObject({ kind: "backoff", reason: "http_200" });
    expect((await rows()).map((r) => [r.sent, r.attempts])).toEqual([
      [false, 2],
      [false, 2],
    ]);
  });

  it("413이면 반으로 나눠 보내고, 한 건만 보내도 413이면 그 행만 보관한다", async () => {
    const ingest = await fakeIngest();
    await addEvents(4);
    ingest.replies.push(() => ({ status: 413 }));
    expect(await relayRound(store(), ingest.send)).toMatchObject({ kind: "sent", inserted: 4 });
    expect(ingest.requests.map((r) => r.length)).toEqual([4, 2, 2]);

    await pool.query("delete from outbox_events");
    const [only] = await addEvents(1);
    ingest.replies.push(() => ({ status: 413 }));
    expect(await relayRound(store(), ingest.send)).toMatchObject({ kind: "sent", parked: 1 });
    expect(await rows()).toEqual([{ id: only, sent: false, parkReason: "too_large", attempts: 1 }]);
  });

  it("401은 아무것도 적지 않고 멈추고, 400은 그 배치만 보관하고 멈춘다(어느 배치든 똑같이 날 봉투 오류)", async () => {
    const ingest = await fakeIngest();
    await addEvents(2);
    ingest.replies.push(() => ({ status: 401 }));
    expect(await relayRound(store(), ingest.send)).toMatchObject({ kind: "stop", reason: "401" });
    expect((await rows()).every((r) => !r.sent && r.parkReason === null)).toBe(true);
    ingest.replies.push(() => ({ status: 400 }));
    expect(await relayRound(store(), ingest.send, { batchSize: 1 })).toMatchObject({ kind: "stop", reason: "http_400", parked: 1 });
    expect((await rows()).map((r) => r.parkReason)).toEqual(["http_400", null]);
  });

  it("rejected는 보낸 배열 안의 위치로 그 행만 보관하고, 나머지는 적는다", async () => {
    const ingest = await fakeIngest();
    const ids = await addEvents(3);
    ingest.replies.push(() => ({
      status: 200,
      body: { received: 3, inserted: 2, duplicates: 0, rejected: [{ index: 1, reason: "too_old", message: "7일 전" }] },
    }));
    expect(await relayRound(store(), ingest.send)).toMatchObject({ kind: "sent", inserted: 2, rejected: 1, parked: 1 });
    expect(await rows()).toEqual([
      { id: ids[0], sent: true, parkReason: null, attempts: 1 },
      { id: ids[1], sent: false, parkReason: "rejected: too_old (7일 전)", attempts: 1 },
      { id: ids[2], sent: true, parkReason: null, attempts: 1 },
    ]);
  });

  it(`500은 행마다 세어 다시 보내고, ${MAX_SERVER_ERRORS}번이면 보관한다. 보관한 행은 --unpark로 되살린다`, async () => {
    const ingest = await fakeIngest();
    await addEvents(1);
    for (let i = 0; i < MAX_SERVER_ERRORS; i++) {
      ingest.replies.push(() => ({ status: 500 }));
      expect(await relayRound(store(), ingest.send)).toMatchObject({ kind: "backoff", reason: "http_500" });
    }
    expect(await rows()).toMatchObject([{ sent: false, parkReason: "server_error: http_500", attempts: MAX_SERVER_ERRORS }]);
    expect(await relayRound(store(), ingest.send)).toMatchObject({ kind: "idle" });
    expect(await unpark(pool as unknown as pg.ClientBase)).toBe(1);
    expect(await relayRound(store(), ingest.send)).toMatchObject({ kind: "sent", inserted: 1 });
  });

  it("커서가 없어, 늦게 커밋된 낮은 id도 다음 바퀴가 보낸다", async () => {
    const ingest = await fakeIngest();
    const slow = await pool.connect();
    onTestFinished(() => slow.release());
    await slow.query("begin");
    const { rows: low } = await slow.query<{ id: string }>(
      "insert into outbox_events (user_id, event_name, properties) values (1, 'seats_held', '{}') returning id",
    );
    const [high] = await addEvents(1);
    expect(Number(low[0]!.id)).toBeLessThan(high!);
    expect(await relayRound(store(), ingest.send)).toMatchObject({ kind: "sent", rows: 1 });
    await slow.query("commit");
    expect(await relayRound(store(), ingest.send)).toMatchObject({ kind: "sent", rows: 1 });
    expect((await rows()).every((r) => r.sent)).toBe(true);
  });

  it("릴레이는 하나만 돈다(전용 연결의 advisory lock), 연결이 닫히면 잠금이 풀린다", async () => {
    const connect = async () => {
      const client = new pg.Client({ connectionString: inject("relayDatabaseUrl") });
      await client.connect();
      return client;
    };
    const first = await connect();
    const second = await connect();
    onTestFinished(() => second.end());
    let firstOpen = true;
    onTestFinished(() => (firstOpen ? first.end() : undefined));
    expect(await tryRelayLock(first)).toBe(true);
    expect(await tryRelayLock(second)).toBe(false);
    await first.end();
    firstOpen = false;
    // 연결을 닫아도 서버 쪽 프로세스가 끝나며 잠금을 푸는 것은 조금 늦을 수 있다
    let taken = false;
    for (let i = 0; i < 100 && !taken; i++) {
      taken = await tryRelayLock(second);
      if (!taken) await new Promise((r) => setTimeout(r, 20));
    }
    expect(taken).toBe(true);
  });

  it("보낸 지 7일 지난 행만 지운다(보관한 행과 보내지 않은 행은 남긴다)", async () => {
    const ids = await addEvents(4);
    await pool.query("update outbox_events set sent_at = now() - interval '8 days' where id = $1", [ids[0]]);
    await pool.query("update outbox_events set sent_at = now() - interval '1 day' where id = $1", [ids[1]]);
    await pool.query("update outbox_events set parked_at = now() - interval '30 days', park_reason = 'http_400' where id = $1", [ids[2]]);
    expect(await deleteOldSent(pool as unknown as pg.ClientBase, { chunk: 1 })).toBe(1);
    expect((await rows()).map((r) => r.id)).toEqual(ids.slice(1));
  });
});
