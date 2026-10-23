import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { getPerformances } from "../api/endpoints";
import { queryKeys } from "../api/queries";
import { LoadError, Loading } from "../components/States";
import { type SalesState, salesState } from "../lib/seats";
import { formatKst } from "../lib/time";
import { useNow } from "../lib/useNow";
import { usePageTitle } from "../lib/usePageTitle";
import styles from "./PerformancesPage.module.css";

// 공연 목록에는 serverTime이 없다. 판매 상태는 서버 시각을 받은 적이 있으면 그것으로, 없으면 PC 시계로 대강 보인다(DESIGN 6.5 시계).
function SalesBadge({ state, salesOpenAt, salesCloseAt }: { state: SalesState; salesOpenAt: string; salesCloseAt: string }) {
  switch (state.kind) {
    case "upcoming":
      return <span className={`${styles.badge} ${styles.upcoming}`}>예매 오픈 {formatKst(salesOpenAt)}</span>;
    case "onSale":
      return <span className={`${styles.badge} ${styles.onSale}`}>예매 중 · 마감 {formatKst(salesCloseAt)}</span>;
    case "closed":
      return <span className={`${styles.badge} ${styles.closed}`}>예매 마감</span>;
    case "ended":
      return <span className={`${styles.badge} ${styles.closed}`}>공연 종료</span>;
  }
}

export function PerformancesPage() {
  usePageTitle("공연");
  const performances = useQuery({ queryKey: queryKeys.performances, queryFn: getPerformances });
  const now = useNow(30_000);

  if (performances.isPending) return <Loading />;
  if (performances.isError) return <LoadError error={performances.error} onRetry={() => void performances.refetch()} />;

  const items = performances.data.performances;
  return (
    <section>
      <h1>공연</h1>
      {items.length === 0 ? (
        <p>예정된 공연이 없습니다.</p>
      ) : (
        <ul className={styles.list}>
          {items.map((p) => {
            const state = salesState(p, now);
            return (
              <li key={p.id} className={state.kind === "ended" ? `${styles.item} ${styles.ended}` : styles.item}>
                <div className={styles.info}>
                  <h2 className={styles.title}>{p.showTitle}</h2>
                  <p className={styles.meta}>
                    {p.venueName} · <time dateTime={p.startsAt}>{formatKst(p.startsAt)}</time>
                  </p>
                  <SalesBadge state={state} salesOpenAt={p.salesOpenAt} salesCloseAt={p.salesCloseAt} />
                </div>
                {state.kind !== "ended" && (
                  <Link to={`/performances/${p.id}`} className={styles.action}>
                    {state.kind === "onSale" ? "좌석 고르기" : "좌석 보기"}
                    <span className="visually-hidden">: {p.showTitle} {formatKst(p.startsAt)}</span>
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
