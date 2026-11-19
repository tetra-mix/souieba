/**
 * 署名と鍵の扱い。node:crypto だけで実装する（Skill の CLI を外部依存なしで配るため）。
 * 鍵は JWK の x（公開鍵）・d（秘密鍵）、つまり生の 32 バイトを base64url で扱う。
 */
import { type KeyObject, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { b64, unb64 } from "./base64.ts";

export type KeyPair = { pub: string; priv: string };
type Kind = "ed25519" | "x25519";

const CURVE = { ed25519: "Ed25519", x25519: "X25519" } as const;


function generate(kind: Kind): KeyPair {
  const { privateKey } = generateKeyPairSync(kind as "ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  return { pub: jwk.x!, priv: jwk.d! };
}

/** Agent 署名鍵 */
export const generateSigningKey = () => generate("ed25519");
/** Agent 暗号鍵 */
export const generateEncryptionKey = () => generate("x25519");

function privateKey(kind: Kind, kp: KeyPair): KeyObject {
  return createPrivateKey({ key: { kty: "OKP", crv: CURVE[kind], x: kp.pub, d: kp.priv }, format: "jwk" });
}

function publicKey(kind: Kind, x: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: CURVE[kind], x }, format: "jwk" });
}

export function isPublicKey(kind: Kind, x: unknown): x is string {
  // 往復して同じ文字列に戻るものだけ（末尾の余りビットが違う、別の書き方の鍵を同じ鍵として扱わない）
  if (typeof x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(x) || unb64(x).length !== 32 || b64(unb64(x)) !== x) return false;
  try {
    publicKey(kind, x);
    return true;
  } catch {
    return false;
  }
}

export function signText(kp: KeyPair, text: string): string {
  return b64(sign(null, Buffer.from(text, "utf8"), privateKey("ed25519", kp)));
}

export function verifyText(pub: string, text: string, sig: string): boolean {
  try {
    return verify(null, Buffer.from(text, "utf8"), publicKey("ed25519", pub), unb64(sig));
  } catch {
    return false;
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
