import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";

// 앱 role은 DML만 한다(DESIGN 6.7 "앱 role이 못 하는 것과 하는 것", 10장 92).
// 오류·경고 메시지는 로컬(한국어)과 CI(영어)가 달라 코드로 본다. 테스트 DB는 다른 파일과 함께 쓰므로,
// 혹시 성공해도 남지 않게 모두 트랜잭션 안에서 하고 되돌린다.
describe("앱 role의 권한", () => {
  const app = new pg.Pool({ connectionString: inject("databaseUrl"), max: 1 });
  const owner = new pg.Pool({ connectionString: inject("ownerDatabaseUrl"), max: 1 });
  afterAll(() => Promise.all([app.end(), owner.end()]));

  // 트랜잭션 안에서 work를 하고 되돌린다. 그 사이의 notice(경고)를 "코드 메시지"로 모아 준다.
  // GRANT·REVOKE·ANALYZE는 권한을 보기 전에 표 잠금을 기다린다. 공유 DB에서 venues를 강하게 잠그는 테스트는 없다.
  async function inRolledBack(pool: pg.Pool, work: (client: pg.PoolClient, notices: string[]) => Promise<void>) {
    const client = await pool.connect();
    const notices: string[] = [];
    const onNotice = (n: { code?: string; message?: string }) => notices.push(`${n.code} ${n.message}`);
    client.on("notice", onNotice);
    try {
      await client.query("begin");
      await work(client, notices);
    } finally {
      await client.query("rollback");
      client.off("notice", onNotice);
      client.release();
    }
  }

  it("앱 role로 접속하고, 그 role은 DB 소유자도 슈퍼유저도 아니다", async () => {
    const { rows } = await app.query(
      `select current_user as role, current_user = pg_get_userbyid(d.datdba) as owner, r.rolsuper as superuser
         from pg_database d, pg_roles r where d.datname = current_database() and r.rolname = current_user`,
    );
    expect(rows).toEqual([{ role: "seat_booking_app", owner: false, superuser: false }]);
  });

  // 이것이 없으면 앱 연결이 남은 테스트·E2E·부하 DB를 소유자가 DROP … WITH (FORCE)로 지우지 못한다(README role 만들기).
  it("소유자는 앱 role의 권한을 이어받아 그 연결을 끊을 수 있고, 거꾸로는 아니다", async () => {
    const { rows } = await owner.query(
      `select pg_has_role('seat_booking', 'seat_booking_app', 'USAGE') as owner_has_app,
              pg_has_role('seat_booking_app', 'seat_booking', 'MEMBER') as app_has_owner`,
    );
    expect(rows).toEqual([{ owner_has_app: true, app_has_owner: false }]);
  });

  it.each([
    ["표 만들기", "create table roles_test (id int)"],
    ["인덱스 만들기", "create index roles_test_idx on venues (name)"],
    ["열 더하기", "alter table venues add column roles_test int"],
    ["표 지우기", "drop table tickets"],
    ["표 비우기", "truncate idempotency_keys"],
    ["스키마 만들기", "create schema roles_test"],
    ["소유자 role 쓰기", "set role seat_booking"],
    ["role 주기", "grant seat_booking to seat_booking_app"],
    ["적용 기록 읽기", 'select * from "drizzle"."__drizzle_migrations"'],
  ])("%s는 42501로 실패한다", async (_, sql) => {
    await inRolledBack(app, async (client) => {
      await expect(client.query(sql)).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("표의 GRANT·REVOKE는 경고만 내고 권한을 바꾸지 못한다", async () => {
    const acl = async () => (await owner.query("select relacl::text as acl from pg_class where oid = 'venues'::regclass")).rows;
    const before = await acl();
    await inRolledBack(app, async (client, notices) => {
      await client.query("grant select on venues to public");
      await client.query("revoke select on venues from seat_booking_app");
      expect(notices.map((n) => n.split(" ")[0])).toEqual(expect.arrayContaining(["01007", "01006"]));
    });
    expect(await acl()).toEqual(before);
  });

  // 01000은 일반 경고 코드라, 메시지에 표 이름이 있는지도 본다(메시지 말은 로컬과 CI가 다르다).
  const skipped = [expect.stringMatching(/^01000 .*"venues"/)];

  it("ANALYZE는 경고만 내고 건너뛴다", async () => {
    await inRolledBack(app, async (client, notices) => {
      await client.query("analyze venues");
      expect(notices).toEqual(skipped);
    });
  });

  it("VACUUM도 경고만 내고 건너뛴다", async () => {
    // VACUUM은 트랜잭션 안에서 돌지 않는다
    const client = await app.connect();
    const notices: string[] = [];
    const onNotice = (n: { code?: string; message?: string }) => notices.push(`${n.code} ${n.message}`);
    client.on("notice", onNotice);
    try {
      await client.query("vacuum venues");
      expect(notices).toEqual(skipped);
    } finally {
      client.off("notice", onNotice);
      client.release();
    }
  });

  it("DML과 임시 표는 되고, identity 열 INSERT는 시퀀스 권한 없이 된다", async () => {
    await inRolledBack(app, async (client) => {
      const { rows } = await client.query<{ id: number }>("insert into venues (name) values ('권한 시험 홀') returning id");
      await client.query("update venues set name = '권한 시험 홀 2' where id = $1", [rows[0]!.id]);
      await client.query("delete from venues where id = $1", [rows[0]!.id]);
      await client.query("create temp table roles_test_tmp (id int) on commit drop");
      const seq = await client.query("select has_sequence_privilege('venues_id_seq', 'USAGE') as usage");
      expect(seq.rows).toEqual([{ usage: false }]);
    });
  });

  it("소유자가 뒤에 만든 표에도 앱의 DML 권한이 붙고, TRUNCATE는 붙지 않는다", async () => {
    await inRolledBack(owner, async (client) => {
      await client.query("create table roles_test_later (id int)");
      const { rows } = await client.query(
        `select has_table_privilege('seat_booking_app', 'roles_test_later', 'SELECT, INSERT, UPDATE, DELETE') as dml,
                has_table_privilege('seat_booking_app', 'roles_test_later', 'TRUNCATE') as truncate`,
      );
      expect(rows).toEqual([{ dml: true, truncate: false }]);
    });
  });
});
