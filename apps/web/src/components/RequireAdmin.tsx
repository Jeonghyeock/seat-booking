import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useMe } from "../api/queries";
import { loginPath } from "../lib/navigation";
import { usePageTitle } from "../lib/usePageTitle";
import { LoadError, Loading } from "./States";

// 관리자 화면. 메뉴를 숨기는 것은 편의이고 권한은 서버가 지킨다(DESIGN 6.5 관리자).
// 관리자에서 내려가면 API가 403 FORBIDDEN을 주고 내 정보를 다시 읽으므로 이 화면이 "권한 없음"으로 바뀐다.
// 그 다시 읽기가 5xx로 실패해 옛 내 정보가 남아도, 403으로 거절된 페이지 질의는 refetchRejected로 오류 화면이 된다.
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { data: me, isPending, isLoadingError, error, refetch } = useMe();
  const location = useLocation();
  if (isPending) return <Loading />;
  if (isLoadingError) return <LoadError error={error} onRetry={() => void refetch()} />;
  if (!me) return <Navigate to={loginPath(location.pathname + location.search)} replace />;
  if (me.role !== "admin") return <Forbidden />;
  return children;
}

function Forbidden() {
  usePageTitle("권한 없음");
  return (
    <section>
      <h1>권한 없음</h1>
      <p>관리자만 볼 수 있는 화면입니다.</p>
    </section>
  );
}
