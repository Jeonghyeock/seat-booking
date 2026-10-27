import type pg from "pg";

// 옛 paid 주문의 결제 확정 시각(paid_at)을 채운다(DESIGN 6.7 expand → contract 3). 마이그레이션이 아니라 명령이다.
// 한 트랜잭션에 전부 넣으면 그 행들을 끝까지 잠그고, 실패하면 되돌릴 것이 크다.
// - id 순서로 batchSize행씩 나눠, 문장마다 따로 커밋한다(기본 키 인덱스로 다음 묶음을 찾아 표를 매번 훑지 않는다).
// - paid는 끝 상태라 updated_at이 확정 시각과 같다. updated_at은 건드리지 않는다.
// - 다시 해도 같은 결과다(paid_at이 비어 있는 paid 주문만 채운다). DML만 하므로 앱 role로 돈다.
export async function backfillPaidAt(pool: pg.Pool, { batchSize = 1_000 } = {}) {
  let after = 0;
  let filled = 0;
  for (;;) {
    const { rows } = await pool.query<{ last: number | null; filled: number }>(
      `with batch as (select id from orders where id > $1 order by id limit $2),
            done as (
              update orders o set paid_at = o.updated_at
                from batch
               where o.id = batch.id and o.status = 'paid' and o.paid_at is null
              returning 1)
       select (select max(id) from batch) as last, (select count(*) from done)::int as filled`,
      [after, batchSize],
    );
    const batch = rows[0]!;
    if (batch.last === null) return filled;
    filled += batch.filled;
    after = batch.last;
  }
}
