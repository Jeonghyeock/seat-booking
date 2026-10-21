import { sql } from "drizzle-orm";
import { bigint, check, integer, pgTable, primaryKey, text, timestamp, unique } from "drizzle-orm/pg-core";

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

export const SEAT_STATUSES = ["available", "held", "sold"] as const;

// 회차의 좌석 재고. 판매 상태만 둔다(선점용 열은 2단계에서 더한다).
// 기본 키가 (performance_id, seat_id)라, "이 회차의 좌석 지도" 조회는 이 인덱스를 앞쪽 열로 쓴다.
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
  },
  (t) => [
    primaryKey({ columns: [t.performanceId, t.seatId] }),
    check("performance_seats_status_valid", sql`${t.status} in ('available', 'held', 'sold')`),
  ],
);
