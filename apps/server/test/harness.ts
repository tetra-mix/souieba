import { CLIENT_VERSION_HEADER } from "@souieba/core";
import { MIN_CLIENT_VERSION, createApp } from "../src/app.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { MAX_BOUND_PARAMS, migrate } from "../src/db/index.ts";
import { openDb } from "../src/db/node.ts";

export const T0 = new Date("2026-10-05T14:20:00Z");

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ SOUIEBA_PUBLIC_URL: "https://souieba.test", SOUIEBA_DATA_DIR: "/tmp" }),
    logLevel: "error",
    ...overrides,
  };
}

export function harness(opts: { config?: Partial<Config>; remoteAddr?: string } = {}) {
  const { db, storage } = openDb(":memory:");
  // Durable Object（workerd）は1つの文のバインド変数を100個までしか受け付けない。node:sqlite でも同じ制限で検査する
  const exec = storage.sql.exec;
  storage.sql.exec = (query, ...bindings) => {
    if (bindings.length > MAX_BOUND_PARAMS) throw new Error(`too many SQL variables (${bindings.length})`);
    return exec(query, ...bindings);
  };
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
        [CLIENT_VERSION_HEADER]: MIN_CLIENT_VERSION,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }

  return {
    db,
    storage,
    app,
    clock,
    call,
    setIp: (v: string) => {
      ip = v;
    },
  };
}
