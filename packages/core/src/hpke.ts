/**
 * HPKE（RFC 9180）の Base モード、1回だけの Seal / Open。
 * 暗号スイートは DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20-Poly1305 に固定する（MLS などでも使われる組み合わせ）。
 * 独自の暗号ではなく、RFC の手順を node:crypto の部品（X25519・HMAC-SHA256・ChaCha20-Poly1305）でそのまま組んだもの。
 * 他の実装（@hpke/core）と相互に復号できることを test/hpke.test.ts で確かめている。
 * Skill の CLI を外部依存なしで配るため、ライブラリは使わない（crypto.ts と同じ方針）。
 */
import {
  type KeyObject,
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
} from "node:crypto";

const KEM_ID = 0x0020; // DHKEM(X25519, HKDF-SHA256)
const KDF_ID = 0x0001; // HKDF-SHA256
const AEAD_ID = 0x0003; // ChaCha20-Poly1305
const N_SECRET = 32;
const N_ENC = 32;
const N_K = 32;
const N_N = 12;
const N_T = 16;

/** この実装の暗号スイート。メッセージに記録して、将来スイートを変えたときに見分けられるようにする */
export const HPKE_SUITE = "x25519-hkdfsha256-chacha20poly1305";

const enc = new TextEncoder();
const bytes = (s: string) => Buffer.from(enc.encode(s));

function i2osp(n: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  b.writeUIntBE(n, 0, len);
  return b;
}

const KEM_SUITE = Buffer.concat([bytes("KEM"), i2osp(KEM_ID, 2)]);
const HPKE_SUITE_ID = Buffer.concat([bytes("HPKE"), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2)]);
const VERSION_LABEL = bytes("HPKE-v1");

function extract(salt: Buffer, ikm: Buffer): Buffer {
  return createHmac("sha256", salt).update(ikm).digest();
}

function expand(prk: Buffer, info: Buffer, length: number): Buffer {
  const out: Buffer[] = [];
  let prev = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(out).length < length; i++) {
    prev = createHmac("sha256", prk).update(Buffer.concat([prev, info, Buffer.from([i])])).digest();
    out.push(prev);
  }
  return Buffer.concat(out).subarray(0, length);
}

function labeledExtract(suite: Buffer, salt: Buffer, label: string, ikm: Buffer): Buffer {
  return extract(salt, Buffer.concat([VERSION_LABEL, suite, bytes(label), ikm]));
}

function labeledExpand(suite: Buffer, prk: Buffer, label: string, info: Buffer, length: number): Buffer {
  return expand(prk, Buffer.concat([i2osp(length, 2), VERSION_LABEL, suite, bytes(label), info]), length);
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

function x25519Public(raw: Buffer): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: b64(raw) }, format: "jwk" });
}

function x25519Private(pub: Buffer, priv: Buffer): KeyObject {
  return createPrivateKey({ key: { kty: "OKP", crv: "X25519", x: b64(pub), d: b64(priv) }, format: "jwk" });
}

function dh(priv: KeyObject, pub: KeyObject): Buffer {
  const out = diffieHellman({ privateKey: priv, publicKey: pub });
  // 小さい位数の点などで共有秘密がすべて 0 になる場合は断る（RFC 9180 §7.1.4）
  if (out.every((b) => b === 0)) throw new HpkeError("不正な公開鍵です");
  return out;
}

function extractAndExpand(dhOut: Buffer, kemContext: Buffer): Buffer {
  const prk = labeledExtract(KEM_SUITE, Buffer.alloc(0), "eae_prk", dhOut);
  return labeledExpand(KEM_SUITE, prk, "shared_secret", kemContext, N_SECRET);
}

function keySchedule(sharedSecret: Buffer, info: Buffer): { key: Buffer; nonce: Buffer } {
  const mode = Buffer.from([0x00]); // mode_base
  const pskIdHash = labeledExtract(HPKE_SUITE_ID, Buffer.alloc(0), "psk_id_hash", Buffer.alloc(0));
  const infoHash = labeledExtract(HPKE_SUITE_ID, Buffer.alloc(0), "info_hash", info);
  const context = Buffer.concat([mode, pskIdHash, infoHash]);
  const secret = labeledExtract(HPKE_SUITE_ID, sharedSecret, "secret", Buffer.alloc(0));
  return {
    key: labeledExpand(HPKE_SUITE_ID, secret, "key", context, N_K),
    nonce: labeledExpand(HPKE_SUITE_ID, secret, "base_nonce", context, N_N),
  };
}

export class HpkeError extends Error {}

export type HpkeSealed = {
  /** カプセル化した鍵（送信側の一時公開鍵、base64url） */
  enc: string;
  /** 暗号文とタグ（base64url） */
  ct: string;
};

/**
 * 受信者の X25519 公開鍵（生の32バイトの base64url）に対して、平文を1回だけ封をする。
 * info と aad は送受信で同じものを使う（宛先やメッセージの文脈を縛るため）。
 */
export function hpkeSeal(recipientPub: string, info: string, aad: string, plaintext: Uint8Array): HpkeSealed {
  const pkRm = unb64(recipientPub);
  if (pkRm.length !== N_ENC) throw new HpkeError("公開鍵の長さが不正です");
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const encRaw = unb64(publicKey.export({ format: "jwk" }).x!);
  const shared = extractAndExpand(dh(privateKey, x25519Public(pkRm)), Buffer.concat([encRaw, pkRm]));
  const { key, nonce } = keySchedule(shared, bytes(info));
  // 1回だけの Seal なので、シーケンス番号は 0（nonce は base_nonce そのもの）
  const c = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: N_T });
  c.setAAD(bytes(aad), { plaintextLength: plaintext.length });
  const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  return { enc: b64(encRaw), ct: b64(ct) };
}

/** hpkeSeal で封をしたものを、受信者の鍵ペアで開く。失敗したら HpkeError */
export function hpkeOpen(recipient: { pub: string; priv: string }, sealed: HpkeSealed, info: string, aad: string): Buffer {
  try {
    const encRaw = unb64(sealed.enc);
    const ct = unb64(sealed.ct);
    const pkRm = unb64(recipient.pub);
    if (encRaw.length !== N_ENC || pkRm.length !== N_ENC || ct.length < N_T) throw new HpkeError("形式が不正です");
    const skR = x25519Private(pkRm, unb64(recipient.priv));
    const shared = extractAndExpand(dh(skR, x25519Public(encRaw)), Buffer.concat([encRaw, pkRm]));
    const { key, nonce } = keySchedule(shared, bytes(info));
    const d = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: N_T });
    d.setAAD(bytes(aad), { plaintextLength: ct.length - N_T });
    d.setAuthTag(ct.subarray(ct.length - N_T));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - N_T)), d.final()]);
  } catch (err) {
    if (err instanceof HpkeError) throw err;
    throw new HpkeError("復号できません");
  }
}
