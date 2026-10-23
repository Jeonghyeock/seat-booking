import {
  AuthError,
  ErrorResponse,
  PaymentListQuery,
  PaymentNotRetryable,
  PaymentParams,
  PerformanceParams,
  PerformanceSales,
  RefundFailedPayments,
  RefundRetried,
} from "@seat-booking/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { listRefundFailed, loadPerformanceSales, retryRefund } from "../admin.js";
import type { Db } from "../db/client.js";
import { currentUser } from "./session.js";

// 관리자 경로(DESIGN 6.3 관리자 기능). /admin 접두사를 가진 범위에 등록한다. 그 범위의 훅이 로그인(401)과 역할(403)을 확인한다.
export const adminRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get(
    "/performances/:id/sales",
    {
      schema: {
        params: PerformanceParams,
        response: { 200: PerformanceSales, 401: AuthError, 403: AuthError, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const sales = await loadPerformanceSales(db, request.params.id);
      if (!sales) return reply.code(404).send({ error: "회차를 찾을 수 없습니다" });
      return sales;
    },
  );

  // 지금은 환불 실패(?status=refund_failed)만 본다.
  app.get(
    "/payments",
    {
      schema: {
        querystring: PaymentListQuery,
        response: { 200: RefundFailedPayments, 401: AuthError, 403: AuthError },
      },
    },
    async () => listRefundFailed(db),
  );

  // 누가 어느 결제를 다시 시도하게 했는지 로그에 남긴다.
  app.post(
    "/payments/:id/retry-refund",
    {
      schema: {
        params: PaymentParams,
        response: { 200: RefundRetried, 401: AuthError, 403: AuthError, 404: ErrorResponse, 409: PaymentNotRetryable },
      },
    },
    async (request, reply) => {
      const paymentId = request.params.id;
      const result = await retryRefund(db, paymentId);
      if (!result.ok) {
        if (result.code === "NOT_FOUND") return reply.code(404).send({ error: "결제를 찾을 수 없습니다" });
        return reply
          .code(409)
          .send({ error: "환불이 실패한 결제만 다시 시도할 수 있습니다", code: result.code, status: result.status });
      }
      request.log.info({ adminId: currentUser(request).id, paymentId, changed: result.changed }, "관리자: 환불 다시 시도");
      return { paymentId, status: "refund_pending" as const };
    },
  );
};
