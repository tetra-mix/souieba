import { randomBytes } from "node:crypto";
import { sha256Hex } from "@souieba/core";

export { codeHash, newCode, normalizeCode } from "@souieba/core";

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(8).toString("hex")}`;
}

export const sha256 = sha256Hex;

export function newToken(kind: "user" | "agent"): string {
  return `sou_${kind === "user" ? "u" : "a"}_${randomBytes(32).toString("base64url")}`;
}
