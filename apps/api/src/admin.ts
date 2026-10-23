import type { PerformanceSales, RefundFailedPayments } from "@seat-booking/shared";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { deleteUserSessions, normalizeEmail } from "./auth.js";
import { type Db, writeTransaction } from "./db/client.js";
import { holds, orders, PAYMENT_STATUSES, payments, performanceSeats, performances, users } from "./db/schema.js";
import { performanceSummaries, toSummary } from "./routes/performances.js";

// 관리자 기능(DESIGN 6.3 역할·관리자 기능).

// ── 관리자로 올리기(admin:promote) ──

export type PromoteResult =
  | { ok: true; userId: number; createdAt: Date; alreadyAdmin: boolean }
  | { ok: false; reason: "NOT_FOUND" | "NO_PASSWORD" };

// 가입한 계정을 관리자로 올리고 그 사용자의 세션을 모두 지운다. 손님으로 만든 7일짜리 세션이 관리자 세션으로 남지 않게 한다.
// 역할을 먼저 바꾸고 세션을 지운다. 동시에 로그인해 만드는 세션은 createSession이 사용자 행을 FOR SHARE로 읽으므로,
// 역할을 바꾼 뒤에는 이 트랜잭션이 끝나기를 기다려 관리자 12시간으로 만든다(순서를 바꾸면 지운 뒤 손님 세션이 들어갈 수 있다).
// 비밀번호가 없는 계정(4단계 전에 만든 사용자)은 로그인할 수 없으므로 거절한다. 가입 시각을 돌려줘 명령이 보여 준다
// (이메일 확인이 없으므로, 남이 먼저 가입한 주소인지 운영자가 볼 수 있게). 잠금 대기 3초·문장 5초 제한 안에서 한다.
export async function promoteToAdmin(db: Db, email: string): Promise<PromoteResult> {
  return writeTransaction(db, async (tx) => {
    const [user] = await tx
      .select({ id: users.id, passwordHash: users.passwordHash, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.email, normalizeEmail(email)));
    if (!user) return { ok: false, reason: "NOT_FOUND" };
    if (user.passwordHash === null) return { ok: false, reason: "NO_PASSWORD" };
    // 동시에 두 번 올려도 한쪽만 바꾼다. 다른 쪽은 이미 관리자로 본다.
    const [changed] = await tx
      .update(users)
      .set({ role: "admin" })
      .where(and(eq(users.id, user.id), ne(users.role, "admin")))
      .returning({ id: users.id });
    if (changed) await deleteUserSessions(tx, user.id);
    return { ok: true, userId: user.id, createdAt: user.createdAt, alreadyAdmin: !changed };
  });
}

// ── 판매 현황 ──

type PaymentCounts = Record<(typeof PAYMENT_STATUSES)[number], number>;

// 회차의 좌석·주문·매출·결제를 한 스냅샷(repeatable read)에서 센다. 따로 읽으면 그사이 확정이 커밋되어 좌석과 주문 수가 어긋난다.
// 만료된 선점은 빈 좌석으로, 선점이 만료된 pending 주문은 cancelled로 센다(좌석 지도·주문 조회와 같다).
// now()는 트랜잭션을 시작한 시각이고 스냅샷은 첫 질의에서 잡는다. 그 한 번의 왕복 사이에 정리 작업이 만료된 선점을 풀면
// 좌석은 빈 좌석인데 주문은 pending으로 셀 수 있다. 드물고 다음 조회에서 맞으므로 받아들인다.
// 매출은 paid 주문 금액의 합이다(paid 주문은 취소할 수 없다). 결제 수는 0인 상태도 채운다. 없는 회차면 undefined다.
export async function loadPerformanceSales(db: Db, performanceId: number): Promise<PerformanceSales | undefined> {
  return db.transaction(
    async (tx) => {
      const [performance] = await performanceSummaries(tx).where(eq(performances.id, performanceId));
      if (!performance) return undefined;

      const heldAlive = sql`${performanceSeats.status} = 'held' and ${performanceSeats.holdExpiresAt} >= now()`;
      const [seats] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          available: sql<number>`count(*) filter (where ${performanceSeats.status} <> 'sold' and not (${heldAlive}))::int`,
          held: sql<number>`count(*) filter (where ${heldAlive})::int`,
          sold: sql<number>`count(*) filter (where ${performanceSeats.status} = 'sold')::int`,
        })
        .from(performanceSeats)
        .where(eq(performanceSeats.performanceId, performanceId));

      const pendingAlive = sql`${orders.status} = 'pending' and ${holds.expiresAt} >= now()`;
      const [orderCounts] = await tx
        .select({
          pending: sql<number>`count(*) filter (where ${pendingAlive})::int`,
          paid: sql<number>`count(*) filter (where ${orders.status} = 'paid')::int`,
          cancelled: sql<number>`count(*) filter (where ${orders.status} <> 'paid' and not (${pendingAlive}))::int`,
          // 합은 bigint다. pool의 INT8 파서가 number로 바꾼다(안전한 정수 범위를 넘으면 던진다).
          revenue: sql<number>`coalesce(sum(${orders.amount}) filter (where ${orders.status} = 'paid'), 0)`,
        })
        .from(orders)
        .innerJoin(holds, eq(holds.id, orders.holdId))
        .where(eq(holds.performanceId, performanceId));

      const paymentRows = await tx
        .select({ status: payments.status, count: sql<number>`count(*)::int` })
        .from(payments)
        .innerJoin(orders, eq(orders.id, payments.orderId))
        .innerJoin(holds, eq(holds.id, orders.holdId))
        .where(eq(holds.performanceId, performanceId))
        .groupBy(payments.status);
      const paymentCounts = Object.fromEntries(PAYMENT_STATUSES.map((status) => [status, 0])) as PaymentCounts;
      for (const row of paymentRows) paymentCounts[row.status] = row.count;

      const { revenue, ...orderStatusCounts } = orderCounts!;
      return {
        performance: toSummary(performance),
        seats: seats!,
        orders: orderStatusCounts,
        revenue,
        payments: paymentCounts,
        serverTime: performance.serverTime.toISOString(),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

// ── 환불 실패 ──

export const REFUND_FAILED_PAGE_SIZE = 100;

// 환불이 다섯 번 실패한 결제(10장 35). 최근 바뀐 것부터 100개와, 더 있는지다.
// 상태를 SQL 글자로 적어야 부분 인덱스(payments_refund_failed_updated_idx)를 쓴다(스키마 리뷰 O4).
export async function listRefundFailed(db: Db): Promise<RefundFailedPayments> {
  const rows = await db
    .select({
      paymentId: payments.id,
      providerRef: payments.providerRef,
      orderId: payments.orderId,
      orderStatus: orders.status,
      performanceId: holds.performanceId,
      userId: orders.userId,
      email: users.email,
      amount: payments.amount,
      refundAttempts: payments.refundAttempts,
      createdAt: payments.createdAt,
      updatedAt: payments.updatedAt,
    })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .innerJoin(holds, eq(holds.id, orders.holdId))
    .innerJoin(users, eq(users.id, orders.userId))
    .where(sql`${payments.status} = 'refund_failed'`)
    .orderBy(desc(payments.updatedAt), desc(payments.id))
    .limit(REFUND_FAILED_PAGE_SIZE + 1);
  return {
    payments: rows.slice(0, REFUND_FAILED_PAGE_SIZE).map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    hasMore: rows.length > REFUND_FAILED_PAGE_SIZE,
  };
}

export type RetryRefundResult =
  | { ok: true; changed: boolean }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "PAYMENT_NOT_RETRYABLE"; status: (typeof PAYMENT_STATUSES)[number] };

// 환불을 다시 시도하게 한다. refund_failed일 때만 refund_pending과 시도 횟수 0으로 바꾸고(조건부 UPDATE), 다음 정리 작업이 환불한다.
// 이미 refund_pending이면 바꾸지 않고 성공이다(두 번 눌러도 같다). 그 밖의 상태면 PAYMENT_NOT_RETRYABLE이다.
export async function retryRefund(db: Db, paymentId: number): Promise<RetryRefundResult> {
  const [updated] = await db
    .update(payments)
    .set({ status: "refund_pending", refundAttempts: 0, updatedAt: sql`now()` })
    .where(and(eq(payments.id, paymentId), sql`${payments.status} = 'refund_failed'`))
    .returning({ id: payments.id });
  if (updated) return { ok: true, changed: true };

  const [current] = await db.select({ status: payments.status }).from(payments).where(eq(payments.id, paymentId));
  if (!current) return { ok: false, code: "NOT_FOUND" };
  if (current.status === "refund_pending") return { ok: true, changed: false };
  return { ok: false, code: "PAYMENT_NOT_RETRYABLE", status: current.status };
}
