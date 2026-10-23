import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// 화면은 API와 같은 origin에 둔다(DESIGN 10장 62). 개발에서는 Vite가 /api/*를 API로 넘기며 /api를 뗀다.
// 프록시는 Origin을 바꾸지 않으므로 API의 APP_ORIGIN은 브라우저 주소와 정확히 같아야 한다(개발 http://localhost:5173).
// E2E는 다른 주소·포트·API로 띄운다(WEB_HOST, WEB_PORT, API_PROXY_TARGET).
// strictPort: 포트가 바쁘면 다음 포트로 옮기지 않고 실패한다(옮겨 가 E2E 포트를 차지하지 않게).
const apiTarget = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3001";

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.WEB_HOST ?? "localhost",
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      "^/api/": { target: apiTarget, rewrite: (path) => path.replace(/^\/api/, "") },
    },
  },
  test: {
    environment: "jsdom",
    // E2E(Playwright) 파일을 잡지 않게 src 안의 테스트만 돈다.
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
  },
});
