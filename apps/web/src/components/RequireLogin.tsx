import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useMe } from "../api/queries";
import { loginPath } from "../lib/navigation";
import { LoadError, Loading } from "./States";

// 로그인이 필요한 화면(주문, 내 예매). 내 정보를 다 읽은 뒤에 판단하고, 로그인 전이거나 세션이 끝났으면
// 지금 경로를 next로 붙여 로그인 화면으로 보낸다(DESIGN 6.5 인증 오류). 내 정보를 읽지 못했으면(5xx·네트워크) 로그아웃으로 보지 않는다.
// 이미 읽은 내 정보가 있으면 다시 읽기(창 포커스 등)가 실패해도 보던 화면을 그대로 둔다(#3 리뷰).
export function RequireLogin({ children }: { children: ReactNode }) {
  const { data: me, isPending, isLoadingError, error, refetch } = useMe();
  const location = useLocation();
  if (isPending) return <Loading />;
  if (isLoadingError) return <LoadError error={error} onRetry={() => void refetch()} />;
  if (!me) return <Navigate to={loginPath(location.pathname + location.search)} replace />;
  return children;
}
