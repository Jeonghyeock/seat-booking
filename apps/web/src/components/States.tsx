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
