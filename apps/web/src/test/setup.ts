import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// vitest의 globals를 켜지 않으면 Testing Library가 테스트마다 화면을 지우지 않는다.
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
