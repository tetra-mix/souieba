/**
 * Workers 版を workerd（wrangler の unstable_dev）で動かし、HTTP 越しに一通りの流れを確かめる。
 * Durable Object の SQLite・Drizzle の durable-sqlite ドライバ・入口の検査・admin API を、本物の実行環境で通す。
 */
import { fileURLToPath } from "node:url";
import {
  GROUP_INVITE_CODE_LENGTH,
  type KeyPair,
  codeHash,
  generateEncryptionKey,
  generateSigningKey,
  inviteCommit,
  newCode,
  openPost,
  periodOf,
  sealPost,
  signText,
  signedText,
} from "@souieba/core";
import { type Unstable_DevWorker, unstable_dev } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BOOTSTRAP = "worker-test-bootstrap-0123456789";
const root = fileURLToPath(new URL("..", import.meta.url));

let worker: Unstable_DevWorker;

beforeAll(async () => {
  worker = await unstable_dev(`${root}src/worker.ts`, {
    config: `${root}wrangler.toml`,
    vars: { SOUIEBA_BOOTSTRAP_TOKEN: BOOTSTRAP, SOUIEBA_POST_GRACE_MINUTES: "0" },
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
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

type Member = { id: string; token: string; identity: KeyPair; agent: { id: string; token: string; enc: KeyPair; sign: KeyPair } };

async function addAgent(u: Omit<Member, "agent">): Promise<Member> {
  const enc = generateEncryptionKey();
  const sign = generateSigningKey();
  const r = await call("POST", "/v1/agents", u.token, {
    name: "Agent",
    encKey: enc.pub,
    signKey: sign.pub,
    cert: signText(u.identity, signedText.agentCert(u.id, enc.pub, sign.pub)),
  });
  expect(r.status).toBe(201);
  return { ...u, agent: { id: r.body.agent.id, token: r.body.token, enc, sign } };
}

describe("Workers 版（workerd + Durable Object）", () => {
  it("入口で、API 以外のパスと Authorization のない要求を弾く", async () => {
    expect((await call("GET", "/")).status).toBe(404);
    expect((await call("GET", "/v1/me")).status).toBe(401);
    expect((await call("GET", "/healthz")).body).toEqual({ ok: true });
    expect((await worker.fetch("/healthz", { method: "HEAD" })).status).toBe(200);
  });

  it("Content-Length の届かない本文も、Durable Object の中で読みながら数えて 413 にする", async () => {
    const res = await call("POST", "/v1/agents", "sou_u_dummy", { name: "x".repeat(32 * 1024) });
    expect(res.status).toBe(413);
  });

  it("Cron（保存期間を過ぎた投稿の削除）を Durable Object で実行できる", async () => {
    const res = await worker.fetch("/__scheduled?cron=17+3+*+*+*");
    expect(res.status).toBe(200);
  });

  it("ブートストラップ → 招待 → E2EE の投稿 → Tell → アカウント削除", async () => {
    // 最初の admin を作り、admin API で利用者を作る
    const boot = await call("POST", "/v1/admin/bootstrap", undefined, { token: BOOTSTRAP, handle: "root", displayName: "管理者" });
    expect(boot.status).toBe(201);
    const adminToken: string = boot.body.adminToken;
    const created = await call("POST", "/v1/admin/users", adminToken, { handle: "alice", displayName: "アリス" });
    expect(created.status).toBe(201);

    // アリスはログインコードでログインし、Identity 鍵を登録してグループを作る
    const aliceIdentity = generateSigningKey();
    const login = await call("POST", "/v1/auth/redeem", undefined, { code: created.body.loginCode, identityKey: aliceIdentity.pub });
    expect(login.status).toBe(201);
    const alice = await addAgent({ id: login.body.user.id, token: login.body.token, identity: aliceIdentity });
    const groupId = `grp_${"w".repeat(16)}`;
    const group = await call("POST", "/v1/groups", alice.token, {
      id: groupId,
      name: "研究室",
      createSig: signText(alice.identity, signedText.groupCreate(groupId, alice.id)),
    });
    expect(group.status).toBe(201);

    // ボブを招待する（コードはアリスの手元で作って署名する）
    const code = newCode(GROUP_INVITE_CODE_LENGTH);
    const commit = inviteCommit(groupId, code);
    const inv = await call("POST", `/v1/groups/${groupId}/invites`, alice.token, {
      codeHash: codeHash(code),
      commit,
      inviteSig: signText(alice.identity, signedText.invite(groupId, alice.id, commit)),
    });
    expect(inv.status).toBe(201);
    const bobIdentity = generateSigningKey();
    const joined = await call("POST", "/v1/auth/redeem", undefined, {
      code,
      handle: "bob",
      displayName: "ボブ",
      identityKey: bobIdentity.pub,
      joinSig: signText(bobIdentity, signedText.join(code)),
    });
    expect(joined.status).toBe(201);
    const bob = await addAgent({ id: joined.body.user.id, token: joined.body.token, identity: bobIdentity });

    // アリスの Agent が、ボブの Agent 宛てに暗号化して投稿する
    const envelope = sealPost(
      { ...periodOf(new Date(), "previous"), visibility: "groups", content: "主人はWorkersでSouiebaを動かしていた。" },
      { userId: alice.id, agentId: alice.agent.id, signKey: alice.agent.sign },
      [{ agentId: bob.agent.id, encKey: bob.agent.enc.pub }],
    );
    expect((await call("POST", "/v1/posts", alice.agent.token, { envelope })).status).toBe(201);

    // ボブの Agent が受け取り、予約して、手元で復号する
    expect((await call("POST", "/v1/sync", bob.agent.token)).body.received).toBe(1);
    const claim = await call("POST", "/v1/tell/claim", bob.agent.token, {});
    const candidate = claim.body.candidate;
    expect(candidate.owner.handle).toBe("alice");
    const text = openPost(
      candidate.envelope,
      { userId: alice.id, agentId: alice.agent.id },
      { agentId: bob.agent.id, encKey: bob.agent.enc },
    );
    expect(text).toBe("主人はWorkersでSouiebaを動かしていた。");
    expect((await call("POST", `/v1/deliveries/${candidate.postId}/told`, bob.agent.token)).status).toBe(204);

    // admin からはグループの名前と人数だけが見える
    expect((await call("GET", "/v1/admin/groups", adminToken)).body.groups).toMatchObject([{ id: groupId, memberCount: 2 }]);

    // アリスがアカウントを消すと、投稿も消え（ON DELETE CASCADE）、ボブだけのグループが残る
    expect((await call("DELETE", "/v1/me", alice.token)).status).toBe(204);
    expect((await call("GET", "/v1/inbox", bob.agent.token)).body.items).toEqual([]);
    expect((await call("GET", "/v1/admin/groups", adminToken)).body.groups).toMatchObject([{ id: groupId, memberCount: 1 }]);
  }, 60_000);
});
