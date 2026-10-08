/**
 * E2EE と署名。node:crypto だけで実装する（Skill の CLI を外部依存なしで配るため）。
 * 鍵は JWK の x（公開鍵）・d（秘密鍵）、つまり生の 32 バイトを base64url で扱う。
 */
import {
  type KeyObject,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { normalizeCode } from "./code.ts";
import type { EnvelopeRecipient, PostEnvelope, Visibility } from "./types.ts";

export type KeyPair = { pub: string; priv: string };
type Kind = "ed25519" | "x25519";

const CURVE = { ed25519: "Ed25519", x25519: "X25519" } as const;

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

function generate(kind: Kind): KeyPair {
  const { privateKey } = generateKeyPairSync(kind as "ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  return { pub: jwk.x!, priv: jwk.d! };
}

/** Identity 鍵・Agent 署名鍵 */
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
  if (typeof x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(x) || unb64(x).length !== 32) return false;
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

/** Identity 公開鍵の指紋（例: 4F2A-91C3-77DE）。招待コードに添えて、サーバの外で照合する */
export function fingerprint(identityKey: string): string {
  const hex = createHash("sha256").update(unb64(identityKey)).digest("hex").slice(0, 12).toUpperCase();
  return hex.replace(/(.{4})(?=.)/g, "$1-");
}

export function normalizeFingerprint(fp: string): string {
  return fp.toUpperCase().replace(/[^0-9A-F]/g, "").replace(/(.{4})(?=.)/g, "$1-");
}

// ---- 署名する文面 ----

export const signedText = {
  agentCert: (userId: string, encKey: string, signKey: string) => `souieba/agent/v1\n${userId}\n${encKey}\n${signKey}`,
  groupCreate: (groupId: string, userId: string) => `souieba/group-create/v1\n${groupId}\n${userId}`,
  invite: (groupId: string, inviterId: string, commit: string) => `souieba/invite/v1\n${groupId}\n${inviterId}\n${commit}`,
  join: (code: string) => `souieba/join/v1\n${normalizeCode(code)}`,
};

/** 招待コードへのコミットメント。サーバはここからコードを逆算できない（コードが十分長いため） */
export function inviteCommit(groupId: string, code: string): string {
  return b64(createHash("sha256").update(`souieba/invite-code/v1\n${groupId}\n${normalizeCode(code)}`).digest());
}

// ---- 投稿の封筒 ----

export type PostAuthor = { userId: string; agentId: string };

function aad(author: PostAuthor, env: Pick<PostEnvelope, "periodStart" | "periodEnd" | "visibility">): Buffer {
  return Buffer.from(
    `souieba/post-aad/v1\n${author.userId}\n${author.agentId}\n${env.periodStart}\n${env.periodEnd}\n${env.visibility}`,
    "utf8",
  );
}

function sortRecipients(rs: EnvelopeRecipient[]): EnvelopeRecipient[] {
  return [...rs].sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
}

/** 署名の対象。sig 以外の全フィールドと、投稿者（User・Agent）を含める */
export function postSigningText(author: PostAuthor, env: Omit<PostEnvelope, "sig">): string {
  const rs = sortRecipients(env.recipients).map((r) => `${r.agentId}.${r.iv}.${r.wrapped}`);
  return [
    "souieba/post/v1",
    author.userId,
    author.agentId,
    env.v,
    env.periodStart,
    env.periodEnd,
    env.visibility,
    env.epk,
    env.iv,
    env.ciphertext,
    rs.join(","),
  ].join("\n");
}

function wrapKey(shared: Buffer, epkPub: string, agentId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, unb64(epkPub), `souieba/wrap/v1\n${agentId}`, 32));
}

function gcmEncrypt(key: Buffer, plain: Buffer, additional?: Buffer): { iv: string; data: string } {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  if (additional) c.setAAD(additional);
  const data = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { iv: b64(iv), data: b64(data) };
}

function gcmDecrypt(key: Buffer, iv: string, data: string, additional?: Buffer): Buffer {
  const buf = unb64(data);
  if (buf.length < 16) throw new Error("ciphertext too short");
  const d = createDecipheriv("aes-256-gcm", key, unb64(iv));
  if (additional) d.setAAD(additional);
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]);
}

/**
 * 投稿を暗号化して署名する。本文は投稿ごとの鍵（CEK）で暗号化し、
 * CEK を宛先の Agent ごとに X25519 + HKDF で包む。
 */
export function sealPost(
  post: { periodStart: string; periodEnd: string; visibility: Visibility; content: string },
  author: PostAuthor & { signKey: KeyPair },
  recipients: { agentId: string; encKey: string }[],
): PostEnvelope {
  const header = { periodStart: post.periodStart, periodEnd: post.periodEnd, visibility: post.visibility };
  const cek = randomBytes(32);
  const body = gcmEncrypt(cek, Buffer.from(post.content, "utf8"), aad(author, header));
  const eph = generateEncryptionKey();
  const ephKey = privateKey("x25519", eph);
  const seen = new Set<string>();
  const wrapped: EnvelopeRecipient[] = [];
  for (const r of recipients) {
    if (seen.has(r.agentId)) continue;
    seen.add(r.agentId);
    const shared = diffieHellman({ privateKey: ephKey, publicKey: publicKey("x25519", r.encKey) });
    const w = gcmEncrypt(wrapKey(shared, eph.pub, r.agentId), cek);
    wrapped.push({ agentId: r.agentId, iv: w.iv, wrapped: w.data });
  }
  const unsigned: Omit<PostEnvelope, "sig"> = {
    v: 1,
    ...header,
    epk: eph.pub,
    iv: body.iv,
    ciphertext: body.data,
    recipients: sortRecipients(wrapped),
  };
  return { ...unsigned, sig: signText(author.signKey, postSigningText(author, unsigned)) };
}

export function verifyPostSignature(env: PostEnvelope, author: PostAuthor, signKey: string): boolean {
  const { sig, ...unsigned } = env;
  return verifyText(signKey, postSigningText(author, unsigned), sig);
}

export class DecryptError extends Error {}

/** 自分の Agent 宛ての CEK を開いて本文を復号する。署名の検証は呼び出し側で先に行う */
export function openPost(env: PostEnvelope, author: PostAuthor, me: { agentId: string; encKey: KeyPair }): string {
  const mine = env.recipients.find((r) => r.agentId === me.agentId);
  if (!mine) throw new DecryptError("この Agent 宛てではありません");
  try {
    const shared = diffieHellman({ privateKey: privateKey("x25519", me.encKey), publicKey: publicKey("x25519", env.epk) });
    const cek = gcmDecrypt(wrapKey(shared, env.epk, me.agentId), mine.iv, mine.wrapped);
    return gcmDecrypt(cek, env.iv, env.ciphertext, aad(author, env)).toString("utf8");
  } catch {
    throw new DecryptError("復号できません");
  }
}
