import { ApiError } from "./client";

// API 오류 → 인증 상태에 할 일(DESIGN 6.5 인증 오류, 10장 73).
// - signedOut: 로그인 전이다(GET /auth/me의 401). 아무 데도 보내지 않는다. 공연 목록·좌석 지도는 로그인 전에도 쓴다.
// - sessionExpired: 다른 경로의 401 UNAUTHENTICATED. 내 정보를 null로 하고 사용자 캐시를 지운다.
//   로그인 화면으로는 로그인을 요구하는 화면만 보낸다(화면이 me가 null이 되는 것을 보고 판단한다).
// - forbidden: 403 FORBIDDEN. 관리자에서 내려갔을 수 있으니 내 정보를 다시 읽고 "권한 없음"을 보인다.
// - bug: 403 CSRF_REJECTED. 화면이 헤더를 빠뜨렸거나 APP_ORIGIN이 화면 주소와 다르다.
// - none: 위에 들지 않는다. 가입·로그인 폼의 오류는 폼에 보이므로 여기서 다루지 않는다.
export type AuthAction = "signedOut" | "sessionExpired" | "forbidden" | "bug" | "none";

const FORM_PATHS = new Set(["/auth/login", "/auth/signup"]);

export function authActionFor(error: unknown): AuthAction {
  if (!(error instanceof ApiError)) return "none";
  if (FORM_PATHS.has(error.path)) return "none";
  if (error.status === 401) return error.path === "/auth/me" ? "signedOut" : "sessionExpired";
  if (error.status === 403) {
    if (error.code === "FORBIDDEN") return "forbidden";
    if (error.code === "CSRF_REJECTED") return "bug";
  }
  return "none";
}
