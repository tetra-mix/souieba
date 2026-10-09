/**
 * E2EE と署名。node:crypto だけで実装する（Skill の CLI を外部依存なしで配るため）。
 * 鍵は JWK の x（公開鍵）・d（秘密鍵）、つまり生の 32 バイトを base64url で扱う。
 */
import {
  type KeyObject,
  createCipheriv,
  createDecipheriv,
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
import type { EnvelopeRecipient, GroupNameBox, PostEnvelope, Visibility } from "./types.ts";

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

// ---- グループ名 ----
// グループ名はメンバーの Agent ごとに封をする（docs/public-deployment-plan.md §14）。
// 封をした Agent が署名するので、受信側はそれが今いっしょにグループにいる人の Agent かを確かめる。

function groupNameAad(box: Pick<GroupNameBox, "groupId" | "version" | "recipientAgentId">): Buffer {
  return Buffer.from(`souieba/group-name/v1\n${box.groupId}\n${box.version}\n${box.recipientAgentId}`);
}

function groupNameSigningText(box: Omit<GroupNameBox, "sig">): string {
  return ["souieba/group-name/v1", box.groupId, box.version, box.senderAgentId, box.recipientAgentId, box.epk, box.iv, box.ciphertext].join("\n");
}

export function sealGroupName(
  name: string,
  ctx: { groupId: string; version: number },
  sender: { agentId: string; signKey: KeyPair },
  recipient: { agentId: string; encKey: string },
): GroupNameBox {
  const eph = generateEncryptionKey();
  const shared = diffieHellman({ privateKey: privateKey("x25519", eph), publicKey: publicKey("x25519", recipient.encKey) });
  const head = { groupId: ctx.groupId, version: ctx.version, recipientAgentId: recipient.agentId };
  const body = gcmEncrypt(wrapKey(shared, eph.pub, recipient.agentId), Buffer.from(name, "utf8"), groupNameAad(head));
  const unsigned: Omit<GroupNameBox, "sig"> = { v: 1, ...head, senderAgentId: sender.agentId, epk: eph.pub, iv: body.iv, ciphertext: body.data };
  return { ...unsigned, sig: signText(sender.signKey, groupNameSigningText(unsigned)) };
}

export function verifyGroupNameBox(box: GroupNameBox, senderSignKey: string): boolean {
  const { sig, ...unsigned } = box;
  return verifyText(senderSignKey, groupNameSigningText(unsigned), sig);
}

/** 自分の Agent 宛てのグループ名を復号する。署名の検証は呼び出し側で先に行う */
export function openGroupName(box: GroupNameBox, me: { agentId: string; encKey: KeyPair }): string {
  if (box.recipientAgentId !== me.agentId) throw new DecryptError("この Agent 宛てではありません");
  try {
    const shared = diffieHellman({ privateKey: privateKey("x25519", me.encKey), publicKey: publicKey("x25519", box.epk) });
    return gcmDecrypt(wrapKey(shared, box.epk, me.agentId), box.iv, box.ciphertext, groupNameAad(box)).toString("utf8");
  } catch {
    throw new DecryptError("復号できません");
  }
}

/**
 * 招待コードから作る鍵。参加する前の人は Agent の鍵を持っていないので、招待者がこの鍵でグループ名を封をして招待に添える。
 * サーバはコードの sha256 しか保存しないので、DB からこの鍵は作れない。
 */
function inviteNameKey(code: string, groupId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", normalizeCode(code), "souieba/invite-name/v1", groupId, 32));
}

export function sealInviteName(name: string, code: string, groupId: string): string {
  const { iv, data } = gcmEncrypt(inviteNameKey(code, groupId), Buffer.from(name, "utf8"), Buffer.from(groupId));
  return `${iv}.${data}`;
}

export function openInviteName(box: string, code: string, groupId: string): string {
  const [iv, data] = box.split(".");
  if (!iv || !data) throw new DecryptError("形式が不正です");
  try {
    return gcmDecrypt(inviteNameKey(code, groupId), iv, data, Buffer.from(groupId)).toString("utf8");
  } catch {
    throw new DecryptError("復号できません");
  }
}
