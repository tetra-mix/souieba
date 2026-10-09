import { AGENT_SCOPES, isPublicKey } from "@souieba/core";
import { and, count, eq, isNull, ne } from "drizzle-orm";
import type { Limits } from "../config.ts";
import { newCode, newId, newToken, sha256 } from "../crypto.ts";
import type { DB } from "../db/index.ts";
import { type AgentRow, type UserRow, agents, credentials, invites, users } from "../db/schema.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { deleteEmptyGroups, displayNameTakenAmongCoMembers, findUsableInvite, joinWithInvite } from "./groups.ts";

export type { AgentRow, UserRow };

export const HANDLE_RE = /^[a-z0-9_]{2,20}$/;
const ACCOUNT_INVITE_TTL_MS = 3 * 86_400_000;
const LOGIN_CODE_TTL_MS = 15 * 60_000;

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    handle: u.handle,
    displayName: u.displayName,
    role: u.role,
    createdAt: u.createdAt,
  };
}

export function getUser(db: DB, id: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

export function getUserByHandle(db: DB, handle: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.handle, handle)).get();
}

export function validateDisplayName(displayName: string): string {
  const name = displayName.trim();
  if (name.length < 1 || name.length > 40) throw badRequest("invalid_display_name", "表示名は1〜40文字にしてください");
  return name;
}

function validateProfile(handle: string, displayName: string) {
  if (!HANDLE_RE.test(handle)) throw badRequest("invalid_handle", "handle は英小文字・数字・_ の2〜20文字にしてください");
  return validateDisplayName(displayName);
}

export function createUser(
  db: DB,
  input: { handle: string; displayName: string; role?: "admin" | "member" },
  now: Date,
  limits?: Pick<Limits, "maxUsers">,
): UserRow {
  const displayName = validateProfile(input.handle, input.displayName);
  if (getUserByHandle(db, input.handle)) throw conflict("handle_taken", "その handle は使われています");
  // 無効化したユーザーは数えない（無効化すれば枠が空く）
  if (limits && db.select({ n: count() }).from(users).where(isNull(users.disabledAt)).get()!.n >= limits.maxUsers) {
    throw conflict("limit_users", "このインスタンスのユーザー数が上限に達しています。管理者に連絡してください");
  }
  return db
    .insert(users)
    .values({
      id: newId("usr"),
      handle: input.handle,
      displayName,
      role: input.role ?? "member",
      createdAt: now.toISOString(),
    })
    .returning()
    .get();
}

/**
 * 表示名の変更。Tell 文（「あ、そういえば○○さん、…」）で人を見分けられるよう、
 * いっしょにいるグループのメンバーと同じ表示名にはできない。
 */
export function setDisplayName(db: DB, userId: string, displayName: string): UserRow {
  const name = validateDisplayName(displayName);
  return db.transaction(() => {
    if (displayNameTakenAmongCoMembers(db, userId, name)) {
      throw conflict("display_name_taken", "同じグループに、同じ表示名の人がいます。別の表示名にしてください");
    }
    return db.update(users).set({ displayName: name }).where(eq(users.id, userId)).returning().get();
  });
}

/** admin 専用トークンの scope。User トークンと同じ kind = 'user' の行に入れ、scope で見分ける */
export const ADMIN_SCOPE = "admin";

function insertCredential(
  db: DB,
  row: { kind: "user" | "agent"; userId: string; agentId: string | null; scopes: string },
  token: string,
  now: Date,
) {
  db.insert(credentials)
    .values({ id: newId("cred"), ...row, tokenHash: sha256(token), createdAt: now.toISOString() })
    .run();
  return token;
}

function issueCredential(db: DB, kind: "user" | "agent", userId: string, agentId: string | null, now: Date): string {
  const scopes = kind === "user" ? "user" : AGENT_SCOPES.join(" ");
  return insertCredential(db, { kind, userId, agentId, scopes }, newToken(kind), now);
}

/**
 * admin 専用トークンを発行する。admin API（/v1/admin/*）だけに使え、普段の User の API には使えない。
 * Agent が読める ~/.souieba には保存しない前提（souieba-admin が環境変数で受け取る）。
 */
export function issueAdminToken(db: DB, userId: string, now: Date): string {
  return db.transaction(() => {
    const user = getUser(db, userId);
    if (!user || user.disabledAt || user.role !== "admin") throw badRequest("not_admin", "admin のユーザーにだけ発行できます");
    // 有効な admin 専用トークンは1人1つ。再発行すると古いものは失効する（漏れたトークンの無効化を兼ねる）
    db.update(credentials)
      .set({ revokedAt: now.toISOString() })
      .where(and(eq(credentials.userId, userId), eq(credentials.scopes, ADMIN_SCOPE), isNull(credentials.revokedAt)))
      .run();
    return insertCredential(db, { kind: "user", userId, agentId: null, scopes: ADMIN_SCOPE }, newToken("admin"), now);
  });
}

export function hasAdmin(db: DB): boolean {
  return !!db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "admin"), isNull(users.disabledAt)))
    .limit(1)
    .get();
}

/**
 * 最初の admin を作る（Workers のようにサーバ上で souieba-admin を実行できない環境のため）。
 * admin が1人もいないあいだだけ受け付ける。
 */
export function bootstrapAdmin(db: DB, input: { handle: string; displayName: string }, now: Date, limits: Limits) {
  return db.transaction(() => {
    if (hasAdmin(db)) throw conflict("already_bootstrapped", "admin はすでにいます");
    const user = createUser(db, { ...input, role: "admin" }, now, limits);
    return { user, adminToken: issueAdminToken(db, user.id, now), login: issueLoginCode(db, user.id, now) };
  });
}

/** ログインコードを発行する。トークンを失くした場合の再発行にも使う */
export function issueLoginCode(db: DB, userId: string, now: Date): { code: string; expiresAt: string } {
  const code = newCode();
  const expiresAt = new Date(now.getTime() + LOGIN_CODE_TTL_MS).toISOString();
  db.insert(invites)
    .values({
      id: newId("inv"),
      codeHash: sha256(code),
      kind: "login",
      targetUserId: userId,
      autoFriend: 0,
      expiresAt,
      createdAt: now.toISOString(),
    })
    .run();
  return { code, expiresAt };
}

/** アカウント作成用の招待コード（どのグループにも入らない）。管理者が発行する。グループへの招待は groups.createGroupInvite */
export function createAccountInvite(db: DB, now: Date): { code: string; expiresAt: string } {
  const code = newCode();
  const expiresAt = new Date(now.getTime() + ACCOUNT_INVITE_TTL_MS).toISOString();
  db.insert(invites)
    .values({ id: newId("inv"), codeHash: sha256(code), kind: "invite", autoFriend: 0, expiresAt, createdAt: now.toISOString() })
    .run();
  return { code, expiresAt };
}

export type RedeemInput = {
  code: string;
  handle?: string;
  displayName?: string;
};

export type RedeemResult = {
  user: UserRow;
  token: string;
  group: { id: string; name: string } | null;
  inviter: { id: string; handle: string; displayName: string } | null;
};

function markInviteUsed(db: DB, inviteId: string, userId: string, now: Date) {
  db.update(invites).set({ usedBy: userId, usedAt: now.toISOString() }).where(eq(invites.id, inviteId)).run();
}

export function redeemCode(db: DB, input: RedeemInput, now: Date, limits: Limits): RedeemResult {
  return db.transaction(() => {
    const inv = findUsableInvite(db, input.code, now);

    if (inv.kind === "login") {
      const user = getUser(db, inv.targetUserId!);
      if (!user || user.disabledAt) throw badRequest("invalid_code", "コードが無効か、期限が切れています");
      // 古い User トークンは失効させる（なくした・漏れたトークンの無効化を兼ねる）。admin 専用トークンは別に管理する
      db.update(credentials)
        .set({ revokedAt: now.toISOString() })
        .where(
          and(
            eq(credentials.userId, user.id),
            eq(credentials.kind, "user"),
            ne(credentials.scopes, ADMIN_SCOPE),
            isNull(credentials.revokedAt),
          ),
        )
        .run();
      markInviteUsed(db, inv.id, user.id, now);
      return { user, token: issueCredential(db, "user", user.id, null, now), group: null, inviter: null };
    }

    if (!input.handle || !input.displayName) throw badRequest("profile_required", "handle と displayName が必要です");
    const user = createUser(db, { handle: input.handle, displayName: input.displayName }, now, limits);
    let joined: Pick<RedeemResult, "group" | "inviter"> = { group: null, inviter: null };
    if (inv.groupId) {
      joined = joinWithInvite(db, inv, user, now, limits);
    } else {
      markInviteUsed(db, inv.id, user.id, now);
    }
    return { user, token: issueCredential(db, "user", user.id, null, now), ...joined };
  });
}

/** 既存のユーザーが招待コードで別のグループに参加する */
export function joinGroup(db: DB, userId: string, input: { code: string }, now: Date, limits: Limits) {
  return db.transaction(() => {
    const inv = findUsableInvite(db, input.code, now);
    if (inv.kind !== "invite" || !inv.groupId) throw badRequest("invalid_code", "コードが無効か、期限が切れています");
    return joinWithInvite(db, inv, getUser(db, userId)!, now, limits);
  });
}

export function publicAgent(a: AgentRow) {
  return {
    id: a.id,
    name: a.name,
    provider: a.provider,
    encKey: a.encKey,
    signKey: a.signKey,
    revokedAt: a.revokedAt,
    createdAt: a.createdAt,
  };
}

/**
 * Agent の登録。暗号鍵（X25519）と署名鍵（Ed25519）の公開鍵が必須。
 * 受信側はサーバが配るこの鍵をそのまま使う（サーバを信頼する。docs/public-deployment-plan.md §5）
 */
export function createAgent(
  db: DB,
  ownerId: string,
  input: { name: string; provider?: string; encKey: string; signKey: string },
  now: Date,
): { agent: AgentRow; token: string } {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 40) throw badRequest("invalid_name", "Agent 名は1〜40文字にしてください");
  if (!isPublicKey("x25519", input.encKey) || !isPublicKey("ed25519", input.signKey)) {
    throw badRequest("invalid_agent_keys", "Agent の鍵の形式が不正です");
  }
  return db.transaction(() => {
    const agent = db
      .insert(agents)
      .values({
        id: newId("agt"),
        ownerId,
        name,
        provider: input.provider ?? null,
        encKey: input.encKey,
        signKey: input.signKey,
        createdAt: now.toISOString(),
      })
      .returning()
      .get();
    return { agent, token: issueCredential(db, "agent", ownerId, agent.id, now) };
  });
}

export function getAgent(db: DB, agentId: string): AgentRow | undefined {
  return db.select().from(agents).where(eq(agents.id, agentId)).get();
}

export function listAgents(db: DB, ownerId: string): AgentRow[] {
  return db.select().from(agents).where(eq(agents.ownerId, ownerId)).orderBy(agents.createdAt).all();
}

export function revokeAgent(db: DB, ownerId: string, agentId: string, now: Date): void {
  db.transaction(() => {
    const revoked = db
      .update(agents)
      .set({ revokedAt: now.toISOString() })
      .where(and(eq(agents.id, agentId), eq(agents.ownerId, ownerId), isNull(agents.revokedAt)))
      .returning({ id: agents.id })
      .all();
    if (revoked.length === 0) throw notFound("Agent");
    db.update(credentials)
      .set({ revokedAt: now.toISOString() })
      .where(and(eq(credentials.agentId, agentId), isNull(credentials.revokedAt)))
      .run();
  });
}

export function disableUser(db: DB, userId: string, now: Date): void {
  const disabled = db
    .update(users)
    .set({ disabledAt: now.toISOString() })
    .where(and(eq(users.id, userId), isNull(users.disabledAt)))
    .returning({ id: users.id })
    .all();
  if (disabled.length === 0) throw notFound("ユーザー");
}

/** アカウント削除。外部キーの ON DELETE CASCADE で投稿・配送状態・所属も物理削除される */
export function deleteUser(db: DB, userId: string): void {
  db.transaction(() => {
    db.delete(users).where(eq(users.id, userId)).run();
    deleteEmptyGroups(db);
  });
}

export function listUsers(db: DB): UserRow[] {
  return db.select().from(users).orderBy(users.createdAt).all();
}
