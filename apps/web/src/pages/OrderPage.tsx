import { type OrderView, PaymentConflict, type PaymentScenario } from "@seat-booking/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { ApiError, NetworkError } from "../api/client";
import { cancelOrder, getOrder, getPerformances, requestPayment } from "../api/endpoints";
import { queryKeys } from "../api/queries";
import { LoadError, Loading } from "../components/States";
import { serverNow } from "../lib/clock";
import { type OrderMain, orderRefetchInterval, orderScreen, type RefundLine } from "../lib/orderScreen";
import { formatKst, formatRemaining, formatWon } from "../lib/time";
import { useNow } from "../lib/useNow";
import styles from "./OrderPage.module.css";

// 가짜 결제사의 상황(데모). 기본은 성공이다.
const SCENARIOS: { value: PaymentScenario; label: string }[] = [
  { value: "success", label: "성공" },
  { value: "fail", label: "실패" },
  { value: "duplicate", label: "웹훅 중복" },
  { value: "out_of_order", label: "웹훅 순서 뒤바뀜" },
  { value: "early", label: "웹훅이 응답보다 먼저" },
  { value: "lost", label: "웹훅 유실(대사가 맞춘다)" },
];

const NOT_PAYABLE: Record<string, string> = {
  PAID: "이미 결제가 끝난 주문입니다.",
  CANCELLED: "취소된 주문입니다.",
  HOLD_EXPIRED: "선점 시간이 끝났습니다.",
  TOO_CLOSE_TO_EXPIRY: "결제 마감 시간이 지났습니다.",
};

function refundText(line: RefundLine, main: OrderMain) {
  // 결제가 끝난 주문의 환불은 중복 결제, 결제 대기 주문의 환불은 앞 결제다(DESIGN 6.2 표).
  const what = main.kind === "paid" ? "중복 결제" : main.kind === "pay" || main.kind === "payClosed" ? "앞 결제" : "결제";
  const amount = formatWon(line.amount);
  if (line.status === "refund_pending") return `${what} ${amount} 환불 중`;
  if (line.status === "refunded") return `${what} ${amount} 환불 완료(${formatKst(line.updatedAt)})`;
  return `${what} ${amount} 환불이 늦어지고 있습니다. 문의해 주세요.`;
}

export function OrderPage({ orderId }: { orderId: number }) {
  const queryClient = useQueryClient();
  const now = useNow(1000);
  const scenarioName = useId();
  const [scenario, setScenario] = useState<PaymentScenario>("success");
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const order = useQuery({
    queryKey: queryKeys.order(orderId),
    queryFn: () => getOrder(orderId),
    refetchInterval: (query) => (query.state.data ? orderRefetchInterval(query.state.data, serverNow()) : false),
  });
  // 회차 정보와 판매 종료는 OrderView에 일부러 없다(DESIGN 6.2). 공연 목록 캐시에서 찾는다.
  const performances = useQuery({ queryKey: queryKeys.performances, queryFn: getPerformances });

  // 결제 확정·만료는 서버(웹훅, 정리 작업)가 바꾼다. 폴링으로 상태가 바뀌면 그 회차의 좌석 지도·내 선점과 내 예매를 다시 읽게 한다.
  const previousStatus = useRef<OrderView["status"] | undefined>(undefined);
  useEffect(() => {
    const data = order.data;
    if (!data) return;
    if (previousStatus.current !== undefined && previousStatus.current !== data.status) invalidateAround(data.performanceId);
    previousStatus.current = data.status;
  }, [order.data]);

  function invalidateAround(performanceId: number) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.seatMap(performanceId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.myPerformance(performanceId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.orders });
  }
  const refetchOrder = () => queryClient.invalidateQueries({ queryKey: queryKeys.order(orderId) });

  // "결제하기"는 누를 때마다 새 시도(새 키)다. 같은 시도의 재시도(503, REQUEST_IN_PROGRESS, 끊김)는 저장한 키·본문 그대로다.
  const pay = useMutation({
    mutationFn: () => requestPayment(orderId, { scenario, delayMs: 1000 }, { newAttempt: true }),
    onMutate: () => setNotice(null),
    onSuccess: () => void refetchOrder(),
    onError: (error) => {
      void refetchOrder();
      // 409·재시도 상한을 넘긴 503은 주문을 다시 읽어 상태 함수로 그린다. reason은 문구에만 쓴다(10장 48).
      if (error instanceof ApiError && error.status === 409) {
        const conflict = PaymentConflict.safeParse(error.body);
        if (conflict.success && conflict.data.code === "ORDER_NOT_PAYABLE") setNotice(NOT_PAYABLE[conflict.data.reason] ?? null);
        else if (conflict.success && conflict.data.code === "PAYMENT_IN_PROGRESS") setNotice("이미 확인 중인 결제가 있습니다.");
        return;
      }
      if (error instanceof ApiError && error.status === 503) {
        setNotice("결제사에 닿지 않아 결과를 확인하고 있습니다. 결제됐다면 곧 반영됩니다.");
        return;
      }
      if (error instanceof NetworkError) {
        setNotice("결제 요청이 끊겼습니다. 결과를 확인하고 있습니다.");
        return;
      }
      if (error instanceof ApiError && error.code === "IDEMPOTENCY_KEY_REUSED") {
        setNotice("결제를 다시 시도해 주세요.");
        return;
      }
      setNotice("결제를 요청하지 못했습니다.");
    },
  });

  const cancel = useMutation({
    mutationFn: () => cancelOrder(orderId),
    onSuccess: (view) => {
      setConfirmingCancel(false);
      void refetchOrder();
      invalidateAround(view.performanceId);
    },
    onError: (error) => {
      setConfirmingCancel(false);
      void refetchOrder();
      setNotice(
        error instanceof ApiError && error.code === "ORDER_NOT_CANCELLABLE"
          ? "결제가 끝난 주문은 취소할 수 없습니다."
          : "취소하지 못했습니다. 다시 시도해 주세요.",
      );
    },
  });

  if (order.isPending) return <Loading />;
  if (order.isError) return <LoadError error={order.error} onRetry={() => void order.refetch()} />;

  const view = order.data;
  const { main, refunds } = orderScreen(view, now);
  const performance = performances.data?.performances.find((p) => p.id === view.performanceId);
  const salesClosed = performance ? Date.parse(performance.salesCloseAt) <= now : false;
  const canCancel = main.kind === "pay" || main.kind === "payClosed" || (main.kind === "confirming" && !main.cancelled);

  return (
    <section className={styles.page}>
      <header>
        <h1>주문 {view.orderId}</h1>
        {performance && (
          <p className={styles.meta}>
            {performance.showTitle} · {performance.venueName} · <time dateTime={performance.startsAt}>{formatKst(performance.startsAt)}</time>
          </p>
        )}
      </header>

      <div className={styles.status} data-kind={main.kind} role="status" aria-live="polite">
        {main.kind === "pay" && (
          <>
            <strong>결제 마감까지 {formatRemaining(main.payBy - now)}</strong>
            {main.lastFailed && <span>결제가 실패했습니다. 다시 시도해 주세요.</span>}
          </>
        )}
        {main.kind === "payClosed" && <strong>결제 마감 시간이 지났습니다. 좌석을 다시 골라 주세요.</strong>}
        {main.kind === "confirming" && (
          <strong>
            {main.cancelled
              ? "결제 결과를 확인하고 있습니다. 결제됐다면 자동으로 환불됩니다."
              : "결제를 확인하고 있습니다. 웹훅이 사라진 경우 30초쯤 걸릴 수 있습니다."}
          </strong>
        )}
        {main.kind === "paid" && <strong>예매가 완료되었습니다.</strong>}
        {main.kind === "cancelled" && (
          <>
            <strong>{main.reason === "expired" ? "시간이 초과되어 주문이 취소되었습니다." : "주문을 취소했습니다."}</strong>
            <Link to={`/performances/${view.performanceId}`}>좌석 다시 고르기</Link>
          </>
        )}
      </div>

      {refunds.length > 0 && (
        <ul className={styles.refunds} aria-label="환불">
          {refunds.map((line) => (
            <li key={line.paymentId} data-status={line.status}>
              {refundText(line, main)}
            </li>
          ))}
        </ul>
      )}

      <table className={styles.items}>
        <caption className="visually-hidden">주문한 좌석</caption>
        <thead>
          <tr>
            <th scope="col">좌석</th>
            <th scope="col">등급</th>
            <th scope="col">가격</th>
          </tr>
        </thead>
        <tbody>
          {view.items.map((item) => (
            <tr key={item.seatId}>
              <td>
                {item.section} {item.row}열 {item.number}번
              </td>
              <td>{item.grade}</td>
              <td>{formatWon(item.price)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={2}>
              합계
            </th>
            <td>{formatWon(view.amount)}</td>
          </tr>
        </tfoot>
      </table>

      {main.kind === "paid" && view.tickets.length > 0 && (
        <section aria-labelledby="tickets-title">
          <h2 id="tickets-title">표</h2>
          <ul className={styles.tickets}>
            {view.tickets.map((t) => {
              const item = view.items.find((i) => i.seatId === t.seatId);
              return (
                <li key={t.ticketId}>
                  표 {t.ticketId} · {item ? `${item.section} ${item.row}열 ${item.number}번` : `좌석 ${t.seatId}`}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {main.kind === "pay" && (
        <form
          className={styles.pay}
          onSubmit={(event) => {
            event.preventDefault();
            pay.mutate();
          }}
        >
          <fieldset disabled={pay.isPending}>
            <legend>결제 상황(데모: 가짜 결제사)</legend>
            {SCENARIOS.map((s) => (
              <label key={s.value} className={styles.option}>
                <input
                  type="radio"
                  name={scenarioName}
                  value={s.value}
                  checked={scenario === s.value}
                  onChange={() => setScenario(s.value)}
                />
                {s.label}
              </label>
            ))}
          </fieldset>
          <button type="submit" className={styles.primary} disabled={pay.isPending}>
            {pay.isPending ? "결제 요청 중…" : `${formatWon(view.amount)} 결제하기`}
          </button>
        </form>
      )}

      {notice && <p className={styles.notice}>{notice}</p>}

      {canCancel &&
        (confirmingCancel ? (
          <div className={styles.confirm} role="alertdialog" aria-labelledby="cancel-question">
            <p id="cancel-question">
              {main.kind === "confirming"
                ? "결제를 확인하는 중입니다. 취소하면 결제됐더라도 자동으로 환불됩니다. 취소할까요?"
                : salesClosed
                  ? "예매가 마감되어 취소하면 다시 선점할 수 없습니다. 취소할까요?"
                  : "주문을 취소하고 좌석을 다시 고를까요?"}
            </p>
            <button type="button" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              취소하기
            </button>
            <button type="button" onClick={() => setConfirmingCancel(false)}>
              돌아가기
            </button>
          </div>
        ) : (
          <button type="button" className={styles.secondary} onClick={() => setConfirmingCancel(true)}>
            좌석 다시 선택(주문 취소)
          </button>
        ))}
    </section>
  );
}
