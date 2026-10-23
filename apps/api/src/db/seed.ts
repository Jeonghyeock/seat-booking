import { readFileSync } from "node:fs";
import { GradeName } from "@seat-booking/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "./client.js";
import { performanceGrades, performances, seats, shows, venues } from "./schema.js";

// 시드 JSON의 모양. 좌석 배치는 줄마다 "몇 석, 어느 등급"으로 적는다.
export const SeedData = z.object({
  venue: z.object({
    name: z.string().min(1),
    rows: z
      .array(
        z.object({
          section: z.string().min(1),
          row: z.string().min(1),
          seats: z.number().int().positive(),
          grade: GradeName,
        }),
      )
      .min(1),
  }),
  shows: z.array(
    z.object({
      title: z.string().min(1),
      performances: z.array(
        z.object({
          startsAt: z.iso.datetime({ offset: true }),
          salesOpenAt: z.iso.datetime({ offset: true }),
          salesCloseAt: z.iso.datetime({ offset: true }),
          prices: z.record(GradeName, z.number().int().nonnegative()),
        }),
      ),
    }),
  ),
});
export type SeedData = z.infer<typeof SeedData>;

export function readSeedFile(path: URL): SeedData {
  return SeedData.parse(JSON.parse(readFileSync(path, "utf8")));
}

export const SAMPLE_SEED = new URL("../../seed/sample.json", import.meta.url);

// 공연장·좌석·작품·회차·등급 가격을 넣고, 회차마다 그 공연장의 좌석으로 재고를 만든다. 전부 한 트랜잭션이다.
export function seed(db: Db, data: SeedData) {
  return db.transaction((tx) => seedInto(tx, data));
}

// 이미 연 트랜잭션 안에서 넣는다. 중간에 실패하면 그 트랜잭션 전체가 되돌려진다.
// 회차의 가격 등급이 공연장 좌석의 등급과 정확히 같아야 한다(관리자 회차 등록과 같은 규칙).
export async function seedInto(tx: Tx, data: SeedData) {
  const grades = new Set(data.venue.rows.map((r) => r.grade));
  for (const show of data.shows) {
    for (const p of show.performances) {
      const missing = [...grades].filter((g) => !Object.hasOwn(p.prices, g));
      if (missing.length) throw new Error(`${show.title} ${p.startsAt} 회차에 가격이 없는 등급: ${missing.join(", ")}`);
      const unknown = Object.keys(p.prices).filter((g) => !grades.has(g));
      if (unknown.length) throw new Error(`${show.title} ${p.startsAt} 회차에 좌석이 없는 등급: ${unknown.join(", ")}`);
    }
  }

  const venueId = await insertVenue(tx, data.venue);
  const performanceIds: number[] = [];
  for (const show of data.shows) {
    const [s] = await tx.insert(shows).values({ title: show.title }).returning({ id: shows.id });
    for (const p of show.performances) {
      performanceIds.push(
        await insertPerformance(tx, {
          showId: s!.id,
          venueId,
          startsAt: new Date(p.startsAt),
          salesOpenAt: new Date(p.salesOpenAt),
          salesCloseAt: new Date(p.salesCloseAt),
          prices: p.prices,
        }),
      );
    }
  }
  return { venueId, performanceIds };
}

// 한 문장의 파라미터는 65,535개까지다. 좌석 하나에 5개라 이만큼씩 나눠 넣는다.
const SEAT_INSERT_BATCH = 10_000;

// 공연장과 좌석 배치를 넣는다. 공연장(좌석 배치) 등록은 시드로만 한다(DESIGN 6.3 관리자 기능).
export async function insertVenue(tx: Tx, venue: SeedData["venue"]) {
  const [row] = await tx.insert(venues).values({ name: venue.name }).returning({ id: venues.id });
  const venueId = row!.id;
  const seatRows = venue.rows.flatMap((r) =>
    Array.from({ length: r.seats }, (_, i) => ({
      venueId,
      section: r.section,
      rowLabel: r.row,
      seatNumber: i + 1,
      grade: r.grade,
    })),
  );
  for (let i = 0; i < seatRows.length; i += SEAT_INSERT_BATCH) {
    await tx.insert(seats).values(seatRows.slice(i, i + SEAT_INSERT_BATCH));
  }
  return venueId;
}

export type NewPerformance = {
  showId: number;
  venueId: number;
  startsAt: Date;
  salesOpenAt: Date;
  salesCloseAt: Date;
  prices: Record<string, number>;
};

// 같은 공연장·같은 공연 시작의 회차가 이미 있다(performances_venue_starts_unique).
export class DuplicatePerformanceError extends Error {
  override name = "DuplicatePerformanceError";
}

// 회차와 등급 가격을 넣고, 그 공연장의 좌석으로 재고를 만든다. 시드와 관리자 회차 등록이 함께 쓴다.
// 넣을 열을 하나씩 적는다. 등급 가격이 그 공연장 좌석의 등급과 맞는지는 호출자가 본다.
// 좌석이 회차의 공연장 것인지는 DB 제약 대신 여기서 지킨다(재고를 그 공연장의 좌석에서만 뽑는다).
// 같은 공연장·공연 시작의 회차가 이미 있으면 DuplicatePerformanceError를 던진다(호출자의 트랜잭션이 되돌려진다).
export async function insertPerformance(tx: Tx, p: NewPerformance) {
  const [row] = await tx
    .insert(performances)
    .values({
      showId: p.showId,
      venueId: p.venueId,
      startsAt: p.startsAt,
      salesOpenAt: p.salesOpenAt,
      salesCloseAt: p.salesCloseAt,
    })
    .onConflictDoNothing({ target: [performances.venueId, performances.startsAt] })
    .returning({ id: performances.id });
  if (!row) throw new DuplicatePerformanceError(`공연장 ${p.venueId}에 ${p.startsAt.toISOString()} 회차가 이미 있습니다`);
  const performanceId = row.id;

  await tx
    .insert(performanceGrades)
    .values(Object.entries(p.prices).map(([grade, price]) => ({ performanceId, grade, price })));
  await tx.execute(sql`
    insert into performance_seats (performance_id, seat_id)
    select ${performanceId}, id from seats where venue_id = ${p.venueId}
  `);
  return performanceId;
}
