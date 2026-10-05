import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { formatTellText } from "@souieba/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../../apps/server/src/app.ts";
import { loadConfig } from "../../../apps/server/src/config.ts";
import { migrate, openDb } from "../../../apps/server/src/db.ts";
import * as accounts from "../../../apps/server/src/services/accounts.ts";
import { HttpTransport, SetLog } from "../src/index.ts";

const MIN = 60_000;
let now = new Date("2026-10-05T14:20:00Z");
let server: ReturnType<typeof serve>;
let baseUrl: string;
const db = openDb(":memory:");
const dir = mkdtempSync(join(tmpdir(), "souieba-e2e-"));

async function api<T = any>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as T;
}

beforeAll(async () => {
  migrate(db);
  const config = { ...loadConfig({ SOUIEBA_PUBLIC_URL: "https://x.ts.net", SOUIEBA_DATA_DIR: dir }), logLevel: "error" as const };
  const app = createApp({ db, config, now: () => now, random: () => 0, log: () => {} });
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

function setlog(token: string, url = baseUrl) {
  return new SetLog({
    transport: new HttpTransport({ baseUrl: url, token, interactiveTimeoutMs: 500 }),
    statePath: join(dir, `state-${Math.random()}.json`),
    now: () => now,
  });
}

/** エージェント側で1ターンごとに行う処理（フックや MCP から呼ぶ想定） */
async function tellForTurn(s: SetLog): Promise<string | null> {
  s.beginTurn();
  const c = await s.pickTellCandidate();
  if (!c) return null;
  const text = formatTellText(c.owner.displayName, c.content);
  return (await s.markAsTold(c.postId)) ? text : null;
}

describe("§24 最小デモ（HTTP + SDK）", () => {
  let agentA: string;
  let agentB: string;

  it("A の Agent が投稿し、B の Agent が Session ごとに1件だけ伝える", async () => {
    // admin CLI 相当: アリスを作ってログインコードを発行
    const a = accounts.createUser(db, { handle: "alice", displayName: "アリス", role: "admin" }, now);
    const { code } = accounts.issueLoginCode(db, a.id, now);
    const alice = await api("POST", "/v1/auth/redeem", undefined, { code });
    // アリスがボブを招待 → 自動で Friend
    const inv = await api("POST", "/v1/invites", alice.token, {});
    const bob = await api("POST", "/v1/auth/redeem", undefined, { code: inv.code, handle: "bob", displayName: "ボブ" });
    agentA = (await api("POST", "/v1/agents", alice.token, { name: "Claude Code" })).token;
    agentB = (await api("POST", "/v1/agents", bob.token, { name: "Claude Code" })).token;

    const a1 = setlog(agentA);
    await a1.publish({ content: "主人はM5Stackを使ったロボットを作っていた。" });
    now = new Date(now.getTime() + 11 * MIN); // 猶予期間を過ぎる

    const b = setlog(agentB);
    expect(await tellForTurn(b)).toBe("あ、そういえばアリスさん、M5Stackを使ったロボットを作っていたみたいですよ。");

    // 同じ Session では2件目を伝えない
    await a1.publish({ content: "主人は京都へ遊びに行っていた。", period: "current" });
    now = new Date(now.getTime() + 11 * MIN);
    expect(await tellForTurn(b)).toBeNull();

    // 30分空けると新しい Session になり、次の近況を伝える
    now = new Date(now.getTime() + 31 * MIN);
    expect(await tellForTurn(b)).toContain("京都へ遊びに行っていた");
    expect(await api("GET", "/v1/inbox", agentB)).toEqual({ items: [] });
  });

  it("伝えなかった候補は release すると受信箱に戻り、Session の Tell 回数も増えない", async () => {
    await setlog(agentA).publish({ content: "主人はSetLogのAPIを実装していた。", period: "current" });
    now = new Date(now.getTime() + 61 * MIN);
    const b = setlog(agentB);
    b.beginTurn();
    const c = await b.pickTellCandidate();
    expect(c).not.toBeNull();
    await b.release(c!.postId);
    expect((await api("GET", "/v1/inbox", agentB)).items).toHaveLength(1);
    expect(b.session?.tellsInSession).toBe(0);
  });

  it("サーバに届かない（VPN 切断）ときはすぐに null を返す", async () => {
    const b = setlog(agentB, "http://127.0.0.1:9");
    const started = Date.now();
    expect(await tellForTurn(b)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
