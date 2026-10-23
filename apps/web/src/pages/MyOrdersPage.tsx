import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { getMyOrders } from "../api/endpoints";
import { queryKeys } from "../api/queries";
import { LoadError, Loading } from "../components/States";
import { orderScreen, orderStatusLabel } from "../lib/orderScreen";
import { formatKst, formatRemaining, formatWon } from "../lib/time";
import { useNow } from "../lib/useNow";
import { usePageTitle } from "../lib/usePageTitle";
import styles from "./MyOrdersPage.module.css";

// 내 예매(DESIGN 6.5 내 예매). 결제 대기·결제 완료·돈이 움직였을 수 있는 취소 주문을 최근 것부터 보인다.
// 상태는 주문 화면과 같은 함수로 고른다. 자세한 것은 주문 화면에서 본다.
// 결제 대기 주문의 남은 시간. 1초마다 바뀌는 것은 이 작은 부분만 다시 그린다(목록 전체는 5초마다).
function PayCountdown({ payBy }: { payBy: number }) {
  const now = useNow(1000);
  return <> · {formatRemaining(payBy - now)} 남음</>;
}

export function MyOrdersPage() {
  usePageTitle("내 예매");
  const orders = useQuery({ queryKey: queryKeys.orders, queryFn: getMyOrders });
  const now = useNow(5000);

  if (orders.isPending) return <Loading />;
  if (orders.isError) return <LoadError error={orders.error} onRetry={() => void orders.refetch()} />;

  const { orders: items, hasMore } = orders.data;
  return (
    <section>
      <h1>내 예매</h1>
      {items.length === 0 ? (
        <p>
          예매한 공연이 없습니다. <Link to="/">공연 보러 가기</Link>
        </p>
      ) : (
        <ul className={styles.list}>
          {items.map((o) => {
            const screen = orderScreen(o, now);
            return (
              <li key={o.orderId} className={styles.item} data-kind={screen.main.kind}>
                <div className={styles.info}>
                  <h2 className={styles.title}>{o.performance.showTitle}</h2>
                  <p className={styles.meta}>
                    {o.performance.venueName} · <time dateTime={o.performance.startsAt}>{formatKst(o.performance.startsAt)}</time>
                  </p>
                  <p className={styles.meta}>
                    {o.seatCount}석 · {formatWon(o.amount)}
                  </p>
                  <p className={styles.status}>
                    {orderStatusLabel(screen)}
                    {screen.main.kind === "pay" && <PayCountdown payBy={screen.main.payBy} />}
                  </p>
                </div>
                <Link to={`/orders/${o.orderId}`} className={styles.action}>
                  {screen.main.kind === "pay" ? "결제하기" : "자세히"}
                  <span className="visually-hidden">: 주문 {o.orderId}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && <p className={styles.meta}>최근 100건만 보입니다.</p>}
    </section>
  );
}
