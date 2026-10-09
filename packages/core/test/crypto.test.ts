import { describe, expect, it } from "vitest";
import {
  DecryptError,
  generateEncryptionKey,
  generateSigningKey,
  newCode,
  openGroupName,
  openInviteName,
  openPost,
  sealGroupName,
  sealInviteName,
  sealPost,
  verifyGroupNameBox,
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

  it("招待・ログインのコードは 12 文字", () => {
    expect(newCode()).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });
});

describe("グループ名の封", () => {
  const alice = { agentId: "agt_a", keys: agentKeys() };
  const bob = { agentId: "agt_b", keys: agentKeys() };
  const seal = () =>
    sealGroupName("研究室", { groupId: "grp_1", version: 2 }, { agentId: alice.agentId, signKey: alice.keys.sign }, { agentId: bob.agentId, encKey: bob.keys.enc.pub });

  it("宛先の Agent だけが開け、封をした Agent の署名を検証できる", () => {
    const box = seal();
    expect(JSON.stringify(box)).not.toContain("研究室");
    expect(verifyGroupNameBox(box, alice.keys.sign.pub)).toBe(true);
    expect(verifyGroupNameBox(box, bob.keys.sign.pub)).toBe(false);
    expect(openGroupName(box, { agentId: bob.agentId, encKey: bob.keys.enc })).toBe("研究室");
    expect(() => openGroupName(box, { agentId: alice.agentId, encKey: alice.keys.enc })).toThrow(DecryptError);
  });

  it("グループや版を書き換えると、署名も復号も通らない", () => {
    const box = { ...seal(), version: 3 };
    expect(verifyGroupNameBox(box, alice.keys.sign.pub)).toBe(false);
    expect(() => openGroupName(box, { agentId: bob.agentId, encKey: bob.keys.enc })).toThrow(DecryptError);
  });
});

describe("招待に添えるグループ名", () => {
  it("同じ招待コードとグループでだけ開ける（コードの大文字・小文字やハイフンの違いは同じ扱い）", () => {
    const code = newCode();
    const box = sealInviteName("研究室", code, "grp_1");
    expect(box).not.toContain("研究室");
    expect(openInviteName(box, code.toLowerCase().replace(/-/g, ""), "grp_1")).toBe("研究室");
    expect(() => openInviteName(box, newCode(), "grp_1")).toThrow(DecryptError);
    expect(() => openInviteName(box, code, "grp_2")).toThrow(DecryptError);
  });
});
