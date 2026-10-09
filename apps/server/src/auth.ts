import type { Context, MiddlewareHandler } from "hono";
import { sha256 } from "./crypto.ts";
import { and, eq, isNull, or } from "drizzle-orm";
import type { DB } from "./db/index.ts";
import { agents, credentials, users } from "./db/schema.ts";
import { ApiError, forbidden, unauthorized } from "./errors.ts";
import { ADMIN_SCOPE } from "./services/accounts.ts";

export type Auth = {
  /** admin は admin 専用トークン（/v1/admin/* だけに使える） */
  kind: "user" | "agent" | "admin";
  userId: string;
  agentId: string | null;
  role: "admin" | "member";
  scopes: Set<string>;
};

export type Env = { Variables: { auth: Auth; clientIp: string } };

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
    const m = /^Bearer\s+(sou_[uam]_[A-Za-z0-9_-]+)$/.exec(header);
    if (!m) throw fail();
    // 失効した資格情報・無効化されたユーザー・失効した Agent はすべて 401
    const row = db
      .select({
        kind: credentials.kind,
        userId: credentials.userId,
        agentId: credentials.agentId,
        scopes: credentials.scopes,
        role: users.role,
      })
      .from(credentials)
      .innerJoin(users, eq(users.id, credentials.userId))
      .leftJoin(agents, eq(agents.id, credentials.agentId))
      .where(
        and(
          eq(credentials.tokenHash, sha256(m[1]!)),
          isNull(credentials.revokedAt),
          isNull(users.disabledAt),
          or(isNull(credentials.agentId), isNull(agents.revokedAt)),
        ),
      )
      .get();
    if (!row) throw fail();
    const scopes = new Set(row.scopes.split(" "));
    const isAdminToken = scopes.has(ADMIN_SCOPE);
    // admin 専用トークンは、持ち主が今も admin のときだけ有効
    if (isAdminToken && row.role !== "admin") throw fail();
    c.set("auth", {
      kind: isAdminToken ? "admin" : row.kind,
      userId: row.userId,
      agentId: row.agentId,
      role: row.role,
      scopes,
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
