import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

// 리허설 스크립트(backup-rehearsal, pitr-rehearsal)가 PostgreSQL 명령줄 도구를 부르는 방법.
// PG_BIN이 없으면 Windows 설치 경로를, 그것도 없으면 PATH에서 찾는다.
const windowsBin = "C:/Program Files/PostgreSQL/18/bin";
const bin = process.env.PG_BIN ?? (existsSync(windowsBin) ? windowsBin : "");
export const pgTool = (name: string) => (bin ? path.join(bin, name) : name);

// 자식 프로세스에는 실행에 필요한 것만 넘긴다(.env에서 읽은 다른 비밀을 퍼뜨리지 않게). 메시지는 영어로 받는다.
const KEEP = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "USERNAME",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
]);
export function toolEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { LC_MESSAGES: "C" };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && KEEP.has(key.toUpperCase())) env[key] = value;
  }
  return { ...env, ...extra };
}

// libpq 환경 변수로 접속한다. 비밀번호를 명령줄에 두지 않는다.
export function libpqEnv(url: string, database: string) {
  const u = new URL(url);
  return toolEnv({
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: database,
  });
}

export function runTool(name: string, args: string[], env: Record<string, string>) {
  const started = performance.now();
  const r = spawnSync(pgTool(name), args, { env, encoding: "utf8" });
  if (r.error) throw r.error;
  return { status: r.status, ms: Math.round(performance.now() - started), stderr: `${r.stderr ?? ""}`.trim() };
}

// 덤프·백업에는 비밀번호 해시와 세션 토큰 해시가 든다. Windows는 방금 닫은 파일을 잠깐 잡고 있어 다시 시도한다.
export const removeDir = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });

// 정리를 예외뿐 아니라 Ctrl+C와 종료 신호에도 부른다. 정리는 한 번만 돈다.
export function cleanupOnce(cleanup: () => Promise<void>) {
  let done: Promise<void> | null = null;
  const run = () => (done ??= cleanup());
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
    process.once(signal, () => {
      console.error(`${signal}: 정리하고 끝냅니다`);
      void run().finally(() => process.exit(130));
    });
  }
  return run;
}
