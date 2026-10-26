import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { findSessionUser } from "../auth.js";
import { createDb } from "../db/client.js";
import { createPool } from "../db/pool.js";
import { checkInvariants, checkLeftovers, compareClientPaid, compareProvider, seatCounts } from "./checks.js";
import { historyLayout, type LoadData, type LoadShape, LOAD_SHAPE, seedLoadData } from "./data.js";
import { cookieHeaders, verifyTemplateFiles } from "./template.js";

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
  // 한 트랜잭션 안에서 데이터를 일부러 바꾸고 확인한 뒤 되돌린다(다른 테스트가 같은 데이터를 쓴다). 0이 아닌 확인의 이름을 돌려준다.
  const broken = async (corrupt: (client: pg.PoolClient) => Promise<unknown>) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await corrupt(client);
      const counts = { ...(await checkInvariants(client, all)), ...(await checkLeftovers(client, all)) };
      return Object.keys(counts)
        .filter((k) => counts[k as keyof typeof counts] !== 0)
        .sort();
    } finally {
      await client.query("rollback");
      client.release();
    }
  };
  // 회차들의 주문 하나(조건으로 고름)와 그 선점·좌석.
  const anOrder = async (c: pg.PoolClient, performanceIds: number[], where: string) =>
    (
      await c.query<{
        id: number;
        user_id: number;
        hold_id: number;
        performance_id: number;
        amount: number;
        expires_at: Date;
        seat_ids: number[];
      }>(
        `select o.id, o.user_id, o.hold_id, h.performance_id, o.amount, h.expires_at,
                array(select oi.seat_id from order_items oi where oi.order_id = o.id order by oi.seat_id) as seat_ids
           from orders o join holds h on h.id = o.hold_id
          where h.performance_id = any($1) and ${where} order by o.id limit 1`,
        [performanceIds],
      )
    ).rows[0]!;

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

  it("템플릿과 결과 파일이 같은 것에서 나왔는지 쿠키 하나로 확인한다", async () => {
    const [first] = cookieHeaders(data.tokens);
    expect(first).toMatch(/^sid=/);
    await expect(verifyTemplateFiles(inject("databaseUrl"), first!, data.userIds[0]!)).resolves.toBeUndefined();
    await expect(verifyTemplateFiles(inject("databaseUrl"), first!, data.userIds[1]!)).rejects.toThrow();
    await expect(verifyTemplateFiles(inject("databaseUrl"), cookieHeaders(["x".repeat(43)])[0]!, data.userIds[0]!)).rejects.toThrow();
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

  it("지난 주문은 끝난 상태만이고, 사용자마다 좌석 수가 섞이며 paid가 있다", async () => {
    const orders = await pool.query<{ status: string; cancel_reason: string | null; count: string }>(
      `select o.status, o.cancel_reason, count(*) from orders o join holds h on h.id = o.hold_id
        where h.performance_id = any($1) group by 1, 2`,
      [data.pastPerformanceIds],
    );
    expect(orders.rows.map((r) => [r.status, r.cancel_reason ?? "", Number(r.count)]).sort()).toEqual([
      ["cancelled", "expired", 20],
      ["cancelled", "user", 10],
      ["paid", "", 70],
    ]);
    // 정렬은 JS에서 한다(DB의 정렬 규칙에 따라 refund_failed와 refunded의 순서가 다르다).
    const payments = await pool.query<{ status: string }>(
      `select distinct p.status from payments p join orders o on o.id = p.order_id join holds h on h.id = o.hold_id
        where h.performance_id = any($1)`,
      [all],
    );
    expect(payments.rows.map((r) => r.status).sort()).toEqual(["failed", "refund_failed", "refunded", "succeeded"]);
    const perUser = await pool.query<{ paid: string; sizes: string }>(
      `select count(*) filter (where o.status = 'paid') as paid,
              count(distinct (select count(*) from order_items oi where oi.order_id = o.id)) as sizes
         from orders o join holds h on h.id = o.hold_id
        where h.performance_id = any($1) group by o.user_id`,
      [data.pastPerformanceIds],
    );
    expect(perUser.rows).toHaveLength(20);
    for (const row of perUser.rows) {
      expect(Number(row.paid)).toBeGreaterThan(0);
      expect(Number(row.sizes)).toBeGreaterThan(1);
    }
  });

  it("넣은 데이터는 C2 불변식과 남은 일이 모두 0이다", async () => {
    const invariants = await checkInvariants(pool, all);
    const leftovers = await checkLeftovers(pool, all);
    expect(Object.entries({ ...invariants, ...leftovers }).filter(([, v]) => v !== 0)).toEqual([]);
    expect(Object.keys(invariants)).toHaveLength(11);
  });

  it("측정 중에 생기는 합법적인 중간 상태에서는 불변식이 0이다", async () => {
    // 결제 확정이 만료에 걸리면 좌석을 held로 둔 채 주문을 끝내고 정리 작업에 맡긴다: 만료가 지난 held 좌석 + 끝난 주문.
    expect(
      await broken(async (c) => {
        const order = await anOrder(c, data.pastPerformanceIds, "o.cancel_reason = 'expired'");
        await c.query(
          "update performance_seats set status = 'held', hold_id = $2, hold_expires_at = $3 where performance_id = $1 and seat_id = any($4)",
          [order.performance_id, order.hold_id, order.expires_at, order.seat_ids],
        );
      }),
    ).toEqual(["heldSeats"]);
  });

  it("불변식이 깨지면 그 확인이 잡는다", async () => {
    const s1 = [data.s1PerformanceId];
    // 팔린 좌석을 빈 좌석으로 되돌림.
    expect(
      await broken(async (c) => {
        const order = await anOrder(c, s1, "o.status = 'paid'");
        await c.query(
          "update performance_seats set status = 'available', hold_id = null, hold_expires_at = null where performance_id = $1 and seat_id = $2",
          [order.performance_id, order.seat_ids[0]],
        );
      }),
    ).toEqual(["paidOrderBroken", "validTicketNotSold"]);
    // 표를 취소함.
    expect(
      await broken((c) =>
        c.query("update tickets set status = 'cancelled' where id = (select min(id) from tickets where performance_id = $1)", s1),
      ),
    ).toEqual(["paidOrderBroken", "soldWithoutValidTicket"]);
    // 다른 사람이 산 좌석 하나를 한 사람의 선점으로 옮김(그 사람이 5석이 된다). 만료도 그 선점에 맞춘다.
    expect(
      await broken(async (c) => {
        const a = await anOrder(c, s1, "o.status = 'paid'");
        const b = await anOrder(c, s1, `o.status = 'paid' and o.id <> ${a.id}`);
        await c.query("update performance_seats set hold_id = $3, hold_expires_at = $4 where performance_id = $1 and seat_id = $2", [
          a.performance_id,
          b.seat_ids[0],
          a.hold_id,
          a.expires_at,
        ]);
      }),
    ).toEqual(["overLimit", "paidOrderBroken"]);
    // 취소된 주문에 성공한 결제(금액은 주문과 같게).
    expect(
      await broken(async (c) => {
        const order = await anOrder(c, data.pastPerformanceIds, "o.cancel_reason = 'expired'");
        await c.query("insert into payments (order_id, status, amount, idempotency_key) values ($1, 'succeeded', $2, 'broken')", [
          order.id,
          order.amount,
        ]);
      }),
    ).toEqual(["cancelledOrderBroken", "succeededPaymentNotPaid"]);
    // 취소된 주문의 선점으로 좌석이 팔림.
    expect(
      await broken(async (c) => {
        const order = await anOrder(c, data.pastPerformanceIds, "o.cancel_reason = 'user'");
        await c.query(
          "update performance_seats set status = 'sold', hold_id = $2, hold_expires_at = $3 where performance_id = $1 and seat_id = $4",
          [order.performance_id, order.hold_id, order.expires_at, order.seat_ids[0]],
        );
      }),
    ).toEqual(["cancelledOrderBroken", "soldWithoutPaidOrder", "soldWithoutValidTicket"]);
    // 주문이 없는 선점으로 좌석이 팔림.
    expect(
      await broken(async (c) => {
        const seat = await c.query<{ performance_id: number; seat_id: number }>(
          "select performance_id, seat_id from performance_seats where performance_id = any($1) and status = 'available' limit 1",
          [data.pastPerformanceIds],
        );
        const { performance_id, seat_id } = seat.rows[0]!;
        const hold = await c.query<{ id: number; expires_at: Date }>(
          // JS Date는 밀리초까지라 마이크로초가 있는 now()를 그대로 되돌려 쓰면 좌석과 선점의 만료가 달라진다. 초 단위로 자른다.
          "insert into holds (user_id, performance_id, expires_at) values ($1, $2, date_trunc('second', now()) - interval '1 day') returning id, expires_at",
          [data.userIds[0], performance_id],
        );
        await c.query(
          "update performance_seats set status = 'sold', hold_id = $3, hold_expires_at = $4 where performance_id = $1 and seat_id = $2",
          [performance_id, seat_id, hold.rows[0]!.id, hold.rows[0]!.expires_at],
        );
      }),
    ).toEqual(["soldWithoutPaidOrder", "soldWithoutValidTicket"]);
    // 끝난(사용자가 취소한) 주문의 선점으로 좌석을 만료 전 held로 다시 잡음.
    expect(
      await broken(async (c) => {
        const order = await anOrder(c, data.pastPerformanceIds, "o.cancel_reason = 'user'");
        const { rows } = await c.query<{ expires_at: Date }>(
          "update holds set expires_at = date_trunc('second', now()) + interval '5 minutes' where id = $1 returning expires_at",
          [order.hold_id],
        );
        await c.query(
          "update performance_seats set status = 'held', hold_id = $2, hold_expires_at = $3 where performance_id = $1 and seat_id = any($4)",
          [order.performance_id, order.hold_id, rows[0]!.expires_at, order.seat_ids],
        );
      }),
    ).toEqual(["heldForFinishedOrder", "heldSeats"]);
    // paid 주문의 좌석 하나가 만료 전 held로 남음.
    expect(
      await broken(async (c) => {
        const order = await anOrder(c, s1, "o.status = 'paid'");
        const { rows } = await c.query<{ expires_at: Date }>(
          "update holds set expires_at = date_trunc('second', now()) + interval '5 minutes' where id = $1 returning expires_at",
          [order.hold_id],
        );
        await c.query("update performance_seats set hold_expires_at = $2 where hold_id = $1", [order.hold_id, rows[0]!.expires_at]);
        await c.query("update performance_seats set status = 'held' where performance_id = $1 and seat_id = $2", [
          order.performance_id,
          order.seat_ids[0],
        ]);
      }),
    ).toEqual(["heldForFinishedOrder", "heldSeats", "paidOrderBroken", "validTicketNotSold"]);
    // 주문 금액이 담은 좌석 가격의 합·결제 금액과 다름.
    expect(
      await broken(async (c) => {
        const order = await anOrder(c, s1, "o.status = 'paid'");
        await c.query("update orders set amount = amount + 1 where id = $1", [order.id]);
      }),
    ).toEqual(["amountMismatch"]);
    // 성공한 결제의 금액이 주문 금액과 다름.
    expect(
      await broken(async (c) => {
        const order = await anOrder(c, s1, "o.status = 'paid'");
        await c.query("update payments set amount = amount + 1 where order_id = $1 and status = 'succeeded'", [order.id]);
      }),
    ).toEqual(["amountMismatch"]);
    // 좌석의 선점이 다른 회차의 것.
    expect(
      await broken(async (c) => {
        const order = await anOrder(c, s1, "o.status = 'paid'");
        await c.query("update holds set performance_id = $2 where id = $1", [order.hold_id, data.pastPerformanceIds[0]]);
      }),
    ).toEqual(["paidOrderBroken", "seatHoldMismatch"]);
    // 좌석의 선점 만료가 선점 행과 다름.
    expect(
      await broken(async (c) => {
        const order = await anOrder(c, s1, "o.status = 'paid'");
        await c.query(
          "update performance_seats set hold_expires_at = hold_expires_at + interval '1 minute' where performance_id = $1 and seat_id = $2",
          [order.performance_id, order.seat_ids[0]],
        );
      }),
    ).toEqual(["seatHoldMismatch"]);
    // 한 좌석에 유효한 표 둘. 공유 표를 잠그지 않게 이 트랜잭션에만 보이는 임시 tickets를 만들어 확인한다
    // (임시 표가 같은 이름의 public 표를 가린다).
    expect(
      await broken(async (c) => {
        await c.query("create temp table tickets (like public.tickets including defaults) on commit drop");
        await c.query(
          `insert into tickets (id, order_id, performance_id, seat_id, status, created_at)
           select -id, order_id, performance_id, seat_id, status, created_at from public.tickets where performance_id = any($1)`,
          [all],
        );
        await c.query(
          `insert into tickets (id, order_id, performance_id, seat_id, status, created_at)
           select -1000000000 - id, order_id, performance_id, seat_id, status, created_at
             from public.tickets where performance_id = $1 order by id limit 1`,
          s1,
        );
      }),
    ).toEqual(["duplicateValidTickets", "paidOrderBroken"]);
  });

  it("남은 일(조용해진 뒤 0이어야 하는 것)이 있으면 잡는다", async () => {
    expect(
      await broken(async (c) => {
        const order = await anOrder(c, [data.s1PerformanceId], "o.status = 'paid'");
        const payment = await c.query<{ id: number }>(
          "insert into payments (order_id, status, amount, idempotency_key) values ($1, 'requested', 0, 'left') returning id",
          [order.id],
        );
        await c.query("insert into payments (order_id, status, amount, idempotency_key) values ($1, 'refund_pending', 0, 'left-refund')", [
          order.id,
        ]);
        await c.query("insert into payment_webhooks (event_id, payment_id, type, body) values ($1, $2, 'payment.succeeded', '{}')", [
          randomUUID(),
          payment.rows[0]!.id,
        ]);
        await c.query(
          "insert into idempotency_keys (user_id, route, key, request_hash, owner_token) values ($1, 'TEST', $2, 'h', gen_random_uuid())",
          [order.user_id, randomUUID()],
        );
        await c.query("update orders set status = 'pending' where id = $1", [order.id]);
      }),
    ).toEqual([
      "pendingOrders",
      "processingIdempotencyKeys",
      "refundPendingPayments",
      "requestedPayments",
      "soldWithoutPaidOrder",
      "succeededPaymentNotPaid",
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
    const compare = (paid: typeof clientPaid, clientGaveUp: number[] = []) =>
      compareClientPaid(pool, { performanceId: data.s1PerformanceId, userIds: data.buyerIds, clientPaid: paid, clientGaveUp });
    const ok = { clientOnly: 0, dbOnly: 0, seatMismatch: 0, seatClaimedTwice: 0, conflictingDuplicates: 0 };
    expect(await compare(clientPaid)).toEqual({ failures: ok, paidAfterClientGaveUp: 0 });
    expect((await compare(clientPaid.slice(1))).failures).toMatchObject({ dbOnly: 1 });
    // 결과를 기다리다 그만둔 주문이 나중에 paid가 된 것은 실패가 아니다.
    expect(await compare(clientPaid.slice(1), [clientPaid[0]!.orderId])).toEqual({ failures: ok, paidAfterClientGaveUp: 1 });
    expect((await compare([...clientPaid, { orderId: -1, seatIds: [] }])).failures).toMatchObject({ clientOnly: 1 });
    // 같은 주문을 두 번 받으면 한 번으로 센다. 좌석이 다르면 따로 알린다.
    expect((await compare([...clientPaid, clientPaid[0]!])).failures).toEqual(ok);
    expect((await compare([...clientPaid, { ...clientPaid[0]!, seatIds: [1] }])).failures).toEqual({ ...ok, conflictingDuplicates: 1 });
    const [first, second, ...rest] = clientPaid;
    expect(
      (await compare([first!, { ...second!, seatIds: [first!.seatIds[0]!, ...second!.seatIds.slice(1)] }, ...rest])).failures,
    ).toEqual({ ...ok, seatMismatch: 1, seatClaimedTwice: 1 });
    // 부하 사용자가 아닌 사람의 주문은 대조하지 않는다.
    expect(
      (await compareClientPaid(pool, { performanceId: data.s1PerformanceId, userIds: data.userIds, clientPaid: [] })).failures,
    ).toEqual(ok);
  });

  it("결제사가 아는 결제와 DB를 맞춘다", async () => {
    const ids = await pool.query<{ id: number; status: string }>(
      `select distinct on (p.status) p.id, p.status from payments p join orders o on o.id = p.order_id
         join holds h on h.id = o.hold_id where h.performance_id = any($1) order by p.status, p.id`,
      [all],
    );
    const id = Object.fromEntries(ids.rows.map((r) => [r.status, Number(r.id)]));
    const s1Payments = await pool.query<{ id: number }>(
      `select p.id from payments p join orders o on o.id = p.order_id join holds h on h.id = o.hold_id
        where h.performance_id = $1 and p.status = 'succeeded' order by p.id`,
      [data.s1PerformanceId],
    );
    const succeeded = s1Payments.rows.map((r) => ({ paymentId: Number(r.id), outcome: "succeeded" as const, refunded: false }));
    const compare = (providerPayments: { paymentId: number; outcome: "succeeded" | "failed"; refunded: boolean }[]) =>
      compareProvider(pool, { performanceId: data.s1PerformanceId, userIds: data.buyerIds, providerPayments });
    const ok = {
      chargedWithoutTicketOrRefund: 0,
      failedButNotFailedInDb: 0,
      refundedButNotInDb: 0,
      refundedInDbNotByProvider: 0,
      unknownToDb: 0,
      unknownToProvider: 0,
    };
    expect(
      await compare([
        ...succeeded,
        { paymentId: id.refunded!, outcome: "succeeded", refunded: true },
        { paymentId: id.failed!, outcome: "failed", refunded: false },
      ]),
    ).toEqual(ok);
    // 그 회차에서 돈이 오간 결제를 결제사가 모름.
    expect(await compare(succeeded.slice(1))).toEqual({ ...ok, unknownToProvider: 1 });
    expect(
      await compare([
        ...succeeded,
        // 돈을 받았는데 DB는 실패, 또는 refund_failed(표도 환불도 없음).
        { paymentId: id.failed!, outcome: "succeeded", refunded: false },
        { paymentId: id.refund_failed!, outcome: "succeeded", refunded: false },
        // 결제사는 실패인데 DB는 성공(돈 없이 표).
        { paymentId: succeeded[0]!.paymentId, outcome: "failed", refunded: false },
        // 결제사는 환불했는데 DB는 환불 아님, DB는 환불인데 결제사는 환불하지 않음.
        { paymentId: id.refund_failed!, outcome: "succeeded", refunded: true },
        { paymentId: id.refunded!, outcome: "succeeded", refunded: false },
        { paymentId: -1, outcome: "succeeded", refunded: false },
      ]),
    ).toEqual({
      // DB는 refunded인데 결제사는 환불하지 않은 결제도 돈만 받은 것이라 여기에도 센다.
      chargedWithoutTicketOrRefund: 3,
      failedButNotFailedInDb: 1,
      refundedButNotInDb: 1,
      refundedInDbNotByProvider: 1,
      unknownToDb: 1,
      unknownToProvider: 0,
    });
  });
});
