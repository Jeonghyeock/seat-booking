import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type pg from "pg";
import * as schema from "./schema.js";

// 트랜잭션은 풀에서 연결을 직접 빌려 그 연결에 묶은 drizzle로 돌리고, 끝나면 반드시 돌려준다.
// drizzle(0.45)이 풀로 여는 트랜잭션은 begin을 try 밖에서 보내, 연결이 끊겨 begin이 실패하면 연결을 돌려주지 않는다.
// 그러면 풀 자리 하나가 영영 새고, DB 재시작이 몇 번 겹치면 모든 요청이 연결 대기 끝에 실패한다. 끊긴 연결은 돌려줄 때 풀이 버린다.
// 여기서 바꾸면 db.transaction을 부르는 모든 곳(writeTransaction, 읽기 스냅샷, 시드)이 함께 고쳐진다. 격리 수준 등 설정은 그대로 넘긴다.
// 연결에 묶은 drizzle은 연결마다 한 번만 만든다. 만드는 데 짧은 트랜잭션 하나만큼(약 50µs)의 CPU가 든다. 한 연결은 한 번에 한 곳만 빌린다.
export function createDb(pool: pg.Pool) {
  const db = drizzle({ client: pool, schema });
  const bound = new WeakMap<pg.PoolClient, NodePgDatabase<typeof schema>>();
  db.transaction = async (run, config) => {
    const client = await pool.connect();
    try {
      let onClient = bound.get(client);
      if (!onClient) bound.set(client, (onClient = drizzle({ client, schema })));
      return await onClient.transaction(run, config);
    } finally {
      client.release();
    }
  };
  return db;
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
