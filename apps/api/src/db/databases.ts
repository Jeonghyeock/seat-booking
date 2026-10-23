import pg from "pg";

// 테스트·E2E가 DB를 만들고 지울 때 쓴다. 앱 role은 CREATEDB만 있다(README 로컬 준비).

// 같은 서버·같은 계정으로 다른 DB를 가리키는 주소.
export function withDatabase(url: string, database: string) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

// 그 서버의 postgres DB에 붙어 work를 한다(지우고 만들 DB에는 붙어 있을 수 없다).
export async function withAdminClient(baseUrl: string, work: (client: pg.Client) => Promise<unknown>) {
  const client = new pg.Client({ connectionString: withDatabase(baseUrl, "postgres") });
  await client.connect();
  try {
    await work(client);
  } finally {
    await client.end();
  }
}

// FORCE는 남은 연결을 끊지만, autovacuum 작업자는 앱 role이 끊을 권한이 없어(42501) 실패할 수 있다. 끝나길 잠시 기다려 다시 한다.
export async function dropDatabase(client: pg.Client, db: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== "42501" || attempt === 10) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
