import { sha256Hex } from "@souieba/core";

export { codeHash, newCode, normalizeCode } from "@souieba/core";

// Workers でも動くよう、node:crypto ではなく Web Crypto の乱数を使う
function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Buffer.from(randomBytes(8)).toString("hex")}`;
}

export const sha256 = sha256Hex;

const TOKEN_PREFIX = { user: "u", agent: "a", admin: "m" } as const;

export function newToken(kind: keyof typeof TOKEN_PREFIX): string {
  return `sou_${TOKEN_PREFIX[kind]}_${Buffer.from(randomBytes(32)).toString("base64url")}`;
}

/** 秘密の比較。長さや一致した位置で時間差が出ないよう、ハッシュどうしを全桁比べる */
export function safeEqual(a: string, b: string): boolean {
  const x = sha256(a);
  const y = sha256(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
