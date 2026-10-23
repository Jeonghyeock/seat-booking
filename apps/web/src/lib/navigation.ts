// 로그인·가입 뒤 돌아갈 경로(?next=). 같은 사이트 안의 경로만 받는다(열린 리다이렉트를 막는다, DESIGN 10장 73).
// "/"로 시작하고 "//"나 "/\"로 시작하지 않아야 한다(브라우저는 둘 다 다른 호스트로 본다).
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

// 지금 경로를 next로 붙인 로그인 주소.
export function loginPath(currentPath: string): string {
  return `/login?next=${encodeURIComponent(currentPath)}`;
}
