import { afterAll, describe, expect, inject, it } from "vitest";
import { createPool } from "./pool.js";

describe("createPool의 int8 변환", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  afterAll(() => pool.end());

  it("count(*)와 bigint id를 number로 돌려준다", async () => {
    const { rows } = await pool.query<{ n: unknown; id: unknown }>("select count(*) as n, 42::bigint as id");
    expect(rows[0]).toEqual({ n: 1, id: 42 });
  });

  it("number의 안전한 범위를 넘는 int8은 오류를 낸다", async () => {
    await expect(pool.query("select 9007199254740993::bigint as big")).rejects.toThrow(RangeError);
  });
});
