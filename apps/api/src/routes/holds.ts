import {
  ErrorResponse,
  HoldConflict,
  HoldRequest,
  HoldResponse,
  PerformanceParams,
  UserHeaders,
} from "@seat-booking/shared";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { Db } from "../db/client.js";
import { performances, users } from "../db/schema.js";
import { type HoldFailure, holdSeats } from "../holds.js";

// 409 본문. 화면에 띄울 문장과 다음 행동을 정할 값을 함께 준다.
function conflictBody(failure: HoldFailure): HoldConflict {
  switch (failure.code) {
    case "SALES_CLOSED":
      return {
        error: failure.reason === "NOT_OPEN" ? "아직 판매가 열리지 않았습니다" : "판매가 끝났습니다",
        code: failure.code,
        reason: failure.reason,
        salesOpenAt: failure.salesOpenAt.toISOString(),
        startsAt: failure.startsAt.toISOString(),
        serverTime: failure.serverTime.toISOString(),
      };
    case "HOLD_LIMIT":
      return {
        error: `회차당 1인 ${failure.limit}석까지 선점할 수 있습니다(구매 포함). 지금 선점 ${failure.heldSeats}석, 구매 ${failure.purchasedSeats}석`,
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
  app.post(
    "/performances/:id/holds",
    {
      schema: {
        params: PerformanceParams,
        headers: UserHeaders,
        body: HoldRequest,
        response: { 201: HoldResponse, 401: ErrorResponse, 404: ErrorResponse, 409: HoldConflict },
      },
    },
    async (request, reply) => {
      const performanceId = request.params.id;
      const userId = request.headers["x-user-id"];

      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
      if (!user) return reply.code(401).send({ error: "없는 사용자입니다" });
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
