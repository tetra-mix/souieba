/**
 * サーバが配る公開鍵ディレクトリを、サーバを信頼せずに検証する。
 * - Identity 鍵は最初に見たものを信じる（TOFU）。変わったユーザーは信頼しない
 * - グループの所属は、作成者の署名から招待の署名をたどって証明する（所属の証明の連鎖）
 * - Agent の鍵は、持ち主の Identity 鍵による証明書で確かめる
 */
import { inviteCommit, signedText, verifyText } from "./crypto.ts";
import type { DirectoryAgent, DirectoryGroup, DirectoryMember, DirectoryUser, KeyDirectory } from "./types.ts";

/** クライアントが保存する信頼の記録（~/.souieba/known_keys.json） */
export type Pins = {
  /** userId → Identity 公開鍵 */
  identities: Record<string, string>;
  /** groupId → 検証済みのメンバーの userId */
  members: Record<string, string[]>;
};

export const emptyPins = (): Pins => ({ identities: {}, members: {} });

export type TrustProblem =
  | { kind: "identity_changed"; userId: string; handle: string }
  | { kind: "self_identity_mismatch" }
  | { kind: "unverified_member"; groupId: string; groupName: string; userId: string; handle: string }
  | { kind: "invalid_agent_cert"; userId: string; handle: string; agentId: string; agentName: string };

export type TrustedAgent = DirectoryAgent & { user: DirectoryUser };

export type GroupView = {
  id: string;
  name: string;
  members: { userId: string; handle: string; displayName: string; role: string; identityKey: string | null; verified: boolean; active: boolean }[];
};

export type TrustResult = {
  /** 自分と、共通のグループに検証済みで所属しているユーザー */
  users: Map<string, DirectoryUser>;
  /** 上のユーザーの、証明書を検証できた Agent */
  agents: Map<string, TrustedAgent>;
  groups: GroupView[];
  problems: TrustProblem[];
  /** 更新後の記録。呼び出し側で保存する */
  pins: Pins;
};

export function evaluateTrust(dir: KeyDirectory, pinsIn: Pins, selfIdentityKey: string): TrustResult {
  const pins: Pins = {
    identities: { ...pinsIn.identities },
    members: Object.fromEntries(Object.entries(pinsIn.members).map(([k, v]) => [k, [...v]])),
  };
  const problems: TrustProblem[] = [];
  const usersById = new Map(dir.users.map((u) => [u.id, u]));
  const meId = dir.me.userId;

  const reported = new Set<string>();
  /** 信頼してよい Identity 公開鍵。記録と違えば null */
  const identityOf = (userId: string): string | null => {
    if (userId === meId) {
      const listed = usersById.get(meId)?.identityKey;
      if (listed && listed !== selfIdentityKey && !reported.has(meId)) {
        reported.add(meId);
        problems.push({ kind: "self_identity_mismatch" });
      }
      return selfIdentityKey;
    }
    const u = usersById.get(userId);
    if (!u?.identityKey) return null;
    const pinned = pins.identities[userId];
    if (pinned && pinned !== u.identityKey) {
      if (!reported.has(userId)) {
        reported.add(userId);
        problems.push({ kind: "identity_changed", userId, handle: u.handle });
      }
      return null;
    }
    return u.identityKey;
  };

  const groups: GroupView[] = [];
  const shareActiveGroup = new Set<string>();

  for (const g of dir.groups) {
    const verified = verifyGroup(g, identityOf, new Set(pins.members[g.id] ?? []));
    const meActive = g.members.some((m) => m.userId === meId && !m.leftAt);
    pins.members[g.id] = [...new Set([...(pins.members[g.id] ?? []), ...verified])];
    for (const m of g.members) {
      const key = identityOf(m.userId);
      if (verified.has(m.userId) && key && m.userId !== meId) pins.identities[m.userId] ??= key;
    }
    groups.push({
      id: g.id,
      name: g.name,
      members: g.members.map((m) => {
        const u = usersById.get(m.userId);
        return {
          userId: m.userId,
          handle: u?.handle ?? "?",
          displayName: u?.displayName ?? "?",
          role: m.role,
          identityKey: u?.identityKey ?? null,
          verified: verified.has(m.userId),
          active: !m.leftAt,
        };
      }),
    });
    if (!meActive) continue;
    for (const m of g.members) {
      if (m.leftAt || m.userId === meId) continue;
      if (verified.has(m.userId)) shareActiveGroup.add(m.userId);
      else problems.push({ kind: "unverified_member", groupId: g.id, groupName: g.name, userId: m.userId, handle: usersById.get(m.userId)?.handle ?? "?" });
    }
  }

  const users = new Map<string, DirectoryUser>();
  const agents = new Map<string, TrustedAgent>();
  for (const userId of [meId, ...shareActiveGroup]) {
    const u = usersById.get(userId);
    const key = identityOf(userId);
    if (!u || !key) continue;
    users.set(userId, u);
    for (const a of u.agents) {
      if (verifyText(key, signedText.agentCert(userId, a.encKey, a.signKey), a.cert)) {
        agents.set(a.id, { ...a, user: u });
      } else {
        problems.push({ kind: "invalid_agent_cert", userId, handle: u.handle, agentId: a.id, agentName: a.name });
      }
    }
  }
  return { users, agents, groups, problems, pins };
}

/** グループのメンバーのうち、所属を証明できた userId（抜けた人を含む） */
function verifyGroup(g: DirectoryGroup, identityOf: (userId: string) => string | null, pinned: Set<string>): Set<string> {
  const byUser = new Map(g.members.map((m) => [m.userId, m]));
  const codeUses = new Map<string, number>();
  for (const m of g.members) if (m.inviteCode) codeUses.set(m.inviteCode, (codeUses.get(m.inviteCode) ?? 0) + 1);

  const memo = new Map<string, boolean>();
  const check = (m: DirectoryMember, visiting: Set<string>): boolean => {
    const cached = memo.get(m.userId);
    if (cached !== undefined) return cached;
    if (visiting.has(m.userId)) return false; // 循環は不正
    visiting.add(m.userId);
    const result = checkMember(m, visiting);
    visiting.delete(m.userId);
    memo.set(m.userId, result);
    return result;
  };

  const checkMember = (m: DirectoryMember, visiting: Set<string>): boolean => {
    const key = identityOf(m.userId);
    if (!key) return false;
    // 一度検証できたメンバーは、招待者が抜けたりアカウントを消したりしても検証済みのまま
    if (pinned.has(m.userId)) return true;
    if (!m.invitedBy) {
      return g.createdBy === m.userId && verifyText(key, signedText.groupCreate(g.id, m.userId), g.createSig);
    }
    if (!m.inviteCode || !m.inviteSig || !m.joinSig) return false;
    if (codeUses.get(m.inviteCode) !== 1) return false; // 同じコードで2人は参加できない
    const inviter = byUser.get(m.invitedBy);
    if (!inviter || !check(inviter, visiting)) return false;
    const inviterKey = identityOf(inviter.userId);
    if (!inviterKey) return false;
    const commit = inviteCommit(g.id, m.inviteCode);
    return (
      verifyText(inviterKey, signedText.invite(g.id, inviter.userId, commit), m.inviteSig) &&
      verifyText(key, signedText.join(m.inviteCode), m.joinSig)
    );
  };

  const verified = new Set<string>();
  for (const m of g.members) if (check(m, new Set())) verified.add(m.userId);
  return verified;
}
