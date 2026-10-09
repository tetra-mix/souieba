import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";

const base = { SOUIEBA_PUBLIC_URL: "https://souieba.example.com" };

describe("起動時の安全確認", () => {
  it("既定値（127.0.0.1・https・TRUST_PROXY=loopback）は通る", () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({ bind: "127.0.0.1", trustProxy: "loopback", publicUrl: "https://souieba.example.com" });
    expect(c.postGraceMs).toBe(10 * 60_000);
    expect(c.postRetentionMs).toBe(30 * 86_400_000);
  });

  it("リバースプロキシの裏で全アドレスで待ち受けられる", () => {
    const c = loadConfig({ ...base, SOUIEBA_BIND: "0.0.0.0", SOUIEBA_TRUST_PROXY: "private" });
    expect(c).toMatchObject({ bind: "0.0.0.0", trustProxy: "private" });
  });

  it("http は手元で動かす開発用（localhost / 127.0.0.1 / ::1）だけ", () => {
    expect(() => loadConfig({ SOUIEBA_PUBLIC_URL: "http://203.0.113.10" })).toThrow(ConfigError);
    expect(() => loadConfig({ SOUIEBA_PUBLIC_URL: "http://10.8.0.1:8080" })).toThrow(/https/);
    expect(loadConfig({ SOUIEBA_PUBLIC_URL: "http://127.0.0.1:8080" }).publicUrl).toBe("http://127.0.0.1:8080");
    expect(loadConfig({ SOUIEBA_PUBLIC_URL: "http://localhost:8080" }).publicUrl).toBe("http://localhost:8080");
    expect(loadConfig({ SOUIEBA_PUBLIC_URL: "http://[::1]:8080" }).publicUrl).toBe("http://[::1]:8080");
  });

  it("不正な値は原因を表示して失敗する", () => {
    expect(() => loadConfig({})).toThrow(/SOUIEBA_PUBLIC_URL/);
    expect(() => loadConfig({ ...base, SOUIEBA_TRUST_PROXY: "all" })).toThrow(/SOUIEBA_TRUST_PROXY/);
  });
});
