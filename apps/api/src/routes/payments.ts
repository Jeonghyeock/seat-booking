import {
  AuthError,
  ErrorResponse,
  IdempotencyHeaders,
  IdempotencyKeyReused,
  OrderParams,
  PaymentAccepted,
  PaymentConflict,
  PaymentProviderUnavailable,
  PaymentRequest,
} from "@seat-booking/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { Db } from "../db/client.js";
import { orders } from "../db/schema.js";
import type { FakePaymentProvider } from "../fake-pay.js";
import { hashRequest, type WorkResult, withIdempotencyKey } from "../idempotency.js";
import { type NotPayableReason, requestPayment } from "../payments.js";
import { sendIdempotent } from "./idempotent-reply.js";
import { currentUser } from "./session.js";

const NOT_PAYABLE_MESSAGES: Record<NotPayableReason, string> = {
  PAID: "이미 결제한 주문입니다",
  CANCELLED: "취소된 주문입니다",
  HOLD_EXPIRED: "선점 시간이 끝나 결제할 수 없습니다. 좌석을 다시 골라 주세요",
  TOO_CLOSE_TO_EXPIRY: "선점 시간이 거의 끝나 결제할 수 없습니다. 좌석을 다시 골라 주세요",
};

export const paymentRoutes: FastifyPluginAsyncZod<{ db: Db; provider: FakePaymentProvider }> = async (
  app,
  { db, provider },
) => {
  app.post(
    "/orders/:id/payments",
    {
      schema: {
        params: OrderParams,
        headers: IdempotencyHeaders,
        body: PaymentRequest,
        response: {
          202: PaymentAccepted,
          401: AuthError,
          403: AuthError,
          404: ErrorResponse,
          409: PaymentConflict,
          422: IdempotencyKeyReused,
          503: PaymentProviderUnavailable,
        },
      },
    },
    async (request, reply) => {
      const orderId = request.params.id;
      const userId = currentUser(request).id;
      const key = request.headers["idempotency-key"];
      const { scenario, delayMs } = request.body;

      // 남의 주문은 멱등 키를 잡기 전에 거른다(DESIGN 10장 38).
      const [order] = await db
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.userId, userId)));
      if (!order) return reply.code(404).send({ error: "주문을 찾을 수 없습니다" });

      const scope = {
        userId,
        route: "POST /orders/:id/payments",
        key,
        requestHash: hashRequest({ orderId, scenario, delayMs }),
      };
      const outcome = await withIdempotencyKey(db, scope, async (saveInTx): Promise<WorkResult> => {
        const result = await requestPayment(db, provider, { orderId, key, scenario, delayMs }, (tx, accepted) =>
          saveInTx(tx, { statusCode: 202, body: accepted }),
        );
        if (result.ok) return { response: { statusCode: 202, body: result.accepted }, keep: "saved" };
        switch (result.code) {
          // 다시 보내도 결과가 같다(DESIGN 6.2 멱등성 4).
          case "ORDER_NOT_PAYABLE":
            return {
              response: {
                statusCode: 409,
                body: { error: NOT_PAYABLE_MESSAGES[result.reason], code: result.code, orderId, reason: result.reason },
              },
              keep: "save",
            };
          // 진행 중인 결제가 끝나면 풀린다. 키를 지워 같은 키로 다시 보낼 수 있게 한다.
          case "PAYMENT_IN_PROGRESS":
            return {
              response: {
                statusCode: 409,
                body: {
                  error: "이 주문의 결제를 확인하고 있습니다. 결과를 기다려 주세요",
                  code: result.code,
                  paymentId: result.paymentId,
                },
              },
              keep: "release",
            };
          // 같은 키로 다시 보내면 같은 결제를 다시 묻는다(결제 요청 1).
          case "PAYMENT_PROVIDER_UNAVAILABLE":
            request.log.warn({ err: result.cause, paymentId: result.paymentId }, "결제사 호출 실패");
            return {
              response: {
                statusCode: 503,
                body: {
                  error: "결제사에 닿지 않았습니다. 같은 Idempotency-Key로 다시 보내 주세요",
                  code: result.code,
                  paymentId: result.paymentId,
                },
                headers: { "retry-after": "1" },
              },
              keep: "release",
            };
        }
      });
      return sendIdempotent(reply, outcome);
    },
  );
};
