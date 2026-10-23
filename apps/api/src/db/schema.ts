import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const venues = pgTable("venues", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// 공연장의 고정 좌석 배치. 회차별 판매 상태는 performance_seats가 맡는다.
export const seats = pgTable(
  "seats",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    venueId: bigint("venue_id", { mode: "number" })
      .notNull()
      .references(() => venues.id),
    section: text("section").notNull(),
    rowLabel: text("row_label").notNull(),
    seatNumber: integer("seat_number").notNull(),
    grade: text("grade").notNull(),
  },
  // venue_id가 맨 앞이라 외래 키 조회에도 이 인덱스가 쓰인다.
  (t) => [unique("seats_position_unique").on(t.venueId, t.section, t.rowLabel, t.seatNumber)],
);

// 공연 작품. 제목을 회차마다 되풀이하지 않으려고 회차와 나눈다.
export const shows = pgTable("shows", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  title: text("title").notNull(),
});

// 회차. 같은 작품을 여러 날, 여러 공연장에서 할 수 있다.
export const performances = pgTable(
  "performances",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    showId: bigint("show_id", { mode: "number" })
      .notNull()
      .references(() => shows.id),
    venueId: bigint("venue_id", { mode: "number" })
      .notNull()
      .references(() => venues.id),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    salesOpenAt: timestamp("sales_open_at", { withTimezone: true }).notNull(),
  },
  (t) => [check("performances_sales_before_start", sql`${t.salesOpenAt} < ${t.startsAt}`)],
);

// 회차별 등급 가격. 가격은 좌석마다가 아니라 등급마다 정해진다.
export const performanceGrades = pgTable(
  "performance_grades",
  {
    performanceId: bigint("performance_id", { mode: "number" })
      .notNull()
      .references(() => performances.id),
    grade: text("grade").notNull(),
    price: integer("price").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.performanceId, t.grade] }),
    check("performance_grades_price_not_negative", sql`${t.price} >= 0`),
  ],
);

// 선점하는 사람. 2단계에서는 선점을 누가 했는지만 가리키면 되므로 최소한만 둔다. 비밀번호·세션·역할은 4단계에서 더한다.
export const users = pgTable("users", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// 선점 묶음. 요청 하나로 잡은 좌석들이 같은 hold를 가리킨다.
export const holds = pgTable(
  "holds",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id),
    performanceId: bigint("performance_id", { mode: "number" })
      .notNull()
      .references(() => performances.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // 1인 한도를 셀 때 "이 사용자가 이 회차에 만든 선점"을 찾는다.
  (t) => [index("holds_user_performance_idx").on(t.userId, t.performanceId)],
);

export const SEAT_STATUSES = ["available", "held", "sold"] as const;

// 회차의 좌석 재고. 기본 키가 (performance_id, seat_id)라, "이 회차의 좌석 지도" 조회는 이 인덱스를 앞쪽 열로 쓴다.
// 선점 만료 시각은 holds와 이 표에 함께 둔다. 조건부 UPDATE가 잠금을 기다린 뒤 조건을 다시 볼 때,
// 고치려는 행의 열은 새 값으로 보지만 다른 표는 문장을 시작할 때의 값으로 본다(DESIGN 6.1).
// 그래서 만료 판단에 쓰는 값은 이 행에 있어야 한다.
export const performanceSeats = pgTable(
  "performance_seats",
  {
    performanceId: bigint("performance_id", { mode: "number" })
      .notNull()
      .references(() => performances.id),
    seatId: bigint("seat_id", { mode: "number" })
      .notNull()
      .references(() => seats.id),
    status: text("status", { enum: SEAT_STATUSES }).notNull().default("available"),
    holdId: bigint("hold_id", { mode: "number" }).references(() => holds.id),
    holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.performanceId, t.seatId] }),
    check("performance_seats_status_valid", sql`${t.status} in ('available', 'held', 'sold')`),
    // 빈 좌석에만 선점이 없다. 팔린 좌석은 어느 선점에서 팔렸는지 남긴다(3단계).
    check("performance_seats_hold_matches_status", sql`(${t.status} = 'available') = (${t.holdId} is null)`),
    check("performance_seats_hold_fields_together", sql`(${t.holdId} is null) = (${t.holdExpiresAt} is null)`),
    // 선점에 묶인 좌석을 찾는다(1인 한도, 3단계 결제). holds 행을 지울 때 외래 키 확인에도 쓰인다.
    index("performance_seats_hold_id_idx").on(t.holdId),
    // 정리 작업이 만료된 선점 좌석을 찾는다(DESIGN 6.2 정리 1).
    index("performance_seats_held_expiry_idx").on(t.holdExpiresAt).where(sql`${t.status} = 'held'`),
  ],
);

// ── 3단계: 주문, 결제, 표, 멱등 키(DESIGN 5장·6.2) ──

export const ORDER_STATUSES = ["pending", "paid", "cancelled"] as const;
export const CANCEL_REASONS = ["user", "expired"] as const;

// 주문. 선점 하나에 주문 하나다(hold_id unique). amount는 order_items 가격의 합을 만들 때 복사한다.
// 상태 전이는 모두 조건부 UPDATE(WHERE status = 이전 상태)로 한다. pending → paid | cancelled.
export const orders = pgTable(
  "orders",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id),
    holdId: bigint("hold_id", { mode: "number" })
      .notNull()
      .unique()
      .references(() => holds.id),
    status: text("status", { enum: ORDER_STATUSES }).notNull().default("pending"),
    amount: integer("amount").notNull(),
    cancelReason: text("cancel_reason", { enum: CANCEL_REASONS }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("orders_status_valid", sql`${t.status} in ('pending', 'paid', 'cancelled')`),
    check("orders_amount_not_negative", sql`${t.amount} >= 0`),
    check("orders_cancel_reason_valid", sql`${t.cancelReason} in ('user', 'expired')`),
    // 취소된 주문에만 이유가 있다.
    check("orders_cancel_reason_matches_status", sql`(${t.status} = 'cancelled') = (${t.cancelReason} is not null)`),
    // 정리 작업이 선점이 만료된 pending 주문을 찾는다(DESIGN 6.2 정리 2).
    index("orders_pending_hold_idx").on(t.holdId).where(sql`${t.status} = 'pending'`),
  ],
);

// 주문할 때의 좌석과 가격. 결제 확정 때 이 좌석이 모두 남았는지 본다.
// 취소·만료로 좌석 재고의 hold_id가 비어도 주문이 어떤 좌석이었는지 남는다.
export const orderItems = pgTable(
  "order_items",
  {
    orderId: bigint("order_id", { mode: "number" })
      .notNull()
      .references(() => orders.id),
    seatId: bigint("seat_id", { mode: "number" })
      .notNull()
      .references(() => seats.id),
    price: integer("price").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orderId, t.seatId] }),
    check("order_items_price_not_negative", sql`${t.price} >= 0`),
  ],
);

export const PAYMENT_STATUSES = [
  "requested",
  "succeeded",
  "failed",
  "refund_pending",
  "refunded",
  "refund_failed",
] as const;

// 결제 시도마다 한 행이다. 결제사를 부르기 전에 넣고 커밋하며, id가 결제사 쪽 멱등 키다(DESIGN 6.2).
// provider_ref(결제사의 결제 번호)는 결제사가 답한 뒤 채운다. 나중에 채우는 열이라 부분 unique로 둔다.
// 부분이 아닌 unique면 외래 키가 가리킬 수 있는 열이 되어, 채우는 UPDATE가 FOR UPDATE 강도로 잠근다(설계 리뷰 E6).
export const payments = pgTable(
  "payments",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orderId: bigint("order_id", { mode: "number" })
      .notNull()
      .references(() => orders.id),
    providerRef: text("provider_ref"),
    status: text("status", { enum: PAYMENT_STATUSES }).notNull().default("requested"),
    amount: integer("amount").notNull(),
    // 이 결제를 만든 결제 요청의 Idempotency-Key. 같은 키로 다시 보내면 이 결제를 찾아 다시 쓴다.
    idempotencyKey: text("idempotency_key").notNull(),
    refundAttempts: integer("refund_attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "payments_status_valid",
      sql`${t.status} in ('requested', 'succeeded', 'failed', 'refund_pending', 'refunded', 'refund_failed')`,
    ),
    check("payments_amount_not_negative", sql`${t.amount} >= 0`),
    check("payments_refund_attempts_not_negative", sql`${t.refundAttempts} >= 0`),
    uniqueIndex("payments_provider_ref_unique").on(t.providerRef).where(sql`${t.providerRef} is not null`),
    // 같은 키로 결제 행이 둘 생기지 않는다.
    unique("payments_order_idempotency_key_unique").on(t.orderId, t.idempotencyKey),
    // 진행 중인 결제와 성공한 결제는 주문마다 하나다.
    uniqueIndex("payments_one_requested_per_order").on(t.orderId).where(sql`${t.status} = 'requested'`),
    uniqueIndex("payments_one_succeeded_per_order").on(t.orderId).where(sql`${t.status} = 'succeeded'`),
    // 주문의 결제를 최신순으로 보여 준다(OrderView).
    index("payments_order_created_idx").on(t.orderId, t.createdAt),
    // 대사(오래된 requested), 환불(refund_pending), 관리자 목록(refund_failed)이 찾는다.
    index("payments_requested_created_idx").on(t.createdAt).where(sql`${t.status} = 'requested'`),
    index("payments_refund_pending_created_idx").on(t.createdAt).where(sql`${t.status} = 'refund_pending'`),
    index("payments_refund_failed_updated_idx").on(t.updatedAt).where(sql`${t.status} = 'refund_failed'`),
  ],
);

export const WEBHOOK_RESULTS = ["processed", "ignored", "unmatched"] as const;

// 받은 웹훅(inbox). 처리와 같은 트랜잭션에서 넣는다. 처리가 되돌려지면 이 행도 사라져, 결제사가 다시 보낼 때 다시 처리한다.
// payment_id에는 외래 키를 두지 않는다. 모르는 결제의 웹훅(unmatched)도 남겨야 하고,
// 외래 키 확인 잠금(FOR KEY SHARE)이 결제 행 갱신과 부딪히지 않게 하려는 것이다(DESIGN 6.2).
export const paymentWebhooks = pgTable(
  "payment_webhooks",
  {
    eventId: text("event_id").primaryKey(),
    paymentId: bigint("payment_id", { mode: "number" }),
    type: text("type").notNull(),
    result: text("result", { enum: WEBHOOK_RESULTS }).notNull(),
    body: jsonb("body").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("payment_webhooks_result_valid", sql`${t.result} in ('processed', 'ignored', 'unmatched')`)],
);

export const TICKET_STATUSES = ["valid", "cancelled"] as const;

// 결제 확정 때 좌석마다 한 장. 3단계에는 valid만 생긴다(결제 후 취소가 없다, DESIGN 10장 22).
// 한 좌석에 유효한 표는 하나다(부분 unique). 앱 코드에 버그가 있어도 DB가 두 번 판매를 거부한다(DESIGN 6.1의 ④).
export const tickets = pgTable(
  "tickets",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orderId: bigint("order_id", { mode: "number" })
      .notNull()
      .references(() => orders.id),
    performanceId: bigint("performance_id", { mode: "number" }).notNull(),
    seatId: bigint("seat_id", { mode: "number" }).notNull(),
    status: text("status", { enum: TICKET_STATUSES }).notNull().default("valid"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 회차에 실제로 있는 좌석만 표가 된다.
    foreignKey({
      name: "tickets_performance_seat_fk",
      columns: [t.performanceId, t.seatId],
      foreignColumns: [performanceSeats.performanceId, performanceSeats.seatId],
    }),
    check("tickets_status_valid", sql`${t.status} in ('valid', 'cancelled')`),
    uniqueIndex("tickets_one_valid_per_seat").on(t.performanceId, t.seatId).where(sql`${t.status} = 'valid'`),
    index("tickets_order_idx").on(t.orderId),
  ],
);

export const IDEMPOTENCY_STATUSES = ["processing", "done"] as const;

// Idempotency-Key 하나. 키는 사용자와 경로마다 따로다(같은 키를 다른 경로에 써도 서로의 응답을 받지 않는다).
// 업무를 시작하기 전에 따로 커밋해 넣고(processing), 응답은 업무 트랜잭션 안에서 저장한다(done).
// owner_token이 지금 처리하는 요청을 가리킨다. 저장·삭제·넘겨받기는 owner_token이 맞을 때만 한다(DESIGN 6.2).
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id),
    route: text("route").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status", { enum: IDEMPOTENCY_STATUSES }).notNull().default("processing"),
    ownerToken: uuid("owner_token").notNull(),
    responseCode: integer("response_code"),
    responseBody: jsonb("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.route, t.key] }),
    check("idempotency_keys_status_valid", sql`${t.status} in ('processing', 'done')`),
    check("idempotency_keys_key_length", sql`char_length(${t.key}) between 1 and 255`),
    // 끝난 키에만 응답이 있다.
    check(
      "idempotency_keys_response_matches_status",
      sql`(${t.status} = 'done') = (${t.responseCode} is not null and ${t.responseBody} is not null)`,
    ),
    // 24시간 지난 키를 지운다(DESIGN 6.2 정리 5).
    index("idempotency_keys_created_idx").on(t.createdAt),
  ],
);
