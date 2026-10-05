import { createHash, randomBytes, randomInt } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(8).toString("hex")}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newToken(kind: "user" | "agent"): string {
  return `sou_${kind === "user" ? "u" : "a"}_${randomBytes(32).toString("base64url")}`;
}

// 読み間違えやすい文字（0/O, 1/I/L）を除いた32文字
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** 招待・ログイン用のコード（例: K7QF-2MXP-9WRT） */
export function newCode(): string {
  const chars = Array.from({ length: 12 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
  return [0, 4, 8].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(.{4})(?=.)/g, "$1-");
}
