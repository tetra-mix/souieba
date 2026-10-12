import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../server/src/app.ts";
import { loadConfig } from "../../server/src/config.ts";
import { migrate } from "../../server/src/db/index.ts";
import { openDb } from "../../server/src/db/node.ts";
import * as accounts from "../../server/src/services/accounts.ts";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../../..");
const TSX = join(ROOT, "node_modules/.bin/tsx");
const CLI = join(ROOT, "apps/cli/src/main.ts");

let now = new Date("2026-10-05T13:10:00Z");
let server: ReturnType<typeof serve>;
let baseUrl: string;
const { db } = openDb(":memory:");
const tmp = mkdtempSync(join(tmpdir(), "souieba-mcp-"));
const clients: Client[] = [];

function env(home: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    HOME: join(tmp, home),
    SOUIEBA_HOME: join(tmp, home),
    SOUIEBA_NOW: now.toISOString(),
    SOUIEBA_AGENT: "",
  };
}

async function souieba(home: string, ...args: string[]) {
  return (await run(TSX, [CLI, ...args], { env: env(home) })).stdout.trim();
}

/** MCP クライアント（Claude Desktop など）と同じく、souieba mcp を子プロセスとして起動してつなぐ。SOUIEBA_NOW は起動時の now */
async function connect(home: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: TSX, args: [CLI, "mcp"], env: env(home), stderr: "ignore" }));
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  return { text, isError: r.isError === true };
}

beforeAll(async () => {
  migrate(db);
  const config = {
    ...loadConfig({ SOUIEBA_PUBLIC_URL: "https://souieba.test", SOUIEBA_DATA_DIR: tmp }),
    logLevel: "error" as const,
    postGraceMs: 0,
  };
  const app = createApp({ db, config, now: () => now, random: () => 0, log: () => {}, remoteAddr: () => "127.0.0.1" });
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  server.close();
});

describe("souieba mcp（ローカルの MCP サーバ）", () => {
  it("note・tell・compose・publish をツールとして使える", { timeout: 60_000 }, async () => {
    const u = accounts.createUser(db, { handle: "alice", displayName: "アリス" }, now);
    await souieba("alice", "login", baseUrl, "--code", accounts.issueLoginCode(db, u.id, now).code);
    await souieba("alice", "groups", "create", "研究室");
    await souieba("alice", "agent", "add", "Claude Desktop");
    const inv = /((?:[A-Z0-9]{4}-){2}[A-Z0-9]{4})/.exec(await souieba("alice", "invite"))![1]!;
    await souieba("bob", "login", baseUrl, "--code", inv, "--handle", "bob", "--name", "ボブ");
    await souieba("bob", "agent", "add", "Hermes");
    await souieba("bob", "publish", "--period", "2026-10-05T12:00:00.000Z", "主人は畑でトマトを収穫していた。");

    const alice = await connect("alice");
    // 主人の操作（ログイン・招待・Agent の登録など）は出さない
    const { tools } = await alice.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["souieba_compose", "souieba_note", "souieba_publish", "souieba_skip", "souieba_tell"]);
    expect(alice.getInstructions()).toContain("souieba_tell");

    // tell を呼ばれなくても、メモのついでに友人の近況を渡す
    const noted = await call(alice, "souieba_note", { text: "主人はM5Stackでロボットを作っていた" });
    expect(noted.isError).toBe(false);
    expect(noted.text).toContain("メモしました");
    expect(noted.text).toContain("あ、そういえばボブさん、畑でトマトを収穫していたみたいですよ。");
    // 同じ会話では二重に伝えない
    expect((await call(alice, "souieba_tell")).text).toContain("今回伝える近況はありません");
    expect((await call(alice, "souieba_note", { text: "主人はモーターの配線を直していた" })).text).not.toContain("<souieba_tell");

    // 秘密情報は書き直しを求める
    const secret = await call(alice, "souieba_note", { text: "主人は AKIAIOSFODNN7EXAMPLE を設定した" });
    expect(secret.isError).toBe(true);
    expect(secret.text).toContain("aws_access_key");

    // 14時台: 投稿待ちを知らせ、ツールの呼び方で案内する
    now = new Date("2026-10-05T14:05:00Z");
    const later = await connect("alice");
    expect((await call(later, "souieba_tell")).text).toContain("souieba_compose ツールを呼んで");
    const composed = await call(later, "souieba_compose");
    expect(composed.text).toContain("主人はM5Stackでロボットを作っていた");
    expect(composed.text).toContain('souieba_publish ツール（period: "2026-10-05T13:00:00.000Z"');
    expect(composed.text).not.toContain("souieba publish --period");
    const pub = await call(later, "souieba_publish", { period: "2026-10-05T13:00:00.000Z", content: "主人はM5Stackを使ったロボットを作っていた。" });
    expect(pub.text).toContain("投稿しました");
    expect((await call(later, "souieba_compose")).text).toContain("投稿待ちの時間帯はありません");
    expect(await souieba("bob", "tell")).toContain("あ、そういえばアリスさん、M5Stackを使ったロボットを作っていたみたいですよ。");
  });

  it("未ログインでも起動し、ツールの結果で原因を伝える", { timeout: 30_000 }, async () => {
    const r = await call(await connect("nobody"), "souieba_tell");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("souieba login");
  });
});
