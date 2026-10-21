import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./client.js";
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
          grade: z.string().min(1),
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
          prices: z.record(z.string(), z.number().int().nonnegative()),
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

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// 공연장·좌석·작품·회차·등급 가격을 넣고, 회차마다 그 공연장의 좌석으로 재고를 만든다. 전부 한 트랜잭션이다.
export function seed(db: Db, data: SeedData) {
  return db.transaction((tx) => seedInto(tx, data));
}

// 이미 연 트랜잭션 안에서 넣는다. 중간에 실패하면 그 트랜잭션 전체가 되돌려진다.
// 좌석이 회차의 공연장 것인지는 DB 제약 대신 여기서 지킨다(재고를 그 공연장의 좌석에서만 뽑는다).
export async function seedInto(tx: Tx, data: SeedData) {
  const grades = new Set(data.venue.rows.map((r) => r.grade));
  for (const show of data.shows) {
    for (const p of show.performances) {
      const missing = [...grades].filter((g) => !(g in p.prices));
      if (missing.length) throw new Error(`${show.title} ${p.startsAt} 회차에 가격이 없는 등급: ${missing.join(", ")}`);
    }
  }

  const [venue] = await tx.insert(venues).values({ name: data.venue.name }).returning({ id: venues.id });
  const venueId = venue!.id;

  await tx.insert(seats).values(
    data.venue.rows.flatMap((r) =>
      Array.from({ length: r.seats }, (_, i) => ({
        venueId,
        section: r.section,
        rowLabel: r.row,
        seatNumber: i + 1,
        grade: r.grade,
      })),
    ),
  );

  const performanceIds: number[] = [];
  for (const show of data.shows) {
    const [s] = await tx.insert(shows).values({ title: show.title }).returning({ id: shows.id });
    for (const p of show.performances) {
      const [perf] = await tx
        .insert(performances)
        .values({ showId: s!.id, venueId, startsAt: new Date(p.startsAt), salesOpenAt: new Date(p.salesOpenAt) })
        .returning({ id: performances.id });
      const performanceId = perf!.id;
      performanceIds.push(performanceId);

      await tx
        .insert(performanceGrades)
        .values(Object.entries(p.prices).map(([grade, price]) => ({ performanceId, grade, price })));
      await tx.execute(sql`
        insert into performance_seats (performance_id, seat_id)
        select ${performanceId}, id from seats where venue_id = ${venueId}
      `);
    }
  }
  return { venueId, performanceIds };
}
