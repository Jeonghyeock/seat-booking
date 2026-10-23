import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, inject, it } from "vitest";
import { newSignedInUsers, newUsers } from "../test/fixtures.js";
import { promoteToAdmin } from "./admin.js";
import { createSession, findSessionUser } from "./auth.js";
import { createDb } from "./db/client.js";
import { createPool } from "./db/pool.js";

describe("관리자로 올리기(admin:promote)", () => {
  const url = inject("databaseUrl");
  const admin = createPool({ connectionString: url });
  // 잠금을 기다리는 연결만 골라 보려고 이름을 붙인다. 승격과 로그인(세션 만들기)을 다른 이름으로 둔다.
  const pool = createPool({ connectionString: url, application_name: "promote-test" });
  const loginPool = createPool({ connectionString: url, application_name: "promote-test-login" });
  const db = createDb(pool);
  const loginDb = createDb(loginPool);
  afterAll(async () => {
    await Promise.all([pool.end(), loginPool.end(), admin.end()]);
  });

  // 비밀번호 해시 자리에 아무 값이나 둔다(가입한 계정이라는 표시만 필요하다).
  async function signedUp() {
    const [user] = await newSignedInUsers(admin, 1);
    await admin.query("update users set password_hash = $2 where id = $1", [user!.id, randomUUID()]);
    const { rows } = await admin.query("select email, created_at from users where id = $1", [user!.id]);
    return { ...user!, email: rows[0].email as string, createdAt: rows[0].created_at as Date };
  }
  const roleOf = async (userId: number) =>
    (await admin.query("select role from users where id = $1", [userId])).rows[0].role as string;
  const sessionCount = async (userId: number) =>
    (await admin.query("select count(*)::int as n from sessions where user_id = $1", [userId])).rows[0].n as number;
  const lifetime = async (token: string) =>
    (
      await admin.query(
        `select extract(epoch from expires_at - created_at)::int as seconds
           from sessions where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
        [token],
      )
    ).rows[0]?.seconds as number | undefined;

  it("가입한 손님을 관리자로 올리고 그 사용자의 세션을 모두 지운다. 이메일은 대소문자·공백을 가리지 않고, 가입 시각을 준다", async () => {
    const user = await signedUp();
    expect(await sessionCount(user.id)).toBe(1);
    expect(await promoteToAdmin(db, `  ${user.email.toUpperCase()} `)).toEqual({
      ok: true,
      userId: user.id,
      createdAt: user.createdAt,
      alreadyAdmin: false,
    });
    expect(await roleOf(user.id)).toBe("admin");
    expect(await sessionCount(user.id)).toBe(0);
    expect(await findSessionUser(db, user.token)).toBeNull();
  });

  it("이미 관리자면 바꾸지 않고 세션도 그대로 둔다. 동시에 두 번 올려도 한쪽만 바꾼다", async () => {
    const user = await signedUp();
    const both = await Promise.all([promoteToAdmin(db, user.email), promoteToAdmin(db, user.email)]);
    expect(both.map((r) => r.ok && r.alreadyAdmin).sort()).toEqual([false, true]);
    const { token } = await createSession(db, user.id);
    expect(await promoteToAdmin(db, user.email)).toMatchObject({ ok: true, userId: user.id, alreadyAdmin: true });
    expect(await findSessionUser(db, token)).toMatchObject({ id: user.id, role: "admin" });
  });

  it("없는 이메일과 비밀번호 없는 계정은 거절하고 바꾸지 않는다", async () => {
    expect(await promoteToAdmin(db, `${randomUUID()}@test.local`)).toEqual({ ok: false, reason: "NOT_FOUND" });
    const [old] = await newUsers(admin, 1);
    const { rows } = await admin.query("select email from users where id = $1", [old]);
    expect(await promoteToAdmin(db, rows[0].email)).toEqual({ ok: false, reason: "NO_PASSWORD" });
    expect(await roleOf(old!)).toBe("customer");
  });

  async function waitForLockWaiter(applicationName: string) {
    for (let i = 0; i < 300; i++) {
      const { rows } = await admin.query(
        `select count(*)::int as n from pg_stat_activity
          where datname = current_database() and application_name = $1 and wait_event_type = 'Lock'`,
        [applicationName],
      );
      if (rows[0].n === 1) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`${applicationName} 연결이 잠금을 기다리지 않는다`);
  }

  it("올리는 중에 만든 세션은 올린 뒤의 역할(관리자 12시간)로 만들고, 로그인 응답의 역할도 관리자다", async () => {
    const user = await signedUp();
    // 기존 세션 행을 잡아 두면 승격은 역할을 바꾼 뒤 세션을 지우는 곳에서 멈춘다
    const holder = await admin.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from sessions where user_id = $1 for update", [user.id]);
      const promoting = promoteToAdmin(db, user.email);
      promoting.catch(() => {});
      await waitForLockWaiter("promote-test");
      // 그사이 로그인이 세션을 만든다. 승격이 바꾼 사용자 행을 FOR SHARE로 읽으므로 승격이 끝나기를 기다린다
      const creating = createSession(loginDb, user.id);
      creating.catch(() => {});
      await waitForLockWaiter("promote-test-login");
      await holder.query("rollback");

      expect(await promoting).toMatchObject({ ok: true, alreadyAdmin: false });
      const created = await creating;
      expect(created.role).toBe("admin");
      expect(await lifetime(created.token)).toBe(12 * 60 * 60);
      // 승격 전 세션은 지워졌고, 승격 뒤에 들어간 이 세션만 남는다
      expect(await findSessionUser(db, user.token)).toBeNull();
      expect(await sessionCount(user.id)).toBe(1);
    } finally {
      await holder.query("rollback");
      holder.release();
    }
  });
});
