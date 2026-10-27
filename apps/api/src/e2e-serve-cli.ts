// E2E의 API(DESIGN 6.5 E2E). Playwright는 준비(e2e:prepare, 소유자)와 같은 env를 주므로,
// 서버 프로세스가 소유자 주소를 갖지 않게 지우고 띄운다. 서버는 앱 role(DATABASE_URL)로만 접속한다.
delete process.env.DATABASE_OWNER_URL;
await import("./main.js");
