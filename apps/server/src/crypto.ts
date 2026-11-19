import { sha256Hex } from "@souieba/core";

// Workers でも動くよう、node:crypto ではなく Web Crypto の乱数を使う
function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export const sha256 = sha256Hex;

/** セッショントークンの形。入口（edge.ts）と認証（relay-routes.ts）で同じ判定を使う */
const RELAY_TOKEN_RE = /^Bearer\s+(sou_r_[A-Za-z0-9_-]+)$/;

export function newRelayToken(): string {
  return `sou_r_${Buffer.from(randomBytes(32)).toString("base64url")}`;
}

/** Authorization ヘッダから、セッショントークンを取り出す。形が違えば null */
export function bearerToken(header: string | null | undefined): string | null {
  return RELAY_TOKEN_RE.exec(header ?? "")?.[1] ?? null;
}
