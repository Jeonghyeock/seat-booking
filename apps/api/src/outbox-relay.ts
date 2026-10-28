import type pg from "pg";

// outbox 릴레이(DESIGN 6.8, 10장 102). 보내지 않은 행을 골라 분석 프로젝트의 POST /ingest로 보내고, 결과를 적는다.
// 보내기(send)와 적기(store)를 나눈다. 보낸 뒤 적기 전에 죽으면 다음 바퀴가 같은 행을 다시 보내고,
// 받는 쪽은 (event_id, occurred_at)로 둘째 것을 중복으로 세어 저장하지 않는다(한 번 이상 보내기 + 멱등 저장).
// 커서("마지막으로 보낸 id")는 두지 않는다. 낮은 id의 트랜잭션이 늦게 커밋되면 커서가 그 행을 건너뛴다.

export const BATCH_SIZE = 500;
// 500과 표에 없는 응답을 이만큼 받은 행은 보관한다(받는 쪽이 같은 행을 계속 거절하는 버그를 끝없이 돌지 않게).
export const MAX_SERVER_ERRORS = 10;
// 503·네트워크 오류·500 뒤에 쉬는 간격(초). 끝의 값을 되풀이한다.
export const BACKOFF_SECONDS = [1, 2, 4, 8, 16, 30] as const;

export type OutboxRow = {
  id: number;
  eventId: string;
  occurredAt: Date;
  userId: number;
  eventName: string;
  properties: Record<string, unknown>;
  attempts: number;
};

// 받는 쪽 계약(event-analytics DESIGN 6.1)의 이벤트 한 건. 시각은 Date의 toISOString()이다
// (PostgreSQL의 글자 "2026-10-28 01:02:03.456+00"은 받는 쪽이 거절한다). 서버 이벤트라 플랫폼은 web이다.
export type WireEvent = {
  eventId: string;
  occurredAt: string;
  userId: string;
  eventName: string;
  platform: "web";
  properties: Record<string, unknown>;
};

export const toWire = (row: OutboxRow): WireEvent => ({
  eventId: row.eventId,
  occurredAt: row.occurredAt.toISOString(),
  userId: String(row.userId),
  eventName: row.eventName,
  platform: "web",
  properties: row.properties,
});

// 보내기의 결과. 받는 쪽의 응답을 할 일로 바꾼 것이다.
export type SendResult =
  | { kind: "ok"; inserted: number; duplicates: number; rejected: { index: number; reason: string; message?: string }[] }
  | { kind: "retry"; reason: string } // 503, 네트워크 오류, 시간 초과: 같은 배치를 횟수 제한 없이 다시 보낸다
  | { kind: "server_error"; status: number } // 500과 표에 없는 응답: 행마다 횟수를 센다
  | { kind: "bad_request"; status: number } // 400, 415: 보관한다
  | { kind: "unauthorized" } // 401: 멈춘다
  | { kind: "too_large" }; // 413: 반으로 나눈다

export type Send = (events: WireEvent[]) => Promise<SendResult>;

// 네트워크 오류의 까닭. fetch는 늘 "fetch failed"라 원인의 코드(ECONNREFUSED, ENOTFOUND 등)를 붙인다.
const networkReason = (err: unknown) => {
  const e = err as Error & { cause?: { code?: string } };
  if (e.name === "TimeoutError") return "timeout";
  return `network: ${e.cause?.code ?? e.message}`;
};

// 200의 본문이 계약(event-analytics 6.1)과 맞는지. 맞지 않으면(다른 서버, 잘린 본문) 보낸 것으로 적지 않는다.
// received가 보낸 수와 같아야 하고, rejected의 index는 보낸 배열 안이어야 한다.
function parseAccepted(body: unknown, sent: number): Extract<SendResult, { kind: "ok" }> | null {
  const b = body as { received?: unknown; inserted?: unknown; duplicates?: unknown; rejected?: unknown };
  if (b === null || typeof b !== "object" || b.received !== sent || !Array.isArray(b.rejected)) return null;
  if (typeof b.inserted !== "number" || typeof b.duplicates !== "number") return null;
  const rejected = b.rejected as { index?: unknown; reason?: unknown; message?: unknown }[];
  if (!rejected.every((r) => Number.isInteger(r.index) && (r.index as number) >= 0 && (r.index as number) < sent)) return null;
  return {
    kind: "ok",
    inserted: b.inserted,
    duplicates: b.duplicates,
    rejected: rejected.map((r) => ({ index: r.index as number, reason: String(r.reason), ...(typeof r.message === "string" ? { message: r.message } : {}) })),
  };
}

// fetch로 보내는 send. 시간 초과는 10초다(본문을 읽는 동안도 포함). 주소의 경로 접두사는 살린다(…/analytics → …/analytics/ingest).
export function httpSend({ url, writeKey, timeoutMs = 10_000 }: { url: string; writeKey: string; timeoutMs?: number }): Send {
  const endpoint = new URL("ingest", url.endsWith("/") ? url : `${url}/`).toString();
  return async (events) => {
    let res: Response;
    let body: unknown;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-write-key": writeKey },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 200) body = await res.json();
      else await res.body?.cancel();
    } catch (err) {
      if (err instanceof SyntaxError) return { kind: "server_error", status: 200 };
      return { kind: "retry", reason: networkReason(err) };
    }
    if (res.status === 200) return parseAccepted(body, events.length) ?? { kind: "server_error", status: 200 };
    if (res.status === 503) return { kind: "retry", reason: "503" };
    if (res.status === 400 || res.status === 415) return { kind: "bad_request", status: res.status };
    if (res.status === 401) return { kind: "unauthorized" };
    if (res.status === 413) return { kind: "too_large" };
    return { kind: "server_error", status: res.status };
  };
}

// 적기. DB에 닿는 일은 이것뿐이라 테스트가 감싸서 "보낸 뒤 적기 실패"를 만든다.
export type Store = {
  pending(limit: number): Promise<OutboxRow[]>;
  markSent(ids: number[]): Promise<void>;
  park(rows: { id: number; reason: string }[]): Promise<void>;
  countServerError(ids: number[], max: number, reason: string): Promise<void>;
};

export function pgStore(client: pg.ClientBase): Store {
  return {
    async pending(limit) {
      const { rows } = await client.query<{
        id: string;
        event_id: string;
        occurred_at: Date;
        user_id: string;
        event_name: string;
        properties: Record<string, unknown>;
        attempts: number;
      }>(
        `select id, event_id, occurred_at, user_id, event_name, properties, attempts
           from outbox_events where sent_at is null and parked_at is null order by id limit $1`,
        [limit],
      );
      return rows.map((r) => ({
        id: Number(r.id),
        eventId: r.event_id,
        occurredAt: r.occurred_at,
        userId: Number(r.user_id),
        eventName: r.event_name,
        properties: r.properties,
        attempts: r.attempts,
      }));
    },
    async markSent(ids) {
      if (ids.length === 0) return;
      // 받는 쪽이 받았으면(저장 또는 중복) 보낸 것이다. 그 사이 보관된 행은 건드리지 않는다.
      await client.query("update outbox_events set sent_at = now(), attempts = attempts + 1 where id = any($1::bigint[]) and parked_at is null", [ids]);
    },
    async park(rows) {
      await client.query(
        `update outbox_events o set parked_at = now(), park_reason = p.reason, attempts = attempts + 1
           from unnest($1::bigint[], $2::text[]) as p(id, reason)
          where o.id = p.id and o.sent_at is null`,
        [rows.map((r) => r.id), rows.map((r) => r.reason)],
      );
    },
    async countServerError(ids, max, reason) {
      await client.query(
        `update outbox_events
            set attempts = attempts + 1,
                parked_at = case when attempts + 1 >= $2 then now() end,
                park_reason = case when attempts + 1 >= $2 then $3 end
          where id = any($1::bigint[]) and sent_at is null and parked_at is null`,
        [ids, max, reason],
      );
    },
  };
}

export type RoundResult = {
  // idle: 보낼 것이 없음. sent: 보냄(일부 보관 포함). backoff: 쉬었다 같은 행을 다시. stop: 401, 400·415(사람이 볼 것)
  kind: "idle" | "sent" | "backoff" | "stop";
  rows: number;
  inserted: number;
  duplicates: number;
  rejected: number;
  parked: number;
  reason?: string;
};

// 한 바퀴: 고르기 → 보내기 → 적기. 413이면 반으로 나눠 각각 보낸다. 한 건만 보내도 413이면 보관한다.
export async function relayRound(store: Store, send: Send, { batchSize = BATCH_SIZE } = {}): Promise<RoundResult> {
  const rows = await store.pending(batchSize);
  const result: RoundResult = { kind: "idle", rows: rows.length, inserted: 0, duplicates: 0, rejected: 0, parked: 0 };
  if (rows.length === 0) return result;
  result.kind = "sent";

  const deliver = async (part: OutboxRow[]): Promise<void> => {
    const res = await send(part.map(toWire));
    switch (res.kind) {
      case "ok": {
        // rejected의 index는 이번에 보낸(나눈) 배열 안의 위치다
        const rejected = res.rejected.map((r) => ({ id: part[r.index]!.id, reason: `rejected: ${r.reason}${r.message ? ` (${r.message})` : ""}` }));
        const rejectedIds = new Set(rejected.map((r) => r.id));
        await store.markSent(part.filter((r) => !rejectedIds.has(r.id)).map((r) => r.id));
        if (rejected.length > 0) await store.park(rejected);
        result.inserted += res.inserted;
        result.duplicates += res.duplicates;
        result.rejected += rejected.length;
        result.parked += rejected.length;
        return;
      }
      case "too_large":
        if (part.length === 1) {
          await store.park([{ id: part[0]!.id, reason: "too_large" }]);
          result.parked += 1;
          return;
        }
        await deliver(part.slice(0, Math.ceil(part.length / 2)));
        if (result.kind === "sent") await deliver(part.slice(Math.ceil(part.length / 2)));
        return;
      case "bad_request":
        // 봉투 오류는 어느 배치를 보내도 똑같이 난다(계약이 바뀌었거나 다른 서비스). 이 배치만 보관하고 멈춰 사람이 보게 한다.
        // 멈추지 않으면 쌓인 행이 몇 초 만에 모두 보관된다.
        await store.park(part.map((r) => ({ id: r.id, reason: `http_${res.status}` })));
        result.parked += part.length;
        result.kind = "stop";
        result.reason = `http_${res.status}`;
        return;
      case "unauthorized":
        result.kind = "stop";
        result.reason = "401";
        return;
      case "retry":
        result.kind = "backoff";
        result.reason = res.reason;
        return;
      case "server_error":
        await store.countServerError(
          part.map((r) => r.id),
          MAX_SERVER_ERRORS,
          `server_error: http_${res.status}`,
        );
        result.parked += part.filter((r) => r.attempts + 1 >= MAX_SERVER_ERRORS).length;
        result.kind = "backoff";
        result.reason = `http_${res.status}`;
        return;
    }
  };
  await deliver(rows);
  return result;
}

// 보낸 지 7일 지난 행을 지운다(10장 103). DELETE에는 LIMIT이 없으므로 id를 500개씩 골라 지운다. 지운 수를 돌려준다.
export async function deleteOldSent(client: pg.ClientBase, { days = 7, chunk = 500 } = {}) {
  let total = 0;
  for (;;) {
    const { rowCount } = await client.query(
      `delete from outbox_events where id = any(array(
         select id from outbox_events where sent_at < now() - make_interval(days => $1) order by sent_at limit $2))`,
      [days, chunk],
    );
    total += rowCount ?? 0;
    if ((rowCount ?? 0) < chunk) return total;
  }
}

// 보관한 행을 되살린다(--unpark). 까닭을 고친 뒤 다시 보낸다.
export async function unpark(client: pg.ClientBase) {
  const { rowCount } = await client.query(
    "update outbox_events set parked_at = null, park_reason = null, attempts = 0 where parked_at is not null",
  );
  return rowCount ?? 0;
}

// 릴레이는 하나만 돈다. 프로세스가 도는 내내 쥐는 전용 연결에서 잡는다(풀의 연결이면 쉬는 연결이 닫힐 때 잠금이 풀린다).
export const RELAY_LOCK = 7_340_108;
export async function tryRelayLock(client: pg.ClientBase) {
  const { rows } = await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [RELAY_LOCK]);
  return rows[0]!.ok;
}
