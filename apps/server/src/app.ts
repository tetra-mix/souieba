import { type Context, Hono } from "hono";
import { z } from "zod";
import { type Auth, type Env, authenticate, requireAgent, requireUser } from "./auth.ts";
import type { Config } from "./config.ts";
import type { DB } from "./db/index.ts";
import { sha256 } from "./crypto.ts";
import { ApiError, badRequest, forbidden, notFound } from "./errors.ts";
import { isLoopback, isPrivateOrLoopback, normalizeIp } from "./net.ts";
import { RateLimiter } from "./ratelimit.ts";
import * as accounts from "./services/accounts.ts";
import * as groups from "./services/groups.ts";
import * as inboxSvc from "./services/inbox.ts";
import * as posts from "./services/posts.ts";

export const VERSION = "0.2.0";

export type AppDeps = {
  db: DB;
  config: Config;
  now?: () => Date;
  random?: () => number;
  /** 直前の接続元の IP。Node では接続情報、Workers では CF-Connecting-IP から取る */
  remoteAddr: (c: Context<Env>) => string;
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

const b64 = z.string().regex(/^[A-Za-z0-9_-]+$/).max(4096);
const key = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const sig = z.string().regex(/^[A-Za-z0-9_-]{86}$/);

const EnvelopeSchema = z.object({
  v: z.literal(1),
  periodStart: z.string().max(40),
  periodEnd: z.string().max(40),
  visibility: z.enum(["groups", "private"]),
  epk: key,
  iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  // 本文は 300 字までなので、暗号文は数 KB に収まる
  ciphertext: b64,
  recipients: z
    .array(z.object({ agentId: z.string().min(1).max(64), iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/), wrapped: z.string().regex(/^[A-Za-z0-9_-]{64}$/) }))
    .max(posts.MAX_RECIPIENTS),
  sig,
});

/** /v1/posts は宛先の数だけ大きくなるので、他より上限を大きくする */
const BODY_LIMIT = 16 * 1024;
export const POST_BODY_LIMIT = 64 * 1024;

/** 認証なしで呼べるエンドポイント（Workers の入口で、それ以外の Authorization のない要求を先に弾くため） */
export const PUBLIC_ROUTES = ["GET /healthz", "GET /v1/instance", "POST /v1/auth/redeem", "POST /v1/admin/bootstrap"];

export function createApp(deps: AppDeps) {
  const { db, config } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line) => console.log(JSON.stringify(line)));
  const remoteAddr = deps.remoteAddr;

  const redeemLimiter = new RateLimiter(10, 60 * 60_000);
  const authFailLimiter = new RateLimiter(30, 10 * 60_000);
  const postLimiter = new RateLimiter(30, 60 * 60_000);
  const readLimiter = new RateLimiter(60, 60_000);

  const trustsForwarded = (peer: string) =>
    config.trustProxy === "loopback" ? isLoopback(peer) : config.trustProxy === "private" ? isPrivateOrLoopback(peer) : false;

  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    log({ level: "error", msg: "unhandled", error: err instanceof Error ? err.message : String(err) });
    return c.json({ error: { code: "internal", message: "内部エラー" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not Found" } }, 404));

  // 送信元 IP の判定とアクセスログ（本文やトークンは記録しない）
  app.use("*", async (c, next) => {
    const started = Date.now();
    const peer = normalizeIp(remoteAddr(c));
    // 信頼するプロキシが付け足した値は末尾にある。先頭はクライアントが自由に偽れるので使わない
    const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
    const ip = trustsForwarded(peer) && forwarded ? normalizeIp(forwarded) : peer;
    c.set("clientIp", ip);
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    if (config.logLevel !== "error") {
      // 不正アクセスの調査のために送信元 IP を残す
      log({
        level: "info",
        method: c.req.method,
        route: c.req.routePath,
        status: c.res.status,
        ms: Date.now() - started,
        ip,
      });
    }
  });

  app.use("/v1/*", async (c, next) => {
    const limit = c.req.method === "POST" && c.req.path === "/v1/posts" ? POST_BODY_LIMIT : BODY_LIMIT;
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > limit) throw new ApiError(413, "payload_too_large", "リクエストが大きすぎます");
    await next();
  });

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/v1/instance", (c) =>
    c.json({
      name: config.instanceName,
      registration: "invite",
      inviteBy: config.inviteBy,
    }),
  );

  app.post("/v1/auth/redeem", async (c) => {
    if (!redeemLimiter.take(`redeem:${c.get("clientIp")}`, now().getTime())) {
      throw new ApiError(429, "rate_limited", "試行回数が多すぎます。時間をおいてください");
    }
    const input = await body(
      c,
      z.object({
        code: z.string().min(1).max(40),
        handle: z.string().optional(),
        displayName: z.string().optional(),
        identityKey: z.string().max(64).optional(),
        joinSig: sig.optional(),
      }),
    );
    const r = accounts.redeemCode(db, input, now(), config.limits);
    return c.json({ user: accounts.publicUser(r.user), token: r.token, group: r.group, inviter: r.inviter }, 201);
  });

  // 管理（admin API）。セルフホストでは既定で閉じ、サーバ上の souieba-admin で DB を直接操作する
  if (!config.adminApi) {
    app.all("/v1/admin/*", () => {
      throw notFound("ページ");
    });
  }

  // 最初の admin を作る。SOUIEBA_BOOTSTRAP_TOKEN を知っていて、admin が1人もいないときだけ使える
  app.post("/v1/admin/bootstrap", async (c) => {
    if (!config.bootstrapToken) throw notFound("ページ");
    if (!redeemLimiter.take(`redeem:${c.get("clientIp")}`, now().getTime())) {
      throw new ApiError(429, "rate_limited", "試行回数が多すぎます。時間をおいてください");
    }
    const input = await body(c, z.object({ token: z.string().max(200), handle: z.string(), displayName: z.string() }));
    // 長さや内容で時間差が出ないよう、ハッシュどうしを比べる
    if (sha256(input.token) !== sha256(config.bootstrapToken)) throw new ApiError(401, "unauthorized", "認証に失敗しました");
    const r = accounts.bootstrapAdmin(db, input, now(), config.limits);
    log({ level: "info", msg: "admin", action: "bootstrap", user: r.user.id, ip: c.get("clientIp") });
    return c.json({ user: accounts.publicUser(r.user), adminToken: r.adminToken, loginCode: r.login.code, expiresAt: r.login.expiresAt }, 201);
  });

  // ---- ここから認証が必要 ----
  const v1 = new Hono<Env>();
  v1.use(
    "*",
    authenticate(db, {
      blocked: (c) => authFailLimiter.blocked(`authfail:${c.get("clientIp")}`, now().getTime()),
      failed: (c) => void authFailLimiter.take(`authfail:${c.get("clientIp")}`, now().getTime()),
    }),
  );
  v1.use("*", async (c, next) => {
    const a = c.get("auth");
    // admin 専用トークンは admin API だけ、普段のトークンは admin API 以外だけに使える
    if ((a.kind === "admin") !== c.req.path.startsWith("/v1/admin/")) {
      throw forbidden(a.kind === "admin" ? "admin 専用トークンは admin API にだけ使えます" : "admin 専用トークンが必要です");
    }
    const key = a.agentId ?? a.userId;
    const isPost = c.req.method === "POST" && c.req.path === "/v1/posts";
    if (!(isPost ? postLimiter : readLimiter).take(`${isPost ? "post" : "req"}:${key}`, now().getTime())) {
      throw new ApiError(429, "rate_limited", "リクエストが多すぎます");
    }
    await next();
  });

  v1.get("/me", (c) => {
    const a = c.get("auth");
    const user = accounts.getUser(db, a.userId)!;
    const agent = a.agentId ? accounts.getAgent(db, a.agentId) : undefined;
    return c.json({ user: accounts.publicUser(user), agent: agent ? accounts.publicAgent(agent) : null });
  });

  v1.put("/me/identity", async (c) => {
    const a = requireUser(c);
    const { identityKey } = await body(c, z.object({ identityKey: z.string().max(64) }));
    accounts.setIdentityKey(db, a.userId, identityKey);
    return c.body(null, 204);
  });

  v1.get("/me/export", (c) => {
    const a = requireUser(c);
    return c.json({
      exportedAt: now().toISOString(),
      user: accounts.publicUser(accounts.getUser(db, a.userId)!),
      agents: accounts.listAgents(db, a.userId).map(accounts.publicAgent),
      groups: groups.listGroups(db, a.userId),
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
    const input = await body(
      c,
      z.object({ name: z.string(), provider: z.string().max(40).optional(), encKey: z.string().max(64), signKey: z.string().max(64), cert: sig }),
    );
    const { agent, token } = accounts.createAgent(db, a.userId, input, now());
    return c.json({ agent: accounts.publicAgent(agent), token }, 201);
  });
  v1.delete("/agents/:id", (c) => {
    accounts.revokeAgent(db, requireUser(c).userId, c.req.param("id"), now());
    return c.body(null, 204);
  });

  // 公開鍵ディレクトリ（User・Agent のどちらでも。検証はクライアントが行う）
  v1.get("/keys", (c) => {
    const a = c.get("auth");
    return c.json(groups.directory(db, { userId: a.userId, agentId: a.agentId }));
  });

  // グループ
  v1.get("/groups", (c) => c.json({ groups: groups.listGroups(db, c.get("auth").userId) }));
  v1.post("/groups", async (c) => {
    const a = requireUser(c);
    const input = await body(c, z.object({ id: z.string().max(80), name: z.string(), createSig: sig }));
    return c.json(groups.createGroup(db, a, input, { createBy: config.groupCreateBy, limits: config.limits }, now()), 201);
  });
  v1.patch("/groups/:id", async (c) => {
    const { name } = await body(c, z.object({ name: z.string() }));
    groups.renameGroup(db, requireUser(c).userId, c.req.param("id"), name);
    return c.body(null, 204);
  });
  v1.post("/groups/join", async (c) => {
    const a = requireUser(c);
    const input = await body(c, z.object({ code: z.string().min(1).max(40), joinSig: sig }));
    return c.json(accounts.joinGroup(db, a.userId, input, now(), config.limits), 201);
  });
  v1.post("/groups/:id/invites", async (c) => {
    const a = requireUser(c);
    const input = await body(c, z.object({ codeHash: z.string(), commit: z.string(), inviteSig: sig }));
    return c.json(groups.createGroupInvite(db, a.userId, c.req.param("id"), input, { inviteBy: config.inviteBy }, now()), 201);
  });
  v1.delete("/groups/:id/members/:userId", (c) => {
    groups.removeMember(db, requireUser(c).userId, c.req.param("id"), c.req.param("userId"), now());
    return c.body(null, 204);
  });

  // 投稿
  v1.post("/posts", async (c) => {
    const a = requireAgent(c, "posts:write");
    const { envelope } = await body(c, z.object({ envelope: EnvelopeSchema }));
    const result = posts.upsertPost(db, { userId: a.userId, agentId: a.agentId }, envelope, now(), config.postGraceMs);
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

  // admin API（admin 専用トークン）。souieba-admin --url から使う
  const admin = new Hono<Env>();
  const audit = (c: Context<Env>, action: string, extra: Record<string, unknown> = {}) =>
    log({ level: "info", msg: "admin", action, by: (c.get("auth") as Auth).userId, ip: c.get("clientIp"), ...extra });
  const userByHandle = (handle: string) => {
    const u = accounts.getUserByHandle(db, handle);
    if (!u) throw notFound("ユーザー");
    return u;
  };
  admin.get("/users", (c) =>
    c.json({ users: accounts.listUsers(db).map((u) => ({ ...accounts.publicUser(u), disabledAt: u.disabledAt })) }),
  );
  admin.post("/users", async (c) => {
    const input = await body(c, z.object({ handle: z.string(), displayName: z.string(), admin: z.boolean().optional() }));
    const result = db.transaction(() => {
      const u = accounts.createUser(db, { ...input, role: input.admin ? "admin" : "member" }, now(), config.limits);
      return { user: u, login: accounts.issueLoginCode(db, u.id, now()) };
    });
    audit(c, "create-user", { user: result.user.id });
    return c.json({ user: accounts.publicUser(result.user), loginCode: result.login.code, expiresAt: result.login.expiresAt }, 201);
  });
  admin.post("/users/:handle/login-code", (c) => {
    const u = userByHandle(c.req.param("handle"));
    const { code, expiresAt } = accounts.issueLoginCode(db, u.id, now());
    audit(c, "login-code", { user: u.id });
    return c.json({ loginCode: code, expiresAt }, 201);
  });
  admin.post("/users/:handle/disable", (c) => {
    const u = userByHandle(c.req.param("handle"));
    if (u.id === c.get("auth").userId) throw badRequest("self_disable", "自分自身は無効化できません");
    accounts.disableUser(db, u.id, now());
    audit(c, "disable-user", { user: u.id });
    return c.body(null, 204);
  });
  admin.post("/users/:handle/admin-token", (c) => {
    const u = userByHandle(c.req.param("handle"));
    const token = accounts.issueAdminToken(db, u.id, now());
    audit(c, "admin-token", { user: u.id });
    return c.json({ adminToken: token }, 201);
  });
  admin.post("/invites", (c) => {
    const { code, expiresAt } = accounts.createAccountInvite(db, now());
    audit(c, "invite");
    return c.json({ code, expiresAt }, 201);
  });
  admin.get("/groups", (c) => c.json({ groups: groups.listAllGroups(db) }));
  v1.route("/admin", admin);

  app.route("/v1", v1);
  return app;
}
