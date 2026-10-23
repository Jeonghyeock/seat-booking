import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useMe } from "../api/queries";
import { loginPath } from "../lib/navigation";
import { Loading } from "./States";

// 관리자 화면. 메뉴를 숨기는 것은 편의이고 권한은 서버가 지킨다(DESIGN 6.5 관리자).
// 관리자에서 내려가면 API가 403 FORBIDDEN을 주고 내 정보를 다시 읽으므로 이 화면이 "권한 없음"으로 바뀐다.
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { data: me, isPending } = useMe();
  const location = useLocation();
  if (isPending) return <Loading />;
  if (!me) return <Navigate to={loginPath(location.pathname + location.search)} replace />;
  if (me.role !== "admin") {
    return (
      <section>
        <h1>권한 없음</h1>
        <p>관리자만 볼 수 있는 화면입니다.</p>
      </section>
    );
  }
  return children;
}
