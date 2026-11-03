import { ApiError, NetworkError } from "../api/client";
import styles from "./States.module.css";

// 읽는 중·실패 화면. 실패는 다시 읽기를 준다.
export function Loading({ label = "불러오는 중…" }: { label?: string }) {
  return (
    <p className={styles.muted} role="status">
      {label}
    </p>
  );
}

export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message =
    error instanceof NetworkError
      ? "서버에 닿지 않습니다."
      : error instanceof ApiError && error.status === 404
        ? "찾을 수 없습니다."
        : "불러오지 못했습니다.";
  return (
    <div className={styles.error} role="alert">
      <p>{message}</p>
      <button type="button" onClick={onRetry}>
        다시 불러오기
      </button>
    </div>
  );
}

type Refetchable = { isRefetchError: boolean; error: unknown; refetch: () => unknown };

// 이미 읽은 데이터가 있는데 다시 읽기가 4xx로 거절됐다(권한을 잃음·없어짐) — 마지막 데이터가 더 이상 맞지 않으니
// 처음 읽기 실패처럼 화면을 오류로 바꾼다. 관리자에서 내려간 뒤 내 정보 다시 읽기마저 실패해도 옛 관리자 데이터가 남지 않는다.
export function refetchRejected(query: Refetchable): boolean {
  return query.isRefetchError && query.error instanceof ApiError && query.error.status < 500;
}

// 5xx·네트워크로 다시 읽기만 실패했으면 마지막 데이터를 두고(고른 결제 상황 등이 사라지지 않게) 낡았다고 알린다.
export function StaleNotice({ query }: { query: Refetchable }) {
  if (!query.isRefetchError || refetchRejected(query)) return null;
  return (
    <div className={styles.error} role="status">
      <p>최신 정보를 불러오지 못했습니다. 보이는 내용은 마지막으로 읽은 것입니다.</p>
      <button type="button" onClick={() => void query.refetch()}>
        다시 불러오기
      </button>
    </div>
  );
}
