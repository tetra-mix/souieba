import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { z } from "zod";
import { type Env, authenticate, requireAdmin, requireAgent, requireUser } from "./auth.ts";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { ApiError, badRequest, forbidden, notFound } from "./errors.ts";
import { ipInCidrs, isLoopback, normalizeIp } from "./net.ts";
import { RateLimiter } from "./ratelimit.ts";
import * as accounts from "./services/accounts.ts";
import * as friends from "./services/friends.ts";
import * as inboxSvc from "./services/inbox.ts";
import * as posts from "./services/posts.ts";

export const VERSION = "0.1.0";

export type AppDeps = {
  db: DB;
  config: Config;
  now?: () => Date;
  random?: () => number;
  /** テストでは接続情報がないので、送信元 IP を差し替えられるようにする */
  remoteAddr?: (c: Parameters<typeof getConnInfo>[0]) => string;
  log?: (line: Record<string, unknown>) => void;
};

async function body<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    raw = {};
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw badRequest("invalid_body", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

export function createApp(deps: AppDeps) {
  const { db, config } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line) => console.log(JSON.stringify(line)));
  const remoteAddr = deps.remoteAddr ?? ((c) => getConnInfo(c).remote.address ?? "");

  const redeemLimiter = new RateLimiter(10, 60 * 60_000);
  const postLimiter = new RateLimiter(30, 60 * 60_000);
  const readLimiter = new RateLimiter(60, 60_000);

  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    log({ level: "error", msg: "unhandled", error: err instanceof Error ? err.message : String(err) });
    return c.json({ error: { code: "internal", message: "内部エラー" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not Found" } }, 404));

  // 送信元 IP の判定・許可範囲の検査・アクセスログ（本文やトークンは記録しない）
  app.use("*", async (c, next) => {
    const started = Date.now();
    const peer = normalizeIp(remoteAddr(c));
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    const ip = config.trustProxy === "loopback" && isLoopback(peer) && forwarded ? normalizeIp(forwarded) : peer;
    c.set("clientIp", ip);
    if (config.allowedCidrs.length > 0 && !isLoopback(peer) && !ipInCidrs(peer, config.allowedCidrs)) {
      throw forbidden("許可されていないネットワークからの接続です");
    }
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    if (config.logLevel !== "error") {
      log({ level: "info", method: c.req.method, route: c.req.routePath, status: c.res.status, ms: Date.now() - started });
    }
  });

  // body は 16KB まで
  app.use("/v1/*", async (c, next) => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > 16 * 1024) throw new ApiError(413, "payload_too_large", "リクエストが大きすぎます");
    await next();
  });

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/v1/instance", (c) =>
    c.json({ name: config.instanceName, version: VERSION, registration: "invite", inviteBy: config.inviteBy }),
  );

  app.post("/v1/auth/redeem", async (c) => {
    if (!redeemLimiter.take(`redeem:${c.get("clientIp")}`, now().getTime())) {
      throw new ApiError(429, "rate_limited", "試行回数が多すぎます。時間をおいてください");
    }
    const input = await body(
      c,
      z.object({ code: z.string().min(1).max(32), handle: z.string().optional(), displayName: z.string().optional() }),
    );
    const { user, token } = accounts.redeemCode(db, input, now());
    return c.json({ user: accounts.publicUser(user), token }, 201);
  });

  // ---- ここから認証が必要 ----
  const v1 = new Hono<Env>();
  v1.use("*", authenticate(db));
  v1.use("*", async (c, next) => {
    const a = c.get("auth");
    const key = a.agentId ?? a.userId;
    const limiter = c.req.method === "POST" && c.req.path === "/v1/posts" ? postLimiter : readLimiter;
    if (!limiter.take(`${c.req.method === "POST" && c.req.path === "/v1/posts" ? "post" : "req"}:${key}`, now().getTime())) {
      throw new ApiError(429, "rate_limited", "リクエストが多すぎます");
    }
    await next();
  });

  v1.get("/me", (c) => {
    const a = c.get("auth");
    const user = accounts.getUser(db, a.userId)!;
    const agent = a.agentId ? accounts.listAgents(db, a.userId).find((x) => x.id === a.agentId) : undefined;
    return c.json({ user: accounts.publicUser(user), agent: agent ? accounts.publicAgent(agent) : null });
  });

  v1.get("/me/export", (c) => {
    const a = requireUser(c);
    return c.json({
      exportedAt: now().toISOString(),
      user: accounts.publicUser(accounts.getUser(db, a.userId)!),
      agents: accounts.listAgents(db, a.userId).map(accounts.publicAgent),
      friends: friends.listFriendships(db, a.userId),
      postsAboutMe: posts.listMyPosts(db, a.userId),
    });
  });

  v1.delete("/me", (c) => {
    const a = requireUser(c);
    accounts.deleteUser(db, a.userId);
    return c.body(null, 204);
  });

  // Agent
  v1.get("/agents", (c) => c.json({ agents: accounts.listAgents(db, requireUser(c).userId).map(accounts.publicAgent) }));
  v1.post("/agents", async (c) => {
    const a = requireUser(c);
    const input = await body(c, z.object({ name: z.string(), provider: z.string().max(40).optional() }));
    const { agent, token } = accounts.createAgent(db, a.userId, input, now());
    return c.json({ agent: accounts.publicAgent(agent), token }, 201);
  });
  v1.delete("/agents/:id", (c) => {
    accounts.revokeAgent(db, requireUser(c).userId, c.req.param("id"), now());
    return c.body(null, 204);
  });

  // 招待
  v1.post("/invites", async (c) => {
    const a = requireUser(c);
    if (config.inviteBy === "admin" && a.role !== "admin") throw forbidden("このインスタンスでは管理者だけが招待できます");
    const input = await body(c, z.object({ autoFriend: z.boolean().default(true) }));
    return c.json(accounts.createInvite(db, { createdBy: a.userId, autoFriend: input.autoFriend }, now()), 201);
  });

  // Friend
  v1.get("/friends", (c) => c.json({ friends: friends.listFriendships(db, requireUser(c).userId) }));
  v1.post("/friends", async (c) => {
    const a = requireUser(c);
    const { handle } = await body(c, z.object({ handle: z.string() }));
    const target = accounts.getUserByHandle(db, handle);
    if (!target || target.disabled_at) throw notFound("ユーザー");
    return c.json(friends.requestFriendship(db, a.userId, target.id, now()), 201);
  });
  v1.post("/friends/:id/accept", (c) => {
    friends.acceptFriendship(db, c.req.param("id"), requireUser(c).userId, now());
    return c.body(null, 204);
  });
  v1.post("/friends/:id/block", (c) => {
    friends.blockFriendship(db, c.req.param("id"), requireUser(c).userId, now());
    return c.body(null, 204);
  });
  v1.delete("/friends/:id", (c) => {
    friends.removeFriendship(db, c.req.param("id"), requireUser(c).userId);
    return c.body(null, 204);
  });

  // 投稿
  v1.post("/posts", async (c) => {
    const a = requireAgent(c, "posts:write");
    const input = await body(
      c,
      z.object({
        periodStart: z.string(),
        periodEnd: z.string(),
        content: z.string().min(1).max(2000),
        visibility: z.enum(["friends", "private"]).optional(),
      }),
    );
    const result = posts.upsertPost(db, { userId: a.userId, agentId: a.agentId }, input, now(), config.postGraceMs);
    return c.json(result, result.created ? 201 : 200);
  });
  v1.get("/posts/mine", (c) => c.json({ posts: posts.listMyPosts(db, requireUser(c).userId) }));
  v1.delete("/posts/:id", (c) => {
    const a = c.get("auth");
    posts.deletePost(db, { userId: a.userId, agentId: a.agentId }, c.req.param("id"));
    return c.body(null, 204);
  });

  // 受信・Tell
  v1.post("/sync", (c) => c.json(inboxSvc.sync(db, requireAgent(c, "sync"), now())));
  v1.get("/inbox", (c) => c.json({ items: inboxSvc.inbox(db, requireAgent(c, "sync"), now()) }));
  v1.post("/tell/claim", async (c) => {
    const a = requireAgent(c, "tell");
    const { leaseSec } = await body(c, z.object({ leaseSec: z.number().int().min(30).max(3600).optional() }));
    const candidate = inboxSvc.claimTell(db, a, now(), {
      leaseMs: leaseSec ? leaseSec * 1000 : undefined,
      random: deps.random,
    });
    return c.json({ candidate });
  });
  v1.post("/deliveries/:postId/told", (c) => {
    inboxSvc.markTold(db, requireAgent(c, "tell"), c.req.param("postId"), now());
    return c.body(null, 204);
  });
  v1.post("/deliveries/:postId/release", (c) => {
    inboxSvc.releaseTell(db, requireAgent(c, "tell"), c.req.param("postId"));
    return c.body(null, 204);
  });
  v1.post("/deliveries/:postId/dismiss", (c) => {
    inboxSvc.dismiss(db, c.get("auth").userId, c.req.param("postId"), now());
    return c.body(null, 204);
  });

  // 管理
  v1.get("/admin/users", (c) => {
    requireAdmin(c);
    return c.json({
      users: accounts.listUsers(db).map((u) => ({ ...accounts.publicUser(u), disabledAt: u.disabled_at })),
    });
  });
  v1.post("/admin/users/:id/disable", (c) => {
    const a = requireAdmin(c);
    if (c.req.param("id") === a.userId) throw badRequest("self_disable", "自分自身は無効化できません");
    accounts.disableUser(db, c.req.param("id"), now());
    return c.body(null, 204);
  });

  app.route("/v1", v1);
  return app;
}
