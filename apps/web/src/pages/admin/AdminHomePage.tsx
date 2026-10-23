import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { getPerformances } from "../../api/endpoints";
import { queryKeys } from "../../api/queries";
import { LoadError, Loading } from "../../components/States";
import { formatKst } from "../../lib/time";
import styles from "./Admin.module.css";

// 관리자 첫 화면: 회차 등록, 환불 실패, 회차별 판매 현황.
export function AdminHomePage() {
  const performances = useQuery({ queryKey: queryKeys.performances, queryFn: getPerformances });
  return (
    <section className={styles.page}>
      <h1>관리자</h1>
      <nav aria-label="관리자 메뉴" className={styles.actions}>
        <Link to="/admin/performances/new" className={styles.primaryLink}>
          회차 등록
        </Link>
        <Link to="/admin/refunds">환불 실패 목록</Link>
      </nav>
      <h2>판매 현황</h2>
      {performances.isPending ? (
        <Loading />
      ) : performances.isError ? (
        <LoadError error={performances.error} onRetry={() => void performances.refetch()} />
      ) : (
        <ul className={styles.list}>
          {performances.data.performances.map((p) => (
            <li key={p.id}>
              <Link to={`/admin/performances/${p.id}/sales`}>
                {p.showTitle} · {p.venueName} · {formatKst(p.startsAt)}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
