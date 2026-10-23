import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { logout as logoutRequest } from "../api/endpoints";
import { clearUserQueries, queryKeys, useMe } from "../api/queries";
import { clearAttempts } from "../lib/idempotency";
import { clearSelections } from "../lib/selection";
import styles from "./Layout.module.css";

export function Layout() {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const main = useRef<HTMLElement>(null);

  // 다른 탭에서 로그아웃하거나 다른 계정으로 로그인하면, 창으로 돌아와 내 정보를 다시 읽을 때 사용자가 바뀐다.
  // 그때 앞 사용자의 캐시를 지운다.
  const previousUserId = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (me === undefined) return;
    const userId = me?.userId ?? null;
    if (previousUserId.current !== undefined && previousUserId.current !== userId) clearUserQueries(queryClient);
    previousUserId.current = userId;
  }, [me, queryClient]);

  // 화면이 바뀌면 새 화면의 제목(없으면 본문)으로 포커스를 옮긴다(화면 읽기 프로그램이 새 화면을 처음부터 읽게). 첫 화면은 그대로 둔다.
  const firstPath = useRef(true);
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    const heading = main.current?.querySelector("h1");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus();
    } else {
      main.current?.focus();
    }
  }, [location.pathname]);

  // 로그아웃은 공개 화면으로 먼저 간 뒤에 한다(DESIGN 6.5). 로그인이 필요한 화면에서 내 정보를 먼저 비우면
  // 그 화면이 로그인 화면으로 보내고, 그 화면의 조회가 401을 받는다.
  const [loggingOut, setLoggingOut] = useState(false);
  const logout = useMutation({
    mutationFn: logoutRequest,
    onSettled: () => {
      queryClient.setQueryData(queryKeys.me, null);
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.me[0] });
      clearAttempts();
      clearSelections();
    },
  });
  useEffect(() => {
    if (!loggingOut || location.pathname !== "/") return;
    setLoggingOut(false);
    logout.mutate();
  }, [loggingOut, location.pathname, logout]);

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
              <button
                type="button"
                onClick={() => {
                  setLoggingOut(true);
                  void navigate("/", { replace: true });
                }}
                disabled={loggingOut || logout.isPending}
              >
                로그아웃
              </button>
            </>
          ) : me === null ? (
            <Link to="/login">로그인</Link>
          ) : null}
        </div>
      </header>
      <main ref={main} tabIndex={-1} className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
