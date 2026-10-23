import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { adminKeys, getRefundFailed, retryRefund } from "../../api/admin";
import { ApiError } from "../../api/client";
import { LoadError, Loading } from "../../components/States";
import { formatKst, formatWon } from "../../lib/time";
import styles from "./Admin.module.css";

// 환불 실패 목록과 다시 시도(DESIGN 6.3 관리자 기능). 다시 시도는 refund_pending으로 되돌리고 다음 정리 작업이 환불한다.
export function RefundsPage() {
  const queryClient = useQueryClient();
  const refunds = useQuery({ queryKey: adminKeys.refunds, queryFn: getRefundFailed });
  // 결제마다 마지막 결과 문구.
  const [results, setResults] = useState<Record<number, string>>({});

  const retry = useMutation({
    mutationFn: (paymentId: number) => retryRefund(paymentId),
    onSuccess: (result) => {
      setResults((r) => ({
        ...r,
        [result.paymentId]: result.changed ? "환불 대기로 되돌렸습니다. 다음 정리 작업이 환불합니다." : "이미 환불 대기 중입니다.",
      }));
    },
    onError: (error, paymentId) => {
      const status = error instanceof ApiError && error.code === "PAYMENT_NOT_RETRYABLE" ? (error.body as { status?: string }).status : null;
      setResults((r) => ({
        ...r,
        [paymentId]: status ? `환불 실패 상태가 아닙니다(지금 ${status}).` : "다시 시도하지 못했습니다.",
      }));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.refunds });
      void queryClient.invalidateQueries({ queryKey: ["admin", "sales"] });
    },
  });

  return (
    <section className={styles.page}>
      <p>
        <Link to="/admin">관리자</Link>
      </p>
      <h1>환불 실패</h1>
      <p className={styles.muted}>결제사가 다섯 번 모른다고 답한 환불입니다. 결제사에서 확인한 뒤 다시 시도합니다.</p>
      {Object.entries(results).length > 0 && (
        <ul className={styles.results} aria-live="polite">
          {Object.entries(results).map(([paymentId, text]) => (
            <li key={paymentId}>
              결제 {paymentId}: {text}
            </li>
          ))}
        </ul>
      )}
      {refunds.isPending ? (
        <Loading />
      ) : refunds.isError ? (
        <LoadError error={refunds.error} onRetry={() => void refunds.refetch()} />
      ) : refunds.data.payments.length === 0 ? (
        <p>환불이 실패한 결제가 없습니다.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">결제</th>
                <th scope="col">결제사 번호</th>
                <th scope="col">주문</th>
                <th scope="col">사용자</th>
                <th scope="col">금액</th>
                <th scope="col">시도</th>
                <th scope="col">바뀐 시각</th>
                <th scope="col">
                  <span className="visually-hidden">다시 시도</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {refunds.data.payments.map((p) => (
                <tr key={p.paymentId}>
                  <td>{p.paymentId}</td>
                  <td>{p.providerRef ?? "-"}</td>
                  <td>
                    {p.orderId} ({p.orderStatus}) · <Link to={`/admin/performances/${p.performanceId}/sales`}>회차 {p.performanceId}</Link>
                  </td>
                  <td>{p.email}</td>
                  <td>{formatWon(p.amount)}</td>
                  <td>{p.refundAttempts}</td>
                  <td>{formatKst(p.updatedAt)}</td>
                  <td>
                    <button type="button" onClick={() => retry.mutate(p.paymentId)} disabled={retry.isPending}>
                      다시 시도
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {refunds.data?.hasMore && <p className={styles.muted}>최근 100건만 보입니다.</p>}
    </section>
  );
}
