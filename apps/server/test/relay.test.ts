import {
  type NarrativeMessage,
  type RelayIdentity,
  directoryEntry,
  generateEncryptionKey,
  generateRelayIdentity,
  normalizeNarrative,
  openRelayMessage,
  sealRelayMessage,
  signChallenge,
  signText,
  encKeySigningText,
  verifyRecipientBox,
} from "@souieba/core";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runRetention } from "../src/retention.ts";
import { harness } from "./harness.ts";

const ORIGIN = "https://souieba.test";
const HOUR = 3_600_000;

type Member = { id: RelayIdentity; token: string };

function relayHarness(opts: Parameters<typeof harness>[0] = {}) {
  const h = harness({ ...opts, config: { postGraceMs: 0, ...opts.config } });

  async function register(id = generateRelayIdentity()) {
    const r = await h.call("POST", "/v2/agents", undefined, { entry: directoryEntry(id) });
    expect(r.status).toBe(201);
    return id;
  }

  async function login(id: RelayIdentity): Promise<string> {
    const ch = await h.call("POST", "/v2/auth/challenge", undefined, { agentId: id.agentId });
    expect(ch.status).toBe(201);
    const s = await h.call("POST", "/v2/auth/session", undefined, {
      agentId: id.agentId,
      challenge: ch.body.challenge,
      sig: signChallenge(id, ORIGIN, ch.body.challenge),
    });
    expect(s.status).toBe(201);
    return s.body.token;
  }

  async function member(): Promise<Member> {
    const id = await register();
    return { id, token: await login(id) };
  }

  async function connect(a: Member, b: Member) {
    expect((await h.call("POST", "/v2/connections", a.token, { to: b.id.agentId })).status).toBe(201);
    const r = await h.call("POST", `/v2/connections/${a.id.agentId}/accept`, b.token);
    expect(r.status).toBe(200);
    expect(r.body.connection.status).toBe("accepted");
  }

  function seal(from: Member, to: Member[], msg: Partial<NarrativeMessage> = {}, overrides: { createdAt?: Date; ttlMs?: number } = {}) {
    const created = overrides.createdAt ?? h.clock.now;
    const message: NarrativeMessage = {
      v: 1,
      content: "主人は週末に初めてソロキャンプに行ったらしい",
      useExpiresAt: new Date(created.getTime() + 48 * HOUR).toISOString(),
      reshare: "deny",
      ...msg,
    };
    return sealRelayMessage(
      message,
      from.id,
      to.map((m) => ({ agentId: m.id.agentId, encKey: m.id.enc.pub, encKeyVersion: m.id.encKeyVersion })),
      { createdAt: created.toISOString(), deliveryExpiresAt: new Date(created.getTime() + (overrides.ttlMs ?? 72 * HOUR)).toISOString() },
    );
  }

  async function send(from: Member, to: Member[], msg: Partial<NarrativeMessage> = {}) {
    return h.call("POST", "/v2/messages", from.token, { envelope: seal(from, to, msg) });
  }

  async function inbox(m: Member) {
    const r = await h.call("GET", "/v2/messages", m.token);
    expect(r.status).toBe(200);
    return r.body.messages as { envelope: ReturnType<typeof seal> }[];
  }

  return { h, register, login, member, connect, seal, send, inbox };
}

describe("v2 Relay: 登録と認証", () => {
  it("鍵を登録し、チャレンジに署名してセッションを得る", async () => {
    const { h, register, login } = relayHarness();
    const id = await register();
    // 同じ Identity の再登録はそのまま返す
    const again = await h.call("POST", "/v2/agents", undefined, { entry: directoryEntry(id) });
    expect(again.status).toBe(200);
    const token = await login(id);
    expect(token).toMatch(/^sou_r_/);
    const me = await h.call("GET", "/v2/me", token);
    expect(me.body.entry).toEqual(directoryEntry(id));
  });

  it("Encryption 鍵の署名が合わない登録は断る", async () => {
    const { h } = relayHarness();
    const id = generateRelayIdentity();
    const r = await h.call("POST", "/v2/agents", undefined, { entry: { ...directoryEntry(id), encKey: generateEncryptionKey().pub } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_bad_enc_key_sig");
  });

  it("チャレンジは1回しか使えず、別の鍵や別の Relay 向けの署名では通らない", async () => {
    const { h, register } = relayHarness();
    const id = await register();
    const other = generateRelayIdentity();
    const ch1 = await h.call("POST", "/v2/auth/challenge", undefined, { agentId: id.agentId });
    // 別の鍵で署名
    const bad = await h.call("POST", "/v2/auth/session", undefined, {
      agentId: id.agentId,
      challenge: ch1.body.challenge,
      sig: signChallenge({ agentId: id.agentId, identity: other.identity }, ORIGIN, ch1.body.challenge),
    });
    expect(bad.status).toBe(401);
    // 失敗したチャレンジは使い切っている
    const retry = await h.call("POST", "/v2/auth/session", undefined, {
      agentId: id.agentId,
      challenge: ch1.body.challenge,
      sig: signChallenge(id, ORIGIN, ch1.body.challenge),
    });
    expect(retry.status).toBe(401);
    // 別の Relay 向けの署名
    const ch2 = await h.call("POST", "/v2/auth/challenge", undefined, { agentId: id.agentId });
    const wrongOrigin = await h.call("POST", "/v2/auth/session", undefined, {
      agentId: id.agentId,
      challenge: ch2.body.challenge,
      sig: signChallenge(id, "https://evil.test", ch2.body.challenge),
    });
    expect(wrongOrigin.status).toBe(401);
  });

  it("期限切れのチャレンジとセッションは使えない", async () => {
    const { h, register, login } = relayHarness();
    const id = await register();
    const ch = await h.call("POST", "/v2/auth/challenge", undefined, { agentId: id.agentId });
    h.clock.advance(3 * 60_000);
    const late = await h.call("POST", "/v2/auth/session", undefined, {
      agentId: id.agentId,
      challenge: ch.body.challenge,
      sig: signChallenge(id, ORIGIN, ch.body.challenge),
    });
    expect(late.status).toBe(401);
    const token = await login(id);
    h.clock.advance(HOUR + 1);
    expect((await h.call("GET", "/v2/me", token)).status).toBe(401);
  });

  it("v1 のトークンでは v2 を使えない", async () => {
    const { h } = relayHarness();
    const alice = await h.user("alice", "アリス");
    expect((await h.call("GET", "/v2/connections", alice.agentToken)).status).toBe(401);
  });

  it("Encryption 鍵を新しい版に替えられる。版を戻すことや署名のない鍵はだめ", async () => {
    const { h, member } = relayHarness();
    const a = await member();
    const enc = generateEncryptionKey();
    const sig = signText(a.id.identity, encKeySigningText(a.id.agentId, enc.pub, 2));
    const r = await h.call("PUT", "/v2/me/enc-key", a.token, { encKey: enc.pub, encKeyVersion: 2, encKeySig: sig });
    expect(r.status).toBe(200);
    expect(r.body.entry.encKeyVersion).toBe(2);
    const back = await h.call("PUT", "/v2/me/enc-key", a.token, { encKey: enc.pub, encKeyVersion: 2, encKeySig: sig });
    expect(back.status).toBe(409);
    const forged = await h.call("PUT", "/v2/me/enc-key", a.token, { encKey: generateEncryptionKey().pub, encKeyVersion: 3, encKeySig: sig });
    expect(forged.status).toBe(400);
  });

  it("登録数の上限を超えると断る", async () => {
    const { h, register } = relayHarness({ config: { relay: { enabled: true, maxAgents: 1 } } });
    await register();
    const r = await h.call("POST", "/v2/agents", undefined, { entry: directoryEntry(generateRelayIdentity()) });
    expect(r.status).toBe(403);
  });

  it("Relay を閉じたサーバでは /v2 が 404 になる", async () => {
    const { h } = relayHarness({ config: { relay: { enabled: false, maxAgents: 10 } } });
    const r = await h.call("POST", "/v2/agents", undefined, { entry: directoryEntry(generateRelayIdentity()) });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("relay_disabled");
  });
});

describe("v2 Relay: 検索と接続", () => {
  it("Agent ID で検索でき、返すのは鍵情報だけ", async () => {
    const { h, member } = relayHarness();
    const a = await member();
    const b = await member();
    const r = await h.call("GET", `/v2/agents/${b.id.agentId}`, a.token);
    expect(r.body.entry).toEqual(directoryEntry(b.id));
    const many = await h.call("POST", "/v2/agents/lookup", a.token, { agentIds: [b.id.agentId, a.id.agentId, "sb_nope"] });
    expect(many.body.entries).toHaveLength(2);
  });

  it("要求して承認されると接続になる。双方から要求しても1つの接続になる", async () => {
    const { h, member } = relayHarness();
    const a = await member();
    const b = await member();
    const c = await member();
    await h.call("POST", "/v2/connections", a.token, { to: b.id.agentId });
    expect((await h.call("GET", "/v2/connections", b.token)).body.connections).toMatchObject([{ peer: a.id.agentId, status: "incoming" }]);
    expect((await h.call("GET", "/v2/connections", a.token)).body.connections).toMatchObject([{ peer: b.id.agentId, status: "outgoing" }]);
    await h.call("POST", `/v2/connections/${a.id.agentId}/accept`, b.token);
    expect((await h.call("GET", "/v2/connections", a.token)).body.connections).toMatchObject([{ peer: b.id.agentId, status: "accepted" }]);
    // c → a、a → c と両方から要求したら接続になる
    await h.call("POST", "/v2/connections", c.token, { to: a.id.agentId });
    const mutual = await h.call("POST", "/v2/connections", a.token, { to: c.id.agentId });
    expect(mutual.body.connection.status).toBe("accepted");
  });

  it("断った要求は消え、相手には知らせない", async () => {
    const { h, member } = relayHarness();
    const a = await member();
    const b = await member();
    await h.call("POST", "/v2/connections", a.token, { to: b.id.agentId });
    expect((await h.call("POST", `/v2/connections/${a.id.agentId}/reject`, b.token)).status).toBe(204);
    expect((await h.call("GET", "/v2/connections", b.token)).body.connections).toEqual([]);
    expect((await h.call("POST", `/v2/connections/${a.id.agentId}/accept`, b.token)).status).toBe(404);
  });

  it("ブロックすると接続が切れ、ブロックされた側からの要求は相手に届かない（ブロックは知られない）", async () => {
    const { h, member, connect } = relayHarness();
    const a = await member();
    const b = await member();
    await connect(a, b);
    expect((await h.call("PUT", `/v2/blocks/${a.id.agentId}`, b.token)).status).toBe(204);
    expect((await h.call("GET", "/v2/connections", a.token)).body.connections).toEqual([]);
    const again = await h.call("POST", "/v2/connections", a.token, { to: b.id.agentId });
    expect(again.status).toBe(201);
    expect(again.body.connection.status).toBe("outgoing");
    expect((await h.call("GET", "/v2/connections", b.token)).body).toEqual({ connections: [], blocked: [a.id.agentId] });
    // ブロックした側からは、解除するまで要求できない
    expect((await h.call("POST", "/v2/connections", b.token, { to: a.id.agentId })).status).toBe(409);
    await h.call("DELETE", `/v2/blocks/${a.id.agentId}`, b.token);
    expect((await h.call("GET", "/v2/connections", b.token)).body.blocked).toEqual([]);
  });

  it("ブロックされた側から見ても、ふつうの承認待ちと見分けがつかない。解除するとその要求は消える", async () => {
    const { h, member } = relayHarness();
    const a = await member();
    const b = await member();
    await h.call("PUT", `/v2/blocks/${a.id.agentId}`, b.token);
    const first = await h.call("POST", "/v2/connections", a.token, { to: b.id.agentId });
    h.clock.advance(60_000);
    const second = await h.call("POST", "/v2/connections", a.token, { to: b.id.agentId });
    expect(second.body.connection).toEqual(first.body.connection);
    expect((await h.call("GET", "/v2/connections", a.token)).body.connections).toMatchObject([{ peer: b.id.agentId, status: "outgoing" }]);
    expect((await h.call("POST", `/v2/connections/${a.id.agentId}/accept`, b.token)).status).toBe(404);
    await h.call("DELETE", `/v2/blocks/${a.id.agentId}`, b.token);
    expect((await h.call("GET", "/v2/connections", b.token)).body.connections).toEqual([]);
  });

  it("承認待ちの要求の上限と期限、ブロックの対象の確認", async () => {
    const { h, member } = relayHarness();
    const a = await member();
    // 登録されていない相手はブロックできない（表を際限なく大きくしないため）
    expect((await h.call("PUT", `/v2/blocks/${generateRelayIdentity().agentId}`, a.token)).status).toBe(404);
    const b = await member();
    await h.call("POST", "/v2/connections", a.token, { to: b.id.agentId });
    h.clock.advance(15 * 86_400_000);
    expect(runRetention(h.db, h.clock.now, 30 * 86_400_000).relay.requests).toBe(1);
  });

  it("自分自身や、登録されていない Agent には要求できない", async () => {
    const { h, member } = relayHarness();
    const a = await member();
    expect((await h.call("POST", "/v2/connections", a.token, { to: a.id.agentId })).status).toBe(400);
    expect((await h.call("POST", "/v2/connections", a.token, { to: generateRelayIdentity().agentId })).status).toBe(404);
  });
});

describe("v2 Relay: メッセージの配送", () => {
  it("接続している相手にだけ届き、受信者は自分の分の鍵だけを受け取る", async () => {
    const { h, member, connect, send, inbox } = relayHarness();
    const a = await member();
    const b = await member();
    const c = await member();
    const stranger = await member();
    await connect(a, b);
    await connect(a, c);
    const r = await send(a, [b, c, stranger]);
    expect(r.status).toBe(201);
    expect(r.body.accepted.sort()).toEqual([b.id.agentId, c.id.agentId].sort());
    expect(r.body.skipped).toEqual([{ agentId: stranger.id.agentId, reason: "not_connected" }]);

    const got = await inbox(b);
    expect(got).toHaveLength(1);
    const env = got[0]!.envelope;
    expect(env.recipients.map((x) => x.agentId)).toEqual([b.id.agentId]);
    expect(verifyRecipientBox(env, env.recipients[0]!, a.id.identity.pub)).toBe(true);
    const plain = normalizeNarrative(openRelayMessage(env, b.id), { createdAt: env.createdAt });
    expect(plain.ok && plain.message.content).toBe("主人は週末に初めてソロキャンプに行ったらしい");
    expect(await inbox(stranger)).toEqual([]);
  });

  it("受け取りを記録すると次からは返らず、全員が受け取ると暗号文が消える。送信者は配送状態を見られる", async () => {
    const { h, member, connect, send, inbox } = relayHarness();
    const a = await member();
    const b = await member();
    const c = await member();
    await connect(a, b);
    await connect(a, c);
    const { body } = await send(a, [b, c]);
    expect((await h.call("POST", "/v2/messages/ack", b.token, { messageIds: [body.messageId] })).body.acked).toBe(1);
    expect(await inbox(b)).toEqual([]);
    const sent = await h.call("GET", "/v2/messages/sent", a.token);
    expect(sent.body.messages[0].recipients).toEqual(
      expect.arrayContaining([
        { agentId: b.id.agentId, status: "delivered", deliveredAt: expect.any(String) },
        { agentId: c.id.agentId, status: "pending", deliveredAt: null },
      ]),
    );
    await h.call("POST", "/v2/messages/ack", c.token, { messageIds: [body.messageId] });
    expect(h.db.get<{ body: string | null }>(sql`SELECT body FROM relay_messages WHERE id = ${body.messageId}`)?.body).toBeNull();
  });

  it("猶予期間中は届かず、そのあいだに送信者が取り消せる", async () => {
    const { h, member, connect, send, inbox } = relayHarness({ config: { postGraceMs: 10 * 60_000 } });
    const a = await member();
    const b = await member();
    await connect(a, b);
    const first = await send(a, [b]);
    await send(a, [b], { content: "主人は新しいカメラを買ってうれしそうだった" });
    expect(await inbox(b)).toEqual([]);
    expect((await h.call("DELETE", `/v2/messages/${first.body.messageId}`, a.token)).status).toBe(204);
    expect((await h.call("DELETE", `/v2/messages/${first.body.messageId}`, b.token)).status).toBe(404);
    h.clock.advance(10 * 60_000);
    const got = await inbox(b);
    expect(got).toHaveLength(1);
  });

  it("配送期限を過ぎたものは届かず、保持期間の処理で消える", async () => {
    const { h, member, connect, seal, inbox, login } = relayHarness();
    const a = await member();
    const b = await member();
    await connect(a, b);
    const env = seal(a, [b], {}, { ttlMs: HOUR });
    expect((await h.call("POST", "/v2/messages", a.token, { envelope: env })).status).toBe(201);
    h.clock.advance(HOUR + 1);
    b.token = await login(b.id);
    expect(await inbox(b)).toEqual([]);
    expect(runRetention(h.db, h.clock.now, 30 * 86_400_000).relay.messages).toBe(1);
  });

  it("接続を解除すると、まだ届いていないメッセージも届かなくなる", async () => {
    const { h, member, connect, send, inbox } = relayHarness();
    const a = await member();
    const b = await member();
    await connect(a, b);
    await send(a, [b]);
    await h.call("DELETE", `/v2/connections/${a.id.agentId}`, b.token);
    await connect(a, b);
    expect(await inbox(b)).toEqual([]);
  });

  it("署名の改ざん・送信者のなりすまし・期限や時刻の不正・重複を断る", async () => {
    const { h, member, connect, seal } = relayHarness();
    const a = await member();
    const b = await member();
    await connect(a, b);
    const env = seal(a, [b]);
    const post = (envelope: unknown, token = a.token) => h.call("POST", "/v2/messages", token, { envelope });
    expect((await post({ ...env, deliveryExpiresAt: new Date(h.clock.now.getTime() + 5 * 86_400_000).toISOString() })).body.error.code).toBe(
      "invalid_signature",
    );
    // b のセッションで a の名前のメッセージを送る
    expect((await post(env, b.token)).status).toBe(403);
    // 7日を超える配送期限
    expect((await post(seal(a, [b], {}, { ttlMs: 8 * 86_400_000 }))).body.error.code).toBe("bad_delivery_expiry");
    // 時計のずれ
    expect((await post(seal(a, [b], {}, { createdAt: new Date(h.clock.now.getTime() - HOUR) }))).body.error.code).toBe("bad_created_at");
    expect((await post(env)).status).toBe(201);
    expect((await post(env)).status).toBe(409);
  });

  it("古い Encryption 鍵で包んだ宛先は受け付けない", async () => {
    const { h, member, connect, seal } = relayHarness();
    const a = await member();
    const b = await member();
    await connect(a, b);
    const enc = generateEncryptionKey();
    await h.call("PUT", "/v2/me/enc-key", b.token, {
      encKey: enc.pub,
      encKeyVersion: 2,
      encKeySig: signText(b.id.identity, encKeySigningText(b.id.agentId, enc.pub, 2)),
    });
    const r = await h.call("POST", "/v2/messages", a.token, { envelope: seal(a, [b]) });
    expect(r.status).toBe(200);
    expect(r.body.skipped).toEqual([{ agentId: b.id.agentId, reason: "stale_key" }]);
  });
});
