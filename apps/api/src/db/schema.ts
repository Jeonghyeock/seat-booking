import { bigint, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

export const venues = pgTable("venues", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// 공연장의 고정 좌석 배치. 회차별 판매 상태는 1단계의 performance_seats가 맡는다.
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
