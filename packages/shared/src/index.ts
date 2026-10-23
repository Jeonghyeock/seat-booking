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

// 경로·헤더의 id는 10진수 양의 정수만 받는다. 1e3, 0x10, 007, 1.0처럼 같은 수를 다르게 쓴 형식은 400이다.
const IdString = z
  .string()
  .regex(/^[1-9]\d{0,15}$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

export const PerformanceParams = z.object({ id: IdString });

// 4단계 전까지 쓰는 임시 헤더다. 인증이 아니어서 누구나 다른 사람 행세를 할 수 있다(DESIGN 10장 15).
// Fastify는 검증한 값을 원래 헤더 위에 덧씌우므로 다른 헤더가 지워지지는 않는다. looseObject는 다른 헤더도 타입에 남긴다.
export const UserHeaders = z.looseObject({ "x-user-id": IdString });

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

// 1인 좌석 한도(회차당, DESIGN 10장 3). 요청 하나에 담을 수 있는 좌석 수도 같다.
export const SEAT_LIMIT_PER_USER = 4;

export const HoldRequest = z.object({
  seatIds: z
    .array(z.number().int().positive())
    .min(1)
    .max(SEAT_LIMIT_PER_USER)
    .refine((ids) => new Set(ids).size === ids.length, "같은 좌석을 두 번 담을 수 없습니다"),
});
export type HoldRequest = z.infer<typeof HoldRequest>;

const SeatIds = z.array(z.number().int().positive());

// serverTime은 DB의 now()다. 화면은 PC 시계와의 차이를 보정해 남은 시간과 판매 시작까지를 센다(DESIGN 6.2 "서버 시각").
// expiresAt은 보통 serverTime + 5분이고, 공연 시작이 그보다 이르면 공연 시작이다.
export const HoldResponse = z.object({
  holdId: z.number().int().positive(),
  expiresAt: z.iso.datetime({ offset: true }),
  serverTime: z.iso.datetime({ offset: true }),
  seatIds: SeatIds,
});
export type HoldResponse = z.infer<typeof HoldResponse>;

// 409의 이유와, 화면이 다음 행동을 정할 값(DESIGN 6.2 "화면이 받는 것"). code로 가른다.
// SALES_CLOSED: 판매 기간이 아니다. NOT_OPEN이면 serverTime으로 시계를 맞춰 salesOpenAt까지 센다.
// HOLD_LIMIT: 이 회차에 쥔 좌석·산 좌석과 합치면 1인 한도를 넘는다.
// PRICE_MISSING: 담은 좌석 중 이 회차에 가격이 없는 좌석(seatIds)이 있다. 그 좌석을 빼고 다시 고른다.
// SEAT_UNAVAILABLE: 담은 좌석 중 이미 선점·판매됐거나 이 회차의 좌석이 아닌 것(seatIds)이 있다.
export const HoldConflict = z.discriminatedUnion("code", [
  z.object({
    error: z.string(),
    code: z.literal("SALES_CLOSED"),
    reason: z.enum(["NOT_OPEN", "CLOSED"]),
    salesOpenAt: z.iso.datetime({ offset: true }),
    startsAt: z.iso.datetime({ offset: true }),
    serverTime: z.iso.datetime({ offset: true }),
  }),
  z.object({
    error: z.string(),
    code: z.literal("HOLD_LIMIT"),
    limit: z.number().int().positive(),
    heldSeats: z.number().int().nonnegative(),
    purchasedSeats: z.number().int().nonnegative(),
  }),
  z.object({ error: z.string(), code: z.literal("PRICE_MISSING"), seatIds: SeatIds }),
  z.object({ error: z.string(), code: z.literal("SEAT_UNAVAILABLE"), seatIds: SeatIds }),
]);
export type HoldConflict = z.infer<typeof HoldConflict>;
