import { isIP } from "node:net";
import { z } from "zod";
import type { AuthConfig } from "./routes/session.js";

// 서버 설정(DESIGN 6.3 설정). main.ts만 읽는다. 테스트는 buildApp에 값을 바로 넘긴다.

// 쉼표로 나눈 목록. 앞뒤 공백과 빈 항목은 버린다.
const list = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

// 끝에 /가 붙거나 경로가 있으면 브라우저가 보내는 Origin과 같을 수 없어 모든 요청이 403이 된다. 그래서 띄울 때 거절한다.
const Origin = z.string().refine((value) => {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}, "APP_ORIGIN의 각 항목은 끝에 /가 없는 origin이어야 합니다(예: http://localhost:5173)");

const Env = z.object({
  APP_ORIGIN: z.string().default("").transform(list).pipe(z.array(Origin)),
  // "true"/"false" 글자만 받는다. z.coerce.boolean()은 "false"를 참으로 본다.
  COOKIE_SECURE: z.enum(["true", "false"]).default("true"),
  // 숫자만 받는다. z.coerce.number()는 "0x10"·"1e9"도 숫자로 본다.
  AUTH_RATE_LIMIT_PER_MINUTE: z
    .string()
    .regex(/^[1-9]\d{0,4}$/,"AUTH_RATE_LIMIT_PER_MINUTE는 1~99999의 정수여야 합니다")
    .default("10")
    .transform(Number),
});

export function loadAuthConfig(env: Record<string, string | undefined>): AuthConfig {
  const parsed = Env.parse(env);
  return {
    allowedOrigins: parsed.APP_ORIGIN,
    cookieSecure: parsed.COOKIE_SECURE === "true",
    authRateLimitPerMinute: parsed.AUTH_RATE_LIMIT_PER_MINUTE,
  };
}

// 믿을 프록시의 IP 주소 또는 CIDR(예: 10.0.0.1, 10.0.0.0/8, ::1).
const ProxyAddress = z.string().refine((value) => {
  const [address = "", prefix, ...rest] = value.split("/");
  const version = isIP(address);
  if (version === 0 || rest.length > 0) return false;
  return prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128));
}, "TRUST_PROXY의 각 항목은 IP 주소나 CIDR이어야 합니다");

const ProxyEnv = z.object({
  TRUST_PROXY: z
    .string()
    .default("")
    .transform((value) => value.trim())
    .pipe(
      z.union([
        z.literal("").transform(() => false as const),
        z.string().transform(list).pipe(z.array(ProxyAddress).min(1)),
      ]),
    ),
});

// 프록시 뒤에서 요청한 쪽 IP(request.ip)를 X-Forwarded-For에서 읽을지(Fastify trustProxy, DESIGN 6.3 설정). 속도 제한이 이 IP로 센다.
// 비우면 끈다(연결한 쪽 주소). 켤 때는 믿을 프록시의 주소·CIDR을 쉼표로 적는다.
// true(모두 믿음)는 받지 않는다. 누구나 X-Forwarded-For를 지어 보내 IP를 바꿀 수 있어 속도 제한이 없는 것과 같다.
// 앞단 프록시 수(숫자)도 받지 않는다. Fastify 5는 숫자를 주면 아무 프록시도 믿지 않는다(바로 붙은 쪽을 확인할 수 없어서).
export function loadTrustProxy(env: Record<string, string | undefined>): false | string[] {
  return ProxyEnv.parse(env).TRUST_PROXY;
}
