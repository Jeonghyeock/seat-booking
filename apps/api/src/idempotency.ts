import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "./db/client.js";
import { idempotencyKeys } from "./db/schema.js";

// 처리 중인 키를 넘겨받기까지의 시간(DESIGN 6.2 멱등성 2). 쓰기 경로의 시간 제한(5초)과 결제사 호출 제한(3초)보다 길다.
export const TAKEOVER_AFTER_SECONDS = 60;

export type IdempotencyScope = { userId: number; route: string; key: string; requestHash: string };
// body는 JSON 객체다. null이면 응답 열의 CHECK(code와 본문이 함께 있다)가 깨진다.
export type StoredResponse = { statusCode: number; body: object };
// 업무가 끝난 뒤 키를 어떻게 남길지.
// saved: 업무 트랜잭션 안에서 이미 저장했다. save: 다시 보내도 같은 4xx라 저장한다. release: 키를 지워 다시 보낼 수 있게 한다.
export type WorkResult = { response: StoredResponse; keep: "saved" | "save" | "release" };
export type SaveInTx = (tx: Tx, response: StoredResponse) => Promise<void>;
export type IdempotencyOutcome =
  | { kind: "response"; response: StoredResponse; replayed: boolean }
  | { kind: "in_progress" }
  | { kind: "key_reused" };

// 키 순서를 맞춘 JSON의 SHA-256. 키 순서만 다른 같은 요청을 다른 요청으로 보지 않는다(DESIGN 6.2 멱등성 7).
// 부르는 쪽은 검증을 마친 값(경로의 id, 기본값을 채운 본문)을 넘긴다.
export function hashRequest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(sortKeys(value))).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((k) => [k, sortKeys(record[k])]),
    );
  }
  return value;
}

// 업무 트랜잭션 안에서 응답을 저장하려는데 다른 요청이 키를 넘겨받았다. 던져서 업무까지 되돌린다.
class KeyLost extends Error {}

const keyOf = (scope: IdempotencyScope) =>
  and(
    eq(idempotencyKeys.userId, scope.userId),
    eq(idempotencyKeys.route, scope.route),
    eq(idempotencyKeys.key, scope.key),
  );

const staleAt = sql`now() - make_interval(secs => ${TAKEOVER_AFTER_SECONDS})`;

async function readKey(db: Db, scope: IdempotencyScope) {
  const [row] = await db
    .select({
      requestHash: idempotencyKeys.requestHash,
      status: idempotencyKeys.status,
      ownerToken: idempotencyKeys.ownerToken,
      responseCode: idempotencyKeys.responseCode,
      responseBody: idempotencyKeys.responseBody,
      stale: sql<boolean>`${idempotencyKeys.updatedAt} < ${staleAt}`,
    })
    .from(idempotencyKeys)
    .where(keyOf(scope));
  return row;
}

// 이미 있는 키 행을 결과로 바꾼다. 다른 요청이면 key_reused(422), 끝났으면 저장한 응답, 처리 중이면 in_progress.
function outcomeOf(row: NonNullable<Awaited<ReturnType<typeof readKey>>>, scope: IdempotencyScope): IdempotencyOutcome {
  if (row.requestHash !== scope.requestHash) return { kind: "key_reused" };
  if (row.status === "done") {
    return { kind: "response", response: { statusCode: row.responseCode!, body: row.responseBody as object }, replayed: true };
  }
  return { kind: "in_progress" };
}

// 키를 따로 커밋해 넣는다(processing, 새 owner_token). 커밋해 두어야 같은 키로 동시에 온 요청이 이 행을 본다.
// 이미 있으면 outcomeOf로 나눈다. 단, 1분 넘게 처리 중이면 그 요청이 죽었다고 보고 넘겨받는다.
// 옛 owner_token을 조건에 걸어 둘이 함께 넘겨받지 못하고, updated_at을 새로 적으므로 세 번째 요청이 곧바로 다시 넘겨받지 못한다.
// 넘겨받지 못했으면(다른 요청이 먼저 넘겨받았거나 그사이 끝냈다) 처음부터 다시 본다.
// 넣으려다 부딪힌 행이 읽기 전에 지워졌으면(그 요청이 5xx로 키를 지움) 다시 넣어 본다.
async function claim(db: Db, scope: IdempotencyScope): Promise<{ kind: "claimed"; ownerToken: string } | IdempotencyOutcome> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ownerToken = randomUUID();
    const inserted = await db
      .insert(idempotencyKeys)
      .values({ ...scope, ownerToken })
      .onConflictDoNothing()
      .returning({ ownerToken: idempotencyKeys.ownerToken });
    if (inserted.length > 0) return { kind: "claimed", ownerToken };

    const row = await readKey(db, scope);
    if (!row) continue;
    if (row.requestHash !== scope.requestHash || row.status === "done" || !row.stale) return outcomeOf(row, scope);

    const taken = await db
      .update(idempotencyKeys)
      .set({ ownerToken, updatedAt: sql`now()` })
      .where(
        and(keyOf(scope), eq(idempotencyKeys.ownerToken, row.ownerToken), eq(idempotencyKeys.status, "processing")),
      )
      .returning({ ownerToken: idempotencyKeys.ownerToken });
    if (taken.length > 0) return { kind: "claimed", ownerToken };
  }
  return { kind: "in_progress" };
}

// Idempotency-Key 하나로 업무(work)를 한 번만 한다(DESIGN 6.2 멱등성).
// work는 성공하면 업무 트랜잭션 끝에서 saveInTx로 응답을 저장하고, 거절이면 아무것도 쓰지 않았거나 되돌린 뒤 응답과 keep을 돌려준다.
// 저장·삭제는 owner_token이 내 것이고 아직 processing일 때만 한다. 넘겨받힌 키나 이미 끝난 키를 건드리지 않는다.
// 저장·삭제가 0행이면 다른 요청이 키를 넘겨받은 것이다. 같은 키에 응답이 둘이 되지 않게 내 응답은 버리고 그 요청의 결과를 준다.
// work가 예외를 던지면 키를 지우고 다시 던진다(5xx는 같은 키로 다시 보낼 수 있다).
export async function withIdempotencyKey(
  db: Db,
  scope: IdempotencyScope,
  work: (saveInTx: SaveInTx) => Promise<WorkResult>,
): Promise<IdempotencyOutcome> {
  const claimed = await claim(db, scope);
  if (claimed.kind !== "claimed") return claimed;

  const owned = and(
    keyOf(scope),
    eq(idempotencyKeys.ownerToken, claimed.ownerToken),
    eq(idempotencyKeys.status, "processing"),
  );
  const done = (response: StoredResponse) => ({
    status: "done" as const,
    responseCode: response.statusCode,
    responseBody: response.body,
    updatedAt: sql`now()`,
  });
  const saveInTx: SaveInTx = async (tx, response) => {
    const saved = await tx.update(idempotencyKeys).set(done(response)).where(owned).returning({ key: idempotencyKeys.key });
    if (saved.length === 0) throw new KeyLost();
  };

  const lost = async (): Promise<IdempotencyOutcome> => {
    const row = await readKey(db, scope);
    return row ? outcomeOf(row, scope) : { kind: "in_progress" };
  };

  let result: WorkResult;
  try {
    result = await work(saveInTx);
  } catch (err) {
    if (err instanceof KeyLost) return lost();
    // 지우지 못해도 1분 뒤 넘겨받을 수 있다. 원래 오류를 가리지 않게 지우기 오류는 버린다.
    await db
      .delete(idempotencyKeys)
      .where(owned)
      .catch(() => {});
    throw err;
  }
  if (result.keep !== "saved") {
    const kept =
      result.keep === "save"
        ? await db.update(idempotencyKeys).set(done(result.response)).where(owned).returning({ key: idempotencyKeys.key })
        : await db.delete(idempotencyKeys).where(owned).returning({ key: idempotencyKeys.key });
    if (kept.length === 0) return lost();
  }
  return { kind: "response", response: result.response, replayed: false };
}
