/**
 * Souieba v2（Relay）の Identity・署名・メッセージ形式。設計: docs/v2-design.md、実装の決めごと: docs/v2-relay-plan.md
 *
 * - Agent ごとに Identity 鍵（Ed25519）と Encryption 鍵（X25519）を持つ。アカウントやトークンは要らない
 * - Agent ID は Identity 公開鍵のハッシュから作る（自己証明的。ID を知っていれば Relay が返す鍵が本物か確かめられる）
 * - Encryption 公開鍵は Identity 鍵で署名する（Relay が鍵をすり替えても、送信側が気づける）
 * - 本文は使い捨ての鍵 K で AES-256-GCM、K は受信者ごとに HPKE で包み、受信者ごとに送信者が署名する
 *   （受信者ごとに別の署名にするのは、他の受信者が誰かを Relay から各受信者へ渡さずに済ませるため）
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { type KeyPair, generateEncryptionKey, generateSigningKey, isPublicKey, signText, verifyText } from "./crypto.ts";
import { HPKE_SUITE, HpkeError, hpkeOpen, hpkeSeal, isUsableX25519Key } from "./hpke.ts";
import { MAX_POST_LENGTH, MIN_TELL_CONTENT_LENGTH, findInstructionLike, sanitizeContent } from "./sanitize.ts";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

// ---- Identity ----

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export const AGENT_ID_RE = /^sb_[a-z2-7]{32}$/;

/** Identity 公開鍵（Ed25519、生の32バイトの base64url）から Agent ID を作る。sha256 の先頭160ビットを base32 にしたもの */
export function deriveAgentId(identityKey: string): string {
  return `sb_${base32(createHash("sha256").update(unb64(identityKey)).digest().subarray(0, 20))}`;
}

export function isAgentId(id: unknown): id is string {
  return typeof id === "string" && AGENT_ID_RE.test(id);
}

/** Relay の公開鍵ディレクトリの1件 */
export type RelayDirectoryEntry = {
  agentId: string;
  identityKey: string;
  encKey: string;
  encKeyVersion: number;
  /** Identity 鍵による Encryption 鍵への署名 */
  encKeySig: string;
};

export function encKeySigningText(agentId: string, encKey: string, version: number): string {
  return ["souieba/v2/enc-key", agentId, encKey, String(version)].join("\n");
}

export type RelayIdentity = {
  agentId: string;
  identity: KeyPair;
  enc: KeyPair;
  encKeyVersion: number;
};

/** 新しい Identity を作る（初回セットアップ。docs/v2-design.md §4.3） */
export function generateRelayIdentity(): RelayIdentity {
  const identity = generateSigningKey();
  return { agentId: deriveAgentId(identity.pub), identity, enc: generateEncryptionKey(), encKeyVersion: 1 };
}

/** 自分の鍵から、Relay に登録するディレクトリの1件を作る */
export function directoryEntry(me: RelayIdentity): RelayDirectoryEntry {
  return {
    agentId: me.agentId,
    identityKey: me.identity.pub,
    encKey: me.enc.pub,
    encKeyVersion: me.encKeyVersion,
    encKeySig: signText(me.identity, encKeySigningText(me.agentId, me.enc.pub, me.encKeyVersion)),
  };
}

export type DirectoryCheck = { ok: true } | { ok: false; reason: "bad_agent_id" | "bad_key" | "bad_enc_key_sig" };

/** ディレクトリの1件が、自己矛盾なく正しいか（Agent ID と Identity 鍵の対応、Encryption 鍵の署名） */
export function verifyDirectoryEntry(e: RelayDirectoryEntry): DirectoryCheck {
  if (!isPublicKey("ed25519", e.identityKey) || !isPublicKey("x25519", e.encKey) || !isUsableX25519Key(e.encKey)) {
    return { ok: false, reason: "bad_key" };
  }
  if (!Number.isInteger(e.encKeyVersion) || e.encKeyVersion < 1) return { ok: false, reason: "bad_key" };
  if (deriveAgentId(e.identityKey) !== e.agentId) return { ok: false, reason: "bad_agent_id" };
  if (!verifyText(e.identityKey, encKeySigningText(e.agentId, e.encKey, e.encKeyVersion), e.encKeySig)) {
    return { ok: false, reason: "bad_enc_key_sig" };
  }
  return { ok: true };
}

// ---- Relay への認証（チャレンジ・レスポンス） ----

/** 署名するチャレンジの文面。Relay の origin を含めるので、別の Relay への使い回しはできない */
export function authSigningText(relayOrigin: string, agentId: string, challenge: string): string {
  return ["souieba/v2/auth", relayOrigin, agentId, challenge].join("\n");
}

export function signChallenge(me: Pick<RelayIdentity, "agentId" | "identity">, relayOrigin: string, challenge: string): string {
  return signText(me.identity, authSigningText(relayOrigin, me.agentId, challenge));
}

// ---- Narrative Message（暗号化される本文） ----

/** Narrator の各項目（目的・ニュアンス・会話の文脈）の上限 */
export const MAX_NARRATIVE_FIELD_LENGTH = 60;
/** 配送期限・利用期限の上限（作成から） */
export const MAX_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 既定の配送期限（Relay が未配送のまま持つ期間） */
export const DEFAULT_DELIVERY_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** 既定の利用期限（受信側が Tell に使ってよい期間）。v1 の Tell の対象期間（48時間）に合わせる */
export const DEFAULT_USE_TTL_MS = 48 * 60 * 60 * 1000;
/** 1つのメッセージの宛先の上限 */
export const MAX_RELAY_RECIPIENTS = 50;

export type Reshare = "deny" | "allow";

/** 送信側 Agent が書く共有内容と、どう伝えてほしいかの意図（docs/v2-design.md §9） */
export type NarrativeMessage = {
  v: 1;
  /** 共有内容（「主人は〜」の三人称） */
  content: string;
  /** 共有目的（なぜ伝えたいか） */
  purpose?: string;
  /** ニュアンス（どんな調子で伝えてほしいか） */
  nuance?: string;
  /** 推奨する会話の文脈（どんな話題のときに出すとよいか） */
  context?: string;
  /** 受信側がこの情報を使ってよい期限 */
  useExpiresAt: string;
  /** 受信側の Agent が他の人へ伝え直してよいか */
  reshare: Reshare;
  /** 近況の時間帯（Note → Publish の1時間）。ないこともある */
  periodStart?: string;
  periodEnd?: string;
};

export type NarrativeIssue =
  | "too_short"
  | "too_long"
  | "instruction_like"
  | "field_too_long"
  | "field_instruction_like"
  | "bad_expiry"
  | "bad_shape";

const NARRATIVE_FIELDS = ["purpose", "nuance", "context"] as const;

/**
 * 受け取った（または送る）Narrative Message を正規化して確かめる。中身は友人の Agent が書いた、信頼できない入力として扱う。
 * 問題があれば理由、なければ正規化したもの。
 */
export function normalizeNarrative(
  raw: unknown,
  ctx: { createdAt: string },
): { ok: true; message: NarrativeMessage } | { ok: false; reason: NarrativeIssue } {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "bad_shape" };
  const m = raw as Record<string, unknown>;
  if (m.v !== 1 || typeof m.content !== "string" || typeof m.useExpiresAt !== "string") return { ok: false, reason: "bad_shape" };
  if (m.reshare !== "deny" && m.reshare !== "allow") return { ok: false, reason: "bad_shape" };
  const content = sanitizeContent(m.content);
  if (content.length < MIN_TELL_CONTENT_LENGTH) return { ok: false, reason: "too_short" };
  if (content.length > MAX_POST_LENGTH) return { ok: false, reason: "too_long" };
  if (findInstructionLike(content).length > 0) return { ok: false, reason: "instruction_like" };
  const out: NarrativeMessage = { v: 1, content, useExpiresAt: "", reshare: m.reshare };
  for (const f of NARRATIVE_FIELDS) {
    const v = m[f];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string") return { ok: false, reason: "bad_shape" };
    const s = sanitizeContent(v);
    if (s.length === 0) continue;
    if (s.length > MAX_NARRATIVE_FIELD_LENGTH) return { ok: false, reason: "field_too_long" };
    if (findInstructionLike(s).length > 0) return { ok: false, reason: "field_instruction_like" };
    out[f] = s;
  }
  const created = Date.parse(ctx.createdAt);
  const useExp = Date.parse(m.useExpiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(useExp) || useExp <= created || useExp - created > MAX_MESSAGE_TTL_MS) {
    return { ok: false, reason: "bad_expiry" };
  }
  out.useExpiresAt = new Date(useExp).toISOString();
  if (typeof m.periodStart === "string" && typeof m.periodEnd === "string") {
    const s = Date.parse(m.periodStart);
    const e = Date.parse(m.periodEnd);
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
      out.periodStart = new Date(s).toISOString();
      out.periodEnd = new Date(e).toISOString();
    }
  }
  return { ok: true, message: out };
}

// ---- 暗号化したメッセージ（Relay が配送するもの） ----

export type RelayRecipientBox = {
  agentId: string;
  /** 包むのに使った受信者の Encryption 鍵の版 */
  keyVersion: number;
  /** HPKE のカプセル化した鍵 */
  enc: string;
  /** HPKE で包んだ K */
  wrapped: string;
  /** 送信者の Identity 鍵による、この受信者分の署名 */
  sig: string;
};

export type RelayEnvelope = {
  v: 2;
  suite: typeof HPKE_SUITE;
  messageId: string;
  sender: string;
  createdAt: string;
  /** Relay が未配送のまま持つ期限 */
  deliveryExpiresAt: string;
  iv: string;
  ciphertext: string;
  /** 送信時は宛先全員分。Relay は各受信者に、その人の分だけを渡す */
  recipients: RelayRecipientBox[];
};

export const MESSAGE_ID_RE = /^msg_[A-Za-z0-9_-]{22}$/;

/** toISOString の形の日時か（署名した文字列をそのまま比べるので、別の書き方は受け付けない） */
export function isCanonicalIso(s: unknown): s is string {
  if (typeof s !== "string" || s.length > 40) return false;
  const t = Date.parse(s);
  return Number.isFinite(t) && new Date(t).toISOString() === s;
}

export function newMessageId(): string {
  return `msg_${b64(randomBytes(16))}`;
}

type Header = Pick<RelayEnvelope, "v" | "suite" | "messageId" | "sender" | "createdAt" | "deliveryExpiresAt">;

function headerText(h: Header): string {
  return ["souieba/v2/message", String(h.v), h.suite, h.messageId, h.sender, h.createdAt, h.deliveryExpiresAt].join("\n");
}

/** 受信者1人分の署名の対象。ヘッダ・本文の暗号文（のハッシュ）・その受信者の包んだ鍵を含める */
export function recipientSigningText(env: Omit<RelayEnvelope, "recipients">, box: Omit<RelayRecipientBox, "sig">): string {
  const digest = b64(createHash("sha256").update(env.ciphertext, "utf8").digest());
  return [headerText(env), env.iv, digest, box.agentId, String(box.keyVersion), box.enc, box.wrapped].join("\n");
}

const CEK_INFO = "souieba/v2/cek";
const cekAad = (h: Header, agentId: string) => `${headerText(h)}\n${agentId}`;

export type RelayRecipient = { agentId: string; encKey: string; encKeyVersion: number };

/** Narrative Message を宛先ごとに暗号化して署名する（docs/v2-design.md §10.3） */
export function sealRelayMessage(
  message: NarrativeMessage,
  sender: Pick<RelayIdentity, "agentId" | "identity">,
  recipients: RelayRecipient[],
  opts: { createdAt: string; deliveryExpiresAt: string; messageId?: string },
): RelayEnvelope {
  const header: Header = {
    v: 2,
    suite: HPKE_SUITE,
    messageId: opts.messageId ?? newMessageId(),
    sender: sender.agentId,
    createdAt: opts.createdAt,
    deliveryExpiresAt: opts.deliveryExpiresAt,
  };
  const cek = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", cek, iv);
  c.setAAD(Buffer.from(headerText(header), "utf8"));
  const ciphertext = b64(Buffer.concat([c.update(JSON.stringify(message), "utf8"), c.final(), c.getAuthTag()]));
  const body = { ...header, iv: b64(iv), ciphertext };
  const seen = new Set<string>();
  const boxes: RelayRecipientBox[] = [];
  for (const r of recipients) {
    if (seen.has(r.agentId)) continue;
    seen.add(r.agentId);
    const sealed = hpkeSeal(r.encKey, CEK_INFO, cekAad(header, r.agentId), cek);
    const box = { agentId: r.agentId, keyVersion: r.encKeyVersion, enc: sealed.enc, wrapped: sealed.ct };
    boxes.push({ ...box, sig: signText(sender.identity, recipientSigningText(body, box)) });
  }
  boxes.sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
  return { ...body, recipients: boxes };
}

/** 受信者1人分の署名を確かめる（Relay と受信側の両方で使う） */
export function verifyRecipientBox(env: RelayEnvelope, box: RelayRecipientBox, senderIdentityKey: string): boolean {
  const { recipients: _, ...body } = env;
  const { sig, ...unsigned } = box;
  return verifyText(senderIdentityKey, recipientSigningText(body, unsigned), sig);
}

export class RelayDecryptError extends Error {}

/** 自分宛ての K を開いて本文を復号する。署名の検証は呼び出し側で先に行う。中身の検査は normalizeNarrative で行う */
export function openRelayMessage(env: RelayEnvelope, me: { agentId: string; enc: KeyPair }): unknown {
  const box = env.recipients.find((r) => r.agentId === me.agentId);
  if (!box) throw new RelayDecryptError("この Agent 宛てではありません");
  try {
    const cek = hpkeOpen(me.enc, { enc: box.enc, ct: box.wrapped }, CEK_INFO, cekAad(env, me.agentId));
    const buf = unb64(env.ciphertext);
    if (buf.length < 16) throw new RelayDecryptError("暗号文が短すぎます");
    const d = createDecipheriv("aes-256-gcm", cek, unb64(env.iv));
    d.setAAD(Buffer.from(headerText(env), "utf8"));
    d.setAuthTag(buf.subarray(buf.length - 16));
    const plain = Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString("utf8");
    return JSON.parse(plain);
  } catch (err) {
    if (err instanceof RelayDecryptError) throw err;
    if (err instanceof HpkeError || err instanceof Error) throw new RelayDecryptError("復号できません");
    throw err;
  }
}
