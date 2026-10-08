/**
 * グループ（近況の共有範囲）。所属の証明（作成・招待・参加の署名）を保存して配るが、
 * それを信頼の根拠にするのはクライアント側（core/trust.ts）。サーバは形式と署名を確かめて
 * ゴミを入れないようにするだけ。
 */
import {
  type DirectoryGroup,
  type DirectoryUser,
  GROUP_INVITE_CODE_LENGTH,
  type KeyDirectory,
  normalizeCode,
  signedText,
  verifyText,
} from "@souieba/core";
import { codeHash, newId } from "../crypto.ts";
import { type DB, tx } from "../db.ts";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../errors.ts";

export const GROUP_ID_RE = /^grp_[A-Za-z0-9_-]{16,64}$/;
export const GROUP_INVITE_TTL_MS = 3 * 86_400_000;

type GroupRow = { id: string; name: string; created_by: string | null; create_sig: string; created_at: string };

type MemberRow = {
  group_id: string;
  user_id: string;
  role: "owner" | "member";
  invited_by: string | null;
  invite_code: string | null;
  invite_sig: string | null;
  join_sig: string | null;
  joined_at: string;
  left_at: string | null;
};

function validateName(name: string): string {
  const n = name.trim();
  if (n.length < 1 || n.length > 40) throw badRequest("invalid_group_name", "グループ名は1〜40文字にしてください");
  return n;
}

function identityKeyOf(db: DB, userId: string): string {
  const row = db.prepare("SELECT identity_key FROM users WHERE id = ?").get(userId) as { identity_key: string | null } | undefined;
  if (!row?.identity_key) throw conflict("identity_required", "Identity 鍵が未登録です。CLI を更新して login し直してください");
  return row.identity_key;
}

function activeMember(db: DB, groupId: string, userId: string): MemberRow | undefined {
  return db.prepare("SELECT * FROM group_members WHERE group_id = ? AND user_id = ? AND left_at IS NULL").get(groupId, userId) as
    | MemberRow
    | undefined;
}

function requireMember(db: DB, groupId: string, userId: string): MemberRow {
  const m = activeMember(db, groupId, userId);
  // 所属していないグループは、存在するかどうかも見せない
  if (!m) throw notFound("グループ");
  return m;
}

export function createGroup(
  db: DB,
  actor: { userId: string; role: "admin" | "member" },
  input: { id: string; name: string; createSig: string },
  opts: { createBy: "member" | "admin" },
  now: Date,
) {
  if (opts.createBy === "admin" && actor.role !== "admin") throw forbidden("このインスタンスでは管理者だけがグループを作れます");
  if (!GROUP_ID_RE.test(input.id)) throw badRequest("invalid_group_id", "グループ ID の形式が不正です");
  const name = validateName(input.name);
  const key = identityKeyOf(db, actor.userId);
  if (!verifyText(key, signedText.groupCreate(input.id, actor.userId), input.createSig)) {
    throw badRequest("invalid_signature", "作成の署名を検証できません");
  }
  return tx(db, () => {
    if (db.prepare("SELECT 1 FROM groups WHERE id = ?").get(input.id)) throw conflict("group_exists", "その ID のグループはすでにあります");
    const ts = now.toISOString();
    db.prepare("INSERT INTO groups (id, name, created_by, create_sig, created_at) VALUES (?, ?, ?, ?, ?)").run(
      input.id,
      name,
      actor.userId,
      input.createSig,
      ts,
    );
    db.prepare("INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(input.id, actor.userId, ts);
    return { id: input.id, name, role: "owner" as const, createdAt: ts };
  });
}

export function listGroups(db: DB, userId: string) {
  const rows = db
    .prepare(
      `SELECT g.id, g.name, g.created_at, m.role,
              (SELECT count(*) FROM group_members x WHERE x.group_id = g.id AND x.left_at IS NULL) AS member_count
       FROM group_members m JOIN groups g ON g.id = m.group_id
       WHERE m.user_id = ? AND m.left_at IS NULL ORDER BY m.joined_at`,
    )
    .all(userId) as { id: string; name: string; created_at: string; role: string; member_count: number }[];
  return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, memberCount: Number(r.member_count), createdAt: r.created_at }));
}

export function renameGroup(db: DB, userId: string, groupId: string, name: string): void {
  if (requireMember(db, groupId, userId).role !== "owner") throw forbidden("owner だけがグループ名を変更できます");
  db.prepare("UPDATE groups SET name = ? WHERE id = ?").run(validateName(name), groupId);
}

/**
 * 招待コードの登録。コードは招待者のクライアントが生成し、サーバには
 * codeHash（照合用）と commit・署名（所属の証明用）だけを送る。
 */
export function createGroupInvite(
  db: DB,
  userId: string,
  groupId: string,
  input: { codeHash: string; commit: string; inviteSig: string },
  opts: { inviteBy: "member" | "admin" },
  now: Date,
): { expiresAt: string } {
  const m = requireMember(db, groupId, userId);
  if (opts.inviteBy === "admin" && m.role !== "owner") throw forbidden("このインスタンスでは owner だけが招待できます");
  if (!/^[0-9a-f]{64}$/.test(input.codeHash)) throw badRequest("invalid_code_hash", "codeHash の形式が不正です");
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.commit)) throw badRequest("invalid_commit", "commit の形式が不正です");
  if (!verifyText(identityKeyOf(db, userId), signedText.invite(groupId, userId, input.commit), input.inviteSig)) {
    throw badRequest("invalid_signature", "招待の署名を検証できません");
  }
  const expiresAt = new Date(now.getTime() + GROUP_INVITE_TTL_MS).toISOString();
  try {
    db.prepare(
      `INSERT INTO invites (id, code_hash, kind, created_by, auto_friend, expires_at, created_at, group_id, invite_commit, invite_sig)
       VALUES (?, ?, 'invite', ?, 0, ?, ?, ?, ?, ?)`,
    ).run(newId("inv"), input.codeHash, userId, expiresAt, now.toISOString(), groupId, input.commit, input.inviteSig);
  } catch {
    throw conflict("invite_exists", "同じコードがすでに登録されています");
  }
  return { expiresAt };
}

export type InviteRow = {
  id: string;
  kind: "invite" | "login";
  created_by: string | null;
  target_user_id: string | null;
  expires_at: string;
  used_at: string | null;
  group_id: string | null;
  invite_commit: string | null;
  invite_sig: string | null;
};

const invalidCode = () => new ApiError(400, "invalid_code", "コードが無効か、期限が切れています");

export function findUsableInvite(db: DB, code: string, now: Date): InviteRow {
  const inv = db.prepare("SELECT * FROM invites WHERE code_hash = ?").get(codeHash(code)) as InviteRow | undefined;
  if (!inv || inv.used_at || inv.expires_at < now.toISOString()) throw invalidCode();
  return inv;
}

/**
 * 招待コードでグループに参加する（トランザクションの中で呼ぶ）。
 * 使用済みのコードは所属の証明として保存し、他のメンバーに配る。
 */
export function joinWithInvite(
  db: DB,
  inv: InviteRow,
  input: { userId: string; identityKey: string; code: string; joinSig: string | undefined },
  now: Date,
) {
  if (!inv.group_id || !inv.created_by || !inv.invite_sig) throw invalidCode();
  const code = normalizeCode(input.code);
  if (code.replaceAll("-", "").length !== GROUP_INVITE_CODE_LENGTH) throw invalidCode();
  if (!input.joinSig || !verifyText(input.identityKey, signedText.join(code), input.joinSig)) {
    throw badRequest("invalid_signature", "参加の署名を検証できません");
  }
  // 招待者が抜けていたら、そのコードはもう使えない
  if (!activeMember(db, inv.group_id, inv.created_by)) throw invalidCode();
  if (activeMember(db, inv.group_id, input.userId)) throw conflict("already_member", "すでにこのグループのメンバーです");

  const ts = now.toISOString();
  db.prepare(
    `INSERT INTO group_members (group_id, user_id, role, invited_by, invite_code, invite_sig, join_sig, joined_at)
     VALUES (?, ?, 'member', ?, ?, ?, ?, ?)
     ON CONFLICT (group_id, user_id) DO UPDATE SET
       role = 'member', invited_by = excluded.invited_by, invite_code = excluded.invite_code,
       invite_sig = excluded.invite_sig, join_sig = excluded.join_sig, joined_at = excluded.joined_at, left_at = NULL`,
  ).run(inv.group_id, input.userId, inv.created_by, code, inv.invite_sig, input.joinSig, ts);
  db.prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE id = ?").run(input.userId, ts, inv.id);

  const group = db.prepare("SELECT id, name FROM groups WHERE id = ?").get(inv.group_id) as { id: string; name: string };
  const inviter = db.prepare("SELECT id, handle, display_name, identity_key FROM users WHERE id = ?").get(inv.created_by) as {
    id: string;
    handle: string;
    display_name: string;
    identity_key: string;
  };
  return {
    group: { id: group.id, name: group.name },
    inviter: { id: inviter.id, handle: inviter.handle, displayName: inviter.display_name, identityKey: inviter.identity_key },
  };
}

/** 抜ける（本人）・外す（owner）。行は left_at を付けて残す（その人が招待した人の証明を検証するため） */
export function removeMember(db: DB, actorId: string, groupId: string, targetId: string, now: Date): void {
  tx(db, () => {
    const actor = requireMember(db, groupId, actorId);
    if (actorId !== targetId && actor.role !== "owner") throw forbidden("owner だけがメンバーを外せます");
    const target = activeMember(db, groupId, targetId);
    if (!target) throw notFound("メンバー");
    db.prepare("UPDATE group_members SET left_at = ?, role = 'member' WHERE group_id = ? AND user_id = ?").run(
      now.toISOString(),
      groupId,
      targetId,
    );
    const rest = db
      .prepare("SELECT user_id, role FROM group_members WHERE group_id = ? AND left_at IS NULL ORDER BY joined_at")
      .all(groupId) as { user_id: string; role: string }[];
    if (rest.length === 0) {
      db.prepare("DELETE FROM groups WHERE id = ?").run(groupId);
    } else if (!rest.some((r) => r.role === "owner")) {
      db.prepare("UPDATE group_members SET role = 'owner' WHERE group_id = ? AND user_id = ?").run(groupId, rest[0]!.user_id);
    }
  });
}

/** メンバーがいなくなったグループを消す（アカウント削除の後など） */
export function deleteEmptyGroups(db: DB): void {
  db.prepare("DELETE FROM groups WHERE NOT EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = groups.id AND m.left_at IS NULL)").run();
}

/**
 * 公開鍵ディレクトリ。自分が所属するグループと、そのメンバー（抜けた人を含む）の
 * Identity 鍵・有効な Agent の鍵を返す。
 */
export function directory(db: DB, me: { userId: string; agentId: string | null }): KeyDirectory {
  const groupRows = db
    .prepare(
      `SELECT g.* FROM groups g JOIN group_members m ON m.group_id = g.id
       WHERE m.user_id = ? AND m.left_at IS NULL ORDER BY m.joined_at`,
    )
    .all(me.userId) as GroupRow[];

  const userIds = new Set<string>([me.userId]);
  const groups: DirectoryGroup[] = groupRows.map((g) => {
    const members = db.prepare("SELECT * FROM group_members WHERE group_id = ? ORDER BY joined_at").all(g.id) as MemberRow[];
    for (const m of members) userIds.add(m.user_id);
    return {
      id: g.id,
      name: g.name,
      createdBy: g.created_by,
      createSig: g.create_sig,
      members: members.map((m) => ({
        userId: m.user_id,
        role: m.role,
        invitedBy: m.invited_by,
        inviteCode: m.invite_code,
        inviteSig: m.invite_sig,
        joinSig: m.join_sig,
        joinedAt: m.joined_at,
        leftAt: m.left_at,
      })),
    };
  });

  const ids = [...userIds];
  const placeholders = ids.map(() => "?").join(",");
  const users = db
    .prepare(`SELECT id, handle, display_name, identity_key FROM users WHERE id IN (${placeholders}) AND disabled_at IS NULL`)
    .all(...ids) as { id: string; handle: string; display_name: string; identity_key: string | null }[];
  const agents = db
    .prepare(
      `SELECT id, owner_id, name, enc_key, sign_key, cert FROM agents
       WHERE owner_id IN (${placeholders}) AND revoked_at IS NULL AND enc_key IS NOT NULL ORDER BY created_at`,
    )
    .all(...ids) as { id: string; owner_id: string; name: string; enc_key: string; sign_key: string; cert: string }[];

  const result: DirectoryUser[] = users.map((u) => ({
    id: u.id,
    handle: u.handle,
    displayName: u.display_name,
    identityKey: u.identity_key,
    agents: agents
      .filter((a) => a.owner_id === u.id)
      .map((a) => ({ id: a.id, name: a.name, encKey: a.enc_key, signKey: a.sign_key, cert: a.cert })),
  }));
  return { me, users: result, groups };
}

/** 投稿の宛先として認める Agent: 自分の有効な Agent ＋（groups なら）同じグループにいるユーザーの有効な Agent */
export function allowedRecipientAgents(db: DB, ownerId: string, visibility: "groups" | "private"): Set<string> {
  const rows = db
    .prepare(
      visibility === "private"
        ? "SELECT id FROM agents WHERE owner_id = :me AND revoked_at IS NULL AND enc_key IS NOT NULL"
        : `SELECT a.id FROM agents a JOIN users u ON u.id = a.owner_id
           WHERE a.revoked_at IS NULL AND a.enc_key IS NOT NULL AND u.disabled_at IS NULL
             AND (a.owner_id = :me OR EXISTS (
               SELECT 1 FROM group_members x JOIN group_members y ON x.group_id = y.group_id
               WHERE x.user_id = :me AND y.user_id = a.owner_id AND x.left_at IS NULL AND y.left_at IS NULL))`,
    )
    .all({ me: ownerId }) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}
