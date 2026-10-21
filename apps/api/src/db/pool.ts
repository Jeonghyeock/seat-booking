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
  return new pg.Pool(config);
}
