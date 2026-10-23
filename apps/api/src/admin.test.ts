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
  // 잠금을 기다리는 연결만 골라 보려고 이름을 붙인다.
  const pool = createPool({ connectionString: url, application_name: "promote-test" });
  const db = createDb(pool);
  afterAll(async () => {
    await Promise.all([pool.end(), admin.end()]);
  });

  // 비밀번호 해시 자리에 아무 값이나 둔다(가입한 계정이라는 표시만 필요하다).
  async function signedUp() {
    const [user] = await newSignedInUsers(admin, 1);
    await admin.query("update users set password_hash = $2 where id = $1", [user!.id, randomUUID()]);
    const { rows } = await admin.query("select email from users where id = $1", [user!.id]);
    return { ...user!, email: rows[0].email as string };
  }
  const roleOf = async (userId: number) =>
    (await admin.query("select role from users where id = $1", [userId])).rows[0].role as string;
  const sessionCount = async (userId: number) =>
    (await admin.query("select count(*)::int as n from sessions where user_id = $1", [userId])).rows[0].n as number;

  it("가입한 손님을 관리자로 올리고 그 사용자의 세션을 모두 지운다. 이메일은 대소문자·공백을 가리지 않는다", async () => {
    const user = await signedUp();
    expect(await sessionCount(user.id)).toBe(1);
    expect(await promoteToAdmin(db, `  ${user.email.toUpperCase()} `)).toEqual({ ok: true, userId: user.id, alreadyAdmin: false });
    expect(await roleOf(user.id)).toBe("admin");
    expect(await sessionCount(user.id)).toBe(0);
    expect(await findSessionUser(db, user.token)).toBeNull();
  });

  it("이미 관리자면 바꾸지 않고 세션도 그대로 둔다", async () => {
    const user = await signedUp();
    await promoteToAdmin(db, user.email);
    const { token } = await createSession(db, user.id);
    expect(await promoteToAdmin(db, user.email)).toEqual({ ok: true, userId: user.id, alreadyAdmin: true });
    expect(await findSessionUser(db, token)).toMatchObject({ id: user.id, role: "admin" });
  });

  it("없는 이메일과 비밀번호 없는 계정은 거절하고 바꾸지 않는다", async () => {
    expect(await promoteToAdmin(db, `${randomUUID()}@test.local`)).toEqual({ ok: false, reason: "NOT_FOUND" });
    const [old] = await newUsers(admin, 1);
    const { rows } = await admin.query("select email from users where id = $1", [old]);
    expect(await promoteToAdmin(db, rows[0].email)).toEqual({ ok: false, reason: "NO_PASSWORD" });
    expect(await roleOf(old!)).toBe("customer");
  });

  async function waitForLockWaiter() {
    for (let i = 0; i < 300; i++) {
      const { rows } = await admin.query(
        `select count(*)::int as n from pg_stat_activity
          where datname = current_database() and application_name = 'promote-test' and wait_event_type = 'Lock'`,
      );
      if (rows[0].n === 1) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("세션을 만드는 연결이 잠금을 기다리지 않는다");
  }

  it("올리는 중에 만든 세션은 올린 뒤의 역할(관리자 12시간)로 만든다", async () => {
    const [userId] = await newUsers(admin, 1);
    // 올리는 트랜잭션(역할 바꾸기 + 세션 지우기)을 커밋하지 않고 둔다
    const promoting = await admin.connect();
    try {
      await promoting.query("begin");
      await promoting.query("update users set role = 'admin' where id = $1", [userId]);
      await promoting.query("delete from sessions where user_id = $1", [userId]);
      const creating = createSession(db, userId!);
      creating.catch(() => {});
      // 사용자 행을 FOR SHARE로 읽으므로 승격이 끝나기를 기다린다
      await waitForLockWaiter();
      await promoting.query("commit");
      const { token } = await creating;
      const { rows } = await admin.query(
        `select extract(epoch from expires_at - created_at)::int as seconds
           from sessions where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
        [token],
      );
      expect(rows[0].seconds).toBe(12 * 60 * 60);
    } finally {
      await promoting.query("rollback");
      promoting.release();
    }
  });
});
