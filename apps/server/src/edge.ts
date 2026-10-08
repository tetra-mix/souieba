/**
 * Workers の入口で、Durable Object に渡す前に弾く検査。
 * Durable Object へのリクエストはアカウント全体の無料枠・課金に数えられるので、明らかに通らない要求はここで返す。
 * トークンの検証やレート制限の本体は、今までどおり Durable Object の中（app.ts）で行う。
 */
import { POST_BODY_LIMIT, PUBLIC_ROUTES } from "./app.ts";

const json = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** 通してよければ null、弾くならそのレスポンスを返す */
export function edgeGuard(req: Request): Response | null {
  const url = new URL(req.url);
  if (url.pathname !== "/healthz" && !url.pathname.startsWith("/v1/")) return json(404, "not_found", "Not Found");
  if (Number(req.headers.get("content-length") ?? 0) > POST_BODY_LIMIT) {
    return json(413, "payload_too_large", "リクエストが大きすぎます");
  }
  const isPublic = PUBLIC_ROUTES.includes(`${req.method} ${url.pathname}`);
  if (!isPublic && !/^Bearer\s+sou_[uam]_[A-Za-z0-9_-]+$/.test(req.headers.get("authorization") ?? "")) {
    return json(401, "unauthorized", "認証に失敗しました");
  }
  return null;
}

/** 送信元 IP ごとのレート制限に使うキー。Cloudflare が付ける CF-Connecting-IP はクライアントが偽れない */
export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "";
}
