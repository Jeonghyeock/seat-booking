import {
  ErrorResponse,
  HoldConflict,
  HoldRequest,
  HoldResponse,
  PerformanceParams,
  SEAT_LIMIT_PER_USER,
  UserHeaders,
} from "@seat-booking/shared";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { Db } from "../db/client.js";
import { performances, users } from "../db/schema.js";
import { type HoldFailure, holdSeats } from "../holds.js";

const CONFLICT_MESSAGES: Record<HoldFailure, string> = {
  SEAT_UNAVAILABLE: "이미 선점되었거나 이 회차에 없는 좌석이 있습니다",
  HOLD_LIMIT: `한 회차에 ${SEAT_LIMIT_PER_USER}석까지 선점할 수 있습니다`,
};

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
      if (!result.ok) {
        return reply.code(409).send({ error: CONFLICT_MESSAGES[result.code], code: result.code });
      }
      return reply.code(201).send({
        holdId: result.holdId,
        expiresAt: result.expiresAt.toISOString(),
        seatIds: result.seatIds,
      });
    },
  );
};
