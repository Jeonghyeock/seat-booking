import type { PerformanceSales, RefundFailedPayments } from "@seat-booking/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { deleteUserSessions, normalizeEmail } from "./auth.js";
import type { Db } from "./db/client.js";
import { holds, orders, PAYMENT_STATUSES, payments, performanceSeats, performances, users } from "./db/schema.js";

// 관리자 기능(DESIGN 6.3 역할·관리자 기능).

// ── 관리자로 올리기(admin:promote) ──

export type PromoteResult =
  | { ok: true; userId: number; alreadyAdmin: boolean }
  | { ok: false; reason: "NOT_FOUND" | "NO_PASSWORD" };

// 가입한 계정을 관리자로 올리고 그 사용자의 세션을 모두 지운다. 손님으로 만든 7일짜리 세션이 관리자 세션으로 남지 않게 한다.
// 동시에 로그인해 만드는 세션은 createSession이 사용자 행을 FOR SHARE로 읽으므로, 이 트랜잭션이 끝난 뒤의 역할(관리자 12시간)로 만든다.
// 비밀번호가 없는 계정(4단계 전에 만든 사용자)은 로그인할 수 없으므로 거절한다.
export async function promoteToAdmin(db: Db, email: string): Promise<PromoteResult> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, role: users.role, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, normalizeEmail(email)));
    if (!user) return { ok: false, reason: "NOT_FOUND" };
    if (user.passwordHash === null) return { ok: false, reason: "NO_PASSWORD" };
    if (user.role === "admin") return { ok: true, userId: user.id, alreadyAdmin: true };
    await tx.update(users).set({ role: "admin" }).where(eq(users.id, user.id));
    await deleteUserSessions(tx, user.id);
    return { ok: true, userId: user.id, alreadyAdmin: false };
  });
}

// ── 판매 현황 ──

type PaymentCounts = Record<(typeof PAYMENT_STATUSES)[number], number>;

// 회차의 좌석·주문·매출·결제를 한 스냅샷(repeatable read)에서 센다. 따로 읽으면 그사이 확정이 커밋되어 좌석과 주문 수가 어긋난다.
// 만료된 선점은 빈 좌석으로, 선점이 만료된 pending 주문은 cancelled로 센다(좌석 지도·주문 조회와 같다). now()는 스냅샷을 잡은 시각이다.
// 매출은 paid 주문 금액의 합이다(paid 주문은 취소할 수 없다). 결제 수는 0인 상태도 채운다. 없는 회차면 undefined다.
export async function loadPerformanceSales(db: Db, performanceId: number): Promise<PerformanceSales | undefined> {
  return db.transaction(
    async (tx) => {
      const [performance] = await tx
        .select({ serverTime: sql`now()`.mapWith(performances.startsAt) })
        .from(performances)
        .where(eq(performances.id, performanceId));
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
          // 합은 bigint라 pg가 문자열로 돌려준다.
          revenue: sql`coalesce(sum(${orders.amount}) filter (where ${orders.status} = 'paid'), 0)`.mapWith(Number),
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
        performanceId,
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
      orderId: payments.orderId,
      userId: orders.userId,
      email: users.email,
      amount: payments.amount,
      refundAttempts: payments.refundAttempts,
      createdAt: payments.createdAt,
      updatedAt: payments.updatedAt,
    })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
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
