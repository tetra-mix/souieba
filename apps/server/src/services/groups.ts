/**
 * グループ（近況の共有範囲）。所属はサーバが管理し、クライアントはそれを信頼する
 * （サーバを信頼する E2EE。docs/public-deployment-plan.md §5）。
 */
import type { DirectoryUser, KeyDirectory } from "@souieba/core";
import { type SQLWrapper, and, count, eq, exists, inArray, isNotNull, isNull, notExists, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Limits } from "../config.ts";
import { codeHash, newCode, newId } from "../crypto.ts";
import { type DB, MAX_BOUND_PARAMS, chunks } from "../db/index.ts";
import { type InviteRow, type MemberRow, type UserRow, agents, groupMembers, groups, invites, users } from "../db/schema.ts";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../errors.ts";

export type { InviteRow };

export const GROUP_INVITE_TTL_MS = 3 * 86_400_000;

function validateName(name: string): string {
  const n = name.trim();
  if (n.length < 1 || n.length > 40) throw badRequest("invalid_group_name", "グループ名は1〜40文字にしてください");
  return n;
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
  input: { name: string },
  opts: { createBy: "member" | "admin"; limits: Pick<Limits, "maxGroupsPerUser"> },
  now: Date,
) {
  if (opts.createBy === "admin" && actor.role !== "admin") throw forbidden("このインスタンスでは管理者だけがグループを作れます");
  const name = validateName(input.name);
  return db.transaction(() => {
    requireGroupSlot(db, actor.userId, opts.limits);
    const id = newId("grp");
    const ts = now.toISOString();
    db.insert(groups).values({ id, name, createdBy: actor.userId, createdAt: ts }).run();
    db.insert(groupMembers).values({ groupId: id, userId: actor.userId, role: "owner", joinedAt: ts }).run();
    return { id, name, role: "owner" as const, createdAt: ts };
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

/** グループへの招待コードを発行する（1回限り）。サーバはハッシュだけを保存する */
export function createGroupInvite(
  db: DB,
  userId: string,
  groupId: string,
  opts: { inviteBy: "member" | "admin" },
  now: Date,
): { code: string; expiresAt: string } {
  const m = requireMember(db, groupId, userId);
  if (opts.inviteBy === "admin" && m.role !== "owner") throw forbidden("このインスタンスでは owner だけが招待できます");
  const code = newCode();
  const expiresAt = new Date(now.getTime() + GROUP_INVITE_TTL_MS).toISOString();
  db.insert(invites)
    .values({
      id: newId("inv"),
      codeHash: codeHash(code),
      kind: "invite",
      createdBy: userId,
      autoFriend: 0,
      expiresAt,
      createdAt: now.toISOString(),
      groupId,
    })
    .run();
  return { code, expiresAt };
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

/** 招待コードでグループに参加する（トランザクションの中で呼ぶ） */
export function joinWithInvite(
  db: DB,
  inv: InviteRow,
  user: Pick<UserRow, "id" | "displayName">,
  now: Date,
  limits: Pick<Limits, "maxGroupMembers" | "maxGroupsPerUser">,
) {
  if (!inv.groupId || !inv.createdBy) throw invalidCode();
  // 招待者が抜けていたら、そのコードはもう使えない
  if (!activeMember(db, inv.groupId, inv.createdBy)) throw invalidCode();
  if (activeMember(db, inv.groupId, user.id)) throw conflict("already_member", "すでにこのグループのメンバーです");
  if (activeMemberCount(db, inv.groupId) >= limits.maxGroupMembers) {
    throw conflict("limit_group_members", `このグループの人数が上限（${limits.maxGroupMembers} 人）に達しています`);
  }
  requireGroupSlot(db, user.id, limits);

  const ts = now.toISOString();
  const membership = { role: "member" as const, invitedBy: inv.createdBy, joinedAt: ts };
  // 一度抜けた人が入り直すときは、前の行を上書きする
  db.insert(groupMembers)
    .values({ groupId: inv.groupId, userId: user.id, ...membership })
    .onConflictDoUpdate({ target: [groupMembers.groupId, groupMembers.userId], set: { ...membership, leftAt: null } })
    .run();
  db.update(invites).set({ usedBy: user.id, usedAt: ts }).where(eq(invites.id, inv.id)).run();

  const group = db.select({ id: groups.id, name: groups.name }).from(groups).where(eq(groups.id, inv.groupId)).get()!;
  const inviter = db
    .select({ id: users.id, handle: users.handle, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, inv.createdBy))
    .get()!;
  return { group, inviter };
}

/** グループの今のメンバー */
export function listMembers(db: DB, userId: string, groupId: string) {
  requireMember(db, groupId, userId);
  return db
    .select({ userId: users.id, handle: users.handle, displayName: users.displayName, role: groupMembers.role, joinedAt: groupMembers.joinedAt })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, groupId), isActive))
    .orderBy(groupMembers.joinedAt)
    .all();
}

/** 抜ける（本人）・外す（owner）。行は left_at を付けて残す */
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
 * 公開鍵ディレクトリ。自分と、今いっしょにいるグループがあるユーザーの、有効な Agent の鍵を返す。
 * クライアントはこれをそのまま投稿の宛先・受信した投稿の検証に使う。
 */
export function directory(db: DB, me: { userId: string; agentId: string | null }): KeyDirectory {
  const coMembers = db
    .select({ id: users.id })
    .from(users)
    .where(and(isNull(users.disabledAt), or(eq(users.id, me.userId), sharesGroup(db, me.userId, users.id))))
    .all();
  // 同じ人の Agent は同じ塊に入るので、塊ごとの createdAt の順がそのまま使える
  const batches = chunks(
    coMembers.map((u) => u.id),
    MAX_BOUND_PARAMS,
  );
  const userRows = batches.flatMap((ids) =>
    db
      .select({ id: users.id, handle: users.handle, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, ids))
      .all(),
  );
  const agentRows = batches.flatMap((ids) =>
    db
      .select({ id: agents.id, ownerId: agents.ownerId, name: agents.name, encKey: agents.encKey, signKey: agents.signKey, createdAt: agents.createdAt })
      .from(agents)
      .where(and(inArray(agents.ownerId, ids), isNull(agents.revokedAt), isNotNull(agents.encKey)))
      .orderBy(agents.createdAt)
      .all(),
  );
  // 自分のグループのメンバー。新しいメンバーが入ったことを、クライアントが主人に知らせるために使う
  const shared = db
    .select({ groupId: groupMembers.groupId, userId: groupMembers.userId })
    .from(groupMembers)
    .where(
      and(
        isActive,
        inArray(
          groupMembers.groupId,
          db
            .select({ id: groupMembers.groupId })
            .from(groupMembers)
            .where(and(eq(groupMembers.userId, me.userId), isActive)),
        ),
      ),
    )
    .all();
  const directoryUsers: DirectoryUser[] = userRows.map((u) => ({
    ...u,
    groupIds: shared.filter((m) => m.userId === u.id).map((m) => m.groupId),
    agents: agentRows
      .filter((a) => a.ownerId === u.id)
      .map((a) => ({ id: a.id, name: a.name, encKey: a.encKey!, signKey: a.signKey!, createdAt: a.createdAt })),
  }));
  return { me, users: directoryUsers };
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
