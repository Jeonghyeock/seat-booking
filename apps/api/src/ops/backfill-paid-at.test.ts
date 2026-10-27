import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, inject, it, onTestFinished } from "vitest";
import { newPerformance, newUsers } from "../../test/fixtures.js";
import { dropDatabase, withAdminClient, withDatabase } from "../db/databases.js";
import { runMigrations } from "../db/migrate.js";
import { createPool } from "../db/pool.js";
import { backfillPaidAt } from "./backfill-paid-at.js";

const repoFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const ownerUrl = inject("ownerDatabaseUrl");
const folders: string[] = [];
afterAll(() => {
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
});

// 저장소의 마이그레이션 중 tag까지만 든 폴더(그 뒤를 아직 배포하지 않은 DB를 흉내 낸다).
function folderUpTo(tag: string) {
  const journal = JSON.parse(readFileSync(join(repoFolder, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === tag) + 1);
  const dir = mkdtempSync(join(tmpdir(), "seat-booking-backfill-"));
  folders.push(dir);
  mkdirSync(join(dir, "meta"));
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const e of entries) copyFileSync(join(repoFolder, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

// 열(0010)까지 적용하고 제약(0011·0012)은 아직인 DB(배포 1만 나간 DB). 테스트가 끝나면 지운다.
async function databaseBeforeCheck() {
  const name = `seat_booking_backfill_${process.pid}`;
  await withAdminClient(ownerUrl, async (client) => {
    await dropDatabase(client, name);
    await client.query(`CREATE DATABASE ${name}`);
  });
  onTestFinished(() => withAdminClient(ownerUrl, (client) => dropDatabase(client, name)));
  const url = withDatabase(ownerUrl, name);
  await runMigrations(url, { folder: folderUpTo("0010_orders_paid_at") });
  return { ownerUrl: url, appUrl: withDatabase(inject("databaseUrl"), name) };
}

describe("paid_at 다시 채우기(expand → contract 3)", () => {
  it("옛 paid 주문만 updated_at으로 채우고, 묶음으로 나눠도 다시 해도 같다. 채우기 전에는 제약 마이그레이션이 안내하며 거절한다", async () => {
    const { ownerUrl: url, appUrl } = await databaseBeforeCheck();
    // 앱 role(DML만)로 돈다
    const pool = createPool({ connectionString: appUrl, max: 1 });
    try {
      const { performanceId } = await newPerformance(pool);
      const [userId] = await newUsers(pool, 1);
      // 열을 더하기 전에 결제된 주문 다섯(paid_at 없음), 이미 채워진 것 하나, 취소 하나, 결제 대기 하나
      await pool.query(
        `with h as (
           insert into holds (user_id, performance_id, expires_at)
           select $1, $2, now() + interval '5 minutes' from generate_series(1, 8) returning id
         ), numbered as (select id, row_number() over (order by id) as n from h)
         insert into orders (user_id, hold_id, status, amount, cancel_reason, updated_at, paid_at)
         select $1, id,
                case when n <= 6 then 'paid' when n = 7 then 'cancelled' else 'pending' end, 1000,
                case when n = 7 then 'user' end,
                timestamptz '2026-01-01 00:00:00+00' + make_interval(mins => n::int),
                case when n = 6 then timestamptz '2025-12-31 00:00:00+00' end
           from numbered
`,
        [userId, performanceId],
      );
      const before = await pool.query("select id, updated_at from orders order by id");

      // 채우기 전에는 0011이 제약을 걸기 전에 안내하며 실패하고 통째로 되돌아간다(0012도 돌지 않는다)
      await expect(runMigrations(url)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("ops:backfill-paid-at") });
      const constraint = await pool.query("select 1 from pg_constraint where conname = 'orders_paid_at_set'");
      expect(constraint.rowCount).toBe(0);


      expect(await backfillPaidAt(pool, { batchSize: 3 })).toBe(5);
      const after = await pool.query<{ id: number; status: string; paid: boolean; same: boolean }>(
        `select id, status, paid_at is not null as paid, paid_at = updated_at as same from orders order by id`,
      );
      expect(after.rows.map((r) => [r.status, r.paid, r.same])).toEqual([
        ...Array(5).fill(["paid", true, true]),
        ["paid", true, false],
        ["cancelled", false, null],
        ["pending", false, null],
      ]);
      expect((await pool.query("select id, updated_at from orders order by id")).rows).toEqual(before.rows);
      expect(await backfillPaidAt(pool)).toBe(0);

      expect(await runMigrations(url)).toEqual(["0011_orders_paid_at_check", "0012_orders_paid_at_validate"]);
    } finally {
      await pool.end();
    }
  });
});
