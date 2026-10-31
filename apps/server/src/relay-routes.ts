/**
 * v2 の Relay の API（/v2/*）。v1 のトークン（User・Agent）とは別に、Identity 鍵の署名で得たセッショントークン（sou_r_）で認証する。
 * 設計: docs/v2-design.md、決めごと: docs/v2-relay-plan.md
 */
import { MAX_RELAY_RECIPIENTS, type RelayEnvelope } from "@souieba/core";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { Config } from "./config.ts";
import type { DB } from "./db/index.ts";
import { ApiError, badRequest, tooManyRequests, unauthorized } from "./errors.ts";
import { rateLimitKey } from "./net.ts";
import { RateLimiter } from "./ratelimit.ts";
import * as relay from "./services/relay.ts";

export type RelayEnv = { Variables: { clientIp: string; relayAgentId: string } };

/** 認証なしで呼べる v2 のエンドポイント */
export const RELAY_PUBLIC_ROUTES = ["POST /v2/agents", "POST /v2/auth/challenge", "POST /v2/auth/session"];

/** 宛先の数だけ大きくなるので、他より大きい上限にする（app.ts の POST_BODY_LIMIT を使う） */
export const isLargeRelayBody = (method: string, path: string) => method === "POST" && path === "/v2/messages";

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

const agentId = z.string().regex(/^sb_[a-z2-7]{32}$/);
const key = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const sig = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
const iso = z.string().max(40);

const EntrySchema = z.object({
  agentId,
  identityKey: key,
  encKey: key,
  encKeyVersion: z.number().int().min(1).max(1_000_000),
  encKeySig: sig,
});

const BoxSchema = z.object({
  agentId,
  keyVersion: z.number().int().min(1).max(1_000_000),
  enc: key,
  // HPKE で包んだ32バイトの鍵とタグ（48バイト）
  wrapped: z.string().regex(/^[A-Za-z0-9_-]{64}$/),
  sig,
});

const EnvelopeSchema = z.object({
  v: z.literal(2),
  suite: z.literal("x25519-hkdfsha256-chacha20poly1305"),
  messageId: z.string().regex(/^msg_[A-Za-z0-9_-]{22}$/),
  sender: agentId,
  createdAt: iso,
  deliveryExpiresAt: iso,
  iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  // 本文（120字）と Narrator の項目（各60字）の JSON を暗号化したもの。数 KB に収まる
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]{1,8192}$/),
  recipients: z.array(BoxSchema).min(1).max(MAX_RELAY_RECIPIENTS),
});

export function relayRoutes(deps: { db: DB; config: Config; now: () => Date }) {
  const { db, config, now } = deps;
  const app = new Hono<RelayEnv>();

  const publicLimiter = new RateLimiter(30, 10 * 60_000);
  const registerLimiter = new RateLimiter(10, 60 * 60_000);
  // 登録は消えないので、長い期間でも数える（多くの IP から上限まで埋められにくくする）
  const registerDailyLimiter = new RateLimiter(20, 24 * 60 * 60_000);
  const sendLimiter = new RateLimiter(30, 60 * 60_000);
  const connectLimiter = new RateLimiter(30, 60 * 60_000);
  const readLimiter = new RateLimiter(60, 60_000);

  const ipKey = (c: Context<RelayEnv>) => rateLimitKey(c.get("clientIp"));
  const take = (limiter: RateLimiter, k: string) => {
    if (!limiter.take(k, now().getTime())) throw tooManyRequests();
  };

  if (!config.relay.enabled) {
    app.all("*", () => {
      throw new ApiError(404, "relay_disabled", "この サーバでは v2 の Relay を使えません");
    });
    return app;
  }

  // ---- 認証なし ----

  app.post("/agents", async (c) => {
    take(registerLimiter, `register:${ipKey(c)}`);
    take(registerDailyLimiter, `register-day:${ipKey(c)}`);
    const { entry } = await body(c, z.object({ entry: EntrySchema }));
    const r = relay.register(db, entry, now(), { maxAgents: config.relay.maxAgents });
    return c.json({ entry: r.entry }, r.created ? 201 : 200);
  });

  app.post("/auth/challenge", async (c) => {
    take(publicLimiter, `challenge:${ipKey(c)}`);
    const input = await body(c, z.object({ agentId }));
    return c.json(relay.issueChallenge(db, input.agentId, now()), 201);
  });

  app.post("/auth/session", async (c) => {
    take(publicLimiter, `session:${ipKey(c)}`);
    const input = await body(c, z.object({ agentId, challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), sig }));
    return c.json(relay.openSession(db, input, config.publicUrl, now()), 201);
  });

  // ---- ここから認証が必要 ----

  const authed = new Hono<RelayEnv>();
  authed.use("*", async (c, next) => {
    const m = /^Bearer\s+(sou_r_[A-Za-z0-9_-]+)$/.exec(c.req.header("authorization") ?? "");
    const me = m ? relay.sessionAgent(db, m[1]!, now()) : null;
    if (!me) throw unauthorized();
    c.set("relayAgentId", me);
    take(readLimiter, `relay:${me}`);
    await next();
  });
  const me = (c: Context<RelayEnv>) => c.get("relayAgentId");

  authed.get("/me", (c) => c.json({ entry: relay.lookup(db, [me(c)])[0] ?? null }));
  authed.put("/me/enc-key", async (c) => {
    const input = await body(c, EntrySchema.pick({ encKey: true, encKeyVersion: true, encKeySig: true }));
    return c.json({ entry: relay.rotateEncKey(db, me(c), input, now()) });
  });

  // 公開鍵ディレクトリ。返すのは接続に要る鍵だけ（§5.1）
  authed.get("/agents/:id", (c) => {
    const e = relay.lookup(db, [c.req.param("id")])[0];
    if (!e) throw new ApiError(404, "not_found", "Agent が見つかりません");
    return c.json({ entry: e });
  });
  authed.post("/agents/lookup", async (c) => {
    const { agentIds } = await body(c, z.object({ agentIds: z.array(z.string().max(64)).max(MAX_RELAY_RECIPIENTS) }));
    return c.json({ entries: relay.lookup(db, agentIds) });
  });

  // 接続
  authed.get("/connections", (c) => c.json(relay.listConnections(db, me(c))));
  authed.post("/connections", async (c) => {
    take(connectLimiter, `connect:${me(c)}`);
    const { to } = await body(c, z.object({ to: agentId }));
    return c.json({ connection: relay.requestConnection(db, me(c), to, now()) }, 201);
  });
  authed.post("/connections/:peer/accept", (c) => c.json({ connection: relay.acceptConnection(db, me(c), c.req.param("peer"), now()) }));
  authed.post("/connections/:peer/reject", (c) => {
    relay.rejectConnection(db, me(c), c.req.param("peer"));
    return c.body(null, 204);
  });
  authed.delete("/connections/:peer", (c) => {
    relay.disconnect(db, me(c), c.req.param("peer"));
    return c.body(null, 204);
  });
  authed.put("/blocks/:peer", (c) => {
    relay.block(db, me(c), c.req.param("peer"), now());
    return c.body(null, 204);
  });
  authed.delete("/blocks/:peer", (c) => {
    relay.unblock(db, me(c), c.req.param("peer"));
    return c.body(null, 204);
  });

  // メッセージ
  authed.post("/messages", async (c) => {
    take(sendLimiter, `send:${me(c)}`);
    const { envelope } = await body(c, z.object({ envelope: EnvelopeSchema }));
    const r = relay.sendMessage(db, me(c), envelope as RelayEnvelope, now(), config.postGraceMs);
    return c.json(r, r.accepted.length > 0 ? 201 : 200);
  });
  authed.get("/messages", (c) => c.json({ messages: relay.fetchMessages(db, me(c), now()) }));
  authed.post("/messages/ack", async (c) => {
    const { messageIds } = await body(c, z.object({ messageIds: z.array(z.string().max(40)).max(relay.MAX_FETCH) }));
    return c.json({ acked: relay.ackMessages(db, me(c), messageIds, now()) });
  });
  authed.get("/messages/sent", (c) => c.json({ messages: relay.listSent(db, me(c), now()) }));
  authed.delete("/messages/:id", (c) => {
    relay.deleteMessage(db, me(c), c.req.param("id"));
    return c.body(null, 204);
  });

  app.route("/", authed);
  return app;
}
