import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

// 완료 기준(DESIGN 8장 5단계): 가입 → 선점 → 결제 → 내 예매.
// 다시 돌려도 되게 이메일은 시도마다 새로 만들고, 좌석은 지도에서 처음 나오는 고를 수 있는 좌석을 고른다.
test("가입하고 좌석 둘을 선점해 결제하면 내 예매에 결제 완료로 남는다", async ({ page }) => {
  const email = `e2e-${randomUUID()}@test.local`;
  // 비밀번호처럼 보이는 글자를 소스에 두지 않는다(저장소의 비밀 정보 검사). 값은 만들어 쓴다.
  const password = randomUUID();

  await page.goto("/signup");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "가입" }).click();
  await expect(page.getByText(email)).toBeVisible();

  // 판매 중인 첫 회차의 좌석 지도
  await page.getByRole("link", { name: /^좌석 고르기/ }).first().click();
  const available = page.getByRole("button", { name: /선택 가능$/ });
  await available.first().click();
  await available.first().click();
  await expect(page.getByRole("button", { name: /선택함$/ })).toHaveCount(2);

  await page.getByRole("button", { name: "2석 선점하기" }).click();
  await expect(page).toHaveURL(/\/orders\/\d+$/);
  await expect(page.getByText(/결제 마감까지/)).toBeVisible();

  // 결제(가짜 결제사, 기본 상황은 성공). 웹훅은 1초 뒤 오고, 화면은 1초마다 주문을 다시 읽는다.
  await page.getByRole("button", { name: /결제하기$/ }).click();
  // 화면 읽기 프로그램용 알림 줄에도 같은 글이 있어 보이는 상태 글자를 고른다
  await expect(page.locator("strong", { hasText: "예매가 완료되었습니다." })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/^표 \d+/)).toHaveCount(2);

  await page.getByRole("link", { name: "내 예매" }).click();
  await expect(page.getByRole("heading", { name: "내 예매" })).toBeVisible();
  await expect(page.getByText("예매 완료").first()).toBeVisible();

  // 로그인이 필요한 화면에서 로그아웃해도 로그인 화면이 아니라 공연 목록에서 끝난다
  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page.getByRole("link", { name: "로그인" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});
