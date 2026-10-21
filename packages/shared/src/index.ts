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

// 경로의 id는 10진수 양의 정수만 받는다. 1e3, 0x10, 007, 1.0처럼 같은 수를 다르게 쓴 형식은 400이다.
export const PerformanceParams = z.object({
  id: z
    .string()
    .regex(/^[1-9]\d{0,15}$/)
    .transform(Number)
    .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)),
});

export const SeatStatus = z.enum(["available", "held", "sold"]);
export type SeatStatus = z.infer<typeof SeatStatus>;

export const SeatMapSeat = z.object({
  seatId: z.number().int().positive(),
  section: z.string(),
  row: z.string(),
  number: z.number().int().positive(),
  grade: z.string(),
  // 회차에 그 등급의 가격이 없으면 null이다. 좌석을 지도에서 숨기지 않고 빈틈이 보이게 한다.
  price: z.number().int().nonnegative().nullable(),
  status: SeatStatus,
});
export type SeatMapSeat = z.infer<typeof SeatMapSeat>;

export const SeatMap = z.object({ performance: PerformanceSummary, seats: z.array(SeatMapSeat) });
export type SeatMap = z.infer<typeof SeatMap>;
