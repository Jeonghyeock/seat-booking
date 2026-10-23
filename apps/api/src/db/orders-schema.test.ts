import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, inject, it } from "vitest";
import { newPerformance, newUsers } from "../../test/fixtures.js";
import { createPool } from "./pool.js";

// 3단계 표(주문, 결제, 웹훅, 표, 멱등 키)의 제약. 앱 코드가 틀려도 DB가 막아야 하는 것들이다(DESIGN 5장·6.2).
// check 제약이 여럿이면 PostgreSQL은 이름의 알파벳 순서로 검사한다. 어느 제약에 걸렸는지 이름까지 확인한다.
describe("3단계 표의 제약", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  afterAll(() => pool.end());

  // 회차 하나, 사용자 하나, 그 사용자의 선점 하나(좌석 두 개를 쥠)
  async function newHold() {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [userId] = await newUsers(pool, 1);
    const { rows } = await pool.query<{ id: number }>(
      "insert into holds (user_id, performance_id, expires_at) values ($1, $2, now() + interval '5 minutes') returning id",
      [userId, performanceId],
    );
    const holdId = rows[0]!.id;
    const held = seatIds.slice(0, 2);
    await pool.query(
      `update performance_seats set status = 'held', hold_id = $3, hold_expires_at = now() + interval '5 minutes'
        where performance_id = $1 and seat_id = any($2::bigint[])`,
      [performanceId, held, holdId],
    );
    return { performanceId, seatIds, userId: userId!, holdId, held };
  }

  async function newOrder() {
    const hold = await newHold();
    const { rows } = await pool.query<{ id: number }>(
      "insert into orders (user_id, hold_id, amount) values ($1, $2, 100000) returning id",
      [hold.userId, hold.holdId],
    );
    return { ...hold, orderId: rows[0]!.id };
  }

  const insertItem = (orderId: number, seatId: number, price = 50000) =>
    pool.query("insert into order_items (order_id, seat_id, price) values ($1, $2, $3)", [orderId, seatId, price]);

  const insertPayment = (orderId: number, status: string, key = randomUUID(), amount = 100000) =>
    pool.query<{ id: number }>(
      "insert into payments (order_id, status, amount, idempotency_key) values ($1, $2, $3, $4) returning id",
      [orderId, status, amount, key],
    );

  describe("주문", () => {
    it("선점 하나에 주문 하나다(23505)", async () => {
      const { userId, holdId } = await newOrder();
      await expect(
        pool.query("insert into orders (user_id, hold_id, amount) values ($1, $2, 0)", [userId, holdId]),
      ).rejects.toMatchObject({ code: "23505", constraint: "orders_hold_id_unique" });
    });

    it("상태는 pending·paid·cancelled만, 취소 이유는 취소된 주문에만 있다(23514)", async () => {
      const { orderId } = await newOrder();
      const update = (status: string, reason: string | null) =>
        pool.query("update orders set status = $2, cancel_reason = $3 where id = $1", [orderId, status, reason]);

      await expect(update("refunded", null)).rejects.toMatchObject({ code: "23514", constraint: "orders_status_valid" });
      await expect(update("cancelled", null)).rejects.toMatchObject({
        code: "23514",
        constraint: "orders_cancel_reason_matches_status",
      });
      await expect(update("paid", "user")).rejects.toMatchObject({
        code: "23514",
        constraint: "orders_cancel_reason_matches_status",
      });
      await expect(update("cancelled", "timeout")).rejects.toMatchObject({
        code: "23514",
        constraint: "orders_cancel_reason_valid",
      });
      await expect(update("cancelled", "expired")).resolves.toMatchObject({ rowCount: 1 });
    });

    it("금액은 음수가 아니다(23514)", async () => {
      const { orderId } = await newOrder();
      await expect(pool.query("update orders set amount = -1 where id = $1", [orderId])).rejects.toMatchObject({
        code: "23514",
        constraint: "orders_amount_not_negative",
      });
    });

    it("주문 좌석은 좌석마다 한 번, 가격은 음수가 아니다", async () => {
      const { orderId, held } = await newOrder();
      await insertItem(orderId, held[0]!);
      await expect(insertItem(orderId, held[0]!)).rejects.toMatchObject({
        code: "23505",
        constraint: "order_items_order_id_seat_id_pk",
      });
      await expect(insertItem(orderId, held[1]!, -1)).rejects.toMatchObject({
        code: "23514",
        constraint: "order_items_price_not_negative",
      });
    });
  });

  describe("결제", () => {
    it("상태 여섯 가지가 모두 들어가고, 그 밖은 안 된다(23514)", async () => {
      const { orderId } = await newOrder();
      for (const status of ["requested", "succeeded", "failed", "refund_pending", "refunded", "refund_failed"]) {
        await expect(insertPayment(orderId, status)).resolves.toMatchObject({ rowCount: 1 });
      }
      await expect(insertPayment(orderId, "processing")).rejects.toMatchObject({
        code: "23514",
        constraint: "payments_status_valid",
      });
    });

    it("금액과 환불 시도 횟수는 음수가 아니다(23514)", async () => {
      const { orderId } = await newOrder();
      await expect(insertPayment(orderId, "failed", randomUUID(), -1)).rejects.toMatchObject({
        code: "23514",
        constraint: "payments_amount_not_negative",
      });
      const payment = await insertPayment(orderId, "refund_pending");
      await expect(
        pool.query("update payments set refund_attempts = -1 where id = $1", [payment.rows[0]!.id]),
      ).rejects.toMatchObject({ code: "23514", constraint: "payments_refund_attempts_not_negative" });
    });

    it("진행 중인 결제와 성공한 결제는 주문마다 하나다(23505). 실패한 결제는 여럿이어도 된다", async () => {
      const { orderId } = await newOrder();
      const first = await insertPayment(orderId, "requested");
      await expect(insertPayment(orderId, "requested")).rejects.toMatchObject({
        code: "23505",
        constraint: "payments_one_requested_per_order",
      });

      await pool.query("update payments set status = 'succeeded' where id = $1", [first.rows[0]!.id]);
      await expect(insertPayment(orderId, "succeeded")).rejects.toMatchObject({
        code: "23505",
        constraint: "payments_one_succeeded_per_order",
      });

      await insertPayment(orderId, "failed");
      await expect(insertPayment(orderId, "failed")).resolves.toMatchObject({ rowCount: 1 });
    });

    it("같은 주문에 같은 멱등 키로 결제 행이 둘 생기지 않는다(23505). 다른 주문은 같은 키를 써도 된다", async () => {
      const a = await newOrder();
      const b = await newOrder();
      await insertPayment(a.orderId, "failed", "key-1");
      await expect(insertPayment(a.orderId, "requested", "key-1")).rejects.toMatchObject({
        code: "23505",
        constraint: "payments_order_idempotency_key_unique",
      });
      await expect(insertPayment(b.orderId, "requested", "key-1")).resolves.toMatchObject({ rowCount: 1 });
    });

    it("결제사 결제 번호는 비어 있는 행이 여럿이어도 되고, 채운 값은 겹치지 않는다(23505)", async () => {
      const a = await newOrder();
      const b = await newOrder();
      const pa = await insertPayment(a.orderId, "requested");
      const pb = await insertPayment(b.orderId, "requested");
      const setRef = (id: number, ref: string) => pool.query("update payments set provider_ref = $2 where id = $1", [id, ref]);

      await setRef(pa.rows[0]!.id, "fake_ref_1");
      await expect(setRef(pb.rows[0]!.id, "fake_ref_1")).rejects.toMatchObject({
        code: "23505",
        constraint: "payments_provider_ref_unique",
      });
    });

    // provider_ref가 부분이 아닌 unique면 외래 키가 가리킬 수 있는 열이 되어, 그 열을 바꾸는 UPDATE가 FOR UPDATE 강도로 잠근다.
    // 그러면 외래 키 확인(FOR KEY SHARE)을 쥔 트랜잭션을 기다린다(설계 리뷰 E6). 부분 unique라 기다리지 않아야 한다.
    // 지금 payments를 가리키는 외래 키는 없지만, 앞으로 생겨도 이 성질이 남게 한다.
    it("결제사 결제 번호를 채우는 UPDATE는 외래 키 확인 잠금(FOR KEY SHARE)을 기다리지 않는다", async () => {
      const { orderId } = await newOrder();
      const payment = await insertPayment(orderId, "requested");
      const paymentId = payment.rows[0]!.id;

      const holder = await pool.connect();
      const writer = await pool.connect();
      try {
        await holder.query("begin");
        await holder.query("select 1 from payments where id = $1 for key share", [paymentId]);
        await writer.query("begin");
        await writer.query("set local lock_timeout = '500ms'");
        await expect(
          writer.query("update payments set provider_ref = $2 where id = $1", [paymentId, `fake_${randomUUID()}`]),
        ).resolves.toMatchObject({ rowCount: 1 });
        await writer.query("commit");
      } finally {
        await writer.query("rollback").catch(() => {});
        await holder.query("rollback");
        writer.release();
        holder.release();
      }
    });
  });

  describe("웹훅", () => {
    it("결과를 적기 전에는 received이고, 모르는 결제의 웹훅도 남길 수 있으며(외래 키 없음), 같은 이벤트는 두 번 들어가지 않는다", async () => {
      const eventId = `evt_${randomUUID()}`;
      const insert = () =>
        pool.query<{ result: string }>(
          "insert into payment_webhooks (event_id, payment_id, type, body) values ($1, 999999999, 'payment.succeeded', '{}') returning result",
          [eventId],
        );
      await expect(insert()).resolves.toMatchObject({ rows: [{ result: "received" }] });
      await expect(insert()).rejects.toMatchObject({ code: "23505", constraint: "payment_webhooks_pkey" });
      await expect(
        pool.query("update payment_webhooks set result = 'done' where event_id = $1", [eventId]),
      ).rejects.toMatchObject({ code: "23514", constraint: "payment_webhooks_result_valid" });
    });
  });

  describe("표", () => {
    it("한 좌석에 유효한 표는 하나다(23505). 취소된 표는 여럿이어도 되고, 그 밖의 상태는 안 된다", async () => {
      const { orderId, performanceId, held } = await newOrder();
      await insertItem(orderId, held[0]!);
      const insertTicket = (status: string) =>
        pool.query("insert into tickets (order_id, performance_id, seat_id, status) values ($1, $2, $3, $4)", [
          orderId,
          performanceId,
          held[0],
          status,
        ]);

      await insertTicket("valid");
      await expect(insertTicket("valid")).rejects.toMatchObject({
        code: "23505",
        constraint: "tickets_one_valid_per_seat",
      });
      await insertTicket("cancelled");
      await expect(insertTicket("cancelled")).resolves.toMatchObject({ rowCount: 1 });
      await expect(insertTicket("used")).rejects.toMatchObject({ code: "23514", constraint: "tickets_status_valid" });
    });

    it("이 회차에 없는 좌석(다른 공연장의 실제 좌석)으로는 표를 만들 수 없다(23503)", async () => {
      const { orderId, performanceId } = await newOrder();
      const other = await newPerformance(pool); // 다른 공연장
      const foreignSeat = other.seatIds[0]!;
      await insertItem(orderId, foreignSeat); // 주문 좌석 외래 키는 통과하게 해 두고, 회차 좌석 외래 키만 본다
      await expect(
        pool.query("insert into tickets (order_id, performance_id, seat_id) values ($1, $2, $3)", [
          orderId,
          performanceId,
          foreignSeat,
        ]),
      ).rejects.toMatchObject({ code: "23503", constraint: "tickets_performance_seat_fk" });
    });

    it("주문에 없는 좌석으로는 표를 만들 수 없다(23503)", async () => {
      const { orderId, performanceId, held } = await newOrder();
      await insertItem(orderId, held[0]!);
      await expect(
        pool.query("insert into tickets (order_id, performance_id, seat_id) values ($1, $2, $3)", [
          orderId,
          performanceId,
          held[1],
        ]),
      ).rejects.toMatchObject({ code: "23503", constraint: "tickets_order_item_fk" });
    });
  });

  describe("멱등 키", () => {
    type KeyRow = { userId: number; route?: string; key?: string; status?: string; code?: number | null; body?: unknown };
    function insertKey(values: KeyRow) {
      const body = "body" in values ? values.body : values.code == null ? null : { ok: true };
      return pool.query(
        `insert into idempotency_keys (user_id, route, key, request_hash, status, owner_token, response_code, response_body)
         values ($1, $2, $3, 'hash', $4, $5, $6, $7)`,
        [
          values.userId,
          values.route ?? "POST /orders/:id/payments",
          values.key ?? randomUUID(),
          values.status ?? "processing",
          randomUUID(),
          values.code ?? null,
          body == null ? null : JSON.stringify(body),
        ],
      );
    }

    it("사용자·경로·키가 같으면 하나다(23505). 다른 사용자나 다른 경로는 같은 키를 써도 된다", async () => {
      const [a, b] = await newUsers(pool, 2);
      await insertKey({ userId: a!, key: "same" });
      await expect(insertKey({ userId: a!, key: "same" })).rejects.toMatchObject({
        code: "23505",
        constraint: "idempotency_keys_user_id_route_key_pk",
      });
      await expect(insertKey({ userId: b!, key: "same" })).resolves.toMatchObject({ rowCount: 1 });
      await expect(insertKey({ userId: a!, key: "same", route: "POST /holds/:id/orders" })).resolves.toMatchObject({
        rowCount: 1,
      });
    });

    it("끝난 키에만 응답이 있고, 응답은 상태 코드와 본문이 함께 있다(23514)", async () => {
      const [userId] = await newUsers(pool, 1);
      const u = userId!;
      await expect(insertKey({ userId: u, status: "done", code: null })).rejects.toMatchObject({
        code: "23514",
        constraint: "idempotency_keys_response_matches_status",
      });
      await expect(insertKey({ userId: u, status: "processing", code: 201 })).rejects.toMatchObject({
        code: "23514",
        constraint: "idempotency_keys_response_matches_status",
      });
      // 응답 반쪽(코드만, 본문만)은 처리 중이든 끝났든 안 된다
      await expect(insertKey({ userId: u, status: "processing", code: 201, body: null })).rejects.toMatchObject({
        code: "23514",
        constraint: "idempotency_keys_response_fields_together",
      });
      await expect(insertKey({ userId: u, status: "processing", code: null, body: { ok: true } })).rejects.toMatchObject({
        code: "23514",
        constraint: "idempotency_keys_response_fields_together",
      });
      await expect(insertKey({ userId: u, status: "done", code: 201, body: null })).rejects.toMatchObject({
        code: "23514",
        constraint: "idempotency_keys_response_fields_together",
      });
      await expect(insertKey({ userId: u, status: "done", code: 201 })).resolves.toMatchObject({ rowCount: 1 });
    });

    it("상태는 processing·done만, 키는 1~255자다(23514)", async () => {
      const [userId] = await newUsers(pool, 1);
      const u = userId!;
      await expect(insertKey({ userId: u, status: "failed" })).rejects.toMatchObject({
        code: "23514",
        constraint: "idempotency_keys_status_valid",
      });
      await expect(insertKey({ userId: u, key: "" })).rejects.toMatchObject({
        code: "23514",
        constraint: "idempotency_keys_key_length",
      });
      await expect(insertKey({ userId: u, key: "k".repeat(256) })).rejects.toMatchObject({
        code: "23514",
        constraint: "idempotency_keys_key_length",
      });
      await expect(insertKey({ userId: u, key: "k".repeat(255) })).resolves.toMatchObject({ rowCount: 1 });
    });
  });
});
