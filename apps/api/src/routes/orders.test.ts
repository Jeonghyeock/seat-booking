import { randomUUID } from "node:crypto";
import { CreateOrderConflict, HoldResponse, IdempotencyKeyReused, OrderView } from "@seat-booking/shared";
import { afterAll, describe, expect, inject, it } from "vitest";
import { newPerformance, newUsers } from "../../test/fixtures.js";
import { buildApp } from "../app.js";
import { createPool } from "../db/pool.js";
import { hashRequest } from "../idempotency.js";

describe("POST /holds/:id/orders, GET /orders/:id", () => {
  const url = inject("databaseUrl");
  const admin = createPool({ connectionString: url });
  // 잠금을 기다리는 앱 연결만 골라 보려고 이름을 붙인다.
  const pool = createPool({ connectionString: url, application_name: "orders-test" });
  const app = buildApp(pool);
  afterAll(async () => {
    await app.close();
    await Promise.all([pool.end(), admin.end()]);
  });

  async function newHold(seatCount = 2) {
    const { performanceId, seatIds } = await newPerformance(admin);
    const [userId] = await newUsers(admin, 1);
    const res = await app.inject({
      method: "POST",
      url: `/performances/${performanceId}/holds`,
      headers: { "x-user-id": String(userId) },
      payload: { seatIds: seatIds.slice(0, seatCount) },
    });
    return { performanceId, seatIds, userId: userId!, hold: HoldResponse.parse(res.json()) };
  }

  // key가 null이면 Idempotency-Key 헤더를 보내지 않는다
  const createOrder = (holdId: number, userId: number | string, key: string | null = randomUUID()) =>
    app.inject({
      method: "POST",
      url: `/holds/${holdId}/orders`,
      headers: { "x-user-id": String(userId), ...(key === null ? {} : { "idempotency-key": key }) },
    });
  const getOrder = (orderId: number, userId: number) =>
    app.inject({ method: "GET", url: `/orders/${orderId}`, headers: { "x-user-id": String(userId) } });

  const conflict = (res: Awaited<ReturnType<typeof createOrder>>) => {
    expect(res.statusCode).toBe(409);
    return CreateOrderConflict.parse(res.json());
  };
  const expireHold = async (holdId: number) => {
    await admin.query("update holds set expires_at = now() - interval '1 second' where id = $1", [holdId]);
    await admin.query("update performance_seats set hold_expires_at = now() - interval '1 second' where hold_id = $1", [
      holdId,
    ]);
  };
  const countOrders = async (holdId: number) =>
    (await admin.query("select count(*) as n from orders where hold_id = $1", [holdId])).rows[0].n as number;

  it("선점으로 주문을 만들면 201이고, 좌석과 그때의 가격을 복사하며 결제 마감은 선점 만료 30초 전이다", async () => {
    const { performanceId, userId, hold } = await newHold(2);
    const res = await createOrder(hold.holdId, userId);
    expect(res.statusCode).toBe(201);
    const view = OrderView.parse(res.json());

    expect(view).toMatchObject({
      holdId: hold.holdId,
      performanceId,
      status: "pending",
      cancelReason: null,
      holdExpiresAt: hold.expiresAt,
      payments: [],
      tickets: [],
    });
    expect(Date.parse(view.holdExpiresAt) - Date.parse(view.payBy)).toBe(30_000);
    expect(view.items.map((i) => i.seatId)).toEqual(hold.seatIds);

    // 가격은 회차의 등급 가격이고, 합이 주문 금액이다
    const { rows: prices } = await admin.query<{ seat_id: number; price: number }>(
      `select ps.seat_id, g.price
         from performance_seats ps
         join seats s on s.id = ps.seat_id
         join performance_grades g on g.performance_id = ps.performance_id and g.grade = s.grade
        where ps.performance_id = $1 and ps.seat_id = any($2::bigint[])
        order by ps.seat_id`,
      [performanceId, hold.seatIds],
    );
    expect(view.items.map((i) => ({ seat_id: i.seatId, price: i.price }))).toEqual(prices);
    expect(view.amount).toBe(prices.reduce((sum, p) => sum + p.price, 0));

    const { rows } = await admin.query(
      `select o.status, o.amount, o.user_id, (select count(*) from order_items where order_id = o.id) as items
         from orders o where o.id = $1`,
      [view.orderId],
    );
    expect(rows).toEqual([{ status: "pending", amount: view.amount, user_id: userId, items: 2 }]);
  });

  it("같은 키로 다시 보내면 처음 응답을 그대로 돌려주고 Idempotent-Replayed를 붙인다. 주문은 하나다", async () => {
    const { userId, hold } = await newHold();
    const key = randomUUID();
    const first = await createOrder(hold.holdId, userId, key);
    expect(first.statusCode).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();

    const again = await createOrder(hold.holdId, userId, key);
    expect(again.statusCode).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    // serverTime까지 처음 것이다
    expect(again.json()).toEqual(first.json());
    expect(await countOrders(hold.holdId)).toBe(1);
  });

  it("같은 키를 다른 선점에 쓰면 422 IDEMPOTENCY_KEY_REUSED", async () => {
    const { userId, hold, performanceId, seatIds } = await newHold(1);
    const other = HoldResponse.parse(
      (
        await app.inject({
          method: "POST",
          url: `/performances/${performanceId}/holds`,
          headers: { "x-user-id": String(userId) },
          payload: { seatIds: [seatIds[1]] },
        })
      ).json(),
    );
    const key = randomUUID();
    expect((await createOrder(hold.holdId, userId, key)).statusCode).toBe(201);
    const res = await createOrder(other.holdId, userId, key);
    expect(res.statusCode).toBe(422);
    expect(IdempotencyKeyReused.parse(res.json()).code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await countOrders(other.holdId)).toBe(0);
  });

  it("다른 키로 다시 만들면 409 ORDER_EXISTS와 기존 주문 id", async () => {
    const { userId, hold } = await newHold();
    const created = OrderView.parse((await createOrder(hold.holdId, userId)).json());
    expect(conflict(await createOrder(hold.holdId, userId))).toMatchObject({
      code: "ORDER_EXISTS",
      orderId: created.orderId,
    });
  });

  it("다른 키 10개로 동시에 만들면 201은 하나이고, 나머지는 같은 주문의 ORDER_EXISTS다", async () => {
    const { userId, hold } = await newHold();
    const responses = await Promise.all(Array.from({ length: 10 }, () => createOrder(hold.holdId, userId)));
    const created = responses.filter((r) => r.statusCode === 201).map((r) => OrderView.parse(r.json()));
    expect(created).toHaveLength(1);
    const others = responses.filter((r) => r.statusCode !== 201).map(conflict);
    expect(others).toHaveLength(9);
    expect(others.every((c) => c.code === "ORDER_EXISTS" && c.orderId === created[0]!.orderId)).toBe(true);
    expect(await countOrders(hold.holdId)).toBe(1);
  });

  async function waitForLockWaiters(count: number) {
    for (let i = 0; i < 300; i++) {
      const { rows } = await admin.query(
        `select count(*) as n from pg_stat_activity
          where datname = current_database() and application_name = 'orders-test' and wait_event_type = 'Lock'`,
      );
      if (rows[0].n === count) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`잠금을 기다리는 연결이 ${count}개가 되지 않는다`);
  }

  it("C4: 같은 키의 앞 요청이 처리 중이면 뒤 요청은 409 REQUEST_IN_PROGRESS와 Retry-After이고, 앞 요청이 끝나면 그 응답을 받는다", async () => {
    const { userId, hold } = await newHold();
    const key = randomUUID();
    // 세 번째 연결이 같은 선점의 주문을 넣은 채 커밋하지 않아, 앞 요청이 hold_id unique에서 기다리게 한다
    const holder = await admin.connect();
    try {
      await holder.query("begin");
      await holder.query("insert into orders (user_id, hold_id, amount) values ($1, $2, 0)", [userId, hold.holdId]);
      const first = createOrder(hold.holdId, userId, key);
      await waitForLockWaiters(1);

      const second = await createOrder(hold.holdId, userId, key);
      expect(conflict(second).code).toBe("REQUEST_IN_PROGRESS");
      expect(second.headers["retry-after"]).toBe("1");

      await holder.query("rollback");
      const firstRes = await first;
      expect(firstRes.statusCode).toBe(201);
      const again = await createOrder(hold.holdId, userId, key);
      expect(again.json()).toEqual(firstRes.json());
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
    expect(await countOrders(hold.holdId)).toBe(1);
  });

  it("다른 키로 같은 선점의 주문을 넣는 중이면 기다렸다가, 그쪽이 커밋하면 오류 없이 그 주문의 ORDER_EXISTS다", async () => {
    const { userId, hold } = await newHold();
    const holder = await admin.connect();
    try {
      await holder.query("begin");
      const { rows } = await holder.query<{ id: number }>(
        "insert into orders (user_id, hold_id, amount) values ($1, $2, 0) returning id",
        [userId, hold.holdId],
      );
      // 앞의 확인(이미 있는 주문)은 커밋 전이라 지나가고, 주문을 넣다가 hold_id unique에서 기다린다
      const pending = createOrder(hold.holdId, userId);
      await waitForLockWaiters(1);
      await holder.query("commit");
      expect(conflict(await pending)).toMatchObject({ code: "ORDER_EXISTS", orderId: rows[0]!.id });
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
  });

  it("잠금 대기가 3초를 넘으면 500이고, 키를 지워 같은 키로 다시 보낼 수 있다", async () => {
    const { userId, hold } = await newHold();
    const key = randomUUID();
    const holder = await admin.connect();
    try {
      await holder.query("begin");
      await holder.query("insert into orders (user_id, hold_id, amount) values ($1, $2, 0)", [userId, hold.holdId]);
      expect((await createOrder(hold.holdId, userId, key)).statusCode).toBe(500);
      const { rows } = await admin.query("select count(*) as n from idempotency_keys where key = $1", [key]);
      expect(rows[0].n).toBe(0);
      await holder.query("rollback");
      expect((await createOrder(hold.holdId, userId, key)).statusCode).toBe(201);
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
  }, 15_000);

  it("1분 넘게 처리 중인 키는 넘겨받아 처리하고, 1분이 안 된 키는 409 REQUEST_IN_PROGRESS다", async () => {
    const { userId, hold } = await newHold();
    const insertKey = (key: string, age: string) =>
      admin.query(
        `insert into idempotency_keys (user_id, route, key, request_hash, owner_token, created_at, updated_at)
         values ($1, 'POST /holds/:id/orders', $2, $3, gen_random_uuid(), now() - $4::interval, now() - $4::interval)`,
        [userId, key, hashRequest({ holdId: hold.holdId }), age],
      );

    const fresh = randomUUID();
    await insertKey(fresh, "30 seconds");
    expect(conflict(await createOrder(hold.holdId, userId, fresh)).code).toBe("REQUEST_IN_PROGRESS");

    const stale = randomUUID();
    await insertKey(stale, "2 minutes");
    expect((await createOrder(hold.holdId, userId, stale)).statusCode).toBe(201);
    const { rows } = await admin.query("select status, response_code from idempotency_keys where key = $1", [stale]);
    expect(rows).toEqual([{ status: "done", response_code: 201 }]);
  });

  it("선점이 만료됐으면 409 HOLD_EXPIRED이고, 이 응답을 저장해 다시 보내면 같은 409다", async () => {
    const { userId, hold } = await newHold();
    await expireHold(hold.holdId);
    const key = randomUUID();
    const res = await createOrder(hold.holdId, userId, key);
    const body = conflict(res);
    if (body.code !== "HOLD_EXPIRED") throw new Error(body.code);
    const { rows: expiry } = await admin.query("select expires_at from holds where id = $1", [hold.holdId]);
    expect(body.expiredAt).toBe(expiry[0].expires_at.toISOString());

    const again = await createOrder(hold.holdId, userId, key);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.json()).toEqual(res.json());
    expect(await countOrders(hold.holdId)).toBe(0);
  });

  it("좌석을 읽는 문장이 기다리는 사이 만료되고 다른 선점이 좌석 하나를 가져가면, 남은 좌석만으로 주문하지 않고 HOLD_EXPIRED다", async () => {
    const { performanceId, userId, hold } = await newHold(2);
    const { rows: expiry } = await admin.query<{ at: Date }>(
      "update holds set expires_at = now() + interval '1 second' where id = $1 returning expires_at as at",
      [hold.holdId],
    );
    await admin.query("update performance_seats set hold_expires_at = $2 where hold_id = $1", [hold.holdId, expiry[0]!.at]);

    // 좌석을 읽는 문장은 등급 가격 표를 함께 읽으므로, 그 표를 잠가 문장을 시작한 채 기다리게 한다
    const holder = await admin.connect();
    try {
      await holder.query("begin");
      await holder.query("lock table performance_grades in access exclusive mode");
      const pending = createOrder(hold.holdId, userId);
      await waitForLockWaiters(1);

      // 만료가 지난 뒤 다른 사용자가 첫 좌석을 선점한다
      while ((await admin.query("select now() > $1 as passed", [expiry[0]!.at])).rows[0].passed !== true) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const [other] = await newUsers(admin, 1);
      const { rows: taken } = await admin.query<{ id: number }>(
        "insert into holds (user_id, performance_id, expires_at) values ($1, $2, now() + interval '5 minutes') returning id",
        [other, performanceId],
      );
      await admin.query(
        `update performance_seats set hold_id = $1, hold_expires_at = (select expires_at from holds where id = $1)
          where performance_id = $2 and seat_id = $3`,
        [taken[0]!.id, performanceId, hold.seatIds[0]],
      );
      await holder.query("commit");

      expect(conflict(await pending).code).toBe("HOLD_EXPIRED");
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
    expect(await countOrders(hold.holdId)).toBe(0);
  });

  it("선점한 뒤 등급 가격이 사라졌으면 409 PRICE_MISSING이고 주문을 만들지 않는다", async () => {
    const { performanceId, userId, hold } = await newHold(1);
    await admin.query(
      `delete from performance_grades
        where performance_id = $1 and grade = (select grade from seats where id = $2)`,
      [performanceId, hold.seatIds[0]],
    );
    expect(conflict(await createOrder(hold.holdId, userId))).toMatchObject({
      code: "PRICE_MISSING",
      seatIds: hold.seatIds,
    });
    expect(await countOrders(hold.holdId)).toBe(0);
  });

  it("키가 없거나 256자면 400, 없는 사용자 401, 남의 선점과 없는 선점은 404이고, 키 행이 남지 않는다", async () => {
    const { userId, hold } = await newHold();
    const [stranger] = await newUsers(admin, 1);
    const key = randomUUID();
    expect((await createOrder(hold.holdId, userId, null)).statusCode).toBe(400);
    expect((await createOrder(hold.holdId, userId, "k".repeat(256))).statusCode).toBe(400);
    expect((await createOrder(hold.holdId, 999999999, key)).statusCode).toBe(401);
    expect((await createOrder(hold.holdId, stranger!, key)).statusCode).toBe(404);
    expect((await createOrder(999999999, userId, key)).statusCode).toBe(404);
    const { rows } = await admin.query("select count(*) as n from idempotency_keys where key = $1", [key]);
    expect(rows[0].n).toBe(0);
    // 255자는 받는다
    expect((await createOrder(hold.holdId, userId, "k".repeat(255))).statusCode).toBe(201);
  });

  it("GET /orders/:id는 만든 주문과 같은 모양이고, 남의 주문은 404다", async () => {
    const { userId, hold } = await newHold();
    const created = OrderView.parse((await createOrder(hold.holdId, userId)).json());
    const res = await getOrder(created.orderId, userId);
    expect(res.statusCode).toBe(200);
    // 서버 시각만 조회한 때의 것이다
    const { serverTime, ...rest } = OrderView.parse(res.json());
    const { serverTime: createdServerTime, ...createdRest } = created;
    expect(rest).toEqual(createdRest);
    expect(Date.parse(serverTime)).toBeGreaterThanOrEqual(Date.parse(createdServerTime));

    const [stranger] = await newUsers(admin, 1);
    expect((await getOrder(created.orderId, stranger!)).statusCode).toBe(404);
    expect((await getOrder(999999999, userId)).statusCode).toBe(404);
  });

  it("주문 조회의 결제는 최신순(같은 시각이면 id 역순)이고, 표는 유효한 것만 보인다", async () => {
    const { userId, hold } = await newHold(2);
    const created = OrderView.parse((await createOrder(hold.holdId, userId)).json());
    const { rows: paid } = await admin.query<{ id: number }>(
      `insert into payments (order_id, status, amount, idempotency_key, created_at, updated_at)
       values ($1, 'failed', $2, 'a', now() - interval '10 seconds', now() - interval '10 seconds'),
              ($1, 'failed', $2, 'b', now() - interval '10 seconds', now() - interval '10 seconds'),
              ($1, 'refund_pending', $2, 'c', now(), now())
       returning id`,
      [created.orderId, created.amount],
    );
    await admin.query(
      `insert into tickets (order_id, performance_id, seat_id, status)
       values ($1, $2, $3, 'valid'), ($1, $2, $4, 'cancelled')`,
      [created.orderId, created.performanceId, hold.seatIds[0], hold.seatIds[1]],
    );

    const view = OrderView.parse((await getOrder(created.orderId, userId)).json());
    expect(view.payments.map((p) => [p.paymentId, p.status])).toEqual([
      [paid[2]!.id, "refund_pending"],
      [paid[1]!.id, "failed"],
      [paid[0]!.id, "failed"],
    ]);
    expect(view.tickets.map((t) => t.seatId)).toEqual([hold.seatIds[0]]);
  });

  it("선점이 만료된 pending 주문은 정리 작업 전이라도 cancelled(expired)로 보인다", async () => {
    const { userId, hold } = await newHold();
    const created = OrderView.parse((await createOrder(hold.holdId, userId)).json());
    await expireHold(hold.holdId);

    const view = OrderView.parse((await getOrder(created.orderId, userId)).json());
    expect(view).toMatchObject({ status: "cancelled", cancelReason: "expired" });
    const { rows } = await admin.query("select status from orders where id = $1", [created.orderId]);
    expect(rows[0].status).toBe("pending");
  });
});
