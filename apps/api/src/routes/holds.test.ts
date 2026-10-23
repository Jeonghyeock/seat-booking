import { HoldConflict, HoldResponse, SeatMap } from "@seat-booking/shared";
import { afterAll, describe, expect, inject, it } from "vitest";
import { authHeaders, expectUnauthenticated, newPerformance, newSignedInUserIds, unauthenticatedHeaders } from "../../test/fixtures.js";
import { buildApp } from "../app.js";
import { createPool } from "../db/pool.js";

describe("POST /performances/:id/holds", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  const app = buildApp(pool);
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const hold = (performanceId: number, userId: number | string | undefined, seatIds: unknown) =>
    app.inject({
      method: "POST",
      url: `/performances/${performanceId}/holds`,
      headers: userId === undefined ? {} : authHeaders(userId),
      payload: { seatIds },
    });

  const conflict = (res: Awaited<ReturnType<typeof hold>>) => {
    expect(res.statusCode).toBe(409);
    return HoldConflict.parse(res.json());
  };

  async function statuses(performanceId: number) {
    const res = await app.inject({ method: "GET", url: `/performances/${performanceId}/seats` });
    return new Map(SeatMap.parse(res.json()).seats.map((s) => [s.seatId, s.status]));
  }

  it("빈 좌석을 선점하면 201이고, 좌석 지도에 held로 보이며, 좌석과 선점 행의 만료 시각이 같다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [userId] = await newSignedInUserIds(pool, 1);

    const res = await hold(performanceId, userId, [seatIds[1], seatIds[0]]);
    expect(res.statusCode).toBe(201);
    const body = HoldResponse.parse(res.json());
    expect(body.seatIds).toEqual([seatIds[0], seatIds[1]]);
    const minutesLeft = (Date.parse(body.expiresAt) - Date.now()) / 60_000;
    expect(minutesLeft).toBeGreaterThan(4);
    expect(minutesLeft).toBeLessThanOrEqual(5);
    // 만료 시각은 서버 시각(트랜잭션을 시작한 DB 시각)에서 정확히 5분 뒤다
    expect(Date.parse(body.expiresAt) - Date.parse(body.serverTime)).toBe(5 * 60_000);

    const map = await statuses(performanceId);
    expect([map.get(seatIds[0]!), map.get(seatIds[1]!), map.get(seatIds[2]!)]).toEqual(["held", "held", "available"]);

    const { rows } = await pool.query(
      `select h.user_id, count(*)::int as seats, bool_and(ps.hold_expires_at = h.expires_at) as same_expiry
         from performance_seats ps join holds h on h.id = ps.hold_id
        where ps.hold_id = $1
        group by h.user_id`,
      [body.holdId],
    );
    expect(rows).toEqual([{ user_id: userId, seats: 2, same_expiry: true }]);
  });

  it("담은 좌석 중 하나라도 선점돼 있으면 409이고, 나머지 좌석도 잡지 않는다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [first, second] = await newSignedInUserIds(pool, 2);
    expect((await hold(performanceId, first, [seatIds[1]])).statusCode).toBe(201);

    // 안 되는 좌석만 돌려준다
    expect(conflict(await hold(performanceId, second, [seatIds[0], seatIds[1]]))).toMatchObject({
      code: "SEAT_UNAVAILABLE",
      seatIds: [seatIds[1]],
    });
    expect((await statuses(performanceId)).get(seatIds[0]!)).toBe("available");
    const { rows } = await pool.query("select count(*) as n from holds where user_id = $1", [second]);
    expect(rows[0].n).toBe(0);
  });

  it("만료된 선점은 좌석 지도에서 빈 좌석이고, 다른 사람이 다시 선점할 수 있다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [first, second] = await newSignedInUserIds(pool, 2);
    const firstHold = HoldResponse.parse((await hold(performanceId, first, [seatIds[0]])).json());

    // 5분을 기다리지 않고 만료 시각을 과거로 돌린다(DESIGN 10장 2)
    await pool.query("update holds set expires_at = now() - interval '1 second' where id = $1", [firstHold.holdId]);
    await pool.query("update performance_seats set hold_expires_at = now() - interval '1 second' where hold_id = $1", [
      firstHold.holdId,
    ]);
    expect((await statuses(performanceId)).get(seatIds[0]!)).toBe("available");

    const res = await hold(performanceId, second, [seatIds[0]]);
    expect(res.statusCode).toBe(201);
    const { rows } = await pool.query(
      "select hold_id from performance_seats where performance_id = $1 and seat_id = $2",
      [performanceId, seatIds[0]],
    );
    expect(rows[0].hold_id).toBe(HoldResponse.parse(res.json()).holdId);
  });

  it("이 회차에 없는 좌석을 담으면 409 SEAT_UNAVAILABLE", async () => {
    const { performanceId } = await newPerformance(pool);
    const other = await newPerformance(pool);
    const [userId] = await newSignedInUserIds(pool, 1);
    expect(conflict(await hold(performanceId, userId, [other.seatIds[0]]))).toMatchObject({
      code: "SEAT_UNAVAILABLE",
      seatIds: [other.seatIds[0]],
    });
  });

  it("판매가 열리기 전이나 판매 종료 뒤에는 409 SALES_CLOSED이고, 판단에 쓴 시각을 함께 준다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [userId] = await newSignedInUserIds(pool, 1);

    const opening = await pool.query(
      "update performances set sales_open_at = now() + interval '1 hour' where id = $1 returning sales_open_at, sales_close_at, starts_at",
      [performanceId],
    );
    const notOpen = conflict(await hold(performanceId, userId, [seatIds[0]]));
    if (notOpen.code !== "SALES_CLOSED") throw new Error(notOpen.code);
    expect(notOpen).toMatchObject({
      reason: "NOT_OPEN",
      salesOpenAt: opening.rows[0].sales_open_at.toISOString(),
      salesCloseAt: opening.rows[0].sales_close_at.toISOString(),
      startsAt: opening.rows[0].starts_at.toISOString(),
    });
    expect(Date.parse(notOpen.serverTime)).toBeLessThan(Date.parse(notOpen.salesOpenAt));

    // 판매는 닫혔지만 공연은 아직 시작하지 않았다
    await pool.query(
      "update performances set sales_open_at = now() - interval '2 hours', sales_close_at = now() - interval '1 hour' where id = $1",
      [performanceId],
    );
    const closed = conflict(await hold(performanceId, userId, [seatIds[0]]));
    if (closed.code !== "SALES_CLOSED") throw new Error(closed.code);
    expect(closed).toMatchObject({ reason: "CLOSED", error: "예매가 마감되었습니다" });
    expect(Date.parse(closed.serverTime)).toBeGreaterThanOrEqual(Date.parse(closed.salesCloseAt));
    expect(Date.parse(closed.serverTime)).toBeLessThan(Date.parse(closed.startsAt));

    const { rows } = await pool.query("select count(*) as n from holds where user_id = $1", [userId]);
    expect(rows[0].n).toBe(0);
    expect((await statuses(performanceId)).get(seatIds[0]!)).toBe("available");
  });

  it("판매 종료 직전에 잡은 선점도 5분을 다 받는다(판매 종료로 자르지 않는다)", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [userId] = await newSignedInUserIds(pool, 1);
    await pool.query("update performances set sales_close_at = now() + interval '1 minute' where id = $1", [performanceId]);
    const res = await hold(performanceId, userId, [seatIds[0]]);
    expect(res.statusCode).toBe(201);
    const body = HoldResponse.parse(res.json());
    expect(Date.parse(body.expiresAt) - Date.parse(body.serverTime)).toBe(5 * 60_000);
  });

  it("공연 시작이 5분 안이면 선점은 공연 시작에 끝난다(판매 종료가 공연 시작과 같은 회차)", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [userId] = await newSignedInUserIds(pool, 1);
    await pool.query(
      "update performances set sales_close_at = now() + interval '2 minutes', starts_at = now() + interval '2 minutes' where id = $1",
      [performanceId],
    );

    const res = await hold(performanceId, userId, [seatIds[0], seatIds[1]]);
    expect(res.statusCode).toBe(201);
    const { holdId } = HoldResponse.parse(res.json());
    // 밀리초로 바꾸지 않고 DB에서 그대로 비교한다
    const { rows } = await pool.query(
      `select h.expires_at = p.starts_at as capped, bool_and(ps.hold_expires_at = h.expires_at) as same_expiry
         from holds h
         join performances p on p.id = h.performance_id
         join performance_seats ps on ps.hold_id = h.id
        where h.id = $1
        group by h.expires_at, p.starts_at`,
      [holdId],
    );
    expect(rows).toEqual([{ capped: true, same_expiry: true }]);
  });

  it("담은 좌석 중 이 회차에 등급 가격이 없는 좌석이 있으면 409 PRICE_MISSING이고, 어느 좌석도 잡지 않는다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [userId] = await newSignedInUserIds(pool, 1);
    const { rows: grades } = await pool.query<{ seat_id: number; grade: string }>(
      "select id as seat_id, grade from seats where id = any($1::bigint[]) order by id",
      [seatIds],
    );
    const missing = grades[0]!.grade;
    const unpriced = grades.filter((s) => s.grade === missing).map((s) => s.seat_id);
    const priced = grades.find((s) => s.grade !== missing)!.seat_id;
    await pool.query("delete from performance_grades where performance_id = $1 and grade = $2", [performanceId, missing]);

    expect(conflict(await hold(performanceId, userId, [unpriced[1], priced, unpriced[0]]))).toMatchObject({
      code: "PRICE_MISSING",
      seatIds: [unpriced[0], unpriced[1]],
    });
    const map = await statuses(performanceId);
    expect([map.get(unpriced[0]!), map.get(priced)]).toEqual(["available", "available"]);
    const { rows } = await pool.query("select count(*) as n from holds where user_id = $1", [userId]);
    expect(rows[0].n).toBe(0);

    // 가격 확인은 이 회차에 있는 좌석만 본다. 다른 회차의 같은 등급 좌석은 이 회차에서 가격이 없어도 SEAT_UNAVAILABLE이다
    const other = await newPerformance(pool);
    const { rows: sameGrade } = await pool.query<{ id: number }>(
      "select id from seats where id = any($1::bigint[]) and grade = $2 order by id limit 1",
      [other.seatIds, missing],
    );
    const foreign = sameGrade[0]!.id;
    expect(conflict(await hold(performanceId, userId, [foreign]))).toMatchObject({
      code: "SEAT_UNAVAILABLE",
      seatIds: [foreign],
    });
    expect(conflict(await hold(performanceId, userId, [unpriced[0], foreign]))).toMatchObject({
      code: "PRICE_MISSING",
      seatIds: [unpriced[0]],
    });
  });

  it("로그인하지 않았으면(쿠키 없음, X-User-Id만, 모양이 틀린 쿠키, 만료된 세션) 401이고 본문 검증보다 먼저다. 없는 회차는 404", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [userId] = await newSignedInUserIds(pool, 1);
    for (const [name, headers] of Object.entries(await unauthenticatedHeaders(pool))) {
      for (const seatIdsBody of [[seatIds[0]], []]) {
        const res = await app.inject({
          method: "POST",
          url: `/performances/${performanceId}/holds`,
          headers,
          payload: { seatIds: seatIdsBody },
        });
        expectUnauthenticated(res, name);
      }
    }
    const { rows } = await pool.query("select count(*) as n from holds where performance_id = $1", [performanceId]);
    expect(rows[0].n).toBe(0);
    expect((await hold(999999999, userId, [seatIds[0]])).statusCode).toBe(404);
  });

  it("좌석은 1~4개이고, 같은 좌석을 두 번 담으면 400", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [userId] = await newSignedInUserIds(pool, 1);
    for (const body of [[], seatIds.slice(0, 5), [seatIds[0], seatIds[0]], ["1"], [1.5]]) {
      expect((await hold(performanceId, userId, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });
});

// 합격 기준(DESIGN 3장)은 응답 개수만이 아니라 DB를 직접 조회해 확인한다.
describe("동시 선점", () => {
  // 풀이 기본값(10)이면 DB에서 겹치는 요청은 10개뿐이다. 잠금을 기다렸다가 조건을 다시 보는 요청이 더 많아지도록 키운다.
  const pool = createPool({ connectionString: inject("databaseUrl"), max: 50 });
  const app = buildApp(pool);
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const hold = (performanceId: number, userId: number, seatIds: number[]) =>
    app.inject({
      method: "POST",
      url: `/performances/${performanceId}/holds`,
      headers: authHeaders(userId),
      payload: { seatIds },
    });

  function countStatuses(codes: number[]) {
    const counts: Record<number, number> = {};
    for (const c of codes) counts[c] = (counts[c] ?? 0) + 1;
    return counts;
  }

  it("C1: 좌석 1개에 1,000명이 동시에 선점하면 201은 정확히 1개, 나머지 999개는 409", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const users = await newSignedInUserIds(pool, 1000);

    const responses = await Promise.all(users.map((u) => hold(performanceId, u, [seatIds[0]!])));
    expect(countStatuses(responses.map((r) => r.statusCode))).toEqual({ 201: 1, 409: 999 });

    const winner = HoldResponse.parse(responses.find((r) => r.statusCode === 201)!.json());
    const { rows } = await pool.query(
      `select (select count(*) from performance_seats where performance_id = $1 and status = 'held') as held,
              (select hold_id from performance_seats where performance_id = $1 and seat_id = $2) as hold_id,
              (select count(*) from holds where performance_id = $1) as holds`,
      [performanceId, seatIds[0]],
    );
    // 진 요청의 선점 행은 트랜잭션과 함께 되돌려져 남지 않는다
    expect(rows[0]).toEqual({ held: 1, hold_id: winner.holdId, holds: 1 });
  }, 60_000);

  it("만료된 선점에서 시작해도, 200명이 동시에 다시 선점하면 201은 정확히 1개", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const [first, ...others] = await newSignedInUserIds(pool, 201);
    const old = HoldResponse.parse((await hold(performanceId, first!, [seatIds[0]!])).json());
    await pool.query("update holds set expires_at = now() - interval '1 second' where id = $1", [old.holdId]);
    await pool.query("update performance_seats set hold_expires_at = now() - interval '1 second' where hold_id = $1", [
      old.holdId,
    ]);

    // 좌석은 held 그대로라, 겹친 요청은 기다린 뒤 status가 아니라 hold_expires_at으로 다시 판단해야 한다
    const responses = await Promise.all(others.map((u) => hold(performanceId, u, [seatIds[0]!])));
    expect(countStatuses(responses.map((r) => r.statusCode))).toEqual({ 201: 1, 409: 199 });
    const winner = HoldResponse.parse(responses.find((r) => r.statusCode === 201)!.json());
    const { rows } = await pool.query(
      "select hold_id from performance_seats where performance_id = $1 and seat_id = $2",
      [performanceId, seatIds[0]],
    );
    expect(rows[0].hold_id).toBe(winner.holdId);
  }, 60_000);

  it("C2: 좌석 20개에 400명이 1~4석씩 몰려도 같은 좌석을 두 사람이 선점하지 않는다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const contested = seatIds.slice(0, 20);
    const users = await newSignedInUserIds(pool, 400);

    // 사용자 i는 1~4석을 담는다. (i*7 + j*5) % 20은 j가 0~3일 때 서로 달라 같은 좌석이 겹치지 않는다. 홀수 번째는 거꾸로 담는다.
    const requests = users.map((u, i) => {
      const picked = Array.from({ length: (i % 4) + 1 }, (_, j) => contested[(i * 7 + j * 5) % 20]!);
      return { userId: u, seatIds: i % 2 ? picked.reverse() : picked };
    });
    const responses = await Promise.all(requests.map((r) => hold(performanceId, r.userId, r.seatIds)));
    const codes = countStatuses(responses.map((r) => r.statusCode));
    expect(Object.keys(codes).sort()).toEqual(["201", "409"]);

    const winners = responses.filter((r) => r.statusCode === 201).map((r) => HoldResponse.parse(r.json()));
    const claimed = winners.flatMap((w) => w.seatIds);
    expect(new Set(claimed).size).toBe(claimed.length);

    const { rows } = await pool.query<{ seat_id: number; hold_id: number }>(
      "select seat_id, hold_id from performance_seats where performance_id = $1 and status = 'held' order by seat_id",
      [performanceId],
    );
    expect(rows.map((r) => r.seat_id)).toEqual([...claimed].sort((a, b) => a - b));
    const holdOf = new Map(winners.flatMap((w) => w.seatIds.map((s) => [s, w.holdId])));
    expect(rows.every((r) => holdOf.get(r.seat_id) === r.hold_id)).toBe(true);
    const holds = await pool.query("select count(*) as n from holds where performance_id = $1", [performanceId]);
    expect(holds.rows[0].n).toBe(winners.length);
  }, 60_000);

  // 요청에 담긴 순서는 잠금 순서를 바꾸지 못한다(SQL이 좌석 id로 정렬해 잠근다). 이 테스트는 좌석을 담긴 순서대로
  // 하나씩 잠그는 구현으로 바뀌는 것을 잡는다. SQL 안의 잠금 순서는 hold-races.test.ts의 실행 계획 테스트가 지킨다.
  it("좌석을 서로 반대 순서로 담은 요청이 동시에 와도 교착 없이 끝난다", async () => {
    const { performanceId, seatIds } = await newPerformance(pool);
    const users = await newSignedInUserIds(pool, 200);
    const groups = Array.from({ length: 20 }, (_, g) => seatIds.slice(g * 4, g * 4 + 4));

    const requests = users.map((u, i) => {
      const group = groups[i % 20]!;
      return { group: i % 20, res: hold(performanceId, u, i % 2 ? [...group].reverse() : group) };
    });
    const results = await Promise.all(requests.map(async (r) => ({ group: r.group, status: (await r.res).statusCode })));
    expect(Object.keys(countStatuses(results.map((r) => r.status))).sort()).toEqual(["201", "409"]);
    for (let g = 0; g < 20; g++) {
      expect(results.filter((r) => r.group === g && r.status === 201)).toHaveLength(1);
    }
  }, 60_000);
});
