import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { defineConfig, devices } from "@playwright/test";

// E2E(DESIGN 6.5 E2E, 10장 72). 개발 서버와 겹치지 않게 다른 DB(seat_booking_e2e)와 포트(API 3101, 화면 5174)를 쓴다.
// 브라우저 쪽 주소는 baseURL·APP_ORIGIN·Vite 모두 127.0.0.1 하나다(localhost를 IPv4·IPv6 중 어디로 푸는지가 도구마다 다르다).
const API_PORT = 3101;
const WEB_ORIGIN = "http://127.0.0.1:5174";

// DB 주소는 환경 변수(CI), 없으면 저장소 .env에서 DATABASE_URL 하나만 읽는다(슈퍼유저 비밀번호를 webServer로 퍼뜨리지 않게).
function baseDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const file = new URL("../../.env", import.meta.url);
  const url = existsSync(file) ? parseEnv(readFileSync(file, "utf8")).DATABASE_URL : undefined;
  if (!url) throw new Error("DATABASE_URL이 없습니다(.env 또는 환경 변수)");
  return url;
}
const e2eDatabaseUrl = (() => {
  const u = new URL(baseDatabaseUrl());
  u.pathname = "/seat_booking_e2e";
  return u.toString();
})();

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

export default defineConfig({
  testDir: "e2e",
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: { baseURL: WEB_ORIGIN, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // API를 먼저 띄운다(DB 준비가 끝나 /health가 200이 된 뒤 화면을 띄운다). 띄울 때마다 DB를 새로 만드므로 이미 떠 있는 서버는 쓰지 않는다.
  webServer: [
    {
      // DB 준비(지우기·만들기·마이그레이션·시드)는 API를 띄우는 명령 안에서 한다. Playwright는 globalSetup보다 webServer를 먼저 띄운다.
      // --env-file은 넘기지 않은 키를 .env에서 채우므로 쓰지 않고, API가 읽는 키 여덟 개를 모두 준다.
      command: "npm run e2e:prepare -w @seat-booking/api && npm run e2e:serve -w @seat-booking/api",
      cwd: repoRoot,
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        DATABASE_URL: e2eDatabaseUrl,
        PORT: String(API_PORT),
        HOST: "127.0.0.1",
        APP_ORIGIN: WEB_ORIGIN,
        COOKIE_SECURE: "false",
        AUTH_RATE_LIMIT_PER_MINUTE: "10",
        TRUST_PROXY: "",
        FAKE_PAY_SECRET: "",
      },
    },
    {
      command: "npm run dev -w @seat-booking/web",
      cwd: repoRoot,
      url: WEB_ORIGIN,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { WEB_HOST: "127.0.0.1", WEB_PORT: "5174", API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
