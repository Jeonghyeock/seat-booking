import { readFileSync } from "node:fs";
import pg from "pg";
import { hashSessionToken, sessionCookieName } from "../auth.js";
import { dropDatabase, withAdminClient, withDatabase } from "../db/databases.js";
import { runMigrations } from "../db/migrate.js";
import { createPool } from "../db/pool.js";
import { type LoadData, type LoadShape, seedLoadData } from "./data.js";

// 부하용 DB(DESIGN 6.6 "떨어뜨려 놓기", "데이터"). 이름은 여기서 정하고 밖에서 받지 않는다(다른 DB를 지우지 않게).
export const TEMPLATE_DATABASE = "seat_booking_load_template";
export const LOAD_DATABASE = "seat_booking_load";
// 세션이 7일 뒤 만료되므로 6일이 지난 템플릿은 쓰지 않는다.
export const TEMPLATE_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;
// load/results(gitignore). k6와 실행기가 여기서 읽는다.
export const RESULTS_DIR = new URL("../../../../load/results/", import.meta.url);
export const LOAD_DATA_FILE = new URL("load-data.json", RESULTS_DIR);
export const COOKIES_FILE = new URL("cookies.json", RESULTS_DIR);

// 템플릿을 지우고 다시 만든다: 마이그레이션 → 시드 → VACUUM (FREEZE, ANALYZE) → 모든 표의 autovacuum 끄기.
// 대량으로 넣은 직후에는 통계가 없어 계획이 다르고, 그대로 두면 autoanalyze가 측정 중에 계획을 바꾼다.
// 복제본은 누적 통계가 0부터라 측정 중에 바꾼 행만으로 autoanalyze 기준을 넘는다. 회차마다 다른 때 돌면 잡음이라 끈다(DESIGN 10장 86).
export async function buildLoadTemplate(baseUrl: string, shape: LoadShape): Promise<LoadData> {
  const url = withDatabase(baseUrl, TEMPLATE_DATABASE);
  await withAdminClient(baseUrl, async (client) => {
    await dropDatabase(client, TEMPLATE_DATABASE);
    await client.query(`CREATE DATABASE ${TEMPLATE_DATABASE}`);
  });
  await runMigrations(url);
  // int8을 number로 읽게 하는 설정이 pool.ts에 있어 풀에서 연결을 받는다.
  const pool = createPool({ connectionString: url, max: 1 });
  try {
    const client = await pool.connect();
    try {
      const data = await seedLoadData(client, shape, { now: new Date(), tag: "t" });
      await client.query("vacuum (freeze, analyze)");
      await client.query(`
        do $$
        declare t record;
        begin
          for t in select tablename from pg_tables where schemaname = 'public' loop
            execute format('alter table %I set (autovacuum_enabled = false)', t.tablename);
          end loop;
        end $$`);
      return data;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

// 템플릿을 복제해 측정 한 번의 DB를 새로 만든다. FILE_COPY는 스스로 checkpoint를 건다(소유자 role도 CHECKPOINT를 할 수 없다).
// 복제본은 통계와 visibility map을 이어받고, 누적 통계(pg_stat_*)는 0부터다.
export async function cloneLoadDatabase(baseUrl: string) {
  await withAdminClient(baseUrl, async (client) => {
    await dropDatabase(client, LOAD_DATABASE);
    await client.query(`CREATE DATABASE ${LOAD_DATABASE} TEMPLATE ${TEMPLATE_DATABASE} STRATEGY FILE_COPY`);
  });
  return withDatabase(baseUrl, LOAD_DATABASE);
}

// 복제한 DB에서 S1 회차의 판매 시작만 이번 측정의 T0로 바꾼다.
export async function setSalesOpen(loadUrl: string, performanceId: number, at: Date) {
  if (new URL(loadUrl).pathname !== `/${LOAD_DATABASE}`) throw new Error(`판매 시작은 ${LOAD_DATABASE} DB에서만 바꿉니다`);
  const client = new pg.Client({ connectionString: loadUrl });
  await client.connect();
  try {
    const { rowCount } = await client.query("update performances set sales_open_at = $2 where id = $1", [performanceId, at]);
    if (rowCount !== 1) throw new Error(`S1 회차(${performanceId})가 없습니다`);
  } finally {
    await client.end();
  }
}

// 복제한 DB와 load/results의 파일이 같은 템플릿에서 나왔는지 본다. 템플릿은 서버에 하나지만 파일은 작업 트리마다 따로라,
// 다른 곳에서 템플릿을 다시 만들면 id는 같고 토큰만 달라져 모든 요청이 401이 된다. 쿠키 하나로 그 사용자의 세션을 찾는다.
export async function verifyTemplateFiles(loadUrl: string, cookieHeader: string, expectedUserId: number) {
  const token = cookieHeader.slice(cookieHeader.indexOf("=") + 1);
  const client = new pg.Client({ connectionString: loadUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ user_id: string }>("select user_id from sessions where token_hash = $1", [
      hashSessionToken(token),
    ]);
    if (Number(rows[0]?.user_id) !== expectedUserId) {
      throw new Error("템플릿 DB와 load/results의 파일이 맞지 않습니다. npm run load:template으로 둘을 함께 다시 만드세요");
    }
  } finally {
    await client.end();
  }
}

// 템플릿을 만들 때 쓴 파일. 토큰은 cookies.json에만 둔다.
export function loadDataFile(data: LoadData) {
  const { tokens: _tokens, ...rest } = data;
  return rest;
}

// k6가 보낼 Cookie 헤더. 부하는 COOKIE_SECURE=false로 띄우므로 이름은 sid다. tokens[i]가 사용자 i다.
export function cookieHeaders(tokens: string[]) {
  return tokens.map((token) => `${sessionCookieName(false)}=${token}`);
}

export function readLoadData(now = Date.now()): Omit<LoadData, "tokens"> {
  const data = JSON.parse(readFileSync(LOAD_DATA_FILE, "utf8")) as Omit<LoadData, "tokens">;
  if (now - Date.parse(data.createdAt) > TEMPLATE_MAX_AGE_MS) {
    throw new Error(`템플릿이 ${data.createdAt}에 만들어져 세션이 곧 만료됩니다. npm run load:template으로 다시 만드세요`);
  }
  return data;
}
