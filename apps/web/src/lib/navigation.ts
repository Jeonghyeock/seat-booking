// 로그인·가입 뒤 돌아갈 경로(?next=). 같은 사이트 안의 경로만 받는다(열린 리다이렉트를 막는다, DESIGN 10장 73).
// 글자로 거르지 않고 브라우저처럼 URL로 풀어 origin을 본다("//", "/\\", 탭·줄바꿈이 섞인 "/\t/" 모두 다른 호스트가 된다).
export function safeNext(next: string | null | undefined, origin = window.location.origin): string {
  if (!next || !next.startsWith("/")) return "/";
  try {
    const url = new URL(next, origin);
    return url.origin === origin ? url.pathname + url.search + url.hash : "/";
  } catch {
    return "/";
  }
}

// 지금 경로를 next로 붙인 로그인 주소.
export function loginPath(currentPath: string): string {
  return `/login?next=${encodeURIComponent(currentPath)}`;
}
