import { generateEncryptionKey, generateSigningKey } from "@souieba/core";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "../src/db/index.ts";
import { runRetention } from "../src/retention.ts";
import * as accounts from "../src/services/accounts.ts";
import * as groups from "../src/services/groups.ts";
import { harness, testConfig, twoMembers } from "./harness.ts";

const MIN = 60_000;

describe("最小デモ: 投稿 → 猶予 → sync → claim → told", () => {
  it("一連の流れが通り、サーバには暗号文しか残らない", async () => {
    const { h, alice, bob } = await twoMembers();
    const pub = await h.publish(alice, "主人はM5Stackを使ったロボットを作っていた。");
    expect(pub.status).toBe(201);

    // 猶予期間（10分）中は配られない
    expect((await h.call("POST", "/v1/sync", bob.agentToken)).body.received).toBe(0);
    expect((await h.call("POST", "/v1/tell/claim", bob.agentToken, {})).body.candidate).toBeNull();

    h.clock.advance(11 * MIN);
    expect((await h.call("POST", "/v1/sync", bob.agentToken)).body).toEqual({ received: 1, inboxSize: 1 });
    expect((await h.call("POST", "/v1/sync", bob.agentToken)).body.received).toBe(0);

    const claim = await h.call("POST", "/v1/tell/claim", bob.agentToken, {});
    expect(claim.body.candidate).toMatchObject({
      postId: pub.body.postId,
      owner: { handle: "alice", displayName: "アリス" },
      authorAgentId: alice.agentId,
      authorAgentName: "アリスのAgent",
      envelope: { v: 1, visibility: "groups" },
    });
    expect(claim.body.candidate.content).toBeUndefined();

    expect((await h.call("POST", `/v1/deliveries/${pub.body.postId}/told`, bob.agentToken)).status).toBe(204);
    expect((await h.call("POST", "/v1/tell/claim", bob.agentToken, {})).body.candidate).toBeNull();
    expect((await h.call("GET", "/v1/inbox", bob.agentToken)).body.items).toEqual([]);

    // DB のどこにも本文が残っていない
    const dump = JSON.stringify(h.db.select().from(schema.posts).all());
    expect(dump).not.toContain("M5Stack");
  });
});

describe("投稿", () => {
  it("同じ Agent・同じ時間帯の投稿は上書きになる（冪等）", async () => {
    const { h, alice } = await twoMembers();
    const a = await h.publish(alice, "主人は設計をしていた。");
    const b = await h.publish(alice, "主人はAPIの設計をしていた。");
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.postId).toBe(a.body.postId);
    expect((await h.call("GET", "/v1/posts/mine", alice.token)).body.posts).toHaveLength(1);
  });

  it("不正な期間は 400", async () => {
    const { h, alice } = await twoMembers();
    const r = await h.publish(alice, "主人は何かをしていた。", {
      periodStart: "2026-10-05T13:30:00.000Z",
      periodEnd: "2026-10-05T14:30:00.000Z",
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("period_not_hour_aligned");
  });

  it("改ざんした封筒・他の Agent の鍵で署名した封筒は 400", async () => {
    const { h, alice, bob } = await twoMembers();
    const ok = await h.publish(alice, "主人は京都へ遊びに行っていた。");
    const env = JSON.parse(h.db.select().from(schema.posts).where(eq(schema.posts.id, ok.body.postId)).get()!.envelope);
    const tampered = { ...env, periodStart: "2026-10-05T12:00:00.000Z", periodEnd: "2026-10-05T13:00:00.000Z" };
    const r1 = await h.call("POST", "/v1/posts", alice.agentToken, { envelope: tampered });
    expect(r1.body.error.code).toBe("invalid_signature");
    // ボブのトークンでアリスの封筒を投稿する（なりすまし）
    const r2 = await h.call("POST", "/v1/posts", bob.agentToken, { envelope: env });
    expect(r2.body.error.code).toBe("invalid_signature");
  });

  it("平文の content は受け付けない", async () => {
    const { h, alice } = await twoMembers();
    const r = await h.call("POST", "/v1/posts", alice.agentToken, {
      periodStart: "2026-10-05T13:00:00.000Z",
      periodEnd: "2026-10-05T14:00:00.000Z",
      content: "主人は寝ていた。",
    });
    expect(r.status).toBe(400);
  });

  it("User トークンでは投稿できず、Agent トークンではグループ・Agent を操作できない", async () => {
    const { h, alice, groupId } = await twoMembers();
    expect((await h.publish({ ...alice, agent: { ...alice.agent, token: alice.token } }, "主人は寝ていた。")).status).toBe(403);
    expect((await h.call("POST", "/v1/groups", alice.agentToken, {})).status).toBe(403);
    expect((await h.call("POST", `/v1/groups/${groupId}/invites`, alice.agentToken, {})).status).toBe(403);
    expect((await h.call("POST", "/v1/agents", alice.agentToken, {})).status).toBe(403);
  });

  it("Owner が投稿を削除すると、相手の受信箱からも消える", async () => {
    const { h, alice, bob } = await twoMembers();
    const pub = await h.publish(alice, "主人は京都へ遊びに行っていた。");
    h.clock.advance(11 * MIN);
    await h.call("POST", "/v1/sync", bob.agentToken);
    expect((await h.call("DELETE", `/v1/posts/${pub.body.postId}`, bob.token)).status).toBe(404);
    expect((await h.call("DELETE", `/v1/posts/${pub.body.postId}`, alice.token)).status).toBe(204);
    expect((await h.call("GET", "/v1/inbox", bob.agentToken)).body.items).toEqual([]);
  });
});

describe("可視性（グループ）", () => {
  it("共通のグループがない人・private の投稿・宛先にない Agent には配られない", async () => {
    const { h, alice, bob } = await twoMembers();
    const carol = await h.user("carol", "キャロル"); // どのグループにも入っていない
    const bob2 = await h.addAgent(bob, "後から足した Agent");
    await h.publish(alice, "主人は京都へ遊びに行っていた。", { recipients: [alice.agentId, bob.agentId, carol.agentId] });
    h.clock.advance(MIN);
    await h.publish(alice, "主人は日記を書いていた。", {
      visibility: "private",
      periodStart: "2026-10-05T11:00:00.000Z",
      periodEnd: "2026-10-05T12:00:00.000Z",
    });
    h.clock.advance(11 * MIN);

    expect((await h.call("POST", "/v1/sync", carol.agentToken)).body.received).toBe(0);
    expect((await h.call("POST", "/v1/sync", bob.agentToken)).body.received).toBe(1);
    // 宛先に含まれない Agent（投稿の後に足した Agent など）は、復号できないので候補にしない
    expect((await h.call("POST", "/v1/tell/claim", bob2.token, {})).body.candidate).toBeNull();
    // サーバは届けてよくない宛先（キャロル）を保存しない
    const stored = h.db.select().from(schema.postRecipients).all();
    expect(stored.map((r) => r.agentId)).not.toContain(carol.agentId);
  });

  it("別々のグループの人どうしには届かず、両方に入っている人の投稿は両方に届く", async () => {
    const h = harness();
    const alice = await h.user("alice", "アリス");
    const lab = await h.createGroup(alice, "研究室");
    const home = await h.createGroup(alice, "地元");
    const bob = await h.joinNew(alice, lab, "bob", "ボブ");
    const dave = await h.joinNew(alice, home, "dave", "デイブ");
    await h.publish(alice, "主人はロボットを作っていた。");
    await h.publish(bob, "主人は論文を読んでいた。");
    h.clock.advance(11 * MIN);
    expect((await h.call("POST", "/v1/sync", bob.agentToken)).body.received).toBe(1); // アリスの分
    expect((await h.call("POST", "/v1/sync", dave.agentToken)).body.received).toBe(1); // アリスの分だけ（ボブとは別のグループ）
    expect((await h.call("POST", "/v1/sync", alice.agentToken)).body.received).toBe(1); // ボブの分
    // ディレクトリにも、共通のグループがない人は出てこない
    const dir = (await h.call("GET", "/v1/keys", dave.agentToken)).body;
    expect(dir.users.map((u: { handle: string }) => u.handle).sort()).toEqual(["alice", "dave"]);
  });

  it("グループを抜けると、受信済みの投稿も候補から消える", async () => {
    const { h, alice, bob, groupId } = await twoMembers();
    await h.publish(alice, "主人は京都へ遊びに行っていた。");
    h.clock.advance(11 * MIN);
    await h.call("POST", "/v1/sync", bob.agentToken);
    expect((await h.call("DELETE", `/v1/groups/${groupId}/members/${bob.id}`, bob.token)).status).toBe(204);
    expect((await h.call("POST", "/v1/tell/claim", bob.agentToken, {})).body.candidate).toBeNull();
  });
});

describe("グループ", () => {
  it("GROUP_CREATE_BY=admin なら管理者だけが作れる", async () => {
    const h = harness({ config: { groupCreateBy: "admin" } });
    const admin = await h.user("root", "管理者", "admin");
    const member = await h.user("bob", "ボブ");
    await expect(h.createGroup(member)).rejects.toThrow(/403|管理者/);
    await expect(h.createGroup(admin)).resolves.toMatch(/^grp_/);
  });

  it("招待コードは1回限りで、メンバーでない人は招待できない", async () => {
    const { h, alice, groupId } = await twoMembers();
    const outsider = await h.user("eve", "イヴ");
    expect((await h.invite(outsider, groupId)).status).toBe(404);

    const { code } = await h.invite(alice, groupId);
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const redeem = (handle: string) => h.call("POST", "/v1/auth/redeem", undefined, { code, handle, displayName: handle });
    expect((await redeem("carol")).status).toBe(201);
    expect((await redeem("carol2")).body.error.code).toBe("invalid_code");
  });

  it("同じグループに同じ表示名の人がいると参加できない（Tell 文で見分けられないため）", async () => {
    const { h, alice, groupId } = await twoMembers();
    const { code } = await h.invite(alice, groupId);
    const r = await h.call("POST", "/v1/auth/redeem", undefined, { code, handle: "fake", displayName: " アリス " });
    expect(r.body.error.code).toBe("display_name_taken");
    // ユーザーも作られない（コードもまだ使える）
    expect(accounts.getUserByHandle(h.db, "fake")).toBeUndefined();
    expect((await h.call("POST", "/v1/auth/redeem", undefined, { code, handle: "carol", displayName: "キャロル" })).status).toBe(201);
  });

  it("表示名は、いっしょにいるグループのメンバーと同じものには変えられない", async () => {
    const { h, bob } = await twoMembers();
    expect((await h.call("PATCH", "/v1/me", bob.token, { displayName: "アリス" })).body.error.code).toBe("display_name_taken");
    const r = await h.call("PATCH", "/v1/me", bob.token, { displayName: "ボブ太郎" });
    expect(r.body.user.displayName).toBe("ボブ太郎");
    // グループが別なら同じ表示名でもよい
    const carol = await h.user("carol", "キャロル");
    expect((await h.call("PATCH", "/v1/me", carol.token, { displayName: "アリス" })).status).toBe(200);
  });

  it("期限切れ（3日）の招待コードは使えない", async () => {
    const { h, alice, groupId } = await twoMembers();
    const carol = await h.user("carol", "キャロル");
    const { code } = await h.invite(alice, groupId);
    h.clock.advance(4 * 86_400_000);
    const r = await h.call("POST", "/v1/groups/join", carol.token, { code });
    expect(r.status).toBe(400);
  });

  it("INVITE_BY=admin なら owner だけが招待できる", async () => {
    const { h, bob, alice, groupId } = await twoMembers({ config: { inviteBy: "admin" } });
    expect((await h.invite(bob, groupId)).status).toBe(403);
    expect((await h.invite(alice, groupId)).status).toBe(201);
  });

  it("既存のユーザーは groups/join で別のグループに参加でき、応答に招待者が入る", async () => {
    const { h, alice, groupId } = await twoMembers();
    const carol = await h.user("carol", "キャロル");
    const r = await h.join(alice, groupId, carol);
    expect(r.status).toBe(201);
    expect(r.body.inviter).toEqual({ id: alice.id, handle: "alice", displayName: "アリス" });
    expect((await h.join(alice, groupId, carol)).body.error.code).toBe("already_member");
  });

  it("owner が抜けると最も古いメンバーが owner になり、最後の1人が抜けるとグループは消える", async () => {
    const { h, alice, bob, groupId } = await twoMembers();
    await h.call("DELETE", `/v1/groups/${groupId}/members/${alice.id}`, alice.token);
    expect((await h.call("GET", "/v1/groups", bob.token)).body.groups).toMatchObject([{ id: groupId, role: "owner" }]);
    await h.call("DELETE", `/v1/groups/${groupId}/members/${bob.id}`, bob.token);
    expect(h.db.select().from(schema.groups).all()).toEqual([]);
  });

  it("owner でなければ他人を外せない", async () => {
    const { h, alice, bob, groupId } = await twoMembers();
    expect((await h.call("DELETE", `/v1/groups/${groupId}/members/${alice.id}`, bob.token)).status).toBe(403);
    expect((await h.call("DELETE", `/v1/groups/${groupId}/members/${bob.id}`, alice.token)).status).toBe(204);
  });

  it("メンバーの一覧はメンバーだけが見られる", async () => {
    const { h, alice, bob, groupId } = await twoMembers();
    const r = await h.call("GET", `/v1/groups/${groupId}/members`, bob.token);
    expect(r.body.members.map((m: { handle: string; role: string }) => [m.handle, m.role])).toEqual([
      ["alice", "owner"],
      ["bob", "member"],
    ]);
    const eve = await h.user("eve", "イヴ");
    expect((await h.call("GET", `/v1/groups/${groupId}/members`, eve.token)).status).toBe(404);
    expect(alice).toBeDefined();
  });

  it("ディレクトリは、自分と今いっしょにいるグループのメンバーの、有効な Agent の鍵だけを返す", async () => {
    const { h, alice, bob, groupId } = await twoMembers();
    const carol = await h.joinNew(bob, groupId, "carol", "キャロル");
    const old = await h.addAgent(alice, "古い PC");
    await h.call("DELETE", `/v1/agents/${old.id}`, alice.token);
    await h.call("DELETE", `/v1/groups/${groupId}/members/${bob.id}`, bob.token);
    await h.user("eve", "イヴ");
    const dir = (await h.call("GET", "/v1/keys", carol.agentToken)).body;
    expect(dir.me).toEqual({ userId: carol.id, agentId: carol.agentId });
    expect(dir.users.map((u: { handle: string }) => u.handle).sort()).toEqual(["alice", "carol"]);
    const aliceAgents = dir.users.find((u: { id: string }) => u.id === alice.id).agents;
    expect(aliceAgents).toEqual([
      { id: alice.agentId, name: "アリスのAgent", encKey: alice.agent.keys.enc.pub, signKey: alice.agent.keys.sign.pub, createdAt: expect.any(String) },
    ]);
  });
});

describe("鍵", () => {
  it("Agent の鍵の形式が不正なら登録できない", async () => {
    const h = harness();
    const alice = await h.user("alice", "アリス");
    const enc = generateEncryptionKey().pub;
    const sign = generateSigningKey().pub;
    const r = await h.call("POST", "/v1/agents", alice.token, { name: "x", encKey: "not-a-key", signKey: sign });
    expect(r.body.error.code).toBe("invalid_agent_keys");
    expect((await h.call("POST", "/v1/agents", alice.token, { name: "x", encKey: enc, signKey: sign })).status).toBe(201);
  });
});

describe("Tell の排他", () => {
  it("同じ User の2つの Agent が同時に claim しても、取れるのは1つだけ", async () => {
    const { h, alice, bob } = await twoMembers();
    const second = await h.addAgent(bob, "Claude Code");
    await h.publish(alice, "主人は京都へ遊びに行っていた。");
    h.clock.advance(11 * MIN);
    await h.call("POST", "/v1/sync", bob.agentToken);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => h.call("POST", "/v1/tell/claim", i % 2 ? bob.agentToken : second.token, {})),
    );
    const winners = new Set(results.flatMap((r, i) => (r.body.candidate ? [i % 2] : [])));
    expect(winners.size).toBe(1);
  });

  it("予約していない Agent や他人は told にできない", async () => {
    const { h, alice, bob } = await twoMembers();
    const pub = await h.publish(alice, "主人は京都へ遊びに行っていた。");
    h.clock.advance(11 * MIN);
    await h.call("POST", "/v1/sync", bob.agentToken);
    expect((await h.call("POST", `/v1/deliveries/${pub.body.postId}/told`, bob.agentToken)).status).toBe(409);
    await h.call("POST", "/v1/tell/claim", bob.agentToken, {});
    expect((await h.call("POST", `/v1/deliveries/${pub.body.postId}/told`, alice.agentToken)).status).toBe(404);
    const other = await h.addAgent(bob, "other");
    expect((await h.call("POST", `/v1/deliveries/${pub.body.postId}/told`, other.token)).status).toBe(409);
  });

  it("予約はリース切れで他の Agent が取れるようになり、元の Agent は told できない", async () => {
    const { h, alice, bob } = await twoMembers();
    const other = await h.addAgent(bob, "other");
    const pub = await h.publish(alice, "主人は京都へ遊びに行っていた。");
    h.clock.advance(11 * MIN);
    await h.call("POST", "/v1/sync", bob.agentToken);
    await h.call("POST", "/v1/tell/claim", bob.agentToken, { leaseSec: 60 });
    expect((await h.call("POST", "/v1/tell/claim", other.token, {})).body.candidate).toBeNull();
    h.clock.advance(2 * MIN);
    expect((await h.call("POST", "/v1/tell/claim", other.token, {})).body.candidate?.postId).toBe(pub.body.postId);
    expect((await h.call("POST", `/v1/deliveries/${pub.body.postId}/told`, bob.agentToken)).status).toBe(409);
  });

  it("release すると再び候補になり、dismiss すると候補にならない", async () => {
    const { h, alice, bob } = await twoMembers();
    const pub = await h.publish(alice, "主人は京都へ遊びに行っていた。");
    h.clock.advance(11 * MIN);
    await h.call("POST", "/v1/sync", bob.agentToken);
    await h.call("POST", "/v1/tell/claim", bob.agentToken, {});
    expect((await h.call("POST", `/v1/deliveries/${pub.body.postId}/release`, bob.agentToken)).status).toBe(204);
    expect((await h.call("POST", "/v1/tell/claim", bob.agentToken, {})).body.candidate?.postId).toBe(pub.body.postId);
    expect((await h.call("POST", `/v1/deliveries/${pub.body.postId}/dismiss`, bob.agentToken)).status).toBe(204);
    expect((await h.call("POST", "/v1/tell/claim", bob.agentToken, {})).body.candidate).toBeNull();
  });
});

describe("認証", () => {
  it("グループに入らないアカウント用の招待コードでも参加できる", async () => {
    const h = harness();
    const { code } = accounts.createAccountInvite(h.db, h.clock.now);
    const r = await h.call("POST", "/v1/auth/redeem", undefined, { code, handle: "bob", displayName: "ボブ" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ group: null, inviter: null });
    expect((await h.call("GET", "/v1/groups", r.body.token)).body.groups).toEqual([]);
  });

  it("ログインコードを再発行すると古い User トークンは失効する（Agent のトークンはそのまま）", async () => {
    const h = harness();
    const alice = await h.user("alice", "アリス");
    const { code } = accounts.issueLoginCode(h.db, alice.id, h.clock.now);
    const r = await h.call("POST", "/v1/auth/redeem", undefined, { code });
    expect(r.body.user.handle).toBe("alice");
    expect((await h.call("GET", "/v1/me", alice.token)).status).toBe(401);
    expect((await h.call("GET", "/v1/me", r.body.token)).status).toBe(200);
    expect((await h.call("GET", "/v1/me", alice.agentToken)).status).toBe(200);
  });

  it("redeem は IP ごとに 10回/時 まで", async () => {
    const h = harness();
    const codes = Array.from({ length: 11 }, () => h.call("POST", "/v1/auth/redeem", undefined, { code: "AAAA-BBBB-CCCC" }));
    const statuses = (await Promise.all(codes)).map((r) => r.status);
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
  });

  it("不正なトークンは IP ごとに 10分 30回まで。超えると正しいトークンでも 429", async () => {
    const h = harness({ remoteAddr: "203.0.113.5" });
    const alice = await h.user("alice", "アリス");
    for (let i = 0; i < 30; i++) expect((await h.call("GET", "/v1/me", `sou_a_wrong${i}`)).status).toBe(401);
    expect((await h.call("GET", "/v1/me", alice.token)).status).toBe(429);
    h.setIp("203.0.113.6");
    expect((await h.call("GET", "/v1/me", alice.token)).status).toBe(200);
    h.clock.advance(11 * MIN);
    h.setIp("203.0.113.5");
    expect((await h.call("GET", "/v1/me", alice.token)).status).toBe(200);
  });

  it("失効した Agent・無効化されたユーザー・不正なトークンは 401", async () => {
    const h = harness();
    const bob = await h.user("bob", "ボブ");
    expect((await h.call("GET", "/v1/me", "sou_a_nonexistenttoken")).status).toBe(401);
    expect((await h.call("GET", "/v1/me")).status).toBe(401);
    await h.call("DELETE", `/v1/agents/${bob.agentId}`, bob.token);
    expect((await h.call("POST", "/v1/sync", bob.agentToken)).status).toBe(401);
    accounts.disableUser(h.db, bob.id, h.clock.now);
    expect((await h.call("GET", "/v1/me", bob.token)).status).toBe(401);
  });

  it("アカウントを削除すると投稿も消え、メンバーがいなくなったグループも消える", async () => {
    const { h, alice, bob } = await twoMembers();
    await h.publish(alice, "主人は京都へ遊びに行っていた。");
    h.clock.advance(11 * MIN);
    await h.call("POST", "/v1/sync", bob.agentToken);
    expect((await h.call("DELETE", "/v1/me", alice.token)).status).toBe(204);
    expect((await h.call("GET", "/v1/inbox", bob.agentToken)).body.items).toEqual([]);
    expect(h.db.select().from(schema.posts).all()).toEqual([]);
    expect((await h.call("DELETE", "/v1/me", bob.token)).status).toBe(204);
    expect(h.db.select().from(schema.groups).all()).toEqual([]);
  });
});

describe("ネットワーク", () => {
  it("信頼するプロキシが付けた X-Forwarded-For の末尾だけを使う（先頭は偽れる）", async () => {
    const h = harness({ remoteAddr: "127.0.0.1" });
    const redeem = (xff: string) => h.call("POST", "/v1/auth/redeem", undefined, { code: "AAAA" }, { "x-forwarded-for": xff });
    // 攻撃者が先頭を毎回変えても、プロキシが末尾に付けた実際の IP で数えられる
    for (let i = 0; i < 10; i++) await redeem(`1.1.1.${i}, 198.51.100.7`);
    expect((await redeem("9.9.9.9, 198.51.100.7")).status).toBe(429);
    expect((await redeem("198.51.100.8")).status).toBe(400);

    // 信頼しない接続元からの XFF は無視する
    const h2 = harness({ remoteAddr: "100.64.0.3" });
    for (let i = 0; i < 10; i++) await h2.call("POST", "/v1/auth/redeem", undefined, { code: "AAAA" }, { "x-forwarded-for": `1.1.1.${i}` });
    expect((await h2.call("POST", "/v1/auth/redeem", undefined, { code: "AAAA" }, { "x-forwarded-for": "9.9.9.9" })).status).toBe(429);
  });

  it("TRUST_PROXY=private なら Docker のブリッジ上のプロキシからの XFF を信頼する", async () => {
    const h = harness({ config: { trustProxy: "private" }, remoteAddr: "172.18.0.2" });
    for (let i = 0; i < 10; i++)
      await h.call("POST", "/v1/auth/redeem", undefined, { code: "AAAA" }, { "x-forwarded-for": "198.51.100.7" });
    expect((await h.call("POST", "/v1/auth/redeem", undefined, { code: "AAAA" }, { "x-forwarded-for": "198.51.100.8" })).status).toBe(400);
  });
});

describe("公開", () => {
  it("admin API は HTTP からは使えず、インスタンス情報にバージョンを出さない", async () => {
    const h = harness();
    const admin = await h.user("root", "管理者", "admin");
    const bob = await h.user("bob", "ボブ");
    expect((await h.call("GET", "/v1/admin/users", admin.token)).status).toBe(404);
    expect((await h.call("POST", `/v1/admin/users/${bob.id}/disable`, admin.token)).status).toBe(404);
    const inst = await h.call("GET", "/v1/instance");
    expect(inst.body.version).toBeUndefined();
  });
});

describe("ログ", () => {
  it("アクセスログに本文・トークン・コードを出さない", async () => {
    const lines: string[] = [];
    const { createApp } = await import("../src/app.ts");
    const base = await twoMembers();
    const app = createApp({
      db: base.h.db,
      config: { ...testConfig(), logLevel: "info" },
      now: () => base.h.clock.now,
      remoteAddr: () => "127.0.0.1",
      log: (l) => lines.push(JSON.stringify(l)),
    });
    await app.request("/v1/auth/redeem?code=ZZZZ", { method: "POST", body: JSON.stringify({ code: "ZZZZ-YYYY-XXXX" }) });
    await app.request("/v1/me", { headers: { authorization: `Bearer ${base.alice.agentToken}` } });
    const all = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(all).not.toContain(base.alice.agentToken);
    expect(all).not.toContain("ZZZZ");
  });
});

describe("保存期間", () => {
  it("保存期間を過ぎた投稿を物理削除する", async () => {
    const { h, alice } = await twoMembers();
    await h.publish(alice, "主人は京都へ遊びに行っていた。");
    h.clock.advance(15 * 86_400_000);
    expect(runRetention(h.db, h.clock.now, 14 * 86_400_000).posts).toBe(1);
  });
});

const BOOTSTRAP = "bootstrap-secret-0123456789abcdef";
const adminConfig = { adminApi: true, bootstrapToken: BOOTSTRAP };

describe("admin API", () => {
  it("既定（SOUIEBA_ADMIN_API=off）では、ブートストラップも含めて HTTP からは使えない", async () => {
    const h = harness({ config: { bootstrapToken: BOOTSTRAP } });
    expect((await h.call("POST", "/v1/admin/bootstrap", undefined, { token: BOOTSTRAP, handle: "root", displayName: "管理者" })).status).toBe(404);
  });

  it("ブートストラップは秘密が合うときに1回だけ。admin 専用トークンとログインコードを返す", async () => {
    const h = harness({ config: adminConfig });
    const boot = (token: string, handle = "root") => h.call("POST", "/v1/admin/bootstrap", undefined, { token, handle, displayName: "管理者" });
    expect((await boot("wrong-secret-0123456789abcdef")).status).toBe(401);
    const ok = await boot(BOOTSTRAP);
    expect(ok.status).toBe(201);
    expect(ok.body.adminToken).toMatch(/^sou_m_/);
    expect((await boot(BOOTSTRAP, "root2")).status).toBe(409);
    // ログインコードで利用者としてもログインできる
    expect((await h.call("POST", "/v1/auth/redeem", undefined, { code: ok.body.loginCode })).status).toBe(201);
  });

  it("admin 専用トークンは admin API にだけ、普段のトークンは admin API 以外にだけ使える", async () => {
    const h = harness({ config: adminConfig });
    const boot = await h.call("POST", "/v1/admin/bootstrap", undefined, { token: BOOTSTRAP, handle: "root", displayName: "管理者" });
    const adminToken: string = boot.body.adminToken;
    const root = await h.call("POST", "/v1/auth/redeem", undefined, { code: boot.body.loginCode });
    expect((await h.call("GET", "/v1/admin/users", adminToken)).status).toBe(200);
    expect((await h.call("GET", "/v1/me", adminToken)).status).toBe(403);
    expect((await h.call("GET", "/v1/admin/users", root.body.token)).status).toBe(403);
    // ログインコードでの再ログイン（User トークンの失効）では、admin 専用トークンは失効しない
    const again = await h.call("POST", `/v1/admin/users/root/login-code`, adminToken);
    await h.call("POST", "/v1/auth/redeem", undefined, { code: again.body.loginCode });
    expect((await h.call("GET", "/v1/admin/users", adminToken)).status).toBe(200);
  });

  it("souieba-admin と同じ操作ができる", async () => {
    const h = harness({ config: adminConfig });
    const { adminToken } = (await h.call("POST", "/v1/admin/bootstrap", undefined, { token: BOOTSTRAP, handle: "root", displayName: "管理者" })).body;
    const created = await h.call("POST", "/v1/admin/users", adminToken, { handle: "alice", displayName: "アリス" });
    expect(created.status).toBe(201);
    expect((await h.call("POST", "/v1/auth/redeem", undefined, { code: created.body.loginCode })).status).toBe(201);
    expect((await h.call("POST", "/v1/admin/invites", adminToken)).body.code).toBeTruthy();
    expect((await h.call("GET", "/v1/admin/groups", adminToken)).body.groups).toEqual([]);
    expect((await h.call("POST", "/v1/admin/users/root/disable", adminToken)).status).toBe(400);
    expect((await h.call("POST", "/v1/admin/users/alice/disable", adminToken)).status).toBe(204);
    const users = (await h.call("GET", "/v1/admin/users", adminToken)).body.users as { handle: string; disabledAt: string | null }[];
    expect(users.find((u) => u.handle === "alice")?.disabledAt).toBeTruthy();
    // admin でないユーザーには admin 専用トークンを出さない
    expect((await h.call("POST", "/v1/admin/users/alice/admin-token", adminToken)).status).toBe(400);
  });

  it("admin 専用トークンを再発行すると、古いものは失効する", async () => {
    const h = harness({ config: adminConfig });
    const { adminToken } = (await h.call("POST", "/v1/admin/bootstrap", undefined, { token: BOOTSTRAP, handle: "root", displayName: "管理者" })).body;
    const next = (await h.call("POST", "/v1/admin/users/root/admin-token", adminToken)).body.adminToken as string;
    expect((await h.call("GET", "/v1/admin/users", adminToken)).status).toBe(401);
    expect((await h.call("GET", "/v1/admin/users", next)).status).toBe(200);
  });

  it("admin でなくなったユーザーの admin 専用トークンは使えない", async () => {
    const h = harness({ config: adminConfig });
    const { adminToken, user } = (await h.call("POST", "/v1/admin/bootstrap", undefined, { token: BOOTSTRAP, handle: "root", displayName: "管理者" })).body;
    h.db.update(schema.users).set({ role: "member" }).where(eq(schema.users.id, user.id)).run();
    expect((await h.call("GET", "/v1/admin/users", adminToken)).status).toBe(401);
  });
});

describe("本文の大きさ", () => {
  it("Content-Length のない（chunked の）本文も、上限を超えたら 413", async () => {
    const { h, alice } = await twoMembers();
    const big = new TextEncoder().encode(JSON.stringify({ name: "x".repeat(32 * 1024) }));
    const res = await h.app.request("/v1/agents", {
      method: "POST",
      headers: { authorization: `Bearer ${alice.token}`, "content-type": "application/json" },
      body: new ReadableStream({
        start(c) {
          c.enqueue(big);
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
  });
});

describe("上限", () => {
  it("グループの人数の上限を超えて参加できない", async () => {
    const { h, alice, groupId } = await twoMembers({ config: { limits: { maxUsers: 100, maxGroupMembers: 2, maxGroupsPerUser: 10 } } });
    await expect(h.joinNew(alice, groupId, "carol", "キャロル")).rejects.toThrow(/limit_group_members/);
    // 失敗した参加でユーザーだけが作られることはない
    expect(h.db.select().from(schema.users).where(eq(schema.users.handle, "carol")).all()).toEqual([]);
  });

  it("1人が入れるグループの数を超えて、作成も参加もできない", async () => {
    const { h, alice, bob } = await twoMembers({ config: { limits: { maxUsers: 100, maxGroupMembers: 50, maxGroupsPerUser: 1 } } });
    await expect(h.createGroup(alice, "2つ目")).rejects.toThrow(/limit_groups_per_user/);
    const carol = await h.user("carol", "キャロル");
    const other = await h.createGroup(carol, "別のグループ");
    expect((await h.join(carol, other, bob)).body.error.code).toBe("limit_groups_per_user");
  });

  it("宛先が多い投稿・受信箱にたまった投稿・大きなディレクトリでも、1つの文のバインド変数が100個を超えない", async () => {
    const { h, alice, bob, groupId } = await twoMembers();
    // 宛先が51件（2変数 × 51 > 100）の投稿
    for (let i = 0; i < 49; i++) {
      if (i === 25) h.clock.advance(MIN);
      await h.addAgent(alice, `予備${i}`);
    }
    expect((await h.publish(alice, "宛先が多い")).status).toBe(201);
    // 48時間の窓に30件（4変数 × 30 > 100）。sync を毎回呼んでも、すでに受け取った投稿で増えない
    for (let i = 0; i < 29; i++) {
      h.clock.advance(60 * MIN);
      expect((await h.publish(bob, `近況${i}`)).status).toBe(201);
    }
    h.clock.advance(60 * MIN);
    expect((await h.call("POST", "/v1/sync", alice.agentToken)).body).toEqual({ received: 29, inboxSize: 29 });
    expect((await h.call("POST", "/v1/sync", alice.agentToken)).body.received).toBe(0);
    // 101人以上が載るディレクトリと、101個以上のグループの一覧
    for (let i = 0; i < 101; i++) {
      const u = accounts.createUser(h.db, { handle: `u${i}`, displayName: `u${i}` }, h.clock.now);
      h.db.insert(schema.groupMembers).values({ groupId, userId: u.id, role: "member", joinedAt: h.clock.now.toISOString() }).run();
      h.db.insert(schema.groups).values({ id: `grp_extra${i}`, name: `g${i}`, createdBy: u.id, createdAt: h.clock.now.toISOString() }).run();
    }
    expect(groups.directory(h.db, { userId: alice.id, agentId: null }).users).toHaveLength(103);
    expect(groups.listAllGroups(h.db)).toHaveLength(102);
  });

  it("インスタンスのユーザー数の上限を超えて登録できない", async () => {
    const { h, alice, groupId } = await twoMembers({ config: { limits: { maxUsers: 2, maxGroupMembers: 50, maxGroupsPerUser: 10 } } });
    await expect(h.joinNew(alice, groupId, "carol", "キャロル")).rejects.toThrow(/limit_users/);
  });

  it("無効化したユーザーはユーザー数に数えない", async () => {
    const { h, alice, bob, groupId } = await twoMembers({ config: { limits: { maxUsers: 2, maxGroupMembers: 50, maxGroupsPerUser: 10 } } });
    accounts.disableUser(h.db, bob.id, h.clock.now);
    await h.joinNew(alice, groupId, "carol", "キャロル");
  });
});
