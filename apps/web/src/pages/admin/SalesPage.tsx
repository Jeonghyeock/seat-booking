import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { adminKeys, getSales } from "../../api/admin";
import { LoadError, Loading } from "../../components/States";
import { formatKst, formatWon } from "../../lib/time";
import styles from "./Admin.module.css";

const PAYMENT_LABEL = {
  requested: "확인 중",
  succeeded: "성공",
  failed: "실패",
  refund_pending: "환불 대기",
  refunded: "환불 완료",
  refund_failed: "환불 실패",
} as const;

// 회차 판매 현황(DESIGN 6.3 관리자 기능). 한 스냅샷에서 센 값이고, 판매 중에는 15초마다 다시 읽는다.
export function SalesPage({ performanceId }: { performanceId: number }) {
  const sales = useQuery({
    queryKey: adminKeys.sales(performanceId),
    queryFn: () => getSales(performanceId),
    refetchInterval: 15_000,
  });
  if (sales.isPending) return <Loading />;
  if (sales.isError) return <LoadError error={sales.error} onRetry={() => void sales.refetch()} />;

  const { performance, seats, orders, revenue, payments, serverTime } = sales.data;
  const percent = (n: number) => (seats.total === 0 ? 0 : Math.round((n / seats.total) * 100));
  return (
    <section className={styles.page}>
      <p>
        <Link to="/admin">관리자</Link>
      </p>
      <h1>판매 현황</h1>
      <p className={styles.muted}>
        {performance.showTitle} · {performance.venueName} · {formatKst(performance.startsAt)} · 예매 마감{" "}
        {formatKst(performance.salesCloseAt)}
      </p>

      <h2>좌석</h2>
      <div
        className={styles.bar}
        role="img"
        aria-label={`전체 ${seats.total}석 중 판매 ${seats.sold}석, 선점 ${seats.held}석, 빈 좌석 ${seats.available}석`}
      >
        <span className={styles.sold} style={{ width: `${percent(seats.sold)}%` }} />
        <span className={styles.held} style={{ width: `${percent(seats.held)}%` }} />
      </div>
      <dl className={styles.stats}>
        <div>
          <dt>판매</dt>
          <dd>{seats.sold}석</dd>
        </div>
        <div>
          <dt>선점</dt>
          <dd>{seats.held}석</dd>
        </div>
        <div>
          <dt>빈 좌석</dt>
          <dd>{seats.available}석</dd>
        </div>
        <div>
          <dt>매출</dt>
          <dd>{formatWon(revenue)}</dd>
        </div>
      </dl>

      <h2>주문</h2>
      <dl className={styles.stats}>
        <div>
          <dt>결제 대기</dt>
          <dd>{orders.pending}</dd>
        </div>
        <div>
          <dt>결제 완료</dt>
          <dd>{orders.paid}</dd>
        </div>
        <div>
          <dt>취소</dt>
          <dd>{orders.cancelled}</dd>
        </div>
      </dl>

      <h2>결제</h2>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">상태</th>
            <th scope="col">수</th>
          </tr>
        </thead>
        <tbody>
          {(Object.keys(PAYMENT_LABEL) as (keyof typeof PAYMENT_LABEL)[]).map((status) => (
            <tr key={status}>
              <td>{PAYMENT_LABEL[status]}</td>
              <td>{payments[status]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {payments.refund_failed > 0 && (
        <p>
          <Link to="/admin/refunds">환불 실패 {payments.refund_failed}건 보기</Link>
        </p>
      )}
      <p className={styles.muted}>기준 시각 {formatKst(serverTime)}</p>
    </section>
  );
}
