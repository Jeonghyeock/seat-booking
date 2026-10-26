import { describe, expect, it } from "vitest";
import { loadServerConfig } from "./config.js";

describe("서버 설정(측정용 손잡이)", () => {
  it("없으면 손잡이를 더하기 전과 같다: 풀 10, 연결 대기 한도 없음, info, 지표 끔", () => {
    expect(loadServerConfig({})).toEqual({ poolMax: 10, connectTimeoutMs: 0, logLevel: "info", loadStatsDir: null });
    expect(loadServerConfig({ LOAD_STATS: "  " }).loadStatsDir).toBeNull();
  });

  it("값을 읽는다. 지표 디렉터리의 앞뒤 공백은 지운다", () => {
    expect(
      loadServerConfig({ DB_POOL_MAX: "40", DB_CONNECT_TIMEOUT_MS: "2000", LOG_LEVEL: "warn", LOAD_STATS: " load/results/run1 " }),
    ).toEqual({ poolMax: 40, connectTimeoutMs: 2000, logLevel: "warn", loadStatsDir: "load/results/run1" });
    expect(loadServerConfig({ DB_POOL_MAX: "1" }).poolMax).toBe(1);
    expect(loadServerConfig({ DB_POOL_MAX: "100" }).poolMax).toBe(100);
  });

  it("범위 밖이나 숫자가 아닌 글자는 띄울 때 거절한다", () => {
    for (const value of ["0", "101", "1e1", "0x10", " 10", "10.0", "-1", ""]) {
      expect(() => loadServerConfig({ DB_POOL_MAX: value }), value).toThrow();
    }
    for (const value of ["-1", "1000000", "01", "1.5", ""]) {
      expect(() => loadServerConfig({ DB_CONNECT_TIMEOUT_MS: value }), value).toThrow();
    }
    for (const value of ["WARN", "verbose", ""]) {
      expect(() => loadServerConfig({ LOG_LEVEL: value }), value).toThrow();
    }
  });
});
