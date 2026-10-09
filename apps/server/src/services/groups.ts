/**
 * グループ（近況の共有範囲）。所属はサーバが管理し、クライアントはそれを信頼する
 * （サーバを信頼する E2EE。docs/public-deployment-plan.md §5）。
 */
import type { DirectoryUser, GroupNameBox, KeyDirectory, WireGroup } from "@souieba/core";
import { type SQLWrapper, and, count, eq, exists, inArray, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Limits } from "../config.ts";
import { codeHash, newCode, newId } from "../crypto.ts";
import { type DB, MAX_BOUND_PARAMS, chunks } from "../db/index.ts";
import { type InviteRow, type MemberRow, type UserRow, agents, groupMembers, groupNameBoxes, groups, invites, users } from "../db/schema.ts";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../errors.ts";

export type { InviteRow };

export const GROUP_INVITE_TTL_MS = 3 * 86_400_000;

/** 封をしたグループ名の JSON の上限（名前は40文字まで。封と署名を足しても十分に収まる） */
const MAX_NAME_BOX_LENGTH = 2048;

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

/**
 * グループを作る。名前はサーバに送らない（作った人のクライアントが手元に覚え、自分の Agent 宛てに封をして putNameBoxes で置く）。
 */
export function createGroup(
  db: DB,
  actor: { userId: string; role: "admin" | "member" },
  opts: { createBy: "member" | "admin"; limits: Pick<Limits, "maxGroupsPerUser"> },
  now: Date,
) {
  if (opts.createBy === "admin" && actor.role !== "admin") throw forbidden("このインスタンスでは管理者だけがグループを作れます");
  return db.transaction(() => {
    requireGroupSlot(db, actor.userId, opts.limits);
    const id = newId("grp");
    const ts = now.toISOString();
    db.insert(groups).values({ id, name: "", createdBy: actor.userId, createdAt: ts }).run();
    db.insert(groupMembers).values({ groupId: id, userId: actor.userId, role: "owner", joinedAt: ts }).run();
    return { id, role: "owner" as const, nameVersion: 1, createdAt: ts };
  });
}

/** グループのメンバーの、有効で鍵のある Agent */
function memberAgentIds(db: DB, groupId: string): string[] {
  return db
    .select({ id: agents.id })
    .from(agents)
    .innerJoin(groupMembers, eq(groupMembers.userId, agents.ownerId))
    .innerJoin(users, eq(users.id, agents.ownerId))
    .where(and(eq(groupMembers.groupId, groupId), isActive, isNull(agents.revokedAt), isNotNull(agents.encKey), isNull(users.disabledAt)))
    .all()
    .map((r) => r.id);
}

function parseBox(text: string): GroupNameBox | null {
  try {
    return JSON.parse(text) as GroupNameBox;
  } catch {
    return null;
  }
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

/**
 * 自分のグループ。名前は封をしたもの（nameBoxes）だけを返す。
 * Agent トークンならその Agent 宛ての封、User トークンなら自分の Agent すべて宛ての封を返す。
 * missingAgentIds は、今の版の封をまだ持っていないメンバーの Agent。名前を読めるクライアントが封をして置く。
 */
export function listGroups(db: DB, me: { userId: string; agentId: string | null }): WireGroup[] {
  const rows = db
    .select({ id: groups.id, name: groups.name, nameVersion: groups.nameVersion, createdAt: groups.createdAt, role: groupMembers.role })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groupMembers.userId, me.userId), isActive))
    .orderBy(groupMembers.joinedAt)
    .all();
  const counts = memberCounts(
    db,
    rows.map((r) => r.id),
  );
  const myAgents = me.agentId
    ? [me.agentId]
    : db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.ownerId, me.userId))
        .all()
        .map((a) => a.id);
  return rows.map((r) => {
    const boxes = db.select().from(groupNameBoxes).where(and(eq(groupNameBoxes.groupId, r.id), eq(groupNameBoxes.version, r.nameVersion))).all();
    const have = new Set(boxes.map((b) => b.agentId));
    return {
      id: r.id,
      role: r.role,
      memberCount: counts.get(r.id) ?? 0,
      createdAt: r.createdAt,
      nameVersion: r.nameVersion,
      legacyName: r.name || null,
      nameBoxes: boxes
        .filter((b) => myAgents.includes(b.agentId))
        .map((b) => parseBox(b.box))
        .filter((b): b is GroupNameBox => !!b),
      missingAgentIds: memberAgentIds(db, r.id).filter((id) => !have.has(id)),
    };
  });
}

/** インスタンスの全グループ（admin 用）。名前は暗号化されていてサーバでは読めないので、ID と人数だけ */
export function listAllGroups(db: DB) {
  const rows = db.select().from(groups).orderBy(groups.createdAt).all();
  const counts = memberCounts(
    db,
    rows.map((g) => g.id),
  );
  return rows.map((g) => ({ id: g.id, memberCount: counts.get(g.id) ?? 0, createdAt: g.createdAt }));
}

type BoxInput = { agentId: string; box: GroupNameBox };

/** 封の宛先と中身のヘッダが、このグループの今のメンバーの Agent・今の版と合っているか */
function checkedBoxes(db: DB, groupId: string, version: number, boxes: BoxInput[]) {
  const allowed = new Set(memberAgentIds(db, groupId));
  return boxes.map(({ agentId, box }) => {
    if (!allowed.has(agentId)) throw badRequest("invalid_recipient", `${agentId} はこのグループのメンバーの Agent ではありません`);
    if (box.groupId !== groupId || box.version !== version || box.recipientAgentId !== agentId) {
      throw badRequest("invalid_name_box", "封のヘッダが宛先・グループ・版と一致しません");
    }
    const text = JSON.stringify(box);
    if (text.length > MAX_NAME_BOX_LENGTH) throw badRequest("invalid_name_box", "封が大きすぎます");
    return { agentId, text };
  });
}

function insertBoxes(db: DB, groupId: string, version: number, rows: { agentId: string; text: string }[], now: Date) {
  const values = rows.map((r) => ({ groupId, agentId: r.agentId, version, box: r.text, createdAt: now.toISOString() }));
  // 1行に5つのバインド変数を使う
  for (const batch of chunks(values, Math.floor(MAX_BOUND_PARAMS / 5))) {
    db.insert(groupNameBoxes)
      .values(batch)
      .onConflictDoUpdate({
        target: [groupNameBoxes.groupId, groupNameBoxes.agentId],
        set: { version, box: sql`excluded.box`, createdAt: sql`excluded.created_at` },
      })
      .run();
  }
}

/**
 * まだ封を持っていないメンバーの Agent に、封をしたグループ名を置く（メンバーなら誰でも。新しく入った人や Agent のため）。
 * clearPlain: 暗号化する前の平文の名前を消す（封をし直したクライアントが送る）。
 */
export function putNameBoxes(
  db: DB,
  actorId: string,
  groupId: string,
  input: { version: number; boxes: BoxInput[]; clearPlain?: boolean },
  now: Date,
): void {
  db.transaction(() => {
    requireMember(db, groupId, actorId);
    const g = db.select({ nameVersion: groups.nameVersion }).from(groups).where(eq(groups.id, groupId)).get()!;
    if (input.version !== g.nameVersion) throw conflict("stale_name_version", "グループ名が変更されています。最新の名前を取り直してください");
    insertBoxes(db, groupId, input.version, checkedBoxes(db, groupId, input.version, input.boxes), now);
    if (input.clearPlain) db.update(groups).set({ name: "" }).where(eq(groups.id, groupId)).run();
  });
}

/** グループ名の変更（owner だけ）。版を1つ上げ、古い封を消して、メンバーの Agent 宛ての新しい封に置き換える */
export function renameGroup(db: DB, actorId: string, groupId: string, input: { version: number; boxes: BoxInput[] }, now: Date): void {
  db.transaction(() => {
    if (requireMember(db, groupId, actorId).role !== "owner") throw forbidden("owner だけがグループ名を変更できます");
    const g = db.select({ nameVersion: groups.nameVersion }).from(groups).where(eq(groups.id, groupId)).get()!;
    if (input.version !== g.nameVersion + 1) throw conflict("stale_name_version", "グループ名が変更されています。最新の名前を取り直してください");
    const rows = checkedBoxes(db, groupId, input.version, input.boxes);
    db.delete(groupNameBoxes).where(eq(groupNameBoxes.groupId, groupId)).run();
    db.update(groups).set({ name: "", nameVersion: input.version }).where(eq(groups.id, groupId)).run();
    insertBoxes(db, groupId, input.version, rows, now);
  });
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

/** 招待コードから作った鍵で封をしたグループ名を、自分が発行した未使用の招待に添える（招待案 1。#16） */
export function setInviteNameBox(db: DB, userId: string, groupId: string, input: { code: string; box: string }): void {
  requireMember(db, groupId, userId);
  if (input.box.length > MAX_NAME_BOX_LENGTH) throw badRequest("invalid_name_box", "封が大きすぎます");
  const r = db
    .update(invites)
    .set({ nameBox: input.box })
    .where(and(eq(invites.codeHash, codeHash(input.code)), eq(invites.groupId, groupId), eq(invites.createdBy, userId), isNull(invites.usedAt)))
    .returning({ id: invites.id })
    .get();
  if (!r) throw notFound("招待");
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

  const g = db.select({ id: groups.id, name: groups.name, nameVersion: groups.nameVersion }).from(groups).where(eq(groups.id, inv.groupId)).get()!;
  // 名前はサーバでは読めない。招待者が添えた封（招待コードで開く）か、暗号化する前の平文の名前を返す
  const group = { id: g.id, nameVersion: g.nameVersion, legacyName: g.name || null, nameBox: inv.nameBox ?? null };
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
