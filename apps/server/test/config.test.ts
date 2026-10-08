import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";

const base = { SOUIEBA_PUBLIC_URL: "https://souieba.tail1234.ts.net" };

describe("起動時の安全確認", () => {
  it("既定値（127.0.0.1・https）は通る", () => {
    const c = loadConfig(base);
    expect(c.bind).toBe("127.0.0.1");
    expect(c.postGraceMs).toBe(10 * 60_000);
  });

  it("ワイルドカードで待ち受ける場合は ALLOWED_CIDRS が必須", () => {
    expect(() => loadConfig({ ...base, SOUIEBA_BIND: "0.0.0.0" })).toThrow(ConfigError);
    expect(loadConfig({ ...base, SOUIEBA_BIND: "0.0.0.0", SOUIEBA_ALLOWED_CIDRS: "10.8.0.0/24" }).allowedCidrs).toHaveLength(1);
  });

  it("グローバル IP では待ち受けない", () => {
    expect(() => loadConfig({ ...base, SOUIEBA_BIND: "203.0.113.10" })).toThrow(/SOUIEBA_EXPOSURE=public/);
    expect(loadConfig({ ...base, SOUIEBA_BIND: "100.101.102.103" }).bind).toBe("100.101.102.103");
    expect(loadConfig({ ...base, SOUIEBA_BIND: "10.8.0.1" }).bind).toBe("10.8.0.1");
  });

  it("http は明示的に許可したときだけ", () => {
    const http = { SOUIEBA_PUBLIC_URL: "http://10.8.0.1:8080" };
    expect(() => loadConfig(http)).toThrow(/https/);
    expect(loadConfig({ ...http, SOUIEBA_ALLOW_HTTP: "1" }).publicUrl).toBe("http://10.8.0.1:8080");
  });

  it("公開モードでは、全アドレスでの待ち受けを許す代わりに https と TRUST_PROXY の明示を求める", () => {
    const pub = { SOUIEBA_EXPOSURE: "public", SOUIEBA_PUBLIC_URL: "https://souieba.example.com", SOUIEBA_BIND: "0.0.0.0" };
    expect(() => loadConfig(pub)).toThrow(/TRUST_PROXY/);
    const c = loadConfig({ ...pub, SOUIEBA_TRUST_PROXY: "private" });
    expect(c).toMatchObject({ exposure: "public", bind: "0.0.0.0", trustProxy: "private" });
    expect(loadConfig({ ...pub, SOUIEBA_BIND: "203.0.113.10", SOUIEBA_TRUST_PROXY: "none" }).bind).toBe("203.0.113.10");
    expect(() => loadConfig({ ...pub, SOUIEBA_TRUST_PROXY: "private", SOUIEBA_PUBLIC_URL: "http://203.0.113.10" })).toThrow(/https/);
    expect(() =>
      loadConfig({ ...pub, SOUIEBA_TRUST_PROXY: "private", SOUIEBA_PUBLIC_URL: "http://203.0.113.10", SOUIEBA_ALLOW_HTTP: "1" }),
    ).toThrow(/https/);
  });

  it("不正な値は原因を表示して失敗する", () => {
    expect(() => loadConfig({})).toThrow(/SOUIEBA_PUBLIC_URL/);
    expect(() => loadConfig({ ...base, SOUIEBA_ALLOWED_CIDRS: "10.8.0.0/99" })).toThrow(/ALLOWED_CIDRS/);
  });
});
