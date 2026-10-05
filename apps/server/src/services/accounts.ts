import { AGENT_SCOPES, isPublicKey, signedText, verifyText } from "@souieba/core";
import { newCode, newId, newToken, sha256 } from "../crypto.ts";
import { type DB, tx } from "../db.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { deleteEmptyGroups, findUsableInvite, joinWithInvite } from "./groups.ts";

export const HANDLE_RE = /^[a-z0-9_]{2,20}$/;
const ACCOUNT_INVITE_TTL_MS = 3 * 86_400_000;
const LOGIN_CODE_TTL_MS = 15 * 60_000;

export type UserRow = {
  id: string;
  handle: string;
  display_name: string;
  role: "admin" | "member";
  identity_key: string | null;
  disabled_at: string | null;
  created_at: string;
};

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    handle: u.handle,
    displayName: u.display_name,
    role: u.role,
    identityKey: u.identity_key,
    createdAt: u.created_at,
  };
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

function requireIdentityKey(key: unknown): string {
  if (!isPublicKey("ed25519", key)) throw badRequest("invalid_identity_key", "Identity 鍵（Ed25519 の公開鍵）が必要です");
  return key;
}

export function createUser(
  db: DB,
  input: { handle: string; displayName: string; role?: "admin" | "member"; identityKey?: string | null },
  now: Date,
): UserRow {
  const displayName = validateProfile(input.handle, input.displayName);
  if (getUserByHandle(db, input.handle)) throw conflict("handle_taken", "その handle は使われています");
  const id = newId("usr");
  db.prepare("INSERT INTO users (id, handle, display_name, role, identity_key, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    input.handle,
    displayName,
    input.role ?? "member",
    input.identityKey ?? null,
    now.toISOString(),
  );
  return getUser(db, id)!;
}

/** Identity 鍵の登録。サーバが勝手に差し替えられないよう、未登録のときだけ受け付ける */
export function setIdentityKey(db: DB, userId: string, key: unknown): void {
  const k = requireIdentityKey(key);
  const r = db.prepare("UPDATE users SET identity_key = ? WHERE id = ? AND identity_key IS NULL").run(k, userId);
  if (r.changes === 0) throw conflict("identity_exists", "Identity 鍵はすでに登録されています");
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

/**
 * アカウント作成用の招待コード（どのグループにも入らない）。管理者がサーバ上で発行する。
 * グループへの招待はメンバーのクライアントが署名して作る（groups.createGroupInvite）。
 */
export function createAccountInvite(db: DB, now: Date): { code: string; expiresAt: string } {
  const code = newCode();
  const expiresAt = new Date(now.getTime() + ACCOUNT_INVITE_TTL_MS).toISOString();
  db.prepare(
    "INSERT INTO invites (id, code_hash, kind, auto_friend, expires_at, created_at) VALUES (?, ?, 'invite', 0, ?, ?)",
  ).run(newId("inv"), sha256(code), expiresAt, now.toISOString());
  return { code, expiresAt };
}

export type RedeemInput = {
  code: string;
  handle?: string;
  displayName?: string;
  identityKey?: string;
  joinSig?: string;
};

export type RedeemResult = {
  user: UserRow;
  token: string;
  group: { id: string; name: string } | null;
  inviter: { id: string; handle: string; displayName: string; identityKey: string } | null;
};

export function redeemCode(db: DB, input: RedeemInput, now: Date): RedeemResult {
  return tx(db, () => {
    const inv = findUsableInvite(db, input.code, now);

    if (inv.kind === "login") {
      const user = getUser(db, inv.target_user_id!);
      if (!user || user.disabled_at) throw badRequest("invalid_code", "コードが無効か、期限が切れています");
      // 古い User トークンは失効させる（なくした・漏れたトークンの無効化を兼ねる）
      db.prepare("UPDATE credentials SET revoked_at = ? WHERE user_id = ? AND kind = 'user' AND revoked_at IS NULL").run(
        now.toISOString(),
        user.id,
      );
      // 移行前のユーザーは、ここで Identity 鍵を登録できる（未登録のときだけ）
      if (!user.identity_key && input.identityKey) {
        db.prepare("UPDATE users SET identity_key = ? WHERE id = ?").run(requireIdentityKey(input.identityKey), user.id);
      }
      db.prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE id = ?").run(user.id, now.toISOString(), inv.id);
      return { user: getUser(db, user.id)!, token: issueCredential(db, "user", user.id, null, now), group: null, inviter: null };
    }

    if (!input.handle || !input.displayName) throw badRequest("profile_required", "handle と displayName が必要です");
    const identityKey = requireIdentityKey(input.identityKey);
    const user = createUser(db, { handle: input.handle, displayName: input.displayName, identityKey }, now);
    let joined: Pick<RedeemResult, "group" | "inviter"> = { group: null, inviter: null };
    if (inv.group_id) {
      joined = joinWithInvite(db, inv, { userId: user.id, identityKey, code: input.code, joinSig: input.joinSig }, now);
    } else {
      db.prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE id = ?").run(user.id, now.toISOString(), inv.id);
    }
    return { user, token: issueCredential(db, "user", user.id, null, now), ...joined };
  });
}

/** 既存のユーザーが招待コードで別のグループに参加する */
export function joinGroup(db: DB, userId: string, input: { code: string; joinSig?: string }, now: Date) {
  return tx(db, () => {
    const inv = findUsableInvite(db, input.code, now);
    if (inv.kind !== "invite" || !inv.group_id) throw badRequest("invalid_code", "コードが無効か、期限が切れています");
    const user = getUser(db, userId)!;
    if (!user.identity_key) throw conflict("identity_required", "Identity 鍵が未登録です");
    return joinWithInvite(db, inv, { userId, identityKey: user.identity_key, code: input.code, joinSig: input.joinSig }, now);
  });
}

export type AgentRow = {
  id: string;
  owner_id: string;
  name: string;
  provider: string | null;
  enc_key: string | null;
  sign_key: string | null;
  cert: string | null;
  revoked_at: string | null;
  created_at: string;
};

export function publicAgent(a: AgentRow) {
  return {
    id: a.id,
    name: a.name,
    provider: a.provider,
    encKey: a.enc_key,
    signKey: a.sign_key,
    cert: a.cert,
    revokedAt: a.revoked_at,
    createdAt: a.created_at,
  };
}

/**
 * Agent の登録。鍵と、持ち主の Identity 鍵による証明書が必須。
 * サーバが証明書を検証するのはゴミを入れないため（信頼の根拠は受信側の検証）。
 */
export function createAgent(
  db: DB,
  ownerId: string,
  input: { name: string; provider?: string; encKey: string; signKey: string; cert: string },
  now: Date,
): { agent: AgentRow; token: string } {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 40) throw badRequest("invalid_name", "Agent 名は1〜40文字にしてください");
  if (!isPublicKey("x25519", input.encKey) || !isPublicKey("ed25519", input.signKey)) {
    throw badRequest("invalid_agent_keys", "Agent の鍵の形式が不正です");
  }
  const owner = getUser(db, ownerId)!;
  if (!owner.identity_key) throw conflict("identity_required", "先に Identity 鍵を登録してください");
  if (!verifyText(owner.identity_key, signedText.agentCert(ownerId, input.encKey, input.signKey), input.cert)) {
    throw badRequest("invalid_signature", "Agent の証明書を検証できません");
  }
  return tx(db, () => {
    const id = newId("agt");
    db.prepare(
      "INSERT INTO agents (id, owner_id, name, provider, enc_key, sign_key, cert, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, ownerId, name, input.provider ?? null, input.encKey, input.signKey, input.cert, now.toISOString());
    const token = issueCredential(db, "agent", ownerId, id, now);
    return { agent: db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow, token };
  });
}

export function getAgent(db: DB, agentId: string): AgentRow | undefined {
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined;
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

/** アカウント削除。外部キーの ON DELETE CASCADE で投稿・配送状態・所属も物理削除される */
export function deleteUser(db: DB, userId: string): void {
  tx(db, () => {
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    deleteEmptyGroups(db);
  });
}

export function listUsers(db: DB): UserRow[] {
  return db.prepare("SELECT * FROM users ORDER BY created_at").all() as UserRow[];
}
