import { AGENT_SCOPES } from "@souieba/core";
import { newCode, newId, newToken, normalizeCode, sha256 } from "../crypto.ts";
import { type DB, tx } from "../db.ts";
import { ApiError, badRequest, conflict, notFound } from "../errors.ts";
import { acceptFriendshipDirect } from "./friends.ts";

export const HANDLE_RE = /^[a-z0-9_]{2,20}$/;
const INVITE_TTL_MS = 7 * 86_400_000;
const LOGIN_CODE_TTL_MS = 15 * 60_000;

export type UserRow = {
  id: string;
  handle: string;
  display_name: string;
  role: "admin" | "member";
  disabled_at: string | null;
  created_at: string;
};

export function publicUser(u: UserRow) {
  return { id: u.id, handle: u.handle, displayName: u.display_name, role: u.role, createdAt: u.created_at };
}

export function getUser(db: DB, id: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function getUserByHandle(db: DB, handle: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE handle = ?").get(handle) as UserRow | undefined;
}

function validateProfile(handle: string, displayName: string) {
  if (!HANDLE_RE.test(handle)) throw badRequest("invalid_handle", "handle は英小文字・数字・_ の2〜20文字にしてください");
  const name = displayName.trim();
  if (name.length < 1 || name.length > 40) throw badRequest("invalid_display_name", "表示名は1〜40文字にしてください");
  return name;
}

export function createUser(db: DB, input: { handle: string; displayName: string; role?: "admin" | "member" }, now: Date): UserRow {
  const displayName = validateProfile(input.handle, input.displayName);
  if (getUserByHandle(db, input.handle)) throw conflict("handle_taken", "その handle は使われています");
  const id = newId("usr");
  db.prepare("INSERT INTO users (id, handle, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    input.handle,
    displayName,
    input.role ?? "member",
    now.toISOString(),
  );
  return getUser(db, id)!;
}

function issueCredential(db: DB, kind: "user" | "agent", userId: string, agentId: string | null, now: Date): string {
  const token = newToken(kind);
  const scopes = kind === "user" ? "user" : AGENT_SCOPES.join(" ");
  db.prepare(
    "INSERT INTO credentials (id, kind, user_id, agent_id, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(newId("cred"), kind, userId, agentId, sha256(token), scopes, now.toISOString());
  return token;
}

/** ログインコードを発行する。トークンを失くした場合の再発行にも使う */
export function issueLoginCode(db: DB, userId: string, now: Date): { code: string; expiresAt: string } {
  const code = newCode();
  const expiresAt = new Date(now.getTime() + LOGIN_CODE_TTL_MS).toISOString();
  db.prepare(
    "INSERT INTO invites (id, code_hash, kind, target_user_id, auto_friend, expires_at, created_at) VALUES (?, ?, 'login', ?, 0, ?, ?)",
  ).run(newId("inv"), sha256(code), userId, expiresAt, now.toISOString());
  return { code, expiresAt };
}

export function createInvite(
  db: DB,
  input: { createdBy: string | null; autoFriend: boolean },
  now: Date,
): { code: string; expiresAt: string } {
  const code = newCode();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
  db.prepare(
    "INSERT INTO invites (id, code_hash, kind, created_by, auto_friend, expires_at, created_at) VALUES (?, ?, 'invite', ?, ?, ?, ?)",
  ).run(newId("inv"), sha256(code), input.createdBy, input.autoFriend ? 1 : 0, expiresAt, now.toISOString());
  return { code, expiresAt };
}

type InviteRow = {
  id: string;
  kind: "invite" | "login";
  created_by: string | null;
  target_user_id: string | null;
  auto_friend: number;
  expires_at: string;
  used_at: string | null;
};

const invalidCode = () => new ApiError(400, "invalid_code", "コードが無効か、期限が切れています");

export function redeemCode(
  db: DB,
  input: { code: string; handle?: string; displayName?: string },
  now: Date,
): { user: UserRow; token: string } {
  return tx(db, () => {
    const inv = db.prepare("SELECT * FROM invites WHERE code_hash = ?").get(sha256(normalizeCode(input.code))) as
      | InviteRow
      | undefined;
    if (!inv || inv.used_at || inv.expires_at < now.toISOString()) throw invalidCode();

    let user: UserRow;
    if (inv.kind === "login") {
      user = getUser(db, inv.target_user_id!)!;
      if (!user || user.disabled_at) throw invalidCode();
      // 古い User トークンは失効させる（なくした・漏れたトークンの無効化を兼ねる）
      db.prepare("UPDATE credentials SET revoked_at = ? WHERE user_id = ? AND kind = 'user' AND revoked_at IS NULL").run(
        now.toISOString(),
        user.id,
      );
    } else {
      if (!input.handle || !input.displayName) throw badRequest("profile_required", "handle と displayName が必要です");
      user = createUser(db, { handle: input.handle, displayName: input.displayName }, now);
      if (inv.auto_friend && inv.created_by) acceptFriendshipDirect(db, inv.created_by, user.id, now);
    }
    db.prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE id = ?").run(user.id, now.toISOString(), inv.id);
    return { user, token: issueCredential(db, "user", user.id, null, now) };
  });
}

export type AgentRow = {
  id: string;
  owner_id: string;
  name: string;
  provider: string | null;
  revoked_at: string | null;
  created_at: string;
};

export function publicAgent(a: AgentRow) {
  return { id: a.id, name: a.name, provider: a.provider, revokedAt: a.revoked_at, createdAt: a.created_at };
}

export function createAgent(
  db: DB,
  ownerId: string,
  input: { name: string; provider?: string },
  now: Date,
): { agent: AgentRow; token: string } {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 40) throw badRequest("invalid_name", "Agent 名は1〜40文字にしてください");
  return tx(db, () => {
    const id = newId("agt");
    db.prepare("INSERT INTO agents (id, owner_id, name, provider, created_at) VALUES (?, ?, ?, ?, ?)").run(
      id,
      ownerId,
      name,
      input.provider ?? null,
      now.toISOString(),
    );
    const token = issueCredential(db, "agent", ownerId, id, now);
    return { agent: db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow, token };
  });
}

export function listAgents(db: DB, ownerId: string): AgentRow[] {
  return db.prepare("SELECT * FROM agents WHERE owner_id = ? ORDER BY created_at").all(ownerId) as AgentRow[];
}

export function revokeAgent(db: DB, ownerId: string, agentId: string, now: Date): void {
  tx(db, () => {
    const r = db.prepare("UPDATE agents SET revoked_at = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL").run(
      now.toISOString(),
      agentId,
      ownerId,
    );
    if (r.changes === 0) throw notFound("Agent");
    db.prepare("UPDATE credentials SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL").run(now.toISOString(), agentId);
  });
}

export function disableUser(db: DB, userId: string, now: Date): void {
  const r = db.prepare("UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL").run(now.toISOString(), userId);
  if (r.changes === 0) throw notFound("ユーザー");
}

/** アカウント削除。外部キーの ON DELETE CASCADE で投稿・配送状態・Friend も物理削除される */
export function deleteUser(db: DB, userId: string): void {
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
}

export function listUsers(db: DB): UserRow[] {
  return db.prepare("SELECT * FROM users ORDER BY created_at").all() as UserRow[];
}
