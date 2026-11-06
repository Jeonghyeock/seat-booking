import { AuthError } from "@seat-booking/shared";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "./app.js";
import { createDb, writeTransaction } from "./db/client.js";
import { createPool } from "./db/pool.js";

describe("GET /health", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  const app = buildApp(pool);
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("DB에 닿으면 200과 status ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("DB 오류로 500이 나도 응답에는 SQL이나 오류 내용이 없다", async () => {
    const down = createPool({
      connectionString: "postgres://nobody:nothing@127.0.0.1:1/none",
      connectionTimeoutMillis: 1000,
    });
    const broken = buildApp(down);
    try {
      const res = await broken.inject({ method: "GET", url: "/performances/7/seats" });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: "서버 오류" });
      expect(res.body).not.toMatch(/select|params|ECONNREFUSED/i);
    } finally {
      await broken.close();
      await down.end();
    }
  });

  it("DB에 닿지 않으면 503, 오류 내용은 응답에 없음", async () => {
    const down = createPool({
      connectionString: "postgres://nobody:nothing@127.0.0.1:1/none",
      connectionTimeoutMillis: 1000,
    });
    const broken = buildApp(down);
    try {
      const res = await broken.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: "unavailable" });
    } finally {
      await broken.close();
      await down.end();
    }
  });

  it("풀의 쉬는 연결이 끊겨도 프로세스가 죽지 않고, 다음 요청에 새로 맺는다", async () => {
    const idle = createPool({ connectionString: inject("databaseUrl"), application_name: "health-idle-test" });
    const server = buildApp(idle);
    const killer = createPool({ connectionString: inject("databaseUrl"), max: 1 });
    try {
      expect((await server.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      expect(idle.idleCount).toBe(1);
      // 듣는 쪽이 없으면 여기서 'error'가 처리되지 않은 오류로 테스트 실행을 깬다
      const { rows } = await killer.query(
        "select pg_terminate_backend(pid) as ok from pg_stat_activity where application_name = 'health-idle-test' and datname = current_database()",
      );
      expect(rows).toEqual([{ ok: true }]);
      for (let i = 0; i < 100 && idle.totalCount > 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(idle.totalCount).toBe(0);
      expect((await server.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    } finally {
      await server.close();
      await idle.end();
      await killer.end();
    }
  });

  it("트랜잭션에 빌려 간 연결이 쿼리 사이에 끊겨도 프로세스가 죽지 않고, 그 작업만 실패한다", async () => {
    const busy = createPool({ connectionString: inject("databaseUrl"), application_name: "health-tx-test" });
    const server = buildApp(busy);
    const killer = createPool({ connectionString: inject("databaseUrl"), max: 1 });
    let paused!: () => void;
    let resume!: () => void;
    const reached = new Promise<void>((r) => (paused = r));
    const gate = new Promise<void>((r) => (resume = r));
    // 선점·주문·결제·정리 작업이 쓰는 트랜잭션. 첫 문장(한도 설정) 뒤 연결을 쥔 채 멈춘다.
    const work = writeTransaction(createDb(busy), async (tx) => {
      paused();
      await gate;
      await tx.execute(sql`select 1`);
    });
    try {
      await reached;
      // 빌려 간 연결에서는 pg-pool이 리스너를 뗀다. 듣는 쪽이 없으면 여기서 연결의 'error'가 처리되지 않은 오류로 테스트 실행을 깬다
      const { rows } = await killer.query(
        "select pg_terminate_backend(pid) as ok from pg_stat_activity where application_name = 'health-tx-test' and datname = current_database() and state = 'idle in transaction'",
      );
      expect(rows).toEqual([{ ok: true }]);
      // 백엔드가 끝난 뒤에 이어 간다. 이것은 서버 쪽이 끝났다는 것만 보장하고, 이 프로세스가 끊김(FATAL)을 다음 쿼리보다
      // 먼저 받았는지는 보장하지 않는다. 어느 순서든 연결은 'error'를 낸다
      let left = 1;
      for (let i = 0; i < 100 && left > 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
        left = (
          await killer.query(
            "select count(*) as n from pg_stat_activity where application_name = 'health-tx-test' and datname = current_database()",
          )
        ).rows[0].n;
      }
      expect(left).toBe(0);
      resume();
      await expect(work).rejects.toThrow();
      // 끊긴 연결은 돌려줄 때 풀이 버리고, 다음 요청에 새로 맺는다
      expect(busy.totalCount).toBe(0);
      expect((await server.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    } finally {
      resume();
      await work.catch(() => {});
      await server.close();
      await busy.end();
      await killer.end();
    }
  });

  it("트랜잭션이 연결을 받자마자 끊겨 begin이 실패해도, 그 연결의 풀 자리가 돌아온다", async () => {
    const one = createPool({ connectionString: inject("databaseUrl"), max: 1, connectionTimeoutMillis: 1000 });
    const server = buildApp(one);
    let taken: { release(): void } | undefined;
    try {
      expect((await server.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      expect(one.idleCount).toBe(1);
      // 쉬는 연결을 빌려 주는 순간 그 소켓을 끊는다(DB 재시작·네트워크 끊김). 트랜잭션의 첫 문장 begin이 실패한다
      one.once("acquire", (client) => {
        taken = client;
        (client as unknown as { connection: { stream: { destroy(): void } } }).connection.stream.destroy();
      });
      await expect(writeTransaction(createDb(one), async () => {})).rejects.toThrow(/Failed query: begin/);
      // 돌려받지 못하면 자리가 하나뿐인 이 풀은 막혀, 다음 요청이 연결 대기 1초 끝에 503이 된다
      expect([one.totalCount, one.idleCount, one.waitingCount]).toEqual([0, 0, 0]);
      expect((await server.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      expect(one.waitingCount).toBe(0);
    } finally {
      // 새어 나간 연결이 남아 있으면(고치기 전) 돌려줘야 풀을 닫을 수 있다
      if (one.totalCount > one.idleCount) taken?.release();
      await server.close();
      await one.end();
    }
  });
});

describe("경로 범위", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  const app = buildApp(pool);
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("세션 확인은 사용자 경로에만 걸린다. 없는 경로는 401이 아니라 404이고, 공개 경로는 로그인 없이 된다", async () => {
    expect((await app.inject({ method: "POST", url: "/nope" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/orders/1/nope" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/performances" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("세션 훅 범위의 경로는 모두 로그인하지 않으면 401이고 code가 남는다", async () => {
    await app.ready();
    expect(app.userRoutes.map((r) => `${r.method} ${r.url}`).sort()).toEqual([
      "GET /auth/me",
      "GET /orders",
      "GET /orders/:id",
      "GET /performances/:id/me",
      "POST /holds/:id/orders",
      "POST /orders/:id/cancel",
      "POST /orders/:id/payments",
      "POST /performances/:id/holds",
    ]);
    for (const route of app.userRoutes) {
      const res = await app.inject({
        method: route.method as "GET" | "POST",
        url: route.url.replace(/:id/g, "1"),
        headers: { "x-requested-with": "seat-booking" },
      });
      expect(res.statusCode, route.url).toBe(401);
      expect(AuthError.parse(res.json()).code, route.url).toBe("UNAUTHENTICATED");
    }
  });

  it("cookieSecure를 끄면 쿠키 이름은 sid이고 Secure 없이 지운다", async () => {
    const dev = buildApp(pool, {}, { auth: { cookieSecure: false } });
    try {
      const res = await dev.inject({ method: "GET", url: "/orders/1", headers: { cookie: "sid=not-a-token" } });
      expect(res.statusCode).toBe(401);
      expect(String(res.headers["set-cookie"])).toMatch(/^sid=;/);
      expect(String(res.headers["set-cookie"])).not.toMatch(/Secure/);
      // Secure 설정의 이름(__Host-sid)은 읽지 않는다
      const other = await dev.inject({ method: "GET", url: "/orders/1", headers: { cookie: "__Host-sid=not-a-token" } });
      expect(other.headers["set-cookie"]).toBeUndefined();
    } finally {
      await dev.close();
    }
  });
});
