import { sha256Hex } from "@souieba/core";

// Workers でも動くよう、node:crypto ではなく Web Crypto の乱数を使う
function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export const sha256 = sha256Hex;

const TOKEN_PREFIX = { relay: "r" } as const;

export function newToken(kind: keyof typeof TOKEN_PREFIX): string {
  return `sou_${TOKEN_PREFIX[kind]}_${Buffer.from(randomBytes(32)).toString("base64url")}`;
}
