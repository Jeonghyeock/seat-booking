import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { findSessionUser } from "../auth.js";
import { createDb } from "../db/client.js";
import { createPool } from "../db/pool.js";
import { checkInvariants, checkLeftovers, compareClientPaid, compareProvider, seatCounts } from "./checks.js";
import { historyLayout, type LoadData, type LoadShape, LOAD_SHAPE, seedLoadData } from "./data.js";

// 40석, S3 회차 3개, 지난 회차 10개, 사용자 20명, 미리 판 좌석 20석(5명), 지난 주문 100건.
const SMALL: LoadShape = {
  sections: 4,
  rowsPerSection: 2,
  seatsPerRow: 5,
  s3Performances: 3,
  pastPerformances: 10,
  users: 20,
  presoldSeats: 20,
  historicalOrders: 100,
};

describe("부하 데이터", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  let data: LoadData;
  let all: number[];
  const one = async <R extends pg.QueryResultRow>(text: string, params: unknown[] = []) => (await pool.query<R>(text, params)).rows[0]!;
  // 한 트랜잭션 안에서 데이터를 일부러 깨뜨리고 확인한 뒤 되돌린다(다른 테스트가 같은 데이터를 쓴다).
  const broken = async (corrupt: (client: pg.PoolClient) => Promise<unknown>) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await corrupt(client);
      return { ...(await checkInvariants(client, all)), ...(await checkLeftovers(client, all)) };
    } finally {
      await client.query("rollback");
      client.release();
    }
  };
  const nonZero = (counts: Record<string, number>) => Object.keys(counts).filter((k) => counts[k] !== 0).sort();

  beforeAll(async () => {
    const client = await pool.connect();
    try {
      data = await seedLoadData(client, SMALL, { now: new Date(), tag: randomUUID() });
    } finally {
      client.release();
    }
    all = [data.s1PerformanceId, ...data.s3PerformanceIds, ...data.pastPerformanceIds];
  });
  afterAll(() => pool.end());

  it("기본 크기는 2,000석·회차 200개·사용자 5,000명·지난 주문 5만 건이고, 나눠 넣을 수 있다", () => {
    expect(LOAD_SHAPE.sections * LOAD_SHAPE.rowsPerSection * LOAD_SHAPE.seatsPerRow).toBe(2000);
    expect(1 + LOAD_SHAPE.s3Performances + LOAD_SHAPE.pastPerformances).toBe(200);
    expect(historyLayout(LOAD_SHAPE)).toEqual({ seatCount: 2000, groups: 10 });
    expect(() => historyLayout({ ...LOAD_SHAPE, pastPerformances: 99 })).toThrow();
    expect(() => historyLayout({ ...LOAD_SHAPE, presoldSeats: 1001 })).toThrow();
    expect(() => historyLayout({ ...LOAD_SHAPE, presoldSeats: 1004 })).toThrow();
  });

  it("좌석·회차·재고·사용자·세션을 넣는다. 세션 토큰으로 그 사용자를 찾는다", async () => {
    expect(data.seatIds).toHaveLength(40);
    expect(data.s3PerformanceIds).toHaveLength(3);
    expect(data.pastPerformanceIds).toHaveLength(10);
    expect(data.userIds).toHaveLength(20);
    expect(data.buyerIds).toHaveLength(5);
    expect(Number((await one("select count(*) from performance_seats where performance_id = any($1)", [all])).count)).toBe(40 * 14);
    const db = createDb(pool);
    for (const i of [0, 19]) expect((await findSessionUser(db, data.tokens[i]!))?.id).toBe(data.userIds[i]);
  });

  it("판매 기간: S1은 판매 전, S3는 판매 중, 지난 회차는 공연이 끝났다", async () => {
    const window = (id: number) =>
      one<{ open: boolean; closed: boolean; started: boolean }>(
        "select sales_open_at <= now() as open, sales_close_at <= now() as closed, starts_at <= now() as started from performances where id = $1",
        [id],
      );
    expect(await window(data.s1PerformanceId)).toEqual({ open: false, closed: false, started: false });
    for (const id of data.s3PerformanceIds) expect(await window(id)).toEqual({ open: true, closed: false, started: false });
    for (const id of data.pastPerformanceIds) expect(await window(id)).toEqual({ open: true, closed: true, started: true });
  });

  it("S1은 홀수 번째 좌석을 미리 팔고, S3는 비어 있다", async () => {
    expect(await seatCounts(pool, data.s1PerformanceId)).toEqual({ available: 20, held: 0, sold: 20 });
    const { rows } = await pool.query<{ seat_id: number }>(
      "select seat_id from performance_seats where performance_id = $1 and status = 'sold' order by seat_id",
      [data.s1PerformanceId],
    );
    expect(rows.map((r) => r.seat_id)).toEqual(data.seatIds.filter((_, i) => i % 2 === 1));
    for (const id of data.s3PerformanceIds) expect(await seatCounts(pool, id)).toEqual({ available: 40, held: 0, sold: 0 });
  });

  it("지난 주문은 끝난 상태만이고, 사용자마다 회차당 4석 이하다", async () => {
    const orders = await pool.query<{ status: string; cancel_reason: string | null; count: string }>(
      `select o.status, o.cancel_reason, count(*) from orders o join holds h on h.id = o.hold_id
        where h.performance_id = any($1) group by 1, 2 order by 1, 2`,
      [data.pastPerformanceIds],
    );
    expect(orders.rows.map((r) => [r.status, r.cancel_reason, Number(r.count)])).toEqual([
      ["cancelled", "expired", 20],
      ["cancelled", "user", 10],
      ["paid", null, 70],
    ]);
    const payments = await pool.query<{ status: string }>(
      `select distinct p.status from payments p join orders o on o.id = p.order_id join holds h on h.id = o.hold_id
        where h.performance_id = any($1) order by 1`,
      [all],
    );
    expect(payments.rows.map((r) => r.status)).toEqual(["failed", "refund_failed", "refunded", "succeeded"]);
  });

  it("넣은 데이터는 C2 불변식과 남은 일이 모두 0이다", async () => {
    const invariants = await checkInvariants(pool, all);
    const leftovers = await checkLeftovers(pool, all);
    expect(nonZero(invariants)).toEqual([]);
    expect(nonZero(leftovers)).toEqual([]);
    expect(Object.keys(invariants)).toHaveLength(8);
  });

  it("불변식이 깨지면 그 확인이 잡는다", async () => {
    const seat = async (client: pg.PoolClient, status: string) =>
      (
        await client.query<{ seat_id: number; hold_id: number }>(
          "select seat_id, hold_id from performance_seats where performance_id = $1 and status = $2 order by seat_id limit 2",
          [data.s1PerformanceId, status],
        )
      ).rows;
    // 팔린 좌석을 빈 좌석으로 되돌림.
    expect(
      nonZero(
        await broken(async (c) => {
          const [s] = await seat(c, "sold");
          await c.query(
            "update performance_seats set status = 'available', hold_id = null, hold_expires_at = null where performance_id = $1 and seat_id = $2",
            [data.s1PerformanceId, s!.seat_id],
          );
        }),
      ),
    ).toEqual(["paidOrderBroken", "validTicketNotSold"]);
    // 표를 취소함.
    expect(
      nonZero(
        await broken((c) =>
          c.query("update tickets set status = 'cancelled' where id = (select min(id) from tickets where performance_id = $1)", [
            data.s1PerformanceId,
          ]),
        ),
      ),
    ).toEqual(["paidOrderBroken", "soldWithoutValidTicket"]);
    // 다른 사람이 산 좌석 하나를 한 사람의 선점으로 옮김(그 사람이 5석이 된다).
    expect(
      nonZero(
        await broken(async (c) => {
          const [a, b] = (
            await c.query<{ hold_id: number; seat_id: number }>(
              `select distinct on (hold_id) hold_id, seat_id from performance_seats
                where performance_id = $1 and status = 'sold' order by hold_id, seat_id limit 2`,
              [data.s1PerformanceId],
            )
          ).rows;
          await c.query("update performance_seats set hold_id = $3 where performance_id = $1 and seat_id = $2", [
            data.s1PerformanceId,
            b!.seat_id,
            a!.hold_id,
          ]);
        }),
      ),
    ).toEqual(["overLimit", "paidOrderBroken"]);
    // 취소된 주문에 성공한 결제.
    expect(
      nonZero(
        await broken((c) =>
          c.query(
            `insert into payments (order_id, status, amount, idempotency_key)
             select o.id, 'succeeded', 0, 'broken' from orders o join holds h on h.id = o.hold_id
              where h.performance_id = any($1) and o.cancel_reason = 'expired' limit 1`,
            [data.pastPerformanceIds],
          ),
        ),
      ),
    ).toEqual(["cancelledOrderBroken"]);
    // 끝난 주문의 선점으로 좌석을 다시 잡음(만료 전).
    expect(
      nonZero(
        await broken((c) =>
          c.query(
            `update performance_seats ps set status = 'held', hold_id = o.hold_id, hold_expires_at = now() + interval '5 minutes'
               from orders o join holds h on h.id = o.hold_id join order_items oi on oi.order_id = o.id
              where h.performance_id = any($1) and o.cancel_reason = 'user'
                and ps.performance_id = h.performance_id and ps.seat_id = oi.seat_id
                and o.id = (select min(o2.id) from orders o2 join holds h2 on h2.id = o2.hold_id
                             where h2.performance_id = any($1) and o2.cancel_reason = 'user')`,
            [data.pastPerformanceIds],
          ),
        ),
      ),
    ).toEqual(["heldForFinishedOrder", "heldSeats"]);
    // 한 좌석에 유효한 표 둘(인덱스를 지운 트랜잭션 안에서).
    expect(
      nonZero(
        await broken(async (c) => {
          await c.query("drop index tickets_one_valid_per_seat");
          await c.query(
            `insert into tickets (order_id, performance_id, seat_id)
             select order_id, performance_id, seat_id from tickets where performance_id = $1 order by id limit 1`,
            [data.s1PerformanceId],
          );
        }),
      ),
    ).toEqual(["duplicateValidTickets", "paidOrderBroken"]);
  });

  it("남은 일(조용해진 뒤 0이어야 하는 것)이 있으면 잡는다", async () => {
    const paidOrder = `select o.id, o.user_id from orders o join holds h on h.id = o.hold_id
                        where h.performance_id = $1 and o.status = 'paid' order by o.id limit 1`;
    expect(
      nonZero(
        await broken(async (c) => {
          const order = (await c.query<{ id: number; user_id: number }>(paidOrder, [data.s1PerformanceId])).rows[0]!;
          const payment = await c.query<{ id: number }>(
            "insert into payments (order_id, status, amount, idempotency_key) values ($1, 'requested', 0, 'left') returning id",
            [order.id],
          );
          await c.query(
            "insert into payments (order_id, status, amount, idempotency_key) values ($1, 'refund_pending', 0, 'left-refund')",
            [order.id],
          );
          await c.query(
            "insert into payment_webhooks (event_id, payment_id, type, body) values ($1, $2, 'payment.succeeded', '{}')",
            [randomUUID(), payment.rows[0]!.id],
          );
          await c.query(
            `insert into idempotency_keys (user_id, route, key, request_hash, owner_token)
             values ($1, 'TEST', $2, 'h', gen_random_uuid())`,
            [order.user_id, randomUUID()],
          );
          await c.query("update orders set status = 'pending' where id = $1", [order.id]);
        }),
      ),
    ).toEqual([
      "pendingOrders",
      "processingIdempotencyKeys",
      "refundPendingPayments",
      "requestedPayments",
      "soldWithoutPaidOrder",
      "unprocessedWebhooks",
    ]);
  });

  it("클라이언트가 paid로 받은 주문과 DB를 맞춘다", async () => {
    const { rows } = await pool.query<{ id: number; seat_ids: number[] }>(
      `select o.id, array_agg(oi.seat_id order by oi.seat_id) seat_ids from orders o
         join holds h on h.id = o.hold_id join order_items oi on oi.order_id = o.id
        where h.performance_id = $1 and o.status = 'paid' group by o.id order by o.id`,
      [data.s1PerformanceId],
    );
    // bigint 배열은 pg가 문자열로 돌려준다. k6가 남기는 값처럼 숫자로, 순서는 거꾸로 준다.
    const clientPaid = rows.map((r) => ({ orderId: r.id, seatIds: r.seat_ids.map(Number).reverse() }));
    const compare = (paid: typeof clientPaid) =>
      compareClientPaid(pool, { performanceId: data.s1PerformanceId, userIds: data.buyerIds, clientPaid: paid });
    expect(await compare(clientPaid)).toEqual({ clientOnly: 0, dbOnly: 0, seatMismatch: 0, seatClaimedTwice: 0 });
    expect(await compare(clientPaid.slice(1))).toMatchObject({ dbOnly: 1 });
    expect(await compare([...clientPaid, { orderId: -1, seatIds: [] }])).toMatchObject({ clientOnly: 1 });
    const [first, second, ...rest] = clientPaid;
    expect(await compare([first!, { ...second!, seatIds: [first!.seatIds[0]!, ...second!.seatIds.slice(1)] }, ...rest])).toEqual({
      clientOnly: 0,
      dbOnly: 0,
      seatMismatch: 1,
      seatClaimedTwice: 1,
    });
    // 부하 사용자가 아닌 사람의 주문은 대조하지 않는다.
    expect(
      await compareClientPaid(pool, { performanceId: data.s1PerformanceId, userIds: data.userIds, clientPaid: [] }),
    ).toMatchObject({ dbOnly: 0 });
  });

  it("결제사가 아는 결제와 DB를 맞춘다", async () => {
    const ids = await pool.query<{ id: number; status: string }>(
      `select distinct on (p.status) p.id, p.status from payments p join orders o on o.id = p.order_id
         join holds h on h.id = o.hold_id where h.performance_id = any($1) order by p.status, p.id`,
      [all],
    );
    const byStatus = Object.fromEntries(ids.rows.map((r) => [r.status, r.id]));
    const known = [
      { paymentId: byStatus.succeeded!, outcome: "succeeded" as const, refunded: false },
      { paymentId: byStatus.refunded!, outcome: "succeeded" as const, refunded: true },
      { paymentId: byStatus.failed!, outcome: "failed" as const, refunded: false },
    ];
    expect(await compareProvider(pool, known)).toEqual({ chargedWithoutTicketOrRefund: 0, refundedButNotByProvider: 0, unknownToDb: 0 });
    expect(
      await compareProvider(pool, [
        { paymentId: byStatus.failed!, outcome: "succeeded", refunded: false },
        { paymentId: byStatus.refunded!, outcome: "succeeded", refunded: false },
        { paymentId: -1, outcome: "succeeded", refunded: false },
      ]),
    ).toEqual({ chargedWithoutTicketOrRefund: 1, refundedButNotByProvider: 1, unknownToDb: 1 });
  });
});
