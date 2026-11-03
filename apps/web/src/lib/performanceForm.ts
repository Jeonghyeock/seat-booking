import { CreatePerformance, PRICE_MAX, type PerformanceProblem } from "@seat-booking/shared";
import { kstLocalToIso } from "./time";

// 회차 등록 폼(DESIGN 6.5 관리자). 입력은 KST datetime-local이고, 보낼 때 초와 +09:00을 붙인다.
// 작품은 고르기와 새 제목 중 하나만 보낸다(둘 다 오면 API가 400).

export type PerformanceForm = {
  showMode: "existing" | "new";
  showId: string;
  title: string;
  venueId: string;
  prices: Record<string, string>;
  startsAt: string;
  salesOpenAt: string;
  salesCloseAt: string;
};

const FORM_FIELDS = ["show", "venueId", "prices", "startsAt", "salesOpenAt", "salesCloseAt"] as const;
export type FormField = (typeof FORM_FIELDS)[number];
export type FormErrors = Partial<Record<FormField, string>>;

const priceOf = (value: string) => (/^\d+$/.test(value.trim()) ? Number(value.trim()) : null);

// API는 회차 시각을 UTC 2000~2099년만 받는다(shared PerformanceTime). 같은 스키마로 보고, 문구는 입력 기준인 한국 시각으로 쓴다.
const OUT_OF_RANGE = "한국 시각 2000-01-01 09:00부터 2100-01-01 09:00 전까지만 등록할 수 있습니다.";
const inApiRange = (iso: string) => CreatePerformance.shape.startsAt.safeParse(iso).success;

// 폼 → API 본문. 틀린 칸이 있으면 칸마다 문구다.
export function buildCreatePerformance(
  form: PerformanceForm,
  grades: readonly string[],
): { ok: true; body: CreatePerformance } | { ok: false; errors: FormErrors } {
  const errors: FormErrors = {};
  const title = form.title.trim();
  if (form.showMode === "existing" && form.showId === "") errors.show = "작품을 고르세요.";
  if (form.showMode === "new" && (title.length === 0 || title.length > 200)) errors.show = "작품 제목은 1~200자입니다.";
  if (form.venueId === "") errors.venueId = "공연장을 고르세요.";

  const startsAt = kstLocalToIso(form.startsAt);
  const salesOpenAt = kstLocalToIso(form.salesOpenAt);
  const salesCloseAt = kstLocalToIso(form.salesCloseAt);
  if (startsAt === null) errors.startsAt = "공연 시작을 입력하세요.";
  else if (!inApiRange(startsAt)) errors.startsAt = OUT_OF_RANGE;
  if (salesOpenAt === null) errors.salesOpenAt = "판매 시작을 입력하세요.";
  else if (!inApiRange(salesOpenAt)) errors.salesOpenAt = OUT_OF_RANGE;
  if (salesCloseAt === null) errors.salesCloseAt = "판매 종료를 입력하세요.";
  else if (!inApiRange(salesCloseAt)) errors.salesCloseAt = OUT_OF_RANGE;

  const prices: Record<string, number> = {};
  const badPrices = grades.filter((grade) => {
    const price = priceOf(form.prices[grade] ?? "");
    if (price === null || price > PRICE_MAX) return true;
    prices[grade] = price;
    return false;
  });
  if (badPrices.length > 0) errors.prices = `가격은 0원 이상 ${PRICE_MAX.toLocaleString("ko-KR")}원 이하 정수입니다: ${badPrices.join(", ")}`;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  // 위 검사를 지나도 API 스키마가 거절하면(공연장 등급 이름이 너무 긺 등) 던지지 않고 칸 문구로 돌려준다 —
  // 던지면 '등록'이 아무 반응도 하지 않았다(#2 리뷰). zod 기본 문구는 영어라 쓰지 않고, 칸을 모르면 맨 위 칸에 단다.
  const parsed = CreatePerformance.safeParse({
    show: form.showMode === "existing" ? { id: Number(form.showId) } : { title },
    venueId: Number(form.venueId),
    startsAt,
    salesOpenAt,
    salesCloseAt,
    prices,
  });
  if (parsed.success) return { ok: true, body: parsed.data };
  for (const issue of parsed.error.issues) {
    const field = FORM_FIELDS.find((f) => f === issue.path[0]) ?? "show";
    errors[field] ??= "이 값으로는 등록할 수 없습니다. 입력을 확인하세요.";
  }
  return { ok: false, errors };
}

// 422 problems → 칸마다 문구. SHOW_TITLE_EXISTS는 그 작품 id를 함께 돌려 "있는 작품으로 바꾸기"를 보인다.
export function problemsToErrors(problems: readonly PerformanceProblem[]): { errors: FormErrors; existingShowId: number | null } {
  const errors: FormErrors = {};
  let existingShowId: number | null = null;
  const add = (field: FormField, message: string) => {
    errors[field] = errors[field] ? `${errors[field]} ${message}` : message;
  };
  for (const problem of problems) {
    switch (problem.reason) {
      case "VENUE_NOT_FOUND":
        add("venueId", "없는 공연장이거나 좌석 배치가 없습니다.");
        break;
      case "SHOW_NOT_FOUND":
        add("show", "없는 작품입니다.");
        break;
      case "SHOW_TITLE_EXISTS":
        add("show", "같은 제목의 작품이 이미 있습니다.");
        existingShowId = problem.showId;
        break;
      case "SALES_WINDOW_INVALID":
        add("salesCloseAt", "판매 시작 < 판매 종료 ≤ 공연 시작이어야 합니다.");
        break;
      case "SALES_CLOSE_PASSED":
        add("salesCloseAt", "판매 종료가 이미 지났습니다.");
        break;
      case "MISSING_GRADES":
        add("prices", `가격이 없는 등급: ${problem.grades.join(", ")}.`);
        break;
      case "UNKNOWN_GRADES":
        add("prices", `이 공연장에 없는 등급: ${problem.grades.join(", ")}.`);
        break;
    }
  }
  return { errors, existingShowId };
}
