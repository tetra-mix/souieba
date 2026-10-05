import { periodOf } from "@souieba/core";
import { createApp } from "../src/app.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { type DB, migrate, openDb } from "../src/db.ts";
import * as accounts from "../src/services/accounts.ts";

export const T0 = new Date("2026-10-05T14:20:00Z");

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ SOUIEBA_PUBLIC_URL: "https://souieba.test.ts.net", SOUIEBA_DATA_DIR: "/tmp" }),
    logLevel: "error",
    ...overrides,
  };
}

export function harness(opts: { config?: Partial<Config>; remoteAddr?: string } = {}) {
  const db: DB = openDb(":memory:");
  migrate(db);
  let now = new Date(T0);
  const clock = {
    get now() {
      return now;
    },
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
  let ip = opts.remoteAddr ?? "127.0.0.1";
  const app = createApp({
    db,
    config: testConfig(opts.config),
    now: () => now,
    random: () => 0,
    remoteAddr: () => ip,
    log: () => {},
  });

  async function call<T = any>(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }

  /** admin CLI と同じ経路でユーザーを作り、ログインコードで User トークンを得る */
  async function user(handle: string, displayName: string, role: "admin" | "member" = "member") {
    const u = accounts.createUser(db, { handle, displayName, role }, now);
    const { code } = accounts.issueLoginCode(db, u.id, now);
    const r = await call("POST", "/v1/auth/redeem", undefined, { code });
    const agent = await call("POST", "/v1/agents", r.body.token, { name: `${displayName}のAgent` });
    return { id: u.id, token: r.body.token as string, agentId: agent.body.agent.id as string, agentToken: agent.body.token as string };
  }

  async function befriend(a: { token: string }, bHandle: string, b: { token: string }) {
    const req = await call("POST", "/v1/friends", a.token, { handle: bHandle });
    await call("POST", `/v1/friends/${req.body.id}/accept`, b.token);
    return req.body.id as string;
  }

  function publish(agentToken: string, content: string, extra: Record<string, unknown> = {}) {
    return call("POST", "/v1/posts", agentToken, { ...periodOf(now, "previous"), content, ...extra });
  }

  return {
    db,
    app,
    clock,
    call,
    user,
    befriend,
    publish,
    setIp: (v: string) => {
      ip = v;
    },
  };
}
