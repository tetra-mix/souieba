import { describe, expect, it } from "vitest";
import {
  DecryptError,
  type DirectoryGroup,
  type DirectoryUser,
  GROUP_INVITE_CODE_LENGTH,
  type KeyDirectory,
  type KeyPair,
  emptyPins,
  evaluateTrust,
  fingerprint,
  generateEncryptionKey,
  generateSigningKey,
  inviteCommit,
  newCode,
  normalizeFingerprint,
  openPost,
  sealPost,
  signText,
  signedText,
  verifyPostSignature,
} from "../src/index.ts";

const post = { periodStart: "2026-10-05T13:00:00.000Z", periodEnd: "2026-10-05T14:00:00.000Z", visibility: "groups" as const };

function agentKeys() {
  return { enc: generateEncryptionKey(), sign: generateSigningKey() };
}

describe("投稿の封筒", () => {
  const author = { userId: "usr_a", agentId: "agt_a", keys: agentKeys() };
  const bob = { agentId: "agt_b", keys: agentKeys() };
  const carol = { agentId: "agt_c", keys: agentKeys() };
  const seal = (content = "主人はロボットを作っていた。") =>
    sealPost({ ...post, content }, { userId: author.userId, agentId: author.agentId, signKey: author.keys.sign }, [
      { agentId: bob.agentId, encKey: bob.keys.enc.pub },
      { agentId: author.agentId, encKey: author.keys.enc.pub },
    ]);
  const as = { userId: author.userId, agentId: author.agentId };

  it("宛先の Agent だけが復号でき、署名を検証できる", () => {
    const env = seal();
    expect(env.ciphertext).not.toContain("ロボット");
    expect(env.recipients.map((r) => r.agentId)).toEqual(["agt_a", "agt_b"]);
    expect(verifyPostSignature(env, as, author.keys.sign.pub)).toBe(true);
    expect(openPost(env, as, { agentId: bob.agentId, encKey: bob.keys.enc })).toBe("主人はロボットを作っていた。");
    expect(openPost(env, as, { agentId: author.agentId, encKey: author.keys.enc })).toBe("主人はロボットを作っていた。");
    expect(() => openPost(env, as, { agentId: carol.agentId, encKey: carol.keys.enc })).toThrow(DecryptError);
  });

  it("他人宛ての包みを自分のものと偽っても復号できない", () => {
    const env = seal();
    const forged = { ...env, recipients: env.recipients.map((r) => (r.agentId === "agt_b" ? { ...r, agentId: "agt_c" } : r)) };
    expect(() => openPost(forged, as, { agentId: carol.agentId, encKey: carol.keys.enc })).toThrow(DecryptError);
  });

  it("期間・投稿者・宛先を書き換えると、署名の検証か復号に失敗する", () => {
    const env = seal();
    const moved = { ...env, periodStart: "2026-10-05T12:00:00.000Z", periodEnd: "2026-10-05T13:00:00.000Z" };
    expect(verifyPostSignature(moved, as, author.keys.sign.pub)).toBe(false);
    expect(() => openPost(moved, as, { agentId: bob.agentId, encKey: bob.keys.enc })).toThrow(DecryptError);
    // 別の人の投稿だと偽る
    const other = { userId: "usr_x", agentId: "agt_a" };
    expect(verifyPostSignature(env, other, author.keys.sign.pub)).toBe(false);
    expect(() => openPost(env, other, { agentId: bob.agentId, encKey: bob.keys.enc })).toThrow(DecryptError);
    // 宛先を減らす
    expect(verifyPostSignature({ ...env, recipients: env.recipients.slice(1) }, as, author.keys.sign.pub)).toBe(false);
  });

  it("指紋は 12 桁の16進で、表記ゆれを吸収できる", () => {
    const k = generateSigningKey();
    expect(fingerprint(k.pub)).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(normalizeFingerprint(fingerprint(k.pub).toLowerCase().replaceAll("-", " "))).toBe(fingerprint(k.pub));
  });

  it("グループの招待コードは 20 文字", () => {
    expect(newCode(GROUP_INVITE_CODE_LENGTH)).toMatch(/^([A-Z0-9]{4}-){4}[A-Z0-9]{4}$/);
  });
});

/** クライアントが正しく作った場合と同じ署名を持つ、テスト用のグループ */
function world() {
  const people = new Map<string, { identity: KeyPair; agent: ReturnType<typeof agentKeys> }>();
  const users: DirectoryUser[] = [];
  const addUser = (id: string) => {
    const identity = generateSigningKey();
    const agent = agentKeys();
    people.set(id, { identity, agent });
    users.push({
      id,
      handle: id,
      displayName: id,
      identityKey: identity.pub,
      agents: [
        {
          id: `agt_${id}`,
          name: `${id}のAgent`,
          encKey: agent.enc.pub,
          signKey: agent.sign.pub,
          cert: signText(identity, signedText.agentCert(id, agent.enc.pub, agent.sign.pub)),
        },
      ],
    });
  };
  const group: DirectoryGroup = { id: "grp_lab", name: "研究室", createdBy: null, createSig: "", members: [] };
  const create = (creator: string) => {
    addUser(creator);
    group.createdBy = creator;
    group.createSig = signText(people.get(creator)!.identity, signedText.groupCreate(group.id, creator));
    group.members.push({ userId: creator, role: "owner", invitedBy: null, inviteCode: null, inviteSig: null, joinSig: null, joinedAt: "t0", leftAt: null });
  };
  const invite = (inviter: string, joiner: string, code = newCode(GROUP_INVITE_CODE_LENGTH)) => {
    if (!people.has(joiner)) addUser(joiner);
    const commit = inviteCommit(group.id, code);
    group.members.push({
      userId: joiner,
      role: "member",
      invitedBy: inviter,
      inviteCode: code,
      inviteSig: signText(people.get(inviter)!.identity, signedText.invite(group.id, inviter, commit)),
      joinSig: signText(people.get(joiner)!.identity, signedText.join(code)),
      joinedAt: "t1",
      leftAt: null,
    });
    return code;
  };
  const dir = (me: string): KeyDirectory => ({ me: { userId: me, agentId: `agt_${me}` }, users, groups: [group] });
  const trust = (me: string, pins = emptyPins()) => evaluateTrust(dir(me), pins, people.get(me)!.identity.pub);
  return { people, users, group, addUser, create, invite, dir, trust };
}

describe("所属の証明の連鎖", () => {
  it("作成者から招待の署名をたどれるメンバーを信頼する", () => {
    const w = world();
    w.create("alice");
    w.invite("alice", "bob");
    w.invite("bob", "carol");
    const t = w.trust("carol");
    expect([...t.users.keys()].sort()).toEqual(["alice", "bob", "carol"]);
    expect([...t.agents.keys()].sort()).toEqual(["agt_alice", "agt_bob", "agt_carol"]);
    expect(t.problems).toEqual([]);
    expect(t.pins.members.grp_lab?.sort()).toEqual(["alice", "bob", "carol"]);
    expect(Object.keys(t.pins.identities).sort()).toEqual(["alice", "bob"]);
  });

  it("サーバが署名なしで追加したメンバーは信頼しない", () => {
    const w = world();
    w.create("alice");
    w.invite("alice", "bob");
    w.addUser("mallory");
    w.group.members.push({ userId: "mallory", role: "member", invitedBy: "alice", inviteCode: "AAAA", inviteSig: "x", joinSig: "x", joinedAt: "t", leftAt: null });
    const t = w.trust("bob");
    expect(t.users.has("mallory")).toBe(false);
    expect(t.agents.has("agt_mallory")).toBe(false);
    expect(t.problems).toContainEqual(expect.objectContaining({ kind: "unverified_member", userId: "mallory" }));
  });

  it("サーバが自分で作った招待（招待者の署名を偽造できない）では参加させられない", () => {
    const w = world();
    w.create("alice");
    w.addUser("mallory");
    const code = newCode(GROUP_INVITE_CODE_LENGTH);
    const fakeInviter = generateSigningKey();
    w.group.members.push({
      userId: "mallory",
      role: "member",
      invitedBy: "alice",
      inviteCode: code,
      inviteSig: signText(fakeInviter, signedText.invite(w.group.id, "alice", inviteCommit(w.group.id, code))),
      joinSig: signText(w.people.get("mallory")!.identity, signedText.join(code)),
      joinedAt: "t",
      leftAt: null,
    });
    expect(w.trust("alice").users.has("mallory")).toBe(false);
  });

  it("使用済みのコードを使い回した偽のメンバーは信頼しない。先に検証済みの本物は記録で守られる", () => {
    const w = world();
    w.create("alice");
    const code = w.invite("alice", "bob");
    const before = w.trust("alice"); // bob を検証して記録する
    w.invite("alice", "mallory", code); // サーバは使用済みのコードを知っている
    // 2つ目の招待の署名は本物と同じなので、所属の証明は「コードの重複」で弾く
    const after = w.trust("alice", before.pins);
    expect(after.users.has("bob")).toBe(true);
    expect(after.users.has("mallory")).toBe(false);
  });

  it("循環した招待は信頼しない", () => {
    const w = world();
    w.create("alice");
    w.addUser("x");
    w.addUser("y");
    w.invite("y", "x");
    w.invite("x", "y");
    const t = w.trust("alice");
    expect(t.users.has("x")).toBe(false);
    expect(t.users.has("y")).toBe(false);
  });

  it("招待した人が抜けても、その人が招待したメンバーは検証できる。抜けた人には送らない", () => {
    const w = world();
    w.create("alice");
    w.invite("alice", "bob");
    w.invite("bob", "carol");
    w.group.members.find((m) => m.userId === "bob")!.leftAt = "t2";
    const t = w.trust("alice");
    expect(t.users.has("carol")).toBe(true);
    expect(t.users.has("bob")).toBe(false);
  });

  it("自分が抜けた（とサーバが言う）グループのメンバーには送らない", () => {
    const w = world();
    w.create("alice");
    w.invite("alice", "bob");
    w.group.members.find((m) => m.userId === "bob")!.leftAt = "t2";
    expect([...w.trust("bob").users.keys()]).toEqual(["bob"]);
  });
});

describe("鍵のすり替え", () => {
  it("一度見た Identity 鍵が変わったユーザーは信頼しない（TOFU）", () => {
    const w = world();
    w.create("alice");
    w.invite("alice", "bob");
    const first = w.trust("bob");
    // サーバがアリスの鍵を差し替え、偽の Agent も証明書ごと作り直す
    const fake = generateSigningKey();
    const fakeAgent = agentKeys();
    const alice = w.users.find((u) => u.id === "alice")!;
    alice.identityKey = fake.pub;
    alice.agents = [
      {
        id: "agt_fake",
        name: "偽",
        encKey: fakeAgent.enc.pub,
        signKey: fakeAgent.sign.pub,
        cert: signText(fake, signedText.agentCert("alice", fakeAgent.enc.pub, fakeAgent.sign.pub)),
      },
    ];
    const t = w.trust("bob", first.pins);
    expect(t.users.has("alice")).toBe(false);
    expect(t.agents.has("agt_fake")).toBe(false);
    expect(t.problems).toContainEqual({ kind: "identity_changed", userId: "alice", handle: "alice" });
  });

  it("持ち主の Identity 鍵で署名されていない Agent は信頼しない", () => {
    const w = world();
    w.create("alice");
    w.invite("alice", "bob");
    const fakeAgent = agentKeys();
    w.users
      .find((u) => u.id === "alice")!
      .agents.push({
        id: "agt_injected",
        name: "サーバが足した Agent",
        encKey: fakeAgent.enc.pub,
        signKey: fakeAgent.sign.pub,
        cert: signText(generateSigningKey(), signedText.agentCert("alice", fakeAgent.enc.pub, fakeAgent.sign.pub)),
      });
    const t = w.trust("bob");
    expect(t.agents.has("agt_alice")).toBe(true);
    expect(t.agents.has("agt_injected")).toBe(false);
    expect(t.problems).toContainEqual(expect.objectContaining({ kind: "invalid_agent_cert", agentId: "agt_injected" }));
  });

  it("自分の鍵がすり替えられていれば知らせ、自分の Agent は手元の鍵で確かめる", () => {
    const w = world();
    w.create("alice");
    const me = w.users.find((u) => u.id === "alice")!;
    me.identityKey = generateSigningKey().pub;
    const t = w.trust("alice");
    expect(t.problems).toContainEqual({ kind: "self_identity_mismatch" });
    expect(t.agents.has("agt_alice")).toBe(true);
  });
});
