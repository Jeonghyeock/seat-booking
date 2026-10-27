import pg from "pg";

// 테스트·E2E·부하 준비가 소유자 role(CREATEDB만, 슈퍼유저 아님)로 DB를 만들고 지울 때 쓴다(README 로컬 준비).

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

// FORCE는 남은 연결을 끊지만, autovacuum 작업자는 소유자 role이 끊을 권한이 없어(42501) 실패할 수 있다. 끝나길 잠시 기다려 다시 한다.
// 앱 role의 연결은 끊을 수 있다(GRANT seat_booking_app TO seat_booking, README).
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
