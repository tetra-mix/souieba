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
import { type SQLWrapper, and, count, eq, exists, inArray, isNotNull, isNull, notExists, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Limits } from "../config.ts";
import { codeHash, newId } from "../crypto.ts";
import { type DB, MAX_BOUND_PARAMS, chunks } from "../db/index.ts";
import { type InviteRow, type MemberRow, agents, groupMembers, groups, invites, users } from "../db/schema.ts";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../errors.ts";

export type { InviteRow };

export const GROUP_ID_RE = /^grp_[A-Za-z0-9_-]{16,64}$/;
export const GROUP_INVITE_TTL_MS = 3 * 86_400_000;

function validateName(name: string): string {
  const n = name.trim();
  if (n.length < 1 || n.length > 40) throw badRequest("invalid_group_name", "グループ名は1〜40文字にしてください");
  return n;
}

function identityKeyOf(db: DB, userId: string): string {
  const row = db.select({ identityKey: users.identityKey }).from(users).where(eq(users.id, userId)).get();
  if (!row?.identityKey) throw conflict("identity_required", "Identity 鍵が未登録です。CLI を更新して login し直してください");
  return row.identityKey;
}

/** 今グループにいる（抜けていない）メンバー */
const isActive = isNull(groupMembers.leftAt);

function activeMember(db: DB, groupId: string, userId: string): MemberRow | undefined {
  return db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId), isActive))
    .get();
}

function activeMemberCount(db: DB, groupId: string): number {
  return db
    .select({ n: count() })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), isActive))
    .get()!.n;
}

function requireGroupSlot(db: DB, userId: string, limits: Pick<Limits, "maxGroupsPerUser">): void {
  const n = db
    .select({ n: count() })
    .from(groupMembers)
    .where(and(eq(groupMembers.userId, userId), isActive))
    .get()!.n;
  if (n >= limits.maxGroupsPerUser) {
    throw conflict("limit_groups_per_user", `1人が入れるグループは ${limits.maxGroupsPerUser} 個までです`);
  }
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
  opts: { createBy: "member" | "admin"; limits: Pick<Limits, "maxGroupsPerUser"> },
  now: Date,
) {
  if (opts.createBy === "admin" && actor.role !== "admin") throw forbidden("このインスタンスでは管理者だけがグループを作れます");
  if (!GROUP_ID_RE.test(input.id)) throw badRequest("invalid_group_id", "グループ ID の形式が不正です");
  const name = validateName(input.name);
  const key = identityKeyOf(db, actor.userId);
  if (!verifyText(key, signedText.groupCreate(input.id, actor.userId), input.createSig)) {
    throw badRequest("invalid_signature", "作成の署名を検証できません");
  }
  return db.transaction(() => {
    if (db.select({ id: groups.id }).from(groups).where(eq(groups.id, input.id)).get()) {
      throw conflict("group_exists", "その ID のグループはすでにあります");
    }
    requireGroupSlot(db, actor.userId, opts.limits);
    const ts = now.toISOString();
    db.insert(groups).values({ id: input.id, name, createdBy: actor.userId, createSig: input.createSig, createdAt: ts }).run();
    db.insert(groupMembers).values({ groupId: input.id, userId: actor.userId, role: "owner", joinedAt: ts }).run();
    return { id: input.id, name, role: "owner" as const, createdAt: ts };
  });
}

/** グループごとの今の人数 */
function memberCounts(db: DB, groupIds: string[]): Map<string, number> {
  const rows = chunks(groupIds, MAX_BOUND_PARAMS).flatMap((batch) =>
    db
      .select({ groupId: groupMembers.groupId, n: count() })
      .from(groupMembers)
      .where(and(inArray(groupMembers.groupId, batch), isActive))
      .groupBy(groupMembers.groupId)
      .all(),
  );
  return new Map(rows.map((r) => [r.groupId, r.n]));
}

export function listGroups(db: DB, userId: string) {
  const rows = db
    .select({ id: groups.id, name: groups.name, createdAt: groups.createdAt, role: groupMembers.role })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groupMembers.userId, userId), isActive))
    .orderBy(groupMembers.joinedAt)
    .all();
  const counts = memberCounts(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, memberCount: counts.get(r.id) ?? 0, createdAt: r.createdAt }));
}

/** インスタンスの全グループ（admin 用）。名前と人数だけで、投稿本文はサーバでは読めない */
export function listAllGroups(db: DB) {
  const rows = db.select().from(groups).orderBy(groups.createdAt).all();
  const counts = memberCounts(
    db,
    rows.map((g) => g.id),
  );
  return rows.map((g) => ({ id: g.id, name: g.name, memberCount: counts.get(g.id) ?? 0, createdAt: g.createdAt }));
}

export function renameGroup(db: DB, userId: string, groupId: string, name: string): void {
  if (requireMember(db, groupId, userId).role !== "owner") throw forbidden("owner だけがグループ名を変更できます");
  db.update(groups)
    .set({ name: validateName(name) })
    .where(eq(groups.id, groupId))
    .run();
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
  const inserted = db
    .insert(invites)
    .values({
      id: newId("inv"),
      codeHash: input.codeHash,
      kind: "invite",
      createdBy: userId,
      autoFriend: 0,
      expiresAt,
      createdAt: now.toISOString(),
      groupId,
      inviteCommit: input.commit,
      inviteSig: input.inviteSig,
    })
    .onConflictDoNothing({ target: invites.codeHash })
    .returning({ id: invites.id })
    .all();
  if (inserted.length === 0) throw conflict("invite_exists", "同じコードがすでに登録されています");
  return { expiresAt };
}

const invalidCode = () => new ApiError(400, "invalid_code", "コードが無効か、期限が切れています");

export function findUsableInvite(db: DB, code: string, now: Date): InviteRow {
  const inv = db
    .select()
    .from(invites)
    .where(eq(invites.codeHash, codeHash(code)))
    .get();
  if (!inv || inv.usedAt || inv.expiresAt < now.toISOString()) throw invalidCode();
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
  limits: Pick<Limits, "maxGroupMembers" | "maxGroupsPerUser">,
) {
  if (!inv.groupId || !inv.createdBy || !inv.inviteSig) throw invalidCode();
  const code = normalizeCode(input.code);
  if (code.replaceAll("-", "").length !== GROUP_INVITE_CODE_LENGTH) throw invalidCode();
  if (!input.joinSig || !verifyText(input.identityKey, signedText.join(code), input.joinSig)) {
    throw badRequest("invalid_signature", "参加の署名を検証できません");
  }
  // 招待者が抜けていたら、そのコードはもう使えない
  if (!activeMember(db, inv.groupId, inv.createdBy)) throw invalidCode();
  if (activeMember(db, inv.groupId, input.userId)) throw conflict("already_member", "すでにこのグループのメンバーです");
  if (activeMemberCount(db, inv.groupId) >= limits.maxGroupMembers) {
    throw conflict("limit_group_members", `このグループの人数が上限（${limits.maxGroupMembers} 人）に達しています`);
  }
  requireGroupSlot(db, input.userId, limits);

  const ts = now.toISOString();
  const membership = {
    role: "member" as const,
    invitedBy: inv.createdBy,
    inviteCode: code,
    inviteSig: inv.inviteSig,
    joinSig: input.joinSig,
    joinedAt: ts,
  };
  // 一度抜けた人が入り直すときは、前の行を新しい証明で上書きする
  db.insert(groupMembers)
    .values({ groupId: inv.groupId, userId: input.userId, ...membership })
    .onConflictDoUpdate({ target: [groupMembers.groupId, groupMembers.userId], set: { ...membership, leftAt: null } })
    .run();
  db.update(invites).set({ usedBy: input.userId, usedAt: ts }).where(eq(invites.id, inv.id)).run();

  const group = db.select({ id: groups.id, name: groups.name }).from(groups).where(eq(groups.id, inv.groupId)).get()!;
  const inviter = db
    .select({ id: users.id, handle: users.handle, displayName: users.displayName, identityKey: users.identityKey })
    .from(users)
    .where(eq(users.id, inv.createdBy))
    .get()!;
  return { group, inviter: { ...inviter, identityKey: inviter.identityKey! } };
}

/** 抜ける（本人）・外す（owner）。行は left_at を付けて残す（その人が招待した人の証明を検証するため） */
export function removeMember(db: DB, actorId: string, groupId: string, targetId: string, now: Date): void {
  db.transaction(() => {
    const actor = requireMember(db, groupId, actorId);
    if (actorId !== targetId && actor.role !== "owner") throw forbidden("owner だけがメンバーを外せます");
    if (!activeMember(db, groupId, targetId)) throw notFound("メンバー");
    db.update(groupMembers)
      .set({ leftAt: now.toISOString(), role: "member" })
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, targetId)))
      .run();
    const rest = db
      .select({ userId: groupMembers.userId, role: groupMembers.role })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), isActive))
      .orderBy(groupMembers.joinedAt)
      .all();
    if (rest.length === 0) {
      db.delete(groups).where(eq(groups.id, groupId)).run();
    } else if (!rest.some((r) => r.role === "owner")) {
      db.update(groupMembers)
        .set({ role: "owner" })
        .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, rest[0]!.userId)))
        .run();
    }
  });
}

/** メンバーがいなくなったグループを消す（アカウント削除の後など） */
export function deleteEmptyGroups(db: DB): void {
  db.delete(groups)
    .where(
      notExists(
        db
          .select({ userId: groupMembers.userId })
          .from(groupMembers)
          .where(and(eq(groupMembers.groupId, groups.id), isActive)),
      ),
    )
    .run();
}

/**
 * 公開鍵ディレクトリ。自分が所属するグループと、そのメンバー（抜けた人を含む）の
 * Identity 鍵・有効な Agent の鍵を返す。
 */
export function directory(db: DB, me: { userId: string; agentId: string | null }): KeyDirectory {
  const groupRows = db
    .select({ id: groups.id, name: groups.name, createdBy: groups.createdBy, createSig: groups.createSig })
    .from(groups)
    .innerJoin(groupMembers, eq(groupMembers.groupId, groups.id))
    .where(and(eq(groupMembers.userId, me.userId), isActive))
    .orderBy(groupMembers.joinedAt)
    .all();

  const userIds = new Set<string>([me.userId]);
  const result: DirectoryGroup[] = groupRows.map((g) => {
    const members = db.select().from(groupMembers).where(eq(groupMembers.groupId, g.id)).orderBy(groupMembers.joinedAt).all();
    for (const m of members) userIds.add(m.userId);
    return {
      ...g,
      members: members.map((m) => ({
        userId: m.userId,
        role: m.role,
        invitedBy: m.invitedBy,
        inviteCode: m.inviteCode,
        inviteSig: m.inviteSig,
        joinSig: m.joinSig,
        joinedAt: m.joinedAt,
        leftAt: m.leftAt,
      })),
    };
  });

  // 同じ人の Agent は同じ塊に入るので、塊ごとの createdAt の順がそのまま使える
  const batches = chunks([...userIds], MAX_BOUND_PARAMS);
  const userRows = batches.flatMap((ids) =>
    db
      .select({ id: users.id, handle: users.handle, displayName: users.displayName, identityKey: users.identityKey })
      .from(users)
      .where(and(inArray(users.id, ids), isNull(users.disabledAt)))
      .all(),
  );
  const agentRows = batches.flatMap((ids) =>
    db
      .select({
        id: agents.id,
        ownerId: agents.ownerId,
        name: agents.name,
        encKey: agents.encKey,
        signKey: agents.signKey,
        cert: agents.cert,
      })
      .from(agents)
      .where(and(inArray(agents.ownerId, ids), isNull(agents.revokedAt), isNotNull(agents.encKey)))
      .orderBy(agents.createdAt)
      .all(),
  );

  const directoryUsers: DirectoryUser[] = userRows.map((u) => ({
    ...u,
    agents: agentRows
      .filter((a) => a.ownerId === u.id)
      .map((a) => ({ id: a.id, name: a.name, encKey: a.encKey!, signKey: a.signKey!, cert: a.cert! })),
  }));
  return { me, users: directoryUsers, groups: result };
}

/** 2人のユーザーが、今いっしょにいるグループがあるか（相関サブクエリ用） */
export function sharesGroup(db: DB, a: string | SQLWrapper, b: string | SQLWrapper) {
  const x = alias(groupMembers, "x");
  const y = alias(groupMembers, "y");
  return exists(
    db
      .select({ groupId: x.groupId })
      .from(x)
      .innerJoin(y, eq(x.groupId, y.groupId))
      .where(and(eq(x.userId, a), eq(y.userId, b), isNull(x.leftAt), isNull(y.leftAt))),
  );
}

/** 投稿の宛先として認める Agent: 自分の有効な Agent ＋（groups なら）同じグループにいるユーザーの有効な Agent */
export function allowedRecipientAgents(db: DB, ownerId: string, visibility: "groups" | "private"): Set<string> {
  const usable = and(isNull(agents.revokedAt), isNotNull(agents.encKey));
  const rows =
    visibility === "private"
      ? db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.ownerId, ownerId), usable))
          .all()
      : db
          .select({ id: agents.id })
          .from(agents)
          .innerJoin(users, eq(users.id, agents.ownerId))
          .where(and(usable, isNull(users.disabledAt), or(eq(agents.ownerId, ownerId), sharesGroup(db, ownerId, agents.ownerId))))
          .all();
  return new Set(rows.map((r) => r.id));
}
