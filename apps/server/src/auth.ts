import type { Context, MiddlewareHandler } from "hono";
import { sha256 } from "./crypto.ts";
import type { DB } from "./db.ts";
import { ApiError, forbidden, unauthorized } from "./errors.ts";

export type Auth = {
  kind: "user" | "agent";
  userId: string;
  agentId: string | null;
  role: "admin" | "member";
  scopes: Set<string>;
};

export type Env = { Variables: { auth: Auth; clientIp: string } };

type CredRow = {
  kind: "user" | "agent";
  user_id: string;
  agent_id: string | null;
  scopes: string;
  role: "admin" | "member";
};

export type AuthFailureGuard = {
  /** 認証に失敗しすぎた送信元なら true（トークンを照合せずに 429 にする） */
  blocked(c: Context<Env>): boolean;
  failed(c: Context<Env>): void;
};

export function authenticate(db: DB, guard?: AuthFailureGuard): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (guard?.blocked(c)) throw new ApiError(429, "rate_limited", "認証の失敗が多すぎます。時間をおいてください");
    const fail = () => {
      guard?.failed(c);
      return unauthorized();
    };
    const header = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(sou_[ua]_[A-Za-z0-9_-]+)$/.exec(header);
    if (!m) throw fail();
    // 失効した資格情報・無効化されたユーザー・失効した Agent はすべて 401
    const row = db
      .prepare(
        `SELECT c.kind, c.user_id, c.agent_id, c.scopes, u.role
         FROM credentials c JOIN users u ON u.id = c.user_id
         LEFT JOIN agents a ON a.id = c.agent_id
         WHERE c.token_hash = ? AND c.revoked_at IS NULL AND u.disabled_at IS NULL
           AND (c.agent_id IS NULL OR a.revoked_at IS NULL)`,
      )
      .get(sha256(m[1]!)) as CredRow | undefined;
    if (!row) throw fail();
    c.set("auth", {
      kind: row.kind,
      userId: row.user_id,
      agentId: row.agent_id,
      role: row.role,
      scopes: new Set(row.scopes.split(" ")),
    });
    await next();
  };
}

export function requireUser(c: Context<Env>): Auth {
  const a = c.get("auth");
  if (a.kind !== "user") throw forbidden("User トークンが必要です");
  return a;
}

export function requireAgent(c: Context<Env>, scope: string): Auth & { agentId: string } {
  const a = c.get("auth");
  if (a.kind !== "agent" || !a.agentId) throw forbidden("Agent トークンが必要です");
  if (!a.scopes.has(scope)) throw forbidden(`スコープ ${scope} がありません`);
  return a as Auth & { agentId: string };
}
