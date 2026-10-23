import { randomUUID } from "node:crypto";
import {
  AdminShows,
  AdminVenues,
  PerformanceExists,
  PerformanceInvalid,
  PerformanceSummary,
  PRICE_MAX,
  SeatMap,
} from "@seat-booking/shared";
import { afterAll, describe, expect, inject, it } from "vitest";
import { newPerformance, newSignedInUsers } from "../../test/fixtures.js";
import { buildApp } from "../app.js";
import { createPool } from "../db/pool.js";

describe("관리자 회차 등록", () => {
  const url = inject("databaseUrl");
  const pool = createPool({ connectionString: url });
  // 잠금을 기다리는 앱 연결만 골라 보려고 이름을 붙인다.
  const appPool = createPool({ connectionString: url, application_name: "admin-perf-test" });
  // 누가 어느 회차를 만들었는지 로그에서 확인한다.
  const logs: Record<string, unknown>[] = [];
  const app = buildApp(appPool, { logger: { level: "info", stream: { write: (line: string) => logs.push(JSON.parse(line)) } } });
  afterAll(async () => {
    await app.close();
    await Promise.all([pool.end(), appPool.end()]);
  });

  const newAdmin = async () => (await newSignedInUsers(pool, 1, { role: "admin" }))[0]!;
  const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });
  const create = (headers: Record<string, string>, payload: object) =>
    app.inject({ method: "POST", url: "/admin/performances", headers, payload });

  // 샘플 공연장(VIP 20, R 36, S 42석)을 새로 하나 만들고, 그 공연장과 작품의 id를 돌려준다.
  async function newVenue() {
    const { performanceId } = await newPerformance(pool);
    const { rows } = await pool.query("select venue_id, show_id from performances where id = $1", [performanceId]);
    return { venueId: rows[0].venue_id as number, showId: rows[0].show_id as number };
  }
  const day = 24 * 60 * 60 * 1000;
  const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
  // 40일 뒤 공연, 판매는 어제부터 공연 3시간 전까지
  const body = (venueId: number, show: object, overrides: object = {}) => ({
    show,
    venueId,
    startsAt: at(40 * day),
    salesOpenAt: at(-day),
    salesCloseAt: at(40 * day - 3 * 60 * 60 * 1000),
    prices: { VIP: PRICE_MAX, R: 120000, S: 0 },
    ...overrides,
  });
  const countPerformances = async (venueId: number) =>
    (await pool.query("select count(*)::int as n from performances where venue_id = $1", [venueId])).rows[0].n as number;

  it("공연장은 등급별 좌석 수를 배치 순서로, 작품은 최근 것부터 준다", async () => {
    const { venueId, showId } = await newVenue();
    const admin = await newAdmin();
    const { venues } = AdminVenues.parse((await get("/admin/venues", admin.headers)).json());
    expect(venues.find((v) => v.venueId === venueId)).toEqual({
      venueId,
      name: "샘플 아트홀",
      totalSeats: 98,
      grades: [
        { grade: "VIP", seats: 20 },
        { grade: "R", seats: 36 },
        { grade: "S", seats: 42 },
      ],
    });
    const { shows } = AdminShows.parse((await get("/admin/shows", admin.headers)).json());
    expect(shows.map((s) => s.showId)).toContain(showId);
    expect(shows.map((s) => s.showId)).toEqual([...shows.map((s) => s.showId)].sort((a, b) => b - a));
  });

  it("새 작품 제목으로 등록하면 회차·등급 가격·재고를 한 번에 만들고, 목록·좌석 지도에 나온다. 알 수 없는 키는 버린다", async () => {
    const { venueId } = await newVenue();
    // 재고에 다른 공연장(뒤에 만든 것)의 좌석이 섞이지 않는지 보려고 공연장을 하나 더 만든다
    await newVenue();
    const admin = await newAdmin();
    const title = `새 작품 ${randomUUID()}`;
    const payload = { ...body(venueId, { title: `  ${title} ` }), id: 999, status: "sold_out" };
    const res = await create(admin.headers, payload);
    expect(res.statusCode, res.body).toBe(201);
    const created = PerformanceSummary.parse(res.json());
    expect(created).toMatchObject({ showTitle: title, venueName: "샘플 아트홀" });
    expect(Date.parse(created.startsAt)).toBe(Date.parse(payload.startsAt));
    expect(Date.parse(created.salesCloseAt)).toBe(Date.parse(payload.salesCloseAt));

    const seatMap = SeatMap.parse((await get(`/performances/${created.id}/seats`, {})).json());
    expect(seatMap.seats).toHaveLength(98);
    expect(seatMap.seats.every((s) => s.status === "available")).toBe(true);
    const priceOf = (grade: string) => new Set(seatMap.seats.filter((s) => s.grade === grade).map((s) => s.price));
    expect([priceOf("VIP"), priceOf("R"), priceOf("S")]).toEqual([new Set([PRICE_MAX]), new Set([120000]), new Set([0])]);
    const { rows } = await pool.query("select venue_id from seats where id = any($1::bigint[]) group by venue_id", [
      seatMap.seats.map((s) => s.seatId),
    ]);
    expect(rows).toEqual([{ venue_id: venueId }]);

    expect(logs.some((line) => line.msg === "관리자: 회차 등록" && line.performanceId === created.id && line.adminId === admin.id)).toBe(
      true,
    );
  });

  it("있는 작품 id로도 등록한다. 판매 종료가 공연 시작과 같아도 된다", async () => {
    const { venueId, showId } = await newVenue();
    const admin = await newAdmin();
    const startsAt = at(41 * day);
    const res = await create(admin.headers, body(venueId, { id: showId }, { startsAt, salesCloseAt: startsAt }));
    expect(res.statusCode, res.body).toBe(201);
    const { rows } = await pool.query("select show_id from performances where id = $1", [res.json().id]);
    expect(rows[0].show_id).toBe(showId);
  });

  it("같은 공연장·같은 공연 시작이면(오프셋만 달라도) 409 PERFORMANCE_EXISTS와 그 회차 id이고, 새 작품도 만들지 않는다", async () => {
    const { venueId, showId } = await newVenue();
    const admin = await newAdmin();
    const first = await create(admin.headers, body(venueId, { id: showId }, { startsAt: "2027-03-01T10:00:00Z" }));
    expect(first.statusCode, first.body).toBe(201);

    const title = `겹친 작품 ${randomUUID()}`;
    const again = await create(admin.headers, body(venueId, { title }, { startsAt: "2027-03-01T19:00:00+09:00" }));
    expect(again.statusCode).toBe(409);
    expect(PerformanceExists.parse(again.json()).performanceId).toBe(first.json().id);
    const { rows } = await pool.query("select count(*)::int as n from shows where title = $1", [title]);
    expect(rows[0].n).toBe(0);
  });

  it("동시에 두 번 눌러도 회차는 하나다", async () => {
    const { venueId, showId } = await newVenue();
    const admin = await newAdmin();
    const payload = body(venueId, { id: showId });
    const results = await Promise.all([create(admin.headers, payload), create(admin.headers, payload)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await countPerformances(venueId)).toBe(2);
  });

  async function waitForLockWaiter() {
    for (let i = 0; i < 300; i++) {
      const { rows } = await pool.query(
        `select count(*)::int as n from pg_stat_activity
          where datname = current_database() and application_name = 'admin-perf-test' and wait_event_type = 'Lock'`,
      );
      if (rows[0].n === 1) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("회차 등록이 잠금을 기다리지 않는다");
  }

  it("먼저 넣은 같은 회차가 끝나지 않았으면 기다렸다가, 그쪽이 커밋하면 409와 그 회차 id, 되돌리면 201이다", async () => {
    const { venueId, showId } = await newVenue();
    const admin = await newAdmin();
    for (const [startsAt, outcome] of [
      ["2027-05-01T10:00:00Z", "commit"],
      ["2027-05-02T10:00:00Z", "rollback"],
    ] as const) {
      const holder = await pool.connect();
      try {
        await holder.query("begin");
        const { rows } = await holder.query(
          `insert into performances (show_id, venue_id, starts_at, sales_open_at, sales_close_at)
           values ($1, $2, $3, now(), $3) returning id`,
          [showId, venueId, startsAt],
        );
        const pending = create(admin.headers, body(venueId, { id: showId }, { startsAt, salesCloseAt: startsAt }));
        await waitForLockWaiter();
        await holder.query(outcome);
        const res = await pending;
        if (outcome === "commit") {
          expect(res.statusCode, res.body).toBe(409);
          expect(PerformanceExists.parse(res.json()).performanceId).toBe(rows[0].id);
        } else {
          expect(res.statusCode, res.body).toBe(201);
        }
      } finally {
        await holder.query("rollback");
        holder.release();
      }
    }
  });

  it("등록할 수 없는 이유를 모두 모아 422 PERFORMANCE_INVALID이고 아무것도 넣지 않는다", async () => {
    const { venueId, showId } = await newVenue();
    const admin = await newAdmin();
    const problems = async (payload: object) => {
      const res = await create(admin.headers, payload);
      expect(res.statusCode, res.body).toBe(422);
      return PerformanceInvalid.parse(res.json()).problems;
    };

    expect(
      await problems(body(999999999, { id: 999999999 }, { salesOpenAt: at(2 * day), salesCloseAt: at(day) })),
    ).toEqual([{ reason: "VENUE_NOT_FOUND" }, { reason: "SHOW_NOT_FOUND" }, { reason: "SALES_WINDOW_INVALID" }]);
    expect(await problems(body(venueId, { id: showId }, { prices: { VIP: 1, R: 1, X: 1, A: 1 } }))).toEqual([
      { reason: "MISSING_GRADES", grades: ["S"] },
      { reason: "UNKNOWN_GRADES", grades: ["A", "X"] },
    ]);
    // 판매 시작 = 판매 종료, 판매 종료 > 공연 시작
    const startsAt = at(42 * day);
    expect(await problems(body(venueId, { id: showId }, { startsAt, salesOpenAt: startsAt, salesCloseAt: startsAt }))).toEqual([
      { reason: "SALES_WINDOW_INVALID" },
    ]);
    expect(await problems(body(venueId, { id: showId }, { startsAt, salesCloseAt: at(42 * day + 1000) }))).toEqual([
      { reason: "SALES_WINDOW_INVALID" },
    ]);
    // 판매 종료가 이미 지났다(공연도 지났다)
    expect(
      await problems(body(venueId, { id: showId }, { startsAt: at(-day), salesOpenAt: at(-3 * day), salesCloseAt: at(-2 * day) })),
    ).toEqual([{ reason: "SALES_CLOSE_PASSED" }]);
    // 같은 제목의 작품이 이미 있으면 그 작품 id를 준다
    const { rows } = await pool.query("select title from shows where id = $1", [showId]);
    const sameTitle = await problems(body(venueId, { title: ` ${rows[0].title}` }));
    expect(sameTitle).toHaveLength(1);
    expect(sameTitle[0]).toMatchObject({ reason: "SHOW_TITLE_EXISTS" });
    // 좌석 배치가 없는 공연장은 없는 공연장과 같다
    const empty = await pool.query("insert into venues (name) values ('빈 홀') returning id");
    expect(await problems(body(empty.rows[0].id, { id: showId }, { prices: {} }))).toEqual([{ reason: "VENUE_NOT_FOUND" }]);

    expect(await countPerformances(venueId)).toBe(1);
    expect(logs.some((line) => line.msg === "관리자: 회차 등록 거절" && line.adminId === admin.id)).toBe(true);
  });

  it("본문 형식이 틀리면 400이다(가격 범위, 작품 제목 1~200자, 빠진 판매 종료)", async () => {
    const { venueId, showId } = await newVenue();
    const admin = await newAdmin();
    const { salesCloseAt: _, ...withoutClose } = body(venueId, { id: showId });
    const cases: [string, object][] = [
      ["가격 1천만 원 초과", body(venueId, { id: showId }, { prices: { VIP: PRICE_MAX + 1, R: 1, S: 1 } })],
      ["음수 가격", body(venueId, { id: showId }, { prices: { VIP: -1, R: 1, S: 1 } })],
      ["소수 가격", body(venueId, { id: showId }, { prices: { VIP: 1.5, R: 1, S: 1 } })],
      ["빈 제목", body(venueId, { title: "   " })],
      ["201자 제목", body(venueId, { title: "가".repeat(201) })],
      ["작품 없음", body(venueId, {})],
      ["작품 id와 제목이 함께", body(venueId, { id: showId, title: "새 제목" })],
      ["문자열 id와 제목(select 값)", body(venueId, { id: String(showId), title: "새 제목" })],
      ["0년 시각", body(venueId, { id: showId }, { salesOpenAt: "0000-01-01T00:00:00Z" })],
      ["2100년 시각", body(venueId, { id: showId }, { startsAt: "2100-01-01T00:00:00Z" })],
      ["초 없는 시각", body(venueId, { id: showId }, { startsAt: "2027-03-01T19:00+09:00" })],
      ["판매 종료 없음", withoutClose],
      ["공연장 id 문자열", body(venueId, { id: showId }, { venueId: String(venueId) })],
    ];
    for (const [name, payload] of cases) {
      expect((await create(admin.headers, payload)).statusCode, name).toBe(400);
    }
    expect(await countPerformances(venueId)).toBe(1);
  });
});
