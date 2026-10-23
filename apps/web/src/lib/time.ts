// 시각 표시와 입력(DESIGN 6.2 끝 "5단계 화면에서 지킬 것"). API의 시각은 UTC ISO 문자열이고, 화면은 KST로 보인다.
// 관리자 회차 등록은 KST로 받은 값에 초와 +09:00을 붙여 보낸다. 브라우저 시간대를 따르는 toISOString()으로 바꾸지 않는다.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const dateTime = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// "10. 24. (금) 19:30"처럼 보인다.
export function formatKst(iso: string): string {
  return dateTime.format(new Date(iso));
}

// datetime-local 입력값(KST로 본다, 초는 있어도 없어도 된다) → API에 보낼 "YYYY-MM-DDTHH:mm:ss+09:00". 형식이 틀리면 null이다.
export function kstLocalToIso(local: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!match) return null;
  const [, date, hour, minute, second = "00"] = match;
  const iso = `${date}T${hour}:${minute}:${second}+09:00`;
  // 2월 30일 같은 날짜는 Date가 다음 달로 넘기므로, 되돌려 같은지 본다.
  return Number.isNaN(Date.parse(iso)) || isoToKstLocal(iso).slice(0, 16) !== `${date}T${hour}:${minute}` ? null : iso;
}

// ISO 시각 → KST의 datetime-local 값("YYYY-MM-DDTHH:mm").
export function isoToKstLocal(iso: string): string {
  return new Date(Date.parse(iso) + KST_OFFSET_MS).toISOString().slice(0, 16);
}

// 판매 종료 기본값: 공연 3시간 전(DESIGN 10장 54). 입력값(datetime-local)을 받아 입력값으로 준다.
export function defaultSalesClose(startsAtLocal: string): string | null {
  const iso = kstLocalToIso(startsAtLocal);
  if (iso === null) return null;
  return isoToKstLocal(new Date(Date.parse(iso) - 3 * 60 * 60 * 1000).toISOString());
}

// 남은 시간 "4:59". 0보다 작으면 0:00이다.
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// 원화 금액 "150,000원".
export function formatWon(amount: number): string {
  return `${amount.toLocaleString("ko-KR")}원`;
}
