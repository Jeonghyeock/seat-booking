import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import * as schema from "./schema.js";

export function createDb(pool: pg.Pool) {
  return drizzle({ client: pool, schema });
}

export type Db = ReturnType<typeof createDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// 3단계의 쓰기 경로(주문 생성, 결제 요청, 웹훅, 취소, 정리)는 문장 5초, 잠금 대기 3초로 제한한다(DESIGN 6.2 멱등성 6).
// set_config(…, true)는 SET LOCAL과 같아 트랜잭션이 끝나면 풀린다.
export function writeTransaction<T>(db: Db, run: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('statement_timeout', '5s', true), set_config('lock_timeout', '3s', true)`);
    return run(tx);
  });
}
