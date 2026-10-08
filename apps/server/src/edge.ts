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
  if (!clientIp(req)) return json(400, "bad_request", "送信元が分かりません");
  if (url.pathname !== "/healthz" && !url.pathname.startsWith("/v1/")) return json(404, "not_found", "Not Found");
  // Content-Length がない（chunked・HTTP/2 などの）要求は、Durable Object の中（app.ts の bodyLimit）で読みながら数えて打ち切る
  if (Number(req.headers.get("content-length") ?? 0) > POST_BODY_LIMIT) {
    return json(413, "payload_too_large", "リクエストが大きすぎます");
  }
  // HEAD は GET と同じ扱い（Hono も GET のルートで応答する）
  const method = req.method === "HEAD" ? "GET" : req.method;
  const isPublic = PUBLIC_ROUTES.includes(`${method} ${url.pathname}`);
  if (!isPublic && !/^Bearer\s+sou_[uam]_[A-Za-z0-9_-]+$/.test(req.headers.get("authorization") ?? "")) {
    return json(401, "unauthorized", "認証に失敗しました");
  }
  return null;
}

/**
 * 送信元 IP。Cloudflare が付ける CF-Connecting-IP はクライアントが偽れない。
 * Cloudflare を通った要求には必ず付くので、ない要求は入口（edgeGuard）で弾き、全員が同じキーを共有しないようにする
 */
export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "";
}

/** 認証なしで呼べる POST（招待コードの使用・ブートストラップ）。総当たりの対象なので、入口で別に厳しく数える */
export function isPublicPost(req: Request): boolean {
  return req.method === "POST" && PUBLIC_ROUTES.includes(`POST ${new URL(req.url).pathname}`);
}
