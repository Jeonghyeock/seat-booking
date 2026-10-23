import {
  CreateOrderConflict,
  ErrorResponse,
  HoldParams,
  IdempotencyKeyReused,
  IdempotentUserHeaders,
  OrderNotCancellable,
  OrderParams,
  OrderView,
  UserHeaders,
} from "@seat-booking/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { Db } from "../db/client.js";
import { holds, orders, users } from "../db/schema.js";
import { hashRequest, withIdempotencyKey } from "../idempotency.js";
import { type CreateOrderFailure, cancelOrder, createOrder, loadOrderView } from "../orders.js";
import { sendIdempotent } from "./idempotent-reply.js";

function conflictBody(failure: CreateOrderFailure): CreateOrderConflict {
  switch (failure.code) {
    case "HOLD_EXPIRED":
      return {
        error: "선점 시간이 끝났습니다. 좌석을 다시 골라 주세요",
        code: failure.code,
        expiredAt: failure.expiredAt.toISOString(),
      };
    case "ORDER_EXISTS":
      return { error: "이 선점으로 만든 주문이 이미 있습니다", code: failure.code, orderId: failure.orderId };
    case "PRICE_MISSING":
      return { error: "가격이 정해지지 않은 좌석이 있습니다", code: failure.code, seatIds: failure.seatIds };
  }
}

export const orderRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.post(
    "/holds/:id/orders",
    {
      schema: {
        params: HoldParams,
        headers: IdempotentUserHeaders,
        response: {
          201: OrderView,
          401: ErrorResponse,
          404: ErrorResponse,
          409: CreateOrderConflict,
          422: IdempotencyKeyReused,
        },
      },
    },
    async (request, reply) => {
      const holdId = request.params.id;
      const userId = request.headers["x-user-id"];

      // 없는 사용자와 남의 선점은 멱등 키를 잡기 전에 거른다. 키 행은 사용자를 외래 키로 가리키고, 이 확인은 아무것도 바꾸지 않는다.
      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
      if (!user) return reply.code(401).send({ error: "없는 사용자입니다" });
      const [hold] = await db
        .select({ id: holds.id })
        .from(holds)
        .where(and(eq(holds.id, holdId), eq(holds.userId, userId)));
      if (!hold) return reply.code(404).send({ error: "선점을 찾을 수 없습니다" });

      const scope = {
        userId,
        route: "POST /holds/:id/orders",
        key: request.headers["idempotency-key"],
        requestHash: hashRequest({ holdId }),
      };
      const outcome = await withIdempotencyKey(db, scope, async (saveInTx) => {
        const result = await createOrder(db, { userId, holdId }, (tx, view) =>
          saveInTx(tx, { statusCode: 201, body: view }),
        );
        if (result.ok) return { response: { statusCode: 201, body: result.view }, keep: "saved" };
        // 주문 생성의 409는 모두 다시 보내도 결과가 같다(DESIGN 6.2 멱등성 4).
        return { response: { statusCode: 409, body: conflictBody(result) }, keep: "save" };
      });
      return sendIdempotent(reply, outcome);
    },
  );

  app.post(
    "/orders/:id/cancel",
    {
      schema: {
        params: OrderParams,
        headers: UserHeaders,
        response: { 200: OrderView, 401: ErrorResponse, 404: ErrorResponse, 409: OrderNotCancellable },
      },
    },
    async (request, reply) => {
      const orderId = request.params.id;
      const userId = request.headers["x-user-id"];

      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
      if (!user) return reply.code(401).send({ error: "없는 사용자입니다" });
      const [order] = await db
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.userId, userId)));
      if (!order) return reply.code(404).send({ error: "주문을 찾을 수 없습니다" });

      const result = await cancelOrder(db, orderId);
      if (!result.ok) {
        return reply
          .code(409)
          .send({ error: "결제가 끝난 주문은 취소할 수 없습니다", code: result.code, orderId: result.orderId });
      }
      return result.view;
    },
  );

  app.get(
    "/orders/:id",
    {
      schema: {
        params: OrderParams,
        headers: UserHeaders,
        response: { 200: OrderView, 401: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const orderId = request.params.id;
      const userId = request.headers["x-user-id"];

      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
      if (!user) return reply.code(401).send({ error: "없는 사용자입니다" });
      // 남의 주문도 없는 주문과 같이 404다.
      const [order] = await db
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.userId, userId)));
      if (!order) return reply.code(404).send({ error: "주문을 찾을 수 없습니다" });
      // 주문·좌석·결제·표를 한 스냅샷에서 읽는다. 따로 읽으면 확정이 그사이 커밋되어 pending 주문에 성공한 결제가 붙어 보인다(리뷰 L1).
      return (await db.transaction((tx) => loadOrderView(tx, orderId), {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      }))!;
    },
  );
};
