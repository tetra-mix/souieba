import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../server/src/app.ts";
import { loadConfig } from "../../server/src/config.ts";
import { migrate, openDb } from "../../server/src/db.ts";
import * as accounts from "../../server/src/services/accounts.ts";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../../..");
const TSX = join(ROOT, "node_modules/.bin/tsx");
const CLI = join(ROOT, "apps/cli/src/main.ts");

let now = new Date("2026-10-05T13:10:00Z");
let server: ReturnType<typeof serve>;
let baseUrl: string;
const db = openDb(":memory:");
const tmp = mkdtempSync(join(tmpdir(), "souieba-skill-"));

/** Skill から呼ばれるのと同じ形で CLI を実行する */
async function souieba(home: string, ...args: string[]) {
  try {
    const r = await run(TSX, [CLI, ...args], {
      env: { ...process.env, SOUIEBA_HOME: join(tmp, home), SOUIEBA_NOW: now.toISOString(), SOUIEBA_AGENT: "" },
    });
    return { code: 0, out: r.stdout.trim() };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, out: `${e.stdout}${e.stderr}`.trim() };
  }
}

beforeAll(async () => {
  migrate(db);
  const config = { ...loadConfig({ SOUIEBA_PUBLIC_URL: "https://souieba.test", SOUIEBA_DATA_DIR: tmp }), logLevel: "error" as const, postGraceMs: 0 };
  const app = createApp({ db, config, now: () => now, random: () => 0, log: () => {} });
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

describe("Skill の流れ（CLI をサブプロセスで実行）", () => {
  it("note → compose → publish → 友人の tell", { timeout: 60_000 }, async () => {
    // セットアップ（setup.md の手順）
    const u = accounts.createUser(db, { handle: "alice", displayName: "アリス" }, now);
    const { code } = accounts.issueLoginCode(db, u.id, now);
    const login = await souieba("alice", "login", baseUrl, "--code", code);
    expect(login.out).toContain("@alice");
    expect(login.out).toMatch(/Identity 鍵の指紋: [0-9A-F]{4}-/);
    expect((await souieba("alice", "groups", "create", "研究室")).out).toContain("グループ「研究室」を作りました");
    expect((await souieba("alice", "agent", "add", "OpenClaw")).code).toBe(0);
    const inv = await souieba("alice", "invite");
    const invCode = /((?:[A-Z0-9]{4}-){4}[A-Z0-9]{4})/.exec(inv.out)![1]!;
    const fp = /--verify ([0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4})/.exec(inv.out)![1]!;

    // 指紋が違えば参加を中止する（サーバによる鍵のすり替えを想定）
    const inv2 = /((?:[A-Z0-9]{4}-){4}[A-Z0-9]{4})/.exec((await souieba("alice", "invite")).out)![1]!;
    const wrong = await souieba("eve", "login", baseUrl, "--code", inv2, "--verify", "0000-0000-0000", "--handle", "eve", "--name", "イヴ");
    expect(wrong.code).toBe(1);
    expect(wrong.out).toContain("指紋が一致しません");

    const joined = await souieba("bob", "login", baseUrl, "--code", invCode, "--verify", fp, "--handle", "bob", "--name", "ボブ");
    expect(joined.out).toContain("グループ「研究室」に参加しました");
    await souieba("bob", "agent", "add", "Hermes");
    const members = await souieba("bob", "groups", "members");
    expect(members.out).toContain("@alice");
    expect(members.out).toContain("検証済み");

    // 会話中のメモ（13時台）。秘密情報は拒否される
    expect((await souieba("alice", "note", "主人はM5Stackでロボットを作っていた")).out).toContain("メモしました");
    const secret = await souieba("alice", "note", "主人は AKIAIOSFODNN7EXAMPLE を設定した");
    expect(secret.code).toBe(2);
    expect(secret.out).toContain("aws_access_key");

    // 13時台が終わるまでは投稿待ちにならない
    expect((await souieba("alice", "compose")).out).toContain("投稿待ちの時間帯はありません");

    // 14時5分の cron: compose → publish
    now = new Date("2026-10-05T14:05:00Z");
    const composed = await souieba("alice", "compose");
    expect(composed.out).toContain("主人はM5Stackでロボットを作っていた");
    expect(composed.out).toContain("--period 2026-10-05T13:00:00.000Z");
    const pub = await souieba("alice", "publish", "--period", "2026-10-05T13:00:00.000Z", "主人はM5Stackを使ったロボットを作っていた。");
    expect(pub.out).toContain("投稿しました");
    // サーバの DB には本文が残らない
    expect(JSON.stringify(db.prepare("SELECT * FROM posts").all())).not.toContain("M5Stack");
    expect((await souieba("alice", "posts", "mine")).out).toContain("主人はM5Stackを使ったロボットを作っていた。");
    // 秘密情報は送る前に拒否する
    const leak = await souieba("alice", "publish", "--period", "2026-10-05T13:00:00.000Z", "主人は AKIAIOSFODNN7EXAMPLE を設定した");
    expect(leak.code).toBe(2);
    expect((await souieba("alice", "compose")).out).toContain("投稿待ちの時間帯はありません");

    // ボブのエージェントが会話の始めに tell
    const t = await souieba("bob", "tell");
    expect(t.out).toContain("<souieba_tell");
    expect(t.out).toContain("あ、そういえばアリスさん、M5Stackを使ったロボットを作っていたみたいですよ。");
    // 同じ Session では2件目は出ない
    expect((await souieba("bob", "tell")).out).toContain("今回伝える近況はありません");

    // JSON 出力
    now = new Date("2026-10-05T15:00:00Z");
    const j = JSON.parse((await souieba("bob", "tell", "--json")).out);
    expect(j).toEqual({ tell: null, pendingPeriods: 0 });
  });

  it("投稿待ちがあると tell が知らせる（cron のないエージェント向けの追いつき）", { timeout: 30_000 }, async () => {
    now = new Date("2026-10-05T15:10:00Z");
    await souieba("alice", "note", "主人はSouiebaのスキルを書いていた");
    now = new Date("2026-10-05T17:00:00Z");
    expect((await souieba("alice", "tell")).out).toContain("投稿待ちの時間帯が 1 件あります");
  });

  it("サーバに届かなくても tell は正常終了する", { timeout: 30_000 }, async () => {
    const r = await run(TSX, [CLI, "tell"], {
      env: { ...process.env, SOUIEBA_HOME: join(tmp, "bob"), SOUIEBA_SERVER: "http://127.0.0.1:9", SOUIEBA_NOW: "2026-10-06T00:00:00Z" },
    });
    expect(r.stdout).toContain("今回伝える近況はありません");
  });
});
