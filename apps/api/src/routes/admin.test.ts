import { randomUUID } from "node:crypto";
import {
  AuthError,
  HoldResponse,
  OrderView,
  PaymentNotRetryable,
  PerformanceSales,
  RefundFailedPayments,
  SeatMap,
} from "@seat-booking/shared";
import { afterAll, describe, expect, inject, it } from "vitest";
import {
  authHeaders,
  expectUnauthenticated,
  newPerformance,
  newSignedInUserIds,
  newSignedInUsers,
  unauthenticatedHeaders,
} from "../../test/fixtures.js";
import { REFUND_FAILED_PAGE_SIZE } from "../admin.js";
import { buildApp } from "../app.js";
import { createPool } from "../db/pool.js";

describe("관리자 경로", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  // 관리자가 환불을 다시 시도하게 한 기록을 로그에서 확인한다.
  const logs: Record<string, unknown>[] = [];
  const app = buildApp(pool, { logger: { level: "info", stream: { write: (line: string) => logs.push(JSON.parse(line)) } } });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });
  const post = (url: string, headers: Record<string, string>) => app.inject({ method: "POST", url, headers });
  const newAdmin = async () => (await newSignedInUsers(pool, 1, { role: "admin" }))[0]!;

  it("/admin 경로는 모두 관리자 범위에 있다. 로그인하지 않았으면 401, 손님이면 403 FORBIDDEN이다(HEAD도)", async () => {
    await app.ready();
    const listed = (routes: { method: string; url: string }[]) => routes.map((r) => `${r.method} ${r.url}`).sort();
    // 범위 밖에 /admin 경로를 잘못 등록하면(권한 확인 없이 열림) 여기서 걸린다.
    const everyAdminUrl = app.allRoutes.filter((r) => r.url === "/admin" || r.url.startsWith("/admin/"));
    expect(listed(app.adminRoutes)).toEqual(listed(everyAdminUrl));
    expect(listed(app.adminRoutes)).toEqual([
      "GET /admin/payments",
      "GET /admin/performances/:id/sales",
      "POST /admin/payments/:id/retry-refund",
    ]);

    const anonymous = await unauthenticatedHeaders(pool);
    const [customer] = await newSignedInUsers(pool, 1);
    for (const route of app.adminRoutes) {
      const url = route.url.replace(/:id/g, "1");
      const methods = (route.method === "GET" ? ["GET", "HEAD"] : [route.method]) as ("GET" | "HEAD" | "POST")[];
      for (const method of methods) {
        for (const [name, headers] of Object.entries(anonymous)) {
          const res = await app.inject({ method, url, headers });
          if (method === "HEAD") expect(res.statusCode, `${method} ${url} ${name}`).toBe(401);
          else expectUnauthenticated(res, `${name}`);
        }
        const forbidden = await app.inject({ method, url, headers: customer!.headers });
        expect(forbidden.statusCode, `${method} ${url}`).toBe(403);
        expect(forbidden.headers["cache-control"], url).toBe("no-store");
        if (method !== "HEAD") expect(AuthError.parse(forbidden.json()).code, url).toBe("FORBIDDEN");
      }
    }
  });

  it("역할은 요청마다 읽는다. 관리자에서 내리면 다음 요청부터 403이다", async () => {
    const admin = await newAdmin();
    expect((await get("/admin/payments?status=refund_failed", admin.headers)).statusCode).toBe(200);
    await pool.query("update users set role = 'customer' where id = $1", [admin.id]);
    expect((await get("/admin/payments?status=refund_failed", admin.headers)).statusCode).toBe(403);
  });

  // 선점하고 주문까지 만든다.
  async function newOrder(performanceId: number, userId: number, seatIds: number[]) {
    const hold = HoldResponse.parse(
      (
        await app.inject({
          method: "POST",
          url: `/performances/${performanceId}/holds`,
          headers: authHeaders(userId),
          payload: { seatIds },
        })
      ).json(),
    );
    return OrderView.parse(
      (
        await app.inject({
          method: "POST",
          url: `/holds/${hold.holdId}/orders`,
          headers: { ...authHeaders(userId), "idempotency-key": randomUUID() },
        })
      ).json(),
    );
  }
  const insertPayment = async (orderId: number, status: string, amount: number) =>
    (
      await pool.query(
        "insert into payments (order_id, status, amount, idempotency_key, refund_attempts) values ($1, $2, $3, $4, $5) returning id",
        [orderId, status, amount, randomUUID(), status === "refund_failed" ? 5 : 0],
      )
    ).rows[0].id as number;

  // 결제 확정(웹훅 대신 행을 바로 바꾼다).
  async function markPaid(order: OrderView) {
    await pool.query("update orders set status = 'paid' where id = $1", [order.orderId]);
    await pool.query("update performance_seats set status = 'sold' where hold_id = $1", [order.holdId]);
    await insertPayment(order.orderId, "succeeded", order.amount);
  }

  it("판매 현황은 좌석·주문·매출·결제를 센다. 좌석 지도·주문 조회와 같은 기준이고 다른 회차는 세지 않는다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [a, b, c, d, e] = await newSignedInUserIds(pool, 5);
    const active = await newOrder(performanceId, a!, seatIds.slice(0, 2));
    const expired = await newOrder(performanceId, b!, seatIds.slice(2, 3));
    const paid = await newOrder(performanceId, c!, seatIds.slice(3, 6));
    const cancelled = await newOrder(performanceId, d!, seatIds.slice(6, 7));

    // 선점 만료(정리 작업은 아직 돌지 않았다)
    await pool.query("update holds set expires_at = now() - interval '1 second' where id = $1", [expired.holdId]);
    await pool.query("update performance_seats set hold_expires_at = now() - interval '1 second' where hold_id = $1", [
      expired.holdId,
    ]);
    await markPaid(paid);
    // 사용자 취소, 그 뒤 늦게 성공한 결제의 환불이 실패했다
    expect((await post(`/orders/${cancelled.orderId}/cancel`, authHeaders(d))).statusCode).toBe(200);
    await insertPayment(cancelled.orderId, "refund_failed", cancelled.amount);
    await insertPayment(active.orderId, "failed", active.amount);

    // 다른 회차의 판매는 세지 않는다
    const other = await newPerformance(pool);
    const otherOrder = await newOrder(other.performanceId, e!, other.seatIds.slice(0, 4));
    await markPaid(otherOrder);
    await insertPayment(otherOrder.orderId, "refund_pending", otherOrder.amount);

    const res = await get(`/admin/performances/${performanceId}/sales`, (await newAdmin()).headers);
    expect(res.statusCode).toBe(200);
    const sales = PerformanceSales.parse(res.json());
    expect(sales).toEqual({
      performance: expect.objectContaining({ id: performanceId, showTitle: expect.any(String), venueName: expect.any(String) }),
      seats: { total: seatIds.length, available: seatIds.length - 5, held: 2, sold: 3 },
      orders: { pending: 1, paid: 1, cancelled: 2 },
      revenue: paid.amount,
      payments: { requested: 0, succeeded: 1, failed: 1, refund_pending: 0, refunded: 0, refund_failed: 1 },
      serverTime: expect.any(String),
    });
    expect(Math.abs(Date.parse(sales.serverTime) - Date.now())).toBeLessThan(60_000);

    // 좌석 지도의 상태별 수, 주문 조회의 상태와 같다
    const seatMap = SeatMap.parse((await get(`/performances/${performanceId}/seats`, {})).json());
    const byStatus = (status: string) => seatMap.seats.filter((s) => s.status === status).length;
    expect({ available: byStatus("available"), held: byStatus("held"), sold: byStatus("sold") }).toEqual({
      available: sales.seats.available,
      held: sales.seats.held,
      sold: sales.seats.sold,
    });
    const shown = [];
    for (const [order, user] of [[active, a], [expired, b], [paid, c], [cancelled, d]] as const) {
      shown.push(OrderView.parse((await get(`/orders/${order.orderId}`, authHeaders(user))).json()).status);
    }
    expect({
      pending: shown.filter((s) => s === "pending").length,
      paid: shown.filter((s) => s === "paid").length,
      cancelled: shown.filter((s) => s === "cancelled").length,
    }).toEqual(sales.orders);
  });

  it("판매가 없는 회차는 모두 0이고, 없는 회차는 404다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const admin = await newAdmin();
    const sales = PerformanceSales.parse((await get(`/admin/performances/${performanceId}/sales`, admin.headers)).json());
    expect(sales.seats).toEqual({ total: seatIds.length, available: seatIds.length, held: 0, sold: 0 });
    expect(sales.orders).toEqual({ pending: 0, paid: 0, cancelled: 0 });
    expect(sales.revenue).toBe(0);
    expect(Object.values(sales.payments).every((n) => n === 0)).toBe(true);
    expect((await get("/admin/performances/999999999/sales", admin.headers)).statusCode).toBe(404);
  });

  it("환불 실패 목록은 최근 바뀐 것부터 100개와 hasMore이고, 결제사 번호·주문 상태·회차·사용자 이메일·시도 횟수를 준다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [buyer] = await newSignedInUserIds(pool, 1);
    const order = await newOrder(performanceId, buyer!, seatIds.slice(0, 1));
    // 이 테스트의 결제가 맨 앞에 오게 바뀐 시각을 미래로 둔다(다른 테스트의 환불 실패와 섞이지 않게)
    await pool.query(
      `insert into payments (order_id, status, amount, idempotency_key, refund_attempts, provider_ref, updated_at)
       select $1, 'refund_failed', $2, gen_random_uuid()::text, 5, gen_random_uuid()::text,
              now() + interval '1 day' + g * interval '1 second'
         from generate_series(1, $3) g`,
      [order.orderId, order.amount, REFUND_FAILED_PAGE_SIZE + 1],
    );
    const { rows } = await pool.query(
      "select id, provider_ref from payments where order_id = $1 order by updated_at desc limit 1",
      [order.orderId],
    );
    const { rows: users } = await pool.query("select email from users where id = $1", [buyer]);

    const admin = await newAdmin();
    const res = await get("/admin/payments?status=refund_failed", admin.headers);
    expect(res.statusCode).toBe(200);
    const list = RefundFailedPayments.parse(res.json());
    expect(list.payments).toHaveLength(REFUND_FAILED_PAGE_SIZE);
    expect(list.hasMore).toBe(true);
    expect(list.payments[0]).toMatchObject({
      paymentId: rows[0].id,
      providerRef: rows[0].provider_ref,
      orderId: order.orderId,
      orderStatus: "pending",
      performanceId,
      userId: buyer,
      email: users[0].email,
      amount: order.amount,
      refundAttempts: 5,
    });
    const times = list.payments.map((p) => Date.parse(p.updatedAt));
    expect(times).toEqual([...times].sort((x, y) => y - x));

    expect((await get("/admin/payments?status=refunded", admin.headers)).statusCode).toBe(400);
    expect((await get("/admin/payments", admin.headers)).statusCode).toBe(400);
  });

  it("환불 다시 시도는 refund_failed를 refund_pending·시도 0으로 바꾸고 로그에 남긴다. 두 번 눌러도 200이고 changed로 나뉜다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [buyer] = await newSignedInUserIds(pool, 1);
    const order = await newOrder(performanceId, buyer!, seatIds.slice(0, 1));
    const paymentId = await insertPayment(order.orderId, "refund_failed", order.amount);
    const admin = await newAdmin();

    for (const changed of [true, false]) {
      const res = await post(`/admin/payments/${paymentId}/retry-refund`, admin.headers);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ paymentId, status: "refund_pending", changed });
    }
    const { rows } = await pool.query("select status, refund_attempts from payments where id = $1", [paymentId]);
    expect(rows[0]).toEqual({ status: "refund_pending", refund_attempts: 0 });
    const logged = logs.filter((line) => line.msg === "관리자: 환불 다시 시도" && line.paymentId === paymentId);
    expect(logged.map((line) => [line.adminId, line.result])).toEqual([
      [admin.id, { ok: true, changed: true }],
      [admin.id, { ok: true, changed: false }],
    ]);
  });

  it("환불이 실패하지 않은 결제는 409 PAYMENT_NOT_RETRYABLE과 지금 상태이고, 없는 결제는 404다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [buyer] = await newSignedInUserIds(pool, 1);
    const order = await newOrder(performanceId, buyer!, seatIds.slice(0, 1));
    const paymentId = await insertPayment(order.orderId, "succeeded", order.amount);
    const admin = await newAdmin();

    const res = await post(`/admin/payments/${paymentId}/retry-refund`, admin.headers);
    expect(res.statusCode).toBe(409);
    expect(PaymentNotRetryable.parse(res.json())).toMatchObject({ code: "PAYMENT_NOT_RETRYABLE", status: "succeeded" });
    const { rows } = await pool.query("select status from payments where id = $1", [paymentId]);
    expect(rows[0].status).toBe("succeeded");
    expect((await post("/admin/payments/999999999/retry-refund", admin.headers)).statusCode).toBe(404);
  });
});
