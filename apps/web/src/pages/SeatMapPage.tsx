import { HoldConflict, type MyPerformance, SEAT_LIMIT_PER_USER, type SeatMapSeat } from "@seat-booking/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, NetworkError } from "../api/client";
import { createHold, createOrderFor, getMyPerformance, getSeatMap } from "../api/endpoints";
import { queryKeys, useMe } from "../api/queries";
import { SeatGrid, SeatLegend } from "../components/SeatGrid";
import { LoadError, Loading } from "../components/States";
import { serverNow } from "../lib/clock";
import { loginPath } from "../lib/navigation";
import { classifyHoldFailure, mySeats, reconcileSelection, salesState } from "../lib/seats";
import { useSelection } from "../lib/selection";
import { formatCountdown, formatKst, formatRemaining, formatWon } from "../lib/time";
import { useNow } from "../lib/useNow";
import styles from "./SeatMapPage.module.css";

// 판매 중에는 좌석 지도를 15초마다 다시 읽는다(DESIGN 6.5 선점 → 주문 2, 6단계 부하 모델에 넣는다).
const SEAT_MAP_REFRESH_MS = 15_000;

// 선점은 됐는데 주문을 만들지 못했다(새로고침·네트워크). /me의 "주문 이어서 만들기"로 다시 한다.
class OrderStageError extends Error {
  constructor(readonly cause: unknown) {
    super("order stage");
  }
}

const seatName = (seat: SeatMapSeat) => `${seat.section} ${seat.row}열 ${seat.number}번`;

export function SeatMapPage({ performanceId }: { performanceId: number }) {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const now = useNow(1000);
  const [selected, setSelected] = useSelection(performanceId);
  // 화면에 보이고 화면 읽기 프로그램도 읽는 알림 한 줄.
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  const seatMap = useQuery({
    queryKey: queryKeys.seatMap(performanceId),
    queryFn: () => getSeatMap(performanceId),
    refetchInterval: (query) =>
      query.state.data && salesState(query.state.data.performance, serverNow()).kind === "onSale" ? SEAT_MAP_REFRESH_MS : false,
  });
  const myPerformance = useQuery({
    queryKey: queryKeys.myPerformance(performanceId),
    queryFn: () => getMyPerformance(performanceId),
    enabled: Boolean(me),
  });

  const mineByHold = useMemo(() => mySeats(myPerformance.data), [myPerformance.data]);
  const mine = useMemo(() => new Set(mineByHold.keys()), [mineByHold]);
  const seats = seatMap.data?.seats;

  // 지도를 다시 읽을 때마다 고른 좌석을 맞춘다. 그사이 선점·판매된 좌석은 빼고 알린다(DESIGN 6.5 선점 → 주문 2).
  useEffect(() => {
    if (!seats) return;
    const { kept, dropped } = reconcileSelection(selected, seats, mine);
    if (dropped.length > 0) {
      setSelected(kept);
      setNotice({ tone: "info", text: `${dropped.length}석이 그사이 선점되었거나 팔려 선택에서 뺐습니다.` });
    }
    // 고른 좌석이 바뀔 때는 다시 맞추지 않는다(고를 때 이미 고를 수 있는 좌석만 고른다).
  }, [seats, mine]);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.seatMap(performanceId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.myPerformance(performanceId) }),
    ]);

  // 선점하고 곧바로 주문을 만든다(DESIGN 6.5 선점 → 주문 3). 주문 화면으로 간다.
  const hold = useMutation({
    mutationFn: async (seatIds: number[]) => {
      const created = await createHold(performanceId, seatIds);
      void refresh();
      try {
        return await createOrderFor(created.holdId);
      } catch (error) {
        throw new OrderStageError(error);
      }
    },
    onSuccess: (orderId) => {
      setSelected([]);
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders });
      void navigate(`/orders/${orderId}`);
    },
    onError: (error) => void onHoldError(error),
  });

  // 주문이 없는 선점에서 주문을 이어서 만든다(저장해 둔 같은 키로).
  const resume = useMutation({
    mutationFn: (holdId: number) => createOrderFor(holdId),
    onSuccess: (orderId) => void navigate(`/orders/${orderId}`),
    onError: () => {
      setNotice({ tone: "error", text: "주문을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요." });
      void refresh();
    },
  });

  async function onHoldError(error: unknown) {
    if (error instanceof OrderStageError) {
      const cause = error.cause;
      setNotice({
        tone: "error",
        text:
          cause instanceof ApiError && cause.code === "HOLD_EXPIRED"
            ? "선점 시간이 끝났습니다. 좌석을 다시 골라 주세요."
            : "좌석은 선점했지만 주문을 만들지 못했습니다. 위의 \"주문 이어서 만들기\"로 다시 시도해 주세요.",
      });
      void refresh();
      return;
    }
    if (error instanceof ApiError && error.status === 401) {
      setNotice({ tone: "error", text: "로그인이 끝났습니다. 다시 로그인해 주세요." });
      return;
    }
    const conflict = error instanceof ApiError && error.status === 409 ? HoldConflict.safeParse(error.body) : null;
    if (conflict?.success && conflict.data.code === "SALES_CLOSED") {
      setNotice({
        tone: "error",
        text:
          conflict.data.reason === "NOT_OPEN"
            ? `아직 예매가 열리지 않았습니다(오픈 ${formatKst(conflict.data.salesOpenAt)}).`
            : "예매가 마감되었습니다.",
      });
      void refresh();
      return;
    }
    if (conflict?.success && conflict.data.code === "PRICE_MISSING") {
      const missing = new Set(conflict.data.seatIds);
      setSelected(selected.filter((id) => !missing.has(id)));
      setNotice({ tone: "error", text: "가격이 정해지지 않은 좌석을 뺐습니다. 다시 선점해 주세요." });
      void refresh();
      return;
    }
    // 그 밖(네트워크·5xx·SEAT_UNAVAILABLE·HOLD_LIMIT): 응답을 잃고 다시 눌렀거나 두 탭이면 내 선점일 수 있다. /me부터 다시 읽는다.
    let fresh: MyPerformance | null = null;
    try {
      fresh = await queryClient.fetchQuery({
        queryKey: queryKeys.myPerformance(performanceId),
        queryFn: () => getMyPerformance(performanceId),
      });
    } catch {
      // 못 읽으면 내 선점인지 모른다
    }
    const conflictSeatIds = conflict?.success && conflict.data.code === "SEAT_UNAVAILABLE" ? conflict.data.seatIds : null;
    const failure = classifyHoldFailure(selected, conflictSeatIds, fresh);
    void queryClient.invalidateQueries({ queryKey: queryKeys.seatMap(performanceId) });
    if (failure.kind === "alreadyMine") {
      setSelected([]);
      if (failure.orderId !== null) {
        void navigate(`/orders/${failure.orderId}`);
      } else {
        setNotice({ tone: "info", text: "이미 선점한 좌석입니다. 위의 \"주문 이어서 만들기\"를 눌러 주세요." });
      }
      return;
    }
    if (failure.kind === "taken") {
      const taken = new Set(failure.seatIds);
      const names = (seats ?? []).filter((s) => taken.has(s.seatId)).map(seatName);
      setSelected(selected.filter((id) => !taken.has(id)));
      setNotice({ tone: "error", text: `다른 사람이 먼저 선점했습니다: ${names.join(", ")}` });
      return;
    }
    if (conflict?.success && conflict.data.code === "HOLD_LIMIT") {
      const { limit, heldSeats, purchasedSeats } = conflict.data;
      setNotice({
        tone: "error",
        text: `이 회차는 1인 ${limit}석까지입니다(선점 ${heldSeats}석, 구매 ${purchasedSeats}석).`,
      });
      return;
    }
    setNotice({
      tone: "error",
      text: error instanceof NetworkError ? "선점 요청이 끊겼습니다. 다시 시도해 주세요." : "선점하지 못했습니다. 다시 시도해 주세요.",
    });
  }

  if (seatMap.isPending) return <Loading />;
  if (seatMap.isError) return <LoadError error={seatMap.error} onRetry={() => void seatMap.refetch()} />;

  const { performance } = seatMap.data;
  const sales = salesState(performance, now);
  const open = sales.kind === "onSale";
  const remaining = me ? (myPerformance.data?.remaining ?? SEAT_LIMIT_PER_USER) : SEAT_LIMIT_PER_USER;
  const selectedSet = new Set(selected);
  const seatsById = new Map(seatMap.data.seats.map((s) => [s.seatId, s]));
  const selectedSeats = selected.map((id) => seatsById.get(id)).filter((s): s is SeatMapSeat => s !== undefined);
  const total = selectedSeats.reduce((sum, s) => sum + (s.price ?? 0), 0);

  // 등급은 처음 나온 순서(좌석 배치 순서)로 번호를 매겨 바탕색을 고른다.
  const grades: { grade: string; price: number | null; index: number }[] = [];
  for (const seat of seatMap.data.seats) {
    if (!grades.some((g) => g.grade === seat.grade)) grades.push({ grade: seat.grade, price: seat.price, index: grades.length });
  }
  const gradeIndex = new Map(grades.map((g) => [g.grade, g.index]));

  function toggle(seatId: number) {
    if (selectedSet.has(seatId)) {
      setSelected(selected.filter((id) => id !== seatId));
    } else if (selected.length >= remaining) {
      setNotice({ tone: "error", text: `이 회차에서 더 고를 수 있는 좌석은 ${remaining}석입니다.` });
    } else {
      setSelected([...selected, seatId]);
    }
  }

  function onHold() {
    if (!me) {
      void navigate(loginPath(`/performances/${performanceId}`));
      return;
    }
    setNotice(null);
    hold.mutate(selected);
  }

  const holds = me ? (myPerformance.data?.holds ?? []) : [];
  const tooMany = selected.length > remaining;

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1>{performance.showTitle}</h1>
        <p className={styles.meta}>
          {performance.venueName} · <time dateTime={performance.startsAt}>{formatKst(performance.startsAt)}</time>
        </p>
        <p className={styles.sales} data-kind={sales.kind}>
          {sales.kind === "upcoming" && <>예매 오픈까지 {formatCountdown(sales.opensAt - now)} ({formatKst(performance.salesOpenAt)})</>}
          {sales.kind === "onSale" && <>예매 마감 {formatKst(performance.salesCloseAt)}</>}
          {sales.kind === "closed" && <>예매가 마감되었습니다</>}
          {sales.kind === "ended" && <>공연이 끝났습니다</>}
        </p>
      </header>

      {holds.length > 0 && (
        <ul className={styles.banners} aria-label="이어서 할 일">
          {holds.map((h) => (
            <li key={h.holdId} className={styles.banner}>
              <span>
                선점한 좌석 {h.seatIds.length}석 · 남은 시간 {formatRemaining(Date.parse(h.expiresAt) - now)}
              </span>
              {h.orderId !== null ? (
                <Link to={`/orders/${h.orderId}`}>결제 이어서 하기</Link>
              ) : (
                <button type="button" onClick={() => resume.mutate(h.holdId)} disabled={resume.isPending}>
                  주문 이어서 만들기
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className={styles.layout}>
        <div className={styles.mapColumn}>
          <SeatLegend grades={grades} />
          <SeatGrid
            seats={seatMap.data.seats}
            selected={selectedSet}
            mine={mine}
            open={open}
            gradeIndex={gradeIndex}
            onToggle={toggle}
          />
        </div>

        <aside className={styles.panel} aria-labelledby="selection-title">
          <h2 id="selection-title">고른 좌석</h2>
          {selectedSeats.length === 0 ? (
            <p className={styles.muted}>{open ? `좌석을 고르세요(최대 ${remaining}석).` : "지금은 좌석을 고를 수 없습니다."}</p>
          ) : (
            <ul className={styles.selected}>
              {selectedSeats.map((s) => (
                <li key={s.seatId}>
                  <span>
                    {seatName(s)} · {s.grade} {s.price === null ? "" : formatWon(s.price)}
                  </span>
                  <button type="button" onClick={() => toggle(s.seatId)} aria-label={`${seatName(s)} 빼기`}>
                    빼기
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className={styles.total}>
            합계 <strong>{formatWon(total)}</strong>
          </p>
          {tooMany && <p className={styles.error}>이 회차에서 더 고를 수 있는 좌석은 {remaining}석입니다. 좌석을 빼 주세요.</p>}
          <p className={notice?.tone === "error" ? styles.error : styles.info} aria-live="polite">
            {notice?.text}
          </p>
          <button
            type="button"
            className={styles.primary}
            onClick={onHold}
            disabled={!open || selected.length === 0 || tooMany || hold.isPending}
          >
            {hold.isPending ? "선점하는 중…" : me === null ? "로그인하고 선점하기" : `${selected.length}석 선점하기`}
          </button>
          <p className={styles.muted}>선점하면 5분 동안 좌석이 잡히고, 그 안에 결제해야 합니다.</p>
        </aside>
      </div>
    </section>
  );
}
