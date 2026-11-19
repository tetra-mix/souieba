import { CLIENT_VERSION_HEADER, compareVersions } from "@souieba/core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "./body-limit.ts";
import type { Config } from "./config.ts";
import type { DB } from "./db/index.ts";
import { ApiError } from "./errors.ts";
import { isLoopback, isPrivateOrLoopback, normalizeIp } from "./net.ts";
import { RELAY_PUBLIC_ROUTES, isLargeRelayBody, relayRoutes } from "./relay-routes.ts";

export const VERSION = "2.2.0";

export type Env = { Variables: { clientIp: string } };

/**
 * これより古いクライアントと、バージョンを送らないクライアントは 426 で断る（黙って壊れないように、更新を促す）。
 * API に互換性のない変更をしたら上げる
 */
export const MIN_CLIENT_VERSION = "2.1.0";

export type AppDeps = {
  db: DB;
  config: Config;
  now?: () => Date;
  /** 直前の接続元の IP。Node では接続情報、Workers では CF-Connecting-IP から取る */
  remoteAddr: (c: Context<Env>) => string;
  log?: (line: Record<string, unknown>) => void;
};

const BODY_LIMIT = 16 * 1024;
/** メッセージは宛先の端末の数だけ大きくなるので、他より上限を大きくする */
export const POST_BODY_LIMIT = 256 * 1024;

/** 認証なしで呼べるエンドポイント（Workers の入口で、それ以外の Authorization のない要求を先に弾くため） */
export const PUBLIC_ROUTES = ["GET /healthz", ...RELAY_PUBLIC_ROUTES];

export function createApp(deps: AppDeps) {
  const { db, config } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line) => console.log(JSON.stringify(line)));
  const remoteAddr = deps.remoteAddr;

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

  // Content-Length がない（chunked の）要求も、読みながら数えて上限を超えたところで打ち切る
  const limitBody = bodyLimit(BODY_LIMIT);
  const limitPostBody = bodyLimit(POST_BODY_LIMIT);
  app.use("/v2/*", (c, next) => (isLargeRelayBody(c.req.method, c.req.path) ? limitPostBody : limitBody)(c, next));

  app.get("/healthz", (c) => c.json({ ok: true }));

  // クライアントのバージョンを確かめる
  const checkClientVersion = async (c: Context<Env>, next: () => Promise<void>) => {
    const v = c.req.header(CLIENT_VERSION_HEADER);
    if (!v || compareVersions(v, MIN_CLIENT_VERSION) < 0) {
      throw new ApiError(
        426,
        "client_outdated",
        `souieba の CLI が古いため使えません（${v ?? "不明"}、必要: ${MIN_CLIENT_VERSION} 以上）。npm i -g souieba@latest で更新し、npx skills update でスキルも更新してください`,
      );
    }
    await next();
  };
  app.use("/v2/*", checkClientVersion);

  // v2 の Relay（端末の署名鍵で認証する）
  app.route("/v2", relayRoutes({ db, config, now }) as never);

  return app;
}
