import { promoteToAdmin } from "./admin.js";
import { createDb } from "./db/client.js";
import { createPool } from "./db/pool.js";

// 가입한 계정을 관리자로 올린다(DESIGN 6.3 역할). 서버 밖에서 DB에 직접 붙는 운영 작업이다.
// npm run admin:promote -w @seat-booking/api -- <email>
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL이 없습니다(.env 또는 환경 변수)");
const email = process.argv[2];
if (!email) {
  console.error("사용법: npm run admin:promote -w @seat-booking/api -- <email>");
  process.exit(2);
}

const pool = createPool({ connectionString: url });
try {
  const result = await promoteToAdmin(createDb(pool), email);
  if (!result.ok) {
    console.error(
      result.reason === "NOT_FOUND"
        ? `그 이메일로 가입한 계정이 없습니다: ${email}`
        : `비밀번호가 없는 계정이라 올릴 수 없습니다(먼저 가입해야 합니다): ${email}`,
    );
    process.exitCode = 1;
  } else if (result.alreadyAdmin) {
    console.log(`이미 관리자입니다(사용자 ${result.userId})`);
  } else {
    console.log(`관리자로 올렸습니다(사용자 ${result.userId}). 그 사용자의 세션은 모두 지웠으니 다시 로그인해야 합니다`);
  }
} finally {
  await pool.end();
}
