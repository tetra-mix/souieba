/**
 * Workers 版を workerd（wrangler の unstable_dev）で動かし、HTTP 越しに一通りの流れを確かめる。
 * Durable Object の SQLite・Drizzle の durable-sqlite ドライバ・入口の検査を、本物の実行環境で通す。
 * 入口は test/fixtures/worker-entry.ts（本番の Worker に、Durable Object の行を数える口などを足したもの）。
 */
import { fileURLToPath } from "node:url";
import {
  CLIENT_VERSION_HEADER,
  type DeviceIdentity,
  type PersonKeys,
  certifyDevice,
  generateDevice,
  generatePerson,
  openRelayMessage,
  sealRelayMessage,
  signChallenge,
} from "@souieba/core";
import { MIN_CLIENT_VERSION } from "../src/app.ts";
import { type Unstable_DevWorker, unstable_dev } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PUBLIC_URL = "https://souieba.ryouma1128.workers.dev";
const root = fileURLToPath(new URL("..", import.meta.url));

let worker: Unstable_DevWorker;

beforeAll(async () => {
  worker = await unstable_dev(`${root}test/fixtures/worker-entry.ts`, {
    config: `${root}wrangler.toml`,
    vars: { SOUIEBA_POST_GRACE_MINUTES: "0" },
    persist: false,
    logLevel: "error",
    experimental: { disableExperimentalWarning: true, testScheduled: true },
  });
}, 60_000);

afterAll(async () => {
  await worker?.stop();
});

async function call<T = any>(method: string, path: string, token?: string, body?: unknown) {
  const res = await worker.fetch(path, {
    method,
    headers: {
      [CLIENT_VERSION_HEADER]: MIN_CLIENT_VERSION,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

/** Durable Object のメッセージと配送状態の行数（期限切れの削除で行として消えたかを確かめる） */
type RowCounts = { relay_person_messages: number; relay_device_deliveries: number };

async function rows(): Promise<RowCounts> {
  return (await worker.fetch("/__test/rows")).json() as Promise<RowCounts>;
}

const DAY_MS = 86_400_000;

describe("Workers 版（workerd + Durable Object）", () => {
  it("入口で、API 以外のパスと Authorization のない要求を弾く", async () => {
    expect((await call("GET", "/")).status).toBe(404);
    expect((await call("GET", "/v2/me")).status).toBe(401);
    expect((await call("GET", "/v1/me")).status).toBe(404);
    expect((await call("GET", "/healthz")).body).toEqual({ ok: true });
    expect((await worker.fetch("/healthz", { method: "HEAD" })).status).toBe(200);
  });

  it("Content-Length の届かない本文も、Durable Object の中で読みながら数えて 413 にする", async () => {
    const res = await call("POST", "/v2/devices", undefined, { personKey: "x".repeat(32 * 1024) });
    expect(res.status).toBe(413);
  });

  it("Cron（期限切れのメッセージ・チャレンジ・セッションの削除）を Durable Object で実行できる", async () => {
    const res = await worker.fetch("/__scheduled?cron=17+3+*+*+*");
    expect(res.status).toBe(200);
  });

  it("v2: 人と端末の登録 → 端末のチャレンジ認証 → 人と人の接続 → 端末ごとの暗号化メッセージの配送", async () => {
    const at = new Date().toISOString();
    const people = [generatePerson(), generatePerson()];
    const devs: DeviceIdentity[][] = [];
    const tokens: string[][] = [];
    for (const [i, p] of people.entries()) {
      devs.push([]);
      tokens.push([]);
      // 2人目は端末を2台にする（両方に配送される）。入口の AUTH_RATE_LIMITER（10回/分）に収まるよう、2台目はログインしない
      for (let k = 0; k < (i === 1 ? 2 : 1); k++) {
        const d0 = generateDevice(p.personId, at);
        const d = { ...d0, cert: certifyDevice(p, d0) };
        expect((await call("POST", "/v2/devices", undefined, { personKey: p.person.pub, cert: d.cert })).status).toBe(201);
        if (k === 1) {
          devs[i]!.push(d);
          continue;
        }
        const ch = await call("POST", "/v2/auth/challenge", undefined, { deviceId: d.deviceId });
        // wrangler.toml の SOUIEBA_PUBLIC_URL が、署名に含める Relay の origin になる
        const s = await call("POST", "/v2/auth/session", undefined, {
          personId: p.personId,
          deviceId: d.deviceId,
          challenge: ch.body.challenge,
          sig: signChallenge(d, new URL(PUBLIC_URL).origin, ch.body.challenge),
        });
        expect(s.status).toBe(201);
        devs[i]!.push(d);
        tokens[i]!.push(s.body.token);
      }
    }
    const [a, b] = people as [PersonKeys, PersonKeys];
    const ta = tokens[0]![0]!;
    await call("POST", "/v2/connections", ta, { to: b.personId });
    expect((await call("POST", `/v2/connections/${a.personId}/accept`, tokens[1]![0]!)).body.connection.status).toBe("accepted");
    const now = Date.now();
    const env = sealRelayMessage(
      { v: 1, content: "主人は今日はじめて自分でパンを焼いたらしい", useExpiresAt: new Date(now + 86_400_000).toISOString(), reshare: "deny" },
      devs[0]![0]!,
      [{ personId: b.personId, devices: devs[1]!.map((d) => ({ deviceId: d.deviceId, encKey: d.enc.pub, encKeyVersion: 1 })) }],
      { createdAt: new Date(now).toISOString(), deliveryExpiresAt: new Date(now + 86_400_000).toISOString() },
    );
    const sent = await call("POST", "/v2/messages", ta, { envelope: env });
    expect(sent.status).toBe(201);
    const tb = tokens[1]![0]!;
    const got = await call("GET", "/v2/messages", tb);
    expect(got.body.messages).toHaveLength(1);
    // 届いた箱は2台分（どちらの端末の鍵でも開ける）
    for (const d of devs[1]!) expect(openRelayMessage(got.body.messages[0].envelope, d)).toMatchObject({ content: "主人は今日はじめて自分でパンを焼いたらしい" });
    expect((await call("POST", "/v2/messages/ack", tb, { messageIds: [env.messageId] })).body.acked).toBe(1);
    const sentView = await call("GET", "/v2/messages/sent", ta);
    expect(sentView.body.messages[0].recipients).toEqual([{ personId: b.personId, status: "delivered", deliveredAt: expect.any(String), devices: 2 }]);

    // 配送期限を過ぎると、メッセージと配送状態の行が消える（ON DELETE CASCADE）
    expect(await rows()).toEqual({ relay_person_messages: 1, relay_device_deliveries: 2 });
    const retention = await worker.fetch(`/__test/retention?now=${new Date(now + 2 * DAY_MS).toISOString()}`);
    expect(await retention.json()).toMatchObject({ relay: { messages: 1 } });
    expect(await rows()).toEqual({ relay_person_messages: 0, relay_device_deliveries: 0 });
  });

  // 送信元 IP ごとの回数を使い切るので最後に置く
  it("認証なしの POST は、% でエンコードしたパスでも入口の AUTH_RATE_LIMITER（10回/分）で数える", async () => {
    let res: Awaited<ReturnType<typeof call>> | undefined;
    for (let i = 0; i < 12; i++) {
      res = await call("POST", "/v2/auth/ch%61llenge", undefined, {});
      if (res.status === 429) break;
      expect(res.status).toBe(400);
    }
    // Durable Object の中の制限より先に、入口で止まる
    expect(res).toMatchObject({ status: 429, body: { error: { message: "リクエストが多すぎます" } } });
  });
});
