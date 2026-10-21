// API와 화면이 함께 쓰는 요청·응답 스키마. API는 이 스키마로 검증·직렬화하고, 화면은 같은 타입을 쓴다.
import { z } from "zod";

export const HealthResponse = z.object({ status: z.literal("ok") });
export type HealthResponse = z.infer<typeof HealthResponse>;

export const HealthUnavailable = z.object({ status: z.literal("unavailable") });

export const ErrorResponse = z.object({ error: z.string() });
export type ErrorResponse = z.infer<typeof ErrorResponse>;

// 시각은 ISO 8601 문자열로 주고받는다.
export const PerformanceSummary = z.object({
  id: z.number().int().positive(),
  showTitle: z.string(),
  venueName: z.string(),
  startsAt: z.iso.datetime({ offset: true }),
  salesOpenAt: z.iso.datetime({ offset: true }),
});
export type PerformanceSummary = z.infer<typeof PerformanceSummary>;

export const PerformanceList = z.object({ performances: z.array(PerformanceSummary) });
export type PerformanceList = z.infer<typeof PerformanceList>;

export const PerformanceParams = z.object({ id: z.coerce.number().int().positive() });

export const SeatStatus = z.enum(["available", "held", "sold"]);
export type SeatStatus = z.infer<typeof SeatStatus>;

export const SeatMapSeat = z.object({
  seatId: z.number().int().positive(),
  section: z.string(),
  row: z.string(),
  number: z.number().int().positive(),
  grade: z.string(),
  price: z.number().int().nonnegative(),
  status: SeatStatus,
});
export type SeatMapSeat = z.infer<typeof SeatMapSeat>;

export const SeatMap = z.object({ performance: PerformanceSummary, seats: z.array(SeatMapSeat) });
export type SeatMap = z.infer<typeof SeatMap>;
