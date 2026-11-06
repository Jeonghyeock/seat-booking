import pg from "pg";

// PostgreSQL의 bigint(int8)는 node-postgres가 기본으로 문자열로 돌려준다(JS number가 2^53을 넘으면 정확하지 않아서).
// id와 count(*)가 모두 int8이라, 안전한 범위 안에서는 number로 바꿔 Drizzle(mode: "number")과 타입을 맞춘다.
// 범위를 넘는 값은 조용히 틀리게 하지 않고 오류를 낸다. 이 설정은 pg 모듈 전체에 적용되므로 풀을 만드는 이 파일에만 둔다.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`int8 값(${value})이 number의 안전한 범위를 넘습니다`);
  return n;
});

export function createPool(config: pg.PoolConfig): pg.Pool {
  const pool = new pg.Pool(config);
  // pg-pool은 쉬는 연결에만 'error' 리스너를 달고 빌려 줄 때 뗀다. 트랜잭션에 빌려 간 연결이 끊기면(DB 재시작, pg_terminate_backend)
  // 연결이 낸 'error'를 듣는 쪽이 없어 프로세스가 죽는다. 그래서 새 연결마다 리스너를 달아 둔다(API와 CLI의 풀 모두).
  // 리스너는 아무것도 하지 않는다. 빌려 간 연결의 오류는 진행 중인 쿼리나 다음 쿼리를 거절해 호출한 쪽에 이미 간다(요청은 500 로그).
  // 쉬는 연결의 오류는 풀이 'error'로 다시 내고 buildApp이 로그에 남기므로, 여기서도 남기면 두 번 찍힌다.
  pool.on("connect", (client) => client.on("error", () => {}));
  return pool;
}
