// 멱등 키 저장소(DESIGN 6.2 "멱등 키의 수명", 6.5 멱등 키, 10장 76).
// - 사용자가 버튼을 누를 때마다 새 시도(새 키)를 만들고, 보내기 **전에** sessionStorage에 쓴다(응답 전에 새로고침해도 같은 키로 이어 간다).
// - 같은 시도의 재시도(네트워크 오류, 503, REQUEST_IN_PROGRESS)는 저장한 키와 본문을 그대로 쓴다(서버는 키와 본문의 해시를 함께 본다).
// - 이름은 idem:createOrder:<holdId>, idem:pay:<orderId>다. 탭마다 따로이고, 다른 탭에는 키가 없어 새 키로 보낸다(중복은 서버가 막는다).

export type Attempt = { key: string; body: unknown; attempt: number };

const PREFIX = "idem:";

export const createOrderAttemptName = (holdId: number) => `${PREFIX}createOrder:${holdId}`;
export const payAttemptName = (orderId: number) => `${PREFIX}pay:${orderId}`;

// sessionStorage를 쓸 수 없는 창(개인 정보 보호 설정 등)에서는 탭 메모리에 둔다.
const memory = new Map<string, string>();
function getItem(name: string): string | null {
  try {
    return sessionStorage.getItem(name);
  } catch {
    return memory.get(name) ?? null;
  }
}
function setItem(name: string, value: string) {
  try {
    sessionStorage.setItem(name, value);
  } catch {
    memory.set(name, value);
  }
}

export function readAttempt(name: string): Attempt | null {
  const raw = getItem(name);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null && "key" in value && typeof value.key === "string") {
      return value as Attempt;
    }
  } catch {
    // 깨진 값은 없는 것으로 본다
  }
  return null;
}

// 새 시도를 만들어 저장한다. attempt는 앞 시도보다 하나 크다("다시 결제"는 새 시도다).
export function startAttempt(name: string, body: unknown): Attempt {
  const attempt: Attempt = { key: crypto.randomUUID(), body, attempt: (readAttempt(name)?.attempt ?? 0) + 1 };
  setItem(name, JSON.stringify(attempt));
  return attempt;
}

// 저장한 시도가 있으면 그것을, 없으면 새 시도를 준다(새로고침 뒤 이어 보내기).
export function currentOrNewAttempt(name: string, body: unknown): Attempt {
  return readAttempt(name) ?? startAttempt(name, body);
}

// 로그아웃할 때 지운다(다른 사용자가 같은 탭을 쓸 수 있다).
export function clearAttempts() {
  memory.clear();
  try {
    for (const name of Object.keys(sessionStorage)) if (name.startsWith(PREFIX)) sessionStorage.removeItem(name);
  } catch {
    // 쓸 수 없는 창
  }
}
