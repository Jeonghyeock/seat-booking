import { appendFileSync } from "node:fs";
import pg from "pg";

// DB 쪽 표본(DESIGN 6.6 "지표와 표본"). 실행기만 쓴다.

type ActivityRow = { state: string | null; wait_type: string; wait_event: string; query: string; count: number | string };

// 0.2초마다 이 DB의 API 연결(application_name)을 상태·기다리는 것·질의 앞부분별로 세고, 1초마다 평균을 한 줄로 쓴다.
// 앱 role은 다른 role과 백그라운드 프로세스를 볼 수 없다(autovacuum은 표 통계로 본다).
const ACTIVITY = `
  select state, coalesce(wait_event_type, '') as wait_type, coalesce(wait_event, '') as wait_event,
         left(query, 120) as query, count(*)
    from pg_stat_activity
   where backend_type = 'client backend' and datname = current_database() and pid <> pg_backend_pid()
     and application_name = 'seat-booking-api'
   group by 1, 2, 3, 4`;

export async function startActivitySampler(url: string, outFile: string, intervalMs = 200) {
  const client = new pg.Client({ connectionString: url, application_name: "load-sampler" });
  await client.connect();
  let samples: ActivityRow[][] = [];
  let busy = false;
  const sampleTimer = setInterval(() => {
    if (busy) return;
    busy = true;
    client
      .query<ActivityRow>(ACTIVITY)
      .then(({ rows }) => samples.push(rows))
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, intervalMs);

  function flush() {
    const n = samples.length;
    if (n === 0) return;
    const byState: Record<string, number> = {};
    const byWait: Record<string, number> = {};
    const byQuery: Record<string, number> = {};
    for (const rows of samples) {
      for (const row of rows) {
        const count = Number(row.count);
        const state = row.state ?? "unknown";
        byState[state] = (byState[state] ?? 0) + count;
        if (row.wait_type) {
          const wait = `${state} ${row.wait_type}:${row.wait_event}`;
          byWait[wait] = (byWait[wait] ?? 0) + count;
        }
        if (state !== "idle") {
          const key = `${state} ${row.wait_type ? `${row.wait_type}:${row.wait_event}` : "-"} ${row.query.replace(/\s+/g, " ").trim()}`;
          byQuery[key] = (byQuery[key] ?? 0) + count;
        }
      }
    }
    const average = (counts: Record<string, number>) =>
      Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Math.round((v / n) * 100) / 100]));
    const top = Object.entries(average(byQuery))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    appendFileSync(
      outFile,
      `${JSON.stringify({ at: new Date().toISOString(), samples: n, byState: average(byState), byWait: average(byWait), top })}\n`,
    );
    samples = [];
  }
  const flushTimer = setInterval(flush, 1000);

  return {
    async stop() {
      clearInterval(sampleTimer);
      clearInterval(flushTimer);
      flush();
      await client.end();
    },
  };
}

// 측정 앞뒤로 찍는 누적 통계. 뒤에서 앞을 빼서 본다.
export async function snapshotStats(url: string) {
  const client = new pg.Client({ connectionString: url, application_name: "load-sampler" });
  await client.connect();
  try {
    const tables = await client.query(
      `select relname, seq_scan, seq_tup_read, idx_scan, idx_tup_fetch, n_tup_ins, n_tup_upd, n_tup_hot_upd, n_tup_del,
              n_live_tup, n_dead_tup, autovacuum_count, autoanalyze_count
         from pg_stat_user_tables order by relname`,
    );
    const indexes = await client.query(
      "select relname, indexrelname, idx_scan, idx_tup_read, idx_tup_fetch from pg_stat_user_indexes order by relname, indexrelname",
    );
    const database = await client.query(
      `select xact_commit, xact_rollback, deadlocks, temp_files, temp_bytes, blks_hit, blks_read, conflicts
         from pg_stat_database where datname = current_database()`,
    );
    const checkpointer = await client.query("select num_timed, num_requested, num_done, buffers_written from pg_stat_checkpointer");
    return {
      at: new Date().toISOString(),
      tables: tables.rows,
      indexes: indexes.rows,
      database: database.rows[0],
      checkpointer: checkpointer.rows[0],
    };
  } finally {
    await client.end();
  }
}

export type StatsSnapshot = Awaited<ReturnType<typeof snapshotStats>>;
