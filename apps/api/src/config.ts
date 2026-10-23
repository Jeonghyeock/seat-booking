import { z } from "zod";
import type { AuthConfig } from "./routes/session.js";

// 서버 설정(DESIGN 6.3 설정). main.ts만 읽는다. 테스트는 buildApp에 값을 바로 넘긴다.

// 끝에 /가 붙거나 경로가 있으면 브라우저가 보내는 Origin과 같을 수 없어 모든 요청이 403이 된다. 그래서 띄울 때 거절한다.
const Origin = z.string().refine((value) => {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}, "APP_ORIGIN의 각 항목은 끝에 /가 없는 origin이어야 합니다(예: http://localhost:5173)");

const Env = z.object({
  APP_ORIGIN: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    )
    .pipe(z.array(Origin)),
  // "true"/"false" 글자만 받는다. z.coerce.boolean()은 "false"를 참으로 본다.
  COOKIE_SECURE: z.enum(["true", "false"]).default("true"),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
});

export function loadAuthConfig(env: Record<string, string | undefined>): AuthConfig {
  const parsed = Env.parse(env);
  return {
    allowedOrigins: parsed.APP_ORIGIN,
    cookieSecure: parsed.COOKIE_SECURE === "true",
    authRateLimitPerMinute: parsed.AUTH_RATE_LIMIT_PER_MINUTE,
  };
}
