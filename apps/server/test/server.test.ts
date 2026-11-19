import { describe, expect, it } from "vitest";
import { MIN_CLIENT_VERSION, createApp } from "../src/app.ts";
import { rateLimitKey } from "../src/net.ts";
import { RateLimiter } from "../src/ratelimit.ts";
import { harness, testConfig } from "./harness.ts";

/** 認証なしで、IP ごとに数える（30回/10分）エンドポイント。本文が不正なら 400 */
const probe = (h: ReturnType<typeof harness>, headers: Record<string, string> = {}) => h.call("POST", "/v2/auth/challenge", undefined, {}, headers);

describe("クライアントのバージョン", () => {
  it("バージョンを送らない・古いクライアントは 426 で断る", async () => {
    const h = harness();
    for (const v of ["", "0.3.9", "2.0.0", "nonsense"]) {
      const r = await h.call("GET", "/v2/me", undefined, undefined, { "x-souieba-client": v });
      expect(r.status).toBe(426);
      expect(r.body.error.code).toBe("client_outdated");
    }
    // 認証より先に断る（古いクライアントには、まず更新を促す）
    expect((await h.call("POST", "/v2/auth/challenge", undefined, {}, { "x-souieba-client": "0.1.0" })).status).toBe(426);
    expect((await h.call("GET", "/v2/me", undefined, undefined, { "x-souieba-client": MIN_CLIENT_VERSION })).status).toBe(401);
    expect((await h.call("GET", "/v2/me", undefined, undefined, { "x-souieba-client": "9.0.0" })).status).toBe(401);
  });
});

describe("v1 の API", () => {
  it("/v1/* はなくなっていて、404 を返す", async () => {
    const h = harness();
    for (const [method, path] of [
      ["GET", "/v1/instance"],
      ["POST", "/v1/auth/redeem"],
      ["GET", "/v1/me"],
      ["POST", "/v1/admin/bootstrap"],
    ] as const) {
      expect((await h.call(method, path)).status).toBe(404);
    }
  });
});

describe("ネットワーク", () => {
  it("信頼するプロキシが付けた X-Forwarded-For の末尾だけを使う（先頭は偽れる）", async () => {
    const h = harness({ remoteAddr: "127.0.0.1" });
    // 攻撃者が先頭を毎回変えても、プロキシが末尾に付けた実際の IP で数えられる
    for (let i = 0; i < 30; i++) await probe(h, { "x-forwarded-for": `1.1.1.${i}, 198.51.100.7` });
    expect((await probe(h, { "x-forwarded-for": "9.9.9.9, 198.51.100.7" })).status).toBe(429);
    expect((await probe(h, { "x-forwarded-for": "198.51.100.8" })).status).toBe(400);

    // 信頼しない接続元からの XFF は無視する
    const h2 = harness({ remoteAddr: "100.64.0.3" });
    for (let i = 0; i < 30; i++) await probe(h2, { "x-forwarded-for": `1.1.1.${i}` });
    expect((await probe(h2, { "x-forwarded-for": "9.9.9.9" })).status).toBe(429);
  });

  it("TRUST_PROXY=private なら Docker のブリッジ上のプロキシからの XFF を信頼する", async () => {
    const h = harness({ config: { trustProxy: "private" }, remoteAddr: "172.18.0.2" });
    for (let i = 0; i < 30; i++) await probe(h, { "x-forwarded-for": "198.51.100.7" });
    expect((await probe(h, { "x-forwarded-for": "198.51.100.8" })).status).toBe(400);
  });

  it("レート制限は IPv6 を /64 でまとめて数える", async () => {
    expect(rateLimitKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateLimitKey("::ffff:198.51.100.7")).toBe("198.51.100.7");
    const h = harness({ remoteAddr: "2001:db8:1:2::1" });
    for (let i = 0; i < 30; i++) {
      h.setIp(`2001:db8:1:2::${i + 1}`);
      await probe(h);
    }
    h.setIp("2001:db8:1:2:ffff::9");
    expect((await probe(h)).status).toBe(429);
    h.setIp("2001:db8:1:3::1");
    expect((await probe(h)).status).toBe(400);
  });

  it("レート制限が覚えるキーには上限があり、古いものから忘れる", () => {
    const limiter = new RateLimiter(1, 60_000, 100);
    expect(limiter.take("first", 0)).toBe(true);
    expect(limiter.take("first", 0)).toBe(false);
    for (let i = 0; i < 200; i++) limiter.take(`k${i}`, 1);
    expect(limiter.size).toBe(100);
    expect(limiter.blocked("first", 1)).toBe(false);
    // 期限の切れたものは先頭から消える
    limiter.take("late", 120_000);
    expect(limiter.size).toBe(1);
  });
});

describe("ログ", () => {
  it("アクセスログに本文・トークン・チャレンジを出さない", async () => {
    const lines: string[] = [];
    const h = harness();
    const app = createApp({
      db: h.db,
      config: { ...testConfig(), logLevel: "info" },
      now: () => h.clock.now,
      remoteAddr: () => "127.0.0.1",
      log: (l) => lines.push(JSON.stringify(l)),
    });
    const token = `sou_r_${"Z".repeat(43)}`;
    const headers = { "x-souieba-client": MIN_CLIENT_VERSION };
    await app.request("/v2/auth/session?challenge=SECRETCHALLENGE", { method: "POST", headers, body: JSON.stringify({ challenge: "SECRETCHALLENGE" }) });
    await app.request("/v2/me", { headers: { ...headers, authorization: `Bearer ${token}` } });
    const all = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(all).not.toContain(token);
    expect(all).not.toContain("SECRETCHALLENGE");
  });
});

describe("本文の大きさ", () => {
  it("Content-Length のない（chunked の）本文も、上限を超えたら 413", async () => {
    const h = harness();
    const big = new TextEncoder().encode(JSON.stringify({ personKey: "x".repeat(32 * 1024) }));
    const res = await h.app.request("/v2/devices", {
      method: "POST",
      headers: { "x-souieba-client": MIN_CLIENT_VERSION, "content-type": "application/json" },
      body: new ReadableStream({
        start(c) {
          c.enqueue(big);
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
  });
});
