import { type KeyPair, generateEncryptionKey, generateSigningKey, periodOf, sealPost } from "@souieba/core";
import { createApp } from "../src/app.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { MAX_BOUND_PARAMS, migrate } from "../src/db/index.ts";
import { openDb } from "../src/db/node.ts";
import * as accounts from "../src/services/accounts.ts";

export const T0 = new Date("2026-10-05T14:20:00Z");

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ SOUIEBA_PUBLIC_URL: "https://souieba.test", SOUIEBA_DATA_DIR: "/tmp" }),
    logLevel: "error",
    ...overrides,
  };
}

export type TestAgent = { id: string; token: string; keys: { enc: KeyPair; sign: KeyPair } };

export type TestUser = {
  id: string;
  handle: string;
  token: string;
  /** 最初に登録した Agent */
  agentId: string;
  agentToken: string;
  agent: TestAgent;
};

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
  /** これまでに登録したすべての Agent（投稿の宛先の既定値。サーバが届けてよいものだけに絞る） */
  const allAgents: { id: string; userId: string; encKey: string }[] = [];

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

  async function addAgent(u: { id: string; token: string }, name: string): Promise<TestAgent> {
    const enc = generateEncryptionKey();
    const sign = generateSigningKey();
    const r = await call("POST", "/v1/agents", u.token, { name, encKey: enc.pub, signKey: sign.pub });
    if (r.status !== 201) throw new Error(`agent add failed: ${JSON.stringify(r.body)}`);
    allAgents.push({ id: r.body.agent.id, userId: u.id, encKey: enc.pub });
    return { id: r.body.agent.id, token: r.body.token, keys: { enc, sign } };
  }

  async function withAgent(base: Omit<TestUser, "agentId" | "agentToken" | "agent">, displayName: string): Promise<TestUser> {
    const agent = await addAgent(base, `${displayName}のAgent`);
    return { ...base, agentId: agent.id, agentToken: agent.token, agent };
  }

  /** admin CLI と同じ経路でユーザーを作り、ログインコードで User トークンを得る */
  async function user(handle: string, displayName: string, role: "admin" | "member" = "member"): Promise<TestUser> {
    const u = accounts.createUser(db, { handle, displayName, role }, now);
    const { code } = accounts.issueLoginCode(db, u.id, now);
    const r = await call("POST", "/v1/auth/redeem", undefined, { code });
    return withAgent({ id: u.id, handle, token: r.body.token }, displayName);
  }

  async function createGroup(owner: TestUser, name = "研究室"): Promise<string> {
    const r = await call("POST", "/v1/groups", owner.token, { name });
    if (r.status !== 201) throw new Error(`group create failed: ${JSON.stringify(r.body)}`);
    return r.body.id;
  }

  async function invite(inviter: TestUser, groupId: string) {
    const r = await call("POST", `/v1/groups/${groupId}/invites`, inviter.token);
    return { code: r.body?.code as string, status: r.status, body: r.body };
  }

  /** 招待コードで新しいユーザーとして参加する */
  async function joinNew(inviter: TestUser, groupId: string, handle: string, displayName: string): Promise<TestUser> {
    const { code } = await invite(inviter, groupId);
    const r = await call("POST", "/v1/auth/redeem", undefined, { code, handle, displayName });
    if (r.status !== 201) throw new Error(`redeem failed: ${JSON.stringify(r.body)}`);
    return withAgent({ id: r.body.user.id, handle, token: r.body.token }, displayName);
  }

  /** 既存のユーザーが招待コードで参加する */
  async function join(inviter: TestUser, groupId: string, u: TestUser) {
    const { code } = await invite(inviter, groupId);
    return call("POST", "/v1/groups/join", u.token, { code });
  }

  /** Agent と同じく封筒を作って投稿する。宛先の既定値は登録済みの全 Agent */
  function publish(
    author: TestUser,
    content: string,
    extra: { visibility?: "groups" | "private"; periodStart?: string; periodEnd?: string; recipients?: string[]; agent?: TestAgent } = {},
  ) {
    const agent = extra.agent ?? author.agent;
    const period = extra.periodStart ? { periodStart: extra.periodStart, periodEnd: extra.periodEnd! } : periodOf(now, "previous");
    const recipients = allAgents.filter((a) => !extra.recipients || extra.recipients.includes(a.id)).map((a) => ({ agentId: a.id, encKey: a.encKey }));
    const envelope = sealPost(
      { ...period, visibility: extra.visibility ?? "groups", content },
      { userId: author.id, agentId: agent.id, signKey: agent.keys.sign },
      recipients,
    );
    return call("POST", "/v1/posts", agent.token, { envelope });
  }

  return {
    db,
    app,
    clock,
    call,
    user,
    addAgent,
    createGroup,
    invite,
    joinNew,
    join,
    publish,
    setIp: (v: string) => {
      ip = v;
    },
  };
}

/** アリス（グループの作成者）とボブ（招待で参加）の2人 */
export async function twoMembers(opts: Parameters<typeof harness>[0] = {}) {
  const h = harness(opts);
  const alice = await h.user("alice", "アリス", "admin");
  const groupId = await h.createGroup(alice);
  const bob = await h.joinNew(alice, groupId, "bob", "ボブ");
  return { h, alice, bob, groupId };
}
