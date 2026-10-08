import { createHash, randomInt } from "node:crypto";

// 読み間違えやすい文字（0/O, 1/I/L）を除いた31文字
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** ログインコードの長さ（約 59 ビット。サーバが発行し、ハッシュしか保存しない） */
export const LOGIN_CODE_LENGTH = 12;
/**
 * グループへの招待コードの長さ（約 99 ビット）。サーバは codeHash と commit を持つので、
 * 短いとサーバがコードを総当たりで逆算し、偽のメンバーを作れてしまう
 */
export const GROUP_INVITE_CODE_LENGTH = 20;

/** 招待・ログイン用のコード（例: K7QF-2MXP-9WRT） */
export function newCode(length = LOGIN_CODE_LENGTH): string {
  const chars = Array.from({ length }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  return chars.replace(/(.{4})(?=.)/g, "$1-");
}

export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(.{4})(?=.)/g, "$1-");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** サーバがコードの照合に使うハッシュ */
export function codeHash(code: string): string {
  return sha256Hex(normalizeCode(code));
}
