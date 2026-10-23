import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router";
import { logout as logoutRequest } from "../api/endpoints";
import { clearUserQueries, queryKeys, useMe } from "../api/queries";
import { clearAttempts } from "../lib/idempotency";
import { clearSelections } from "../lib/selection";
import styles from "./Layout.module.css";

export function Layout() {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // 다른 탭에서 로그아웃하거나 다른 계정으로 로그인하면, 창으로 돌아와 내 정보를 다시 읽을 때 사용자가 바뀐다.
  // 그때 앞 사용자의 캐시를 지운다.
  const previousUserId = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (me === undefined) return;
    const userId = me?.userId ?? null;
    if (previousUserId.current !== undefined && previousUserId.current !== userId) clearUserQueries(queryClient);
    previousUserId.current = userId;
  }, [me, queryClient]);

  const logout = useMutation({
    mutationFn: logoutRequest,
    onSettled: () => {
      // 공개 화면으로 먼저 간 뒤 비운다(그려진 주문 화면이 다시 읽다가 401을 받지 않게).
      void navigate("/", { replace: true });
      queryClient.setQueryData(queryKeys.me, null);
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.me[0] });
      clearAttempts();
      clearSelections();
    },
  });

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          좌석 예매
        </Link>
        <nav aria-label="주 메뉴" className={styles.nav}>
          <NavLink to="/" end>
            공연
          </NavLink>
          {me && <NavLink to="/my/orders">내 예매</NavLink>}
          {me?.role === "admin" && <NavLink to="/admin">관리자</NavLink>}
        </nav>
        <div className={styles.account}>
          {me ? (
            <>
              <span className={styles.email}>{me.email}</span>
              <button type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>
                로그아웃
              </button>
            </>
          ) : me === null ? (
            <Link to="/login">로그인</Link>
          ) : null}
        </div>
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
