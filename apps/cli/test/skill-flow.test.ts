import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { generateEncryptionKey, generateSigningKey } from "@souieba/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../server/src/app.ts";
import { loadConfig } from "../../server/src/config.ts";
import { migrate, schema } from "../../server/src/db/index.ts";
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
    expect((await souieba("alice", "groups", "create", "研究室")).out).toContain("グループ「研究室」を作りました");
    expect((await souieba("alice", "agent", "add", "OpenClaw")).code).toBe(0);
    const inviteCode = async () => /((?:[A-Z0-9]{4}-){2}[A-Z0-9]{4})/.exec((await souieba("alice", "invite")).out)![1]!;
    const invCode = await inviteCode();

    // 同じグループに同じ表示名の人は入れない（Tell 文でなりすませないように）
    const fake = await souieba("eve", "login", baseUrl, "--code", await inviteCode(), "--handle", "eve", "--name", "アリス");
    expect(fake.code).toBe(1);
    expect(fake.out).toContain("同じ表示名");

    const joined = await souieba("bob", "login", baseUrl, "--code", invCode, "--handle", "bob", "--name", "ボブ");
    expect(joined.out).toContain("グループ「研究室」に参加しました");
    await souieba("bob", "agent", "add", "Hermes");
    const members = await souieba("bob", "groups", "members");
    expect(members.out).toContain("@alice");
    expect(members.out).toMatch(/@bob\tボブ\tmember\t自分/);

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
    expect(JSON.stringify(db.select().from(schema.posts).all())).not.toContain("M5Stack");
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
    expect(j).toEqual({ tell: null, pendingPeriods: 0, newAgents: [] });

    // ボブのアカウントに知らない Agent が足されたら（User トークンの漏洩を想定）、次の tell で一度だけ知らせる
    const bobId = accounts.getUserByHandle(db, "bob")!.id;
    const { agent: added } = accounts.createAgent(
      db,
      bobId,
      { name: "知らない PC", encKey: generateEncryptionKey().pub, signKey: generateSigningKey().pub },
      now,
    );
    const notice = await souieba("bob", "tell");
    expect(notice.out).toContain(`新しい Agent「知らない PC」（${added.id}`);
    expect(notice.out).toContain(`souieba agent revoke ${added.id}`);
    expect((await souieba("bob", "tell")).out).not.toContain("新しい Agent");
    expect((await souieba("bob", "doctor")).out).toContain(`この PC にない Agent「知らない PC」`);
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
