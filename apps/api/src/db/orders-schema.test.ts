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

  const insertPayment = (orderId: number, status: string, key = randomUUID()) =>
    pool.query<{ id: number }>(
      "insert into payments (order_id, status, amount, idempotency_key) values ($1, $2, 100000, $3) returning id",
      [orderId, status, key],
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

    it("주문 좌석은 좌석마다 한 번, 가격은 음수가 아니다", async () => {
      const { orderId, held } = await newOrder();
      const insertItem = (seatId: number, price: number) =>
        pool.query("insert into order_items (order_id, seat_id, price) values ($1, $2, $3)", [orderId, seatId, price]);

      await insertItem(held[0]!, 50000);
      await expect(insertItem(held[0]!, 50000)).rejects.toMatchObject({
        code: "23505",
        constraint: "order_items_order_id_seat_id_pk",
      });
      await expect(insertItem(held[1]!, -1)).rejects.toMatchObject({
        code: "23514",
        constraint: "order_items_price_not_negative",
      });
    });
  });

  describe("결제", () => {
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

    it("같은 주문에 같은 멱등 키로 결제 행이 둘 생기지 않는다(23505)", async () => {
      const { orderId } = await newOrder();
      await insertPayment(orderId, "failed", "key-1");
      await expect(insertPayment(orderId, "requested", "key-1")).rejects.toMatchObject({
        code: "23505",
        constraint: "payments_order_idempotency_key_unique",
      });
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

    it("상태는 정한 여섯 가지만 된다(23514)", async () => {
      const { orderId } = await newOrder();
      await expect(insertPayment(orderId, "processing")).rejects.toMatchObject({
        code: "23514",
        constraint: "payments_status_valid",
      });
    });

    // provider_ref가 부분이 아닌 unique면 외래 키가 가리킬 수 있는 열이 되어, 그 열을 바꾸는 UPDATE가 FOR UPDATE 강도로 잠근다.
    // 그러면 외래 키 확인(FOR KEY SHARE)을 쥔 트랜잭션을 기다린다(설계 리뷰 E6). 부분 unique라 기다리지 않아야 한다.
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
    it("모르는 결제의 웹훅도 남길 수 있고(외래 키 없음), 같은 이벤트는 두 번 들어가지 않는다", async () => {
      const eventId = `evt_${randomUUID()}`;
      const insert = () =>
        pool.query(
          "insert into payment_webhooks (event_id, payment_id, type, result, body) values ($1, 999999999, 'payment.succeeded', 'unmatched', '{}')",
          [eventId],
        );
      await expect(insert()).resolves.toMatchObject({ rowCount: 1 });
      await expect(insert()).rejects.toMatchObject({ code: "23505", constraint: "payment_webhooks_pkey" });
    });
  });

  describe("표", () => {
    it("한 좌석에 유효한 표는 하나다(23505). 취소된 표는 여럿이어도 된다", async () => {
      const { orderId, performanceId, held } = await newOrder();
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
    });

    it("회차에 없는 좌석으로는 표를 만들 수 없다(23503)", async () => {
      const { orderId, performanceId } = await newOrder();
      await expect(
        pool.query("insert into tickets (order_id, performance_id, seat_id) values ($1, $2, 999999999)", [
          orderId,
          performanceId,
        ]),
      ).rejects.toMatchObject({ code: "23503", constraint: "tickets_performance_seat_fk" });
    });
  });

  describe("멱등 키", () => {
    async function insertKey(values: { userId: number; key?: string; status?: string; code?: number | null }) {
      return pool.query(
        `insert into idempotency_keys (user_id, route, key, request_hash, status, owner_token, response_code, response_body)
         values ($1, 'POST /orders/:id/payments', $2, 'hash', $3, $4, $5, $6)`,
        [
          values.userId,
          values.key ?? randomUUID(),
          values.status ?? "processing",
          randomUUID(),
          values.code ?? null,
          values.code == null ? null : JSON.stringify({ ok: true }),
        ],
      );
    }

    it("사용자·경로·키가 같으면 하나다(23505). 다른 사용자는 같은 키를 써도 된다", async () => {
      const [a, b] = await newUsers(pool, 2);
      await insertKey({ userId: a!, key: "same" });
      await expect(insertKey({ userId: a!, key: "same" })).rejects.toMatchObject({
        code: "23505",
        constraint: "idempotency_keys_user_id_route_key_pk",
      });
      await expect(insertKey({ userId: b!, key: "same" })).resolves.toMatchObject({ rowCount: 1 });
    });

    it("끝난 키에만 응답이 있고, 키는 1~255자다(23514)", async () => {
      const [userId] = await newUsers(pool, 1);
      await expect(insertKey({ userId: userId!, status: "done", code: null })).rejects.toMatchObject({
        code: "23514",
        constraint: "idempotency_keys_response_matches_status",
      });
      await expect(insertKey({ userId: userId!, status: "processing", code: 201 })).rejects.toMatchObject({
        code: "23514",
        constraint: "idempotency_keys_response_matches_status",
      });
      await expect(insertKey({ userId: userId!, key: "" })).rejects.toMatchObject({
        code: "23514",
        constraint: "idempotency_keys_key_length",
      });
      await expect(insertKey({ userId: userId!, key: "k".repeat(256) })).rejects.toMatchObject({
        code: "23514",
        constraint: "idempotency_keys_key_length",
      });
      await expect(insertKey({ userId: userId!, status: "done", code: 201 })).resolves.toMatchObject({ rowCount: 1 });
    });
  });
});
