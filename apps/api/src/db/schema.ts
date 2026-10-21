import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, primaryKey, text, timestamp, unique } from "drizzle-orm/pg-core";

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
  ],
);
