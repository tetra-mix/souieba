import {
  type DeviceIdentity,
  type NarrativeMessage,
  type PersonKeys,
  certifyDevice,
  generateDevice,
  generateEncryptionKey,
  generatePerson,
  normalizeNarrative,
  openRelayMessage,
  revokeDevice,
  sealRelayMessage,
  signChallenge,
  verifyRecipientGroup,
} from "@souieba/core";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runRetention } from "../src/retention.ts";
import { harness } from "./harness.ts";

const ORIGIN = "https://souieba.test";
const HOUR = 3_600_000;

type Member = { person: PersonKeys; devices: DeviceIdentity[]; id: DeviceIdentity; personId: string; token: string; tokens: string[] };

function newDevice(p: PersonKeys, at = "2026-10-30T00:00:00.000Z"): DeviceIdentity {
  const d = generateDevice(p.personId, at);
  return { ...d, cert: certifyDevice(p, d) };
}

function relayHarness(opts: Parameters<typeof harness>[0] = {}) {
  const h = harness({ ...opts, config: { postGraceMs: 0, ...opts.config } });

  async function register(person = generatePerson(), d = newDevice(person), status = 201) {
    const r = await h.call("POST", "/v2/devices", undefined, { personKey: person.person.pub, cert: d.cert });
    expect(r.status).toBe(status);
    return { person, d };
  }

  async function login(d: DeviceIdentity): Promise<string> {
    const ch = await h.call("POST", "/v2/auth/challenge", undefined, { deviceId: d.deviceId });
    expect(ch.status).toBe(201);
    const s = await h.call("POST", "/v2/auth/session", undefined, {
      personId: d.personId,
      deviceId: d.deviceId,
      challenge: ch.body.challenge,
      sig: signChallenge(d, ORIGIN, ch.body.challenge),
    });
    expect(s.status).toBe(201);
    return s.body.token;
  }

  async function member(nDevices = 1): Promise<Member> {
    const person = generatePerson();
    const devices: DeviceIdentity[] = [];
    const tokens: string[] = [];
    for (let i = 0; i < nDevices; i++) {
      const { d } = await register(person, newDevice(person));
      devices.push(d);
      tokens.push(await login(d));
    }
    return { person, devices, id: devices[0]!, personId: person.personId, token: tokens[0]!, tokens };
  }

  async function connect(a: Member, b: Member) {
    expect((await h.call("POST", "/v2/connections", a.token, { to: b.personId })).status).toBe(201);
    const r = await h.call("POST", `/v2/connections/${a.personId}/accept`, b.token);
    expect(r.status).toBe(200);
    expect(r.body.connection.status).toBe("accepted");
  }

  function seal(
    from: Member,
    to: Member[],
    msg: Partial<NarrativeMessage> = {},
    overrides: { createdAt?: Date; ttlMs?: number; sender?: DeviceIdentity; devices?: (m: Member) => DeviceIdentity[] } = {},
  ) {
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
      overrides.sender ?? from.id,
      to.map((m) => ({
        personId: m.personId,
        devices: (overrides.devices?.(m) ?? m.devices).map((d) => ({ deviceId: d.deviceId, encKey: d.enc.pub, encKeyVersion: d.encKeyVersion })),
      })),
      { createdAt: created.toISOString(), deliveryExpiresAt: new Date(created.getTime() + (overrides.ttlMs ?? 72 * HOUR)).toISOString() },
    );
  }

  async function send(from: Member, to: Member[], msg: Partial<NarrativeMessage> = {}) {
    return h.call("POST", "/v2/messages", from.token, { envelope: seal(from, to, msg) });
  }

  async function inbox(m: Member, token = m.token) {
    const r = await h.call("GET", "/v2/messages", token);
    expect(r.status).toBe(200);
    return r.body.messages as { envelope: ReturnType<typeof seal> }[];
  }

  return { h, register, login, member, connect, seal, send, inbox };
}

describe("v2 Relay: 登録と認証（人と端末）", () => {
  it("人と端末を登録し、端末の鍵でチャレンジに署名してセッションを得る", async () => {
    const { h, register, login } = relayHarness();
    const { person, d } = await register();
    // 同じ端末の再登録はそのまま返す
    const again = await h.call("POST", "/v2/devices", undefined, { personKey: person.person.pub, cert: d.cert });
    expect(again.status).toBe(200);
    const token = await login(d);
    expect(token).toMatch(/^sou_r_/);
    const me = await h.call("GET", "/v2/me", token);
    expect(me.body.directory).toEqual({ personId: person.personId, personKey: person.person.pub, devices: [d.cert], revocations: [] });
    expect(me.body.deviceId).toBe(d.deviceId);
  });

  it("2台目の端末を足せる。Person 鍵で署名されていない端末証明書は断る", async () => {
    const { h, register } = relayHarness();
    const { person } = await register();
    const d2 = newDevice(person);
    const r = await h.call("POST", "/v2/devices", undefined, { personKey: person.person.pub, cert: d2.cert });
    expect(r.status).toBe(201);
    expect(r.body.directory.devices).toHaveLength(2);
    // 別の人の鍵で署名した端末を、この人の端末として足そうとする
    const mallory = generatePerson();
    const fake = generateDevice(person.personId, "2026-10-30T00:00:00.000Z");
    const forged = { ...certifyDevice(mallory, fake), personId: person.personId };
    expect((await h.call("POST", "/v2/devices", undefined, { personKey: person.person.pub, cert: forged })).body.error.code).toBe("invalid_device_cert");
    // 鍵を差し替えた証明書
    const tampered = { ...d2.cert, encKey: generateEncryptionKey().pub, deviceId: d2.deviceId };
    expect((await h.call("POST", "/v2/devices", undefined, { personKey: person.person.pub, cert: tampered })).status).toBe(400);
  });

  it("取り消した端末はログインもできず、セッションも使えない。偽の取り消しは断る", async () => {
    const { h, member, login } = relayHarness();
    const a = await member(2);
    const [, d2] = a.devices;
    const forged = revokeDevice(generatePerson(), d2!.deviceId, h.clock.now.toISOString());
    expect((await h.call("POST", "/v2/devices/revoke", undefined, { revocation: { ...forged, personId: a.personId } })).status).toBe(400);
    const rev = revokeDevice(a.person, d2!.deviceId, h.clock.now.toISOString());
    const r = await h.call("POST", "/v2/devices/revoke", undefined, { revocation: rev });
    expect(r.status).toBe(200);
    expect(r.body.directory.devices.map((c: { deviceId: string }) => c.deviceId)).toEqual([a.devices[0]!.deviceId]);
    expect(r.body.directory.revocations).toEqual([rev]);
    expect((await h.call("GET", "/v2/connections", a.tokens[1])).status).toBe(401);
    expect((await h.call("POST", "/v2/auth/challenge", undefined, { deviceId: d2!.deviceId })).status).toBe(404);
    // 取り消した端末を登録し直すことはできない
    expect((await h.call("POST", "/v2/devices", undefined, { personKey: a.person.person.pub, cert: d2!.cert })).status).toBe(409);
    expect((await h.call("GET", "/v2/connections", a.tokens[0])).status).toBe(200);
    void login;
  });

  it("チャレンジは1回しか使えず、別の鍵や別の Relay 向けの署名では通らない", async () => {
    const { h, register } = relayHarness();
    const { person, d } = await register();
    const other = newDevice(person);
    const ch1 = await h.call("POST", "/v2/auth/challenge", undefined, { deviceId: d.deviceId });
    const bad = await h.call("POST", "/v2/auth/session", undefined, {
      personId: d.personId,
      deviceId: d.deviceId,
      challenge: ch1.body.challenge,
      sig: signChallenge({ ...d, sign: other.sign }, ORIGIN, ch1.body.challenge),
    });
    expect(bad.status).toBe(401);
    const retry = await h.call("POST", "/v2/auth/session", undefined, {
      personId: d.personId,
      deviceId: d.deviceId,
      challenge: ch1.body.challenge,
      sig: signChallenge(d, ORIGIN, ch1.body.challenge),
    });
    expect(retry.status).toBe(401);
    const ch2 = await h.call("POST", "/v2/auth/challenge", undefined, { deviceId: d.deviceId });
    const wrongOrigin = await h.call("POST", "/v2/auth/session", undefined, {
      personId: d.personId,
      deviceId: d.deviceId,
      challenge: ch2.body.challenge,
      sig: signChallenge(d, "https://evil.test", ch2.body.challenge),
    });
    expect(wrongOrigin.status).toBe(401);
  });

  it("期限切れのチャレンジとセッションは使えない", async () => {
    const { h, register, login } = relayHarness();
    const { d } = await register();
    const ch = await h.call("POST", "/v2/auth/challenge", undefined, { deviceId: d.deviceId });
    h.clock.advance(3 * 60_000);
    const late = await h.call("POST", "/v2/auth/session", undefined, {
      personId: d.personId,
      deviceId: d.deviceId,
      challenge: ch.body.challenge,
      sig: signChallenge(d, ORIGIN, ch.body.challenge),
    });
    expect(late.status).toBe(401);
    const token = await login(d);
    h.clock.advance(HOUR + 1);
    expect((await h.call("GET", "/v2/me", token)).status).toBe(401);
  });

  it("v1 のトークンでは v2 を使えない", async () => {
    const { h } = relayHarness();
    const alice = await h.user("alice", "アリス");
    expect((await h.call("GET", "/v2/connections", alice.agentToken)).status).toBe(401);
  });

  it("鍵の版を上げた端末証明書で、暗号化鍵を替えられる", async () => {
    const { h, member } = relayHarness();
    const a = await member();
    const enc = generateEncryptionKey();
    const next = { ...a.id, enc, encKeyVersion: 2 };
    const r = await h.call("POST", "/v2/devices", undefined, { personKey: a.person.person.pub, cert: certifyDevice(a.person, next) });
    expect(r.status).toBe(200);
    expect(r.body.directory.devices[0].encKeyVersion).toBe(2);
  });

  it("登録できる人数の上限を超えると断る（同じ人の端末は数えない）", async () => {
    const { h, register } = relayHarness({ config: { relay: { enabled: true, maxAgents: 1 } } });
    const { person } = await register();
    await register(person, newDevice(person));
    const other = generatePerson();
    const r = await h.call("POST", "/v2/devices", undefined, { personKey: other.person.pub, cert: newDevice(other).cert });
    expect(r.status).toBe(403);
  });

  it("Relay を閉じたサーバでは /v2 が 404 になる", async () => {
    const { h } = relayHarness({ config: { relay: { enabled: false, maxAgents: 10 } } });
    const p = generatePerson();
    const r = await h.call("POST", "/v2/devices", undefined, { personKey: p.person.pub, cert: newDevice(p).cert });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("relay_disabled");
  });
});

describe("v2 Relay: 検索と接続", () => {
  it("Person ID で検索でき、返すのは鍵と端末証明書だけ", async () => {
    const { h, member } = relayHarness();
    const a = await member();
    const b = await member(2);
    const r = await h.call("GET", `/v2/persons/${b.personId}`, a.token);
    expect(r.body.directory).toEqual({ personId: b.personId, personKey: b.person.person.pub, devices: b.devices.map((d) => d.cert), revocations: [] });
    const many = await h.call("POST", "/v2/persons/lookup", a.token, { personIds: [b.personId, a.personId, "sb_nope"] });
    expect(many.body.directories).toHaveLength(2);
  });

  it("要求して承認されると接続になる。双方から要求しても1つの接続になる", async () => {
    const { h, member } = relayHarness();
    const a = await member();
    const b = await member();
    const c = await member();
    await h.call("POST", "/v2/connections", a.token, { to: b.personId });
    expect((await h.call("GET", "/v2/connections", b.token)).body.connections).toMatchObject([{ peer: a.personId, status: "incoming" }]);
    expect((await h.call("GET", "/v2/connections", a.token)).body.connections).toMatchObject([{ peer: b.personId, status: "outgoing" }]);
    await h.call("POST", `/v2/connections/${a.personId}/accept`, b.token);
    expect((await h.call("GET", "/v2/connections", a.token)).body.connections).toMatchObject([{ peer: b.personId, status: "accepted" }]);
    // c → a、a → c と両方から要求したら接続になる
    await h.call("POST", "/v2/connections", c.token, { to: a.personId });
    const mutual = await h.call("POST", "/v2/connections", a.token, { to: c.personId });
    expect(mutual.body.connection.status).toBe("accepted");
  });

  it("断った要求は消え、相手には知らせない", async () => {
    const { h, member } = relayHarness();
    const a = await member();
    const b = await member();
    await h.call("POST", "/v2/connections", a.token, { to: b.personId });
    expect((await h.call("POST", `/v2/connections/${a.personId}/reject`, b.token)).status).toBe(204);
    expect((await h.call("GET", "/v2/connections", b.token)).body.connections).toEqual([]);
    expect((await h.call("POST", `/v2/connections/${a.personId}/accept`, b.token)).status).toBe(404);
  });

  it("ブロックすると接続が切れ、ブロックされた側からの要求は相手に届かない（ブロックは知られない）", async () => {
    const { h, member, connect } = relayHarness();
    const a = await member();
    const b = await member();
    await connect(a, b);
    expect((await h.call("PUT", `/v2/blocks/${a.personId}`, b.token)).status).toBe(204);
    expect((await h.call("GET", "/v2/connections", a.token)).body.connections).toEqual([]);
    const again = await h.call("POST", "/v2/connections", a.token, { to: b.personId });
    expect(again.status).toBe(201);
    expect(again.body.connection.status).toBe("outgoing");
    expect((await h.call("GET", "/v2/connections", b.token)).body).toEqual({ connections: [], blocked: [a.personId] });
    // ブロックした側からは、解除するまで要求できない
    expect((await h.call("POST", "/v2/connections", b.token, { to: a.personId })).status).toBe(409);
    await h.call("DELETE", `/v2/blocks/${a.personId}`, b.token);
    expect((await h.call("GET", "/v2/connections", b.token)).body.blocked).toEqual([]);
  });

  it("ブロックされた側から見ても、ふつうの承認待ちと見分けがつかない。解除するとその要求は消える", async () => {
    const { h, member } = relayHarness();
    const a = await member();
    const b = await member();
    await h.call("PUT", `/v2/blocks/${a.personId}`, b.token);
    const first = await h.call("POST", "/v2/connections", a.token, { to: b.personId });
    h.clock.advance(60_000);
    const second = await h.call("POST", "/v2/connections", a.token, { to: b.personId });
    expect(second.body.connection).toEqual(first.body.connection);
    expect((await h.call("GET", "/v2/connections", a.token)).body.connections).toMatchObject([{ peer: b.personId, status: "outgoing" }]);
    expect((await h.call("POST", `/v2/connections/${a.personId}/accept`, b.token)).status).toBe(404);
    await h.call("DELETE", `/v2/blocks/${a.personId}`, b.token);
    expect((await h.call("GET", "/v2/connections", b.token)).body.connections).toEqual([]);
  });

  it("承認待ちの要求の上限と期限、ブロックの対象の確認", async () => {
    const { h, member } = relayHarness();
    const a = await member();
    // 登録されていない相手はブロックできない（表を際限なく大きくしないため）
    expect((await h.call("PUT", `/v2/blocks/${generatePerson().personId}`, a.token)).status).toBe(404);
    const b = await member();
    await h.call("POST", "/v2/connections", a.token, { to: b.personId });
    h.clock.advance(15 * 86_400_000);
    expect(runRetention(h.db, h.clock.now, 30 * 86_400_000).relay.requests).toBe(1);
  });

  it("自分自身や、登録されていない Agent には要求できない", async () => {
    const { h, member } = relayHarness();
    const a = await member();
    expect((await h.call("POST", "/v2/connections", a.token, { to: a.personId })).status).toBe(400);
    expect((await h.call("POST", "/v2/connections", a.token, { to: generatePerson().personId })).status).toBe(404);
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
    expect(r.body.accepted.sort()).toEqual([b.personId, c.personId].sort());
    expect(r.body.skipped).toEqual([{ personId: stranger.personId, reason: "not_connected" }]);

    const got = await inbox(b);
    expect(got).toHaveLength(1);
    const env = got[0]!.envelope;
    expect(env.recipients.map((x) => x.person)).toEqual([b.personId]);
    expect(verifyRecipientGroup(env, env.recipients[0]!, a.id.sign.pub)).toBe(true);
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
        { personId: b.personId, status: "delivered", deliveredAt: expect.any(String), devices: 1 },
        { personId: c.personId, status: "pending", deliveredAt: null, devices: 1 },
      ]),
    );
    await h.call("POST", "/v2/messages/ack", c.token, { messageIds: [body.messageId] });
    expect(h.db.get<{ body: string | null }>(sql`SELECT body FROM relay_person_messages WHERE id = ${body.messageId}`)?.body).toBeNull();
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
    await h.call("DELETE", `/v2/connections/${a.personId}`, b.token);
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

  it("古い暗号化鍵で包んだ端末には届けない（使える箱がない人は stale_key）", async () => {
    const { h, member, connect, seal } = relayHarness();
    const a = await member();
    const b = await member();
    await connect(a, b);
    const next = { ...b.id, enc: generateEncryptionKey(), encKeyVersion: 2 };
    await h.call("POST", "/v2/devices", undefined, { personKey: b.person.person.pub, cert: certifyDevice(b.person, next) });
    const r = await h.call("POST", "/v2/messages", a.token, { envelope: seal(a, [b]) });
    expect(r.status).toBe(200);
    expect(r.body.skipped).toEqual([{ personId: b.personId, reason: "stale_key" }]);
  });
});

describe("v2 Relay: 複数の端末", () => {
  it("相手の人の端末すべてに届き、どの端末でも開ける。全端末が受け取ると暗号文が消える", async () => {
    const { h, member, connect, send, inbox } = relayHarness();
    const a = await member(2);
    const b = await member(2);
    await connect(a, b);
    // a の2台目からも送れる（接続は人と人なので、1回だけでよい）
    const { body } = await send(a, [b]);
    expect(body.accepted).toEqual([b.personId]);
    for (const [i, dev] of b.devices.entries()) {
      const got = await inbox(b, b.tokens[i]);
      expect(got).toHaveLength(1);
      const env = got[0]!.envelope;
      expect(env.senderCert).toEqual(a.id.cert);
      expect(verifyRecipientGroup(env, env.recipients[0]!, env.senderCert.signKey)).toBe(true);
      const plain = normalizeNarrative(openRelayMessage(env, dev), { createdAt: env.createdAt });
      expect(plain.ok).toBe(true);
    }
    await h.call("POST", "/v2/messages/ack", b.tokens[0], { messageIds: [body.messageId] });
    expect(await inbox(b, b.tokens[0])).toEqual([]);
    expect(await inbox(b, b.tokens[1])).toHaveLength(1);
    expect(h.db.get<{ body: string | null }>(sql`SELECT body FROM relay_person_messages WHERE id = ${body.messageId}`)?.body).not.toBeNull();
    await h.call("POST", "/v2/messages/ack", b.tokens[1], { messageIds: [body.messageId] });
    expect(h.db.get<{ body: string | null }>(sql`SELECT body FROM relay_person_messages WHERE id = ${body.messageId}`)?.body).toBeNull();
    const sent = await h.call("GET", "/v2/messages/sent", a.tokens[1]);
    expect(sent.body.messages[0].recipients).toEqual([{ personId: b.personId, status: "delivered", deliveredAt: expect.any(String), devices: 2 }]);
  });

  it("2台目の端末から、その端末の証明書で送れる。別の端末の証明書を名乗ると断る", async () => {
    const { h, member, connect, seal, inbox } = relayHarness();
    const a = await member(2);
    const b = await member();
    await connect(a, b);
    const env = seal(a, [b], {}, { sender: a.devices[1] });
    expect((await h.call("POST", "/v2/messages", a.tokens[1], { envelope: env })).status).toBe(201);
    expect((await inbox(b))[0]!.envelope.senderDevice).toBe(a.devices[1]!.deviceId);
    const spoof = { ...seal(a, [b], {}, { sender: a.devices[1] }), senderCert: a.devices[0]!.cert };
    expect((await h.call("POST", "/v2/messages", a.tokens[1], { envelope: spoof })).body.error.code).toBe("invalid_sender_cert");
    // 1台目のセッションで2台目の名前のメッセージ
    expect((await h.call("POST", "/v2/messages", a.tokens[0], { envelope: seal(a, [b], {}, { sender: a.devices[1] }) })).status).toBe(403);
  });

  it("取り消した端末には届かない。取り消す前の未配送の分も消える", async () => {
    const { h, member, connect, send, inbox } = relayHarness();
    const a = await member();
    const b = await member(2);
    await connect(a, b);
    const first = await send(a, [b]);
    await h.call("POST", "/v2/devices/revoke", undefined, { revocation: revokeDevice(b.person, b.devices[1]!.deviceId, h.clock.now.toISOString()) });
    const n = h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM relay_device_deliveries WHERE device_id = ${b.devices[1]!.deviceId} AND delivered_at IS NULL`);
    expect(n?.n).toBe(0);
    // 古いディレクトリのまま、取り消した端末の箱も入れて送っても、その端末への配送は作らない
    const second = await send(a, [b]);
    expect(second.body.accepted).toEqual([b.personId]);
    const rows = h.db.all<{ device_id: string }>(sql`SELECT device_id FROM relay_device_deliveries WHERE message_id = ${second.body.messageId}`);
    expect(rows.map((r) => r.device_id)).toEqual([b.devices[0]!.deviceId]);
    expect(await inbox(b)).toHaveLength(2);
    void first;
  });
});
