import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const unauthorized = () => new ApiError(401, "unauthorized", "認証に失敗しました");
export const forbidden = (msg = "この操作の権限がありません") => new ApiError(403, "forbidden", msg);
export const notFound = (what = "リソース") => new ApiError(404, "not_found", `${what}が見つかりません`);
export const badRequest = (code: string, msg: string) => new ApiError(400, code, msg);
export const conflict = (code: string, msg: string) => new ApiError(409, code, msg);
export const invalidCode = () => new ApiError(400, "invalid_code", "コードが無効か、期限が切れています");
export const tooManyRequests = (msg = "リクエストが多すぎます") => new ApiError(429, "rate_limited", msg);
