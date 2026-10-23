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
  // 온라인 판매를 닫는 시각. 회차마다 다르다. 이 시각부터 새 선점을 받지 않는다.
  salesCloseAt: z.iso.datetime({ offset: true }),
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
export const HoldParams = z.object({ id: IdString });
export const OrderParams = z.object({ id: IdString });

// 주문 생성·결제 요청은 Idempotency-Key가 있어야 한다(DESIGN 6.2 멱등성). 길이는 DB의 CHECK와 같다.
// Fastify는 검증한 값을 원래 헤더 위에 덧씌우므로 다른 헤더(쿠키 등)가 지워지지는 않는다. looseObject는 다른 헤더도 타입에 남긴다.
export const IdempotencyHeaders = z.looseObject({ "idempotency-key": z.string().min(1).max(255) });

// 로그인·CSRF·권한 확인의 401·403(DESIGN 6.3). 훅이 보내므로 보호 경로는 모두 401·403에 이것을 선언한다.
// 선언이 다르면 훅이 보낸 code가 직렬화에서 지워지거나 500이 된다.
export const AuthError = z.object({
  error: z.string(),
  code: z.enum(["UNAUTHENTICATED", "CSRF_REJECTED", "FORBIDDEN"]),
});
export type AuthError = z.infer<typeof AuthError>;

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

// serverTime은 DB의 now()다. 화면은 PC 시계와의 차이를 보정해 판매 시작·종료까지를 센다. 좌석 지도는 로그인 전에도 본다.
export const SeatMap = z.object({
  performance: PerformanceSummary,
  seats: z.array(SeatMapSeat),
  serverTime: z.iso.datetime({ offset: true }),
});
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

// 이 회차에서 내 상태(GET /performances/:id/me). 새로고침·두 탭·응답 유실 뒤 내 선점과 주문을 다시 찾는다.
// limit·heldSeats·purchasedSeats는 HOLD_LIMIT 본문과 같은 뜻이고, remaining은 더 선점할 수 있는 수다.
// holds는 유효한 선점(좌석이 이 선점으로 아직 held이고 만료 전)만이고, 붙은 주문이 있으면 orderId다.
// 선점이 끝난 주문(결제 완료, 환불 중)은 여기에 없다. 예매 내역 API는 5단계에서 만든다(DESIGN 10장 41).
export const MyPerformance = z.object({
  performanceId: z.number().int().positive(),
  serverTime: z.iso.datetime({ offset: true }),
  limit: z.number().int().positive(),
  heldSeats: z.number().int().nonnegative(),
  purchasedSeats: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  holds: z.array(
    z.object({
      holdId: z.number().int().positive(),
      expiresAt: z.iso.datetime({ offset: true }),
      seatIds: SeatIds,
      orderId: z.number().int().positive().nullable(),
    }),
  ),
});
export type MyPerformance = z.infer<typeof MyPerformance>;

const PriceMissing = z.object({ error: z.string(), code: z.literal("PRICE_MISSING"), seatIds: SeatIds });

// 409의 이유와, 화면이 다음 행동을 정할 값(DESIGN 6.2 "화면이 받는 것"). code로 가른다.
// SALES_CLOSED: 판매 기간이 아니다. NOT_OPEN이면 serverTime으로 시계를 맞춰 salesOpenAt까지 센다. CLOSED면 판매 종료(salesCloseAt) 뒤다.
// HOLD_LIMIT: 이 회차에 쥔 좌석·산 좌석과 합치면 1인 한도를 넘는다.
// PRICE_MISSING: 담은 좌석 중 이 회차에 가격이 없는 좌석(seatIds)이 있다. 그 좌석을 빼고 다시 고른다.
// SEAT_UNAVAILABLE: 담은 좌석 중 이미 선점·판매됐거나 이 회차의 좌석이 아닌 것(seatIds)이 있다.
export const HoldConflict = z.discriminatedUnion("code", [
  z.object({
    error: z.string(),
    code: z.literal("SALES_CLOSED"),
    reason: z.enum(["NOT_OPEN", "CLOSED"]),
    salesOpenAt: z.iso.datetime({ offset: true }),
    salesCloseAt: z.iso.datetime({ offset: true }),
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
  PriceMissing,
  z.object({ error: z.string(), code: z.literal("SEAT_UNAVAILABLE"), seatIds: SeatIds }),
]);
export type HoldConflict = z.infer<typeof HoldConflict>;

// 가짜 결제의 상황(DESIGN 10장 20). 결제 요청 본문에서 고른다. 각 상황의 뜻은 apps/api/src/fake-pay.ts에 적었다.
export const PaymentScenario = z.enum(["success", "fail", "duplicate", "out_of_order", "early", "lost"]);
export type PaymentScenario = z.infer<typeof PaymentScenario>;

export const OrderStatus = z.enum(["pending", "paid", "cancelled"]);
export type OrderStatus = z.infer<typeof OrderStatus>;
export const PaymentStatus = z.enum(["requested", "succeeded", "failed", "refund_pending", "refunded", "refund_failed"]);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

// 주문 생성 201, 주문 조회, 취소 200이 함께 쓰는 모양(DESIGN 6.2 "화면이 받는 것").
// 선점이 만료됐는데 정리 작업이 아직 돌지 않은 pending 주문은 cancelled(expired)로 보인다.
// payBy(선점 만료 30초 전)가 결제 마감이다. 화면의 타이머는 serverTime으로 시계를 맞춰 payBy와 holdExpiresAt으로 돈다.
// payments는 이 주문의 결제 전부(최신순)이고, tickets는 paid일 때 좌석마다 한 장이다.
export const OrderView = z.object({
  orderId: z.number().int().positive(),
  holdId: z.number().int().positive(),
  performanceId: z.number().int().positive(),
  status: OrderStatus,
  cancelReason: z.enum(["user", "expired"]).nullable(),
  amount: z.number().int().nonnegative(),
  items: z.array(
    z.object({
      seatId: z.number().int().positive(),
      section: z.string(),
      row: z.string(),
      number: z.number().int().positive(),
      grade: z.string(),
      price: z.number().int().nonnegative(),
    }),
  ),
  holdExpiresAt: z.iso.datetime({ offset: true }),
  payBy: z.iso.datetime({ offset: true }),
  serverTime: z.iso.datetime({ offset: true }),
  payments: z.array(
    z.object({
      paymentId: z.number().int().positive(),
      status: PaymentStatus,
      amount: z.number().int().nonnegative(),
      createdAt: z.iso.datetime({ offset: true }),
      updatedAt: z.iso.datetime({ offset: true }),
    }),
  ),
  tickets: z.array(z.object({ ticketId: z.number().int().positive(), seatId: z.number().int().positive() })),
});
export type OrderView = z.infer<typeof OrderView>;

// 취소의 409. 결제가 끝난 주문은 취소할 수 없다(결제 후 취소는 v1에 없다, DESIGN 10장 22). 예매 내역으로 간다.
export const OrderNotCancellable = z.object({
  error: z.string(),
  code: z.literal("ORDER_NOT_CANCELLABLE"),
  orderId: z.number().int().positive(),
});
export type OrderNotCancellable = z.infer<typeof OrderNotCancellable>;

// 같은 Idempotency-Key의 요청을 아직 처리하고 있다. Retry-After 뒤 같은 키로 다시 보낸다.
const RequestInProgress = z.object({ error: z.string(), code: z.literal("REQUEST_IN_PROGRESS") });

// 같은 Idempotency-Key를 다른 요청에 썼다(422). 화면 버그라 새 키로 다시 시작한다.
export const IdempotencyKeyReused = z.object({ error: z.string(), code: z.literal("IDEMPOTENCY_KEY_REUSED") });
export type IdempotencyKeyReused = z.infer<typeof IdempotencyKeyReused>;

// 주문 생성의 409.
// HOLD_EXPIRED: 선점 시간이 끝났다(expiredAt). 좌석을 다시 고른다.
// ORDER_EXISTS: 이 선점으로 만든 주문이 이미 있다(orderId). 그 주문으로 간다.
// PRICE_MISSING: 가격이 없는 좌석이 있다. 선점 때 막으므로 보통은 나지 않는다.
export const CreateOrderConflict = z.discriminatedUnion("code", [
  z.object({ error: z.string(), code: z.literal("HOLD_EXPIRED"), expiredAt: z.iso.datetime({ offset: true }) }),
  z.object({ error: z.string(), code: z.literal("ORDER_EXISTS"), orderId: z.number().int().positive() }),
  PriceMissing,
  RequestInProgress,
]);
export type CreateOrderConflict = z.infer<typeof CreateOrderConflict>;

// 결제 요청 본문. 비어 있으면 기본값이다(success, 웹훅까지 1초).
export const PaymentRequest = z
  .object({
    scenario: PaymentScenario.default("success"),
    delayMs: z.number().int().min(0).max(60_000).default(1000),
  })
  .prefault({});
export type PaymentRequest = z.infer<typeof PaymentRequest>;

// 결제 요청 202. 결과는 웹훅으로 오므로 status는 보통 requested다. 웹훅이 먼저 왔으면 succeeded일 수 있고,
// 결제사가 무효로 거절했으면 대사가 failed로 바꾼 뒤면 failed, 그 전이면 requested다. 화면은 주문 조회로 결과를 기다린다.
export const PaymentAccepted = z.object({
  orderId: z.number().int().positive(),
  paymentId: z.number().int().positive(),
  status: PaymentStatus,
});
export type PaymentAccepted = z.infer<typeof PaymentAccepted>;

// 결제 요청의 409.
// ORDER_NOT_PAYABLE: 결제할 수 없는 주문이다(PAID·CANCELLED·HOLD_EXPIRED·TOO_CLOSE_TO_EXPIRY). 예매 내역이나 좌석 다시 고르기로 간다.
// PAYMENT_IN_PROGRESS: 이 주문의 다른 결제(paymentId)를 확인하고 있다. 다시 보내지 말고 결과를 기다린다.
export const PaymentConflict = z.discriminatedUnion("code", [
  z.object({
    error: z.string(),
    code: z.literal("ORDER_NOT_PAYABLE"),
    orderId: z.number().int().positive(),
    reason: z.enum(["PAID", "CANCELLED", "HOLD_EXPIRED", "TOO_CLOSE_TO_EXPIRY"]),
  }),
  z.object({ error: z.string(), code: z.literal("PAYMENT_IN_PROGRESS"), paymentId: z.number().int().positive() }),
  RequestInProgress,
]);
export type PaymentConflict = z.infer<typeof PaymentConflict>;

// 결제사에 닿지 않았다(503, Retry-After). 같은 키로 다시 보내면 같은 결제(paymentId)를 다시 묻으므로 이중 결제가 없다.
// 화면은 실패가 아니라 "결제 확인 중"으로 보인다.
export const PaymentProviderUnavailable = z.object({
  error: z.string(),
  code: z.literal("PAYMENT_PROVIDER_UNAVAILABLE"),
  paymentId: z.number().int().positive(),
});
export type PaymentProviderUnavailable = z.infer<typeof PaymentProviderUnavailable>;
