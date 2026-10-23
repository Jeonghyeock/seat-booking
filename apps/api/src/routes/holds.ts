import {
  AuthError,
  ErrorResponse,
  HoldConflict,
  HoldRequest,
  HoldResponse,
  MyPerformance,
  PerformanceParams,
} from "@seat-booking/shared";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { Db } from "../db/client.js";
import { performances } from "../db/schema.js";
import { type HoldFailure, holdSeats, myPerformance } from "../holds.js";
import { currentUser } from "./session.js";

// 409 본문. 화면에 띄울 문장과 다음 행동을 정할 값을 함께 준다.
function conflictBody(failure: HoldFailure): HoldConflict {
  switch (failure.code) {
    case "SALES_CLOSED":
      return {
        error: failure.reason === "NOT_OPEN" ? "아직 판매가 열리지 않았습니다" : "예매가 마감되었습니다",
        code: failure.code,
        reason: failure.reason,
        salesOpenAt: failure.salesOpenAt.toISOString(),
        salesCloseAt: failure.salesCloseAt.toISOString(),
        startsAt: failure.startsAt.toISOString(),
        serverTime: failure.serverTime.toISOString(),
      };
    case "HOLD_LIMIT":
      return {
        error: `선점과 구매를 합쳐 회차당 1인 ${failure.limit}석까지입니다. 지금 선점 ${failure.heldSeats}석, 구매 ${failure.purchasedSeats}석`,
        code: failure.code,
        limit: failure.limit,
        heldSeats: failure.heldSeats,
        purchasedSeats: failure.purchasedSeats,
      };
    case "PRICE_MISSING":
      return { error: "가격이 정해지지 않은 좌석이 있습니다", code: failure.code, seatIds: failure.seatIds };
    case "SEAT_UNAVAILABLE":
      return { error: "이미 선점되었거나 이 회차에 없는 좌석이 있습니다", code: failure.code, seatIds: failure.seatIds };
  }
}

export const holdRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get(
    "/performances/:id/me",
    {
      schema: {
        params: PerformanceParams,
        response: { 200: MyPerformance, 401: AuthError, 403: AuthError, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const performanceId = request.params.id;
      const userId = currentUser(request).id;

      const [performance] = await db
        .select({ id: performances.id })
        .from(performances)
        .where(eq(performances.id, performanceId));
      if (!performance) return reply.code(404).send({ error: "회차를 찾을 수 없습니다" });

      // 한도와 선점 목록을 한 스냅샷에서 읽어 서로 맞게 한다.
      return db.transaction((tx) => myPerformance(tx, userId, performanceId), {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      });
    },
  );

  app.post(
    "/performances/:id/holds",
    {
      schema: {
        params: PerformanceParams,
        body: HoldRequest,
        response: { 201: HoldResponse, 401: AuthError, 403: AuthError, 404: ErrorResponse, 409: HoldConflict },
      },
    },
    async (request, reply) => {
      const performanceId = request.params.id;
      const userId = currentUser(request).id;

      const [performance] = await db
        .select({ id: performances.id })
        .from(performances)
        .where(eq(performances.id, performanceId));
      if (!performance) return reply.code(404).send({ error: "회차를 찾을 수 없습니다" });

      const result = await holdSeats(db, { userId, performanceId, seatIds: request.body.seatIds });
      if (!result.ok) return reply.code(409).send(conflictBody(result));
      return reply.code(201).send({
        holdId: result.holdId,
        expiresAt: result.expiresAt.toISOString(),
        serverTime: result.serverTime.toISOString(),
        seatIds: result.seatIds,
      });
    },
  );
};
