/**
 * Souieba v2（Relay）のPerson・署名・メッセージ形式。設計: docs/architecture.md
 *
 * 2.1.0 から、ID は人ごと（2026-11-01 主人の決定）。
 * - 人ごとに Person 鍵（Ed25519）を1つ持つ。Person ID（sb_…）は Person 公開鍵のハッシュから作る（自己証明的）
 * - エージェントは、その人の「端末」（Device）。端末ごとに署名鍵（Ed25519）と暗号化鍵（X25519）を持ち、
 *   Person 鍵で署名した端末証明書（device certificate）で、その人の端末であることを示す
 * - 端末の取り消し（revocation）も Person 鍵で署名する。Relay は信頼しないので、受け取った側はどれも、
 *   Person ID から確かめた Person 鍵で確かめる（Relay が偽の端末を足しても、証明書の署名が合わない）
 * - 端末の名前（「Claude Code」など）は手元だけのもので、証明書には入れない（友人に見せない。主人の決定）
 * - 本文は使い捨ての鍵 K で AES-256-GCM。K は受信者の「人」の、取り消されていない端末ごとに HPKE で包む。
 *   署名は受信者の人ごとに、送信した端末の署名鍵で行い、送信した端末の証明書を添える（受信側は Person 鍵までたどって確かめる）
 *   （人ごとに別の署名にするのは、他の受信者が誰かを Relay から各受信者へ渡さずに済ませるため）
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { type KeyPair, generateEncryptionKey, generateSigningKey, isPublicKey, signText, verifyText } from "./crypto.ts";
import { HPKE_SUITE, HpkeError, hpkeOpen, hpkeSeal, isUsableX25519Key } from "./hpke.ts";
import { MAX_POST_LENGTH, MIN_TELL_CONTENT_LENGTH, findInstructionLike, sanitizeContent } from "./sanitize.ts";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

// ---- Identity（人と端末） ----

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

const keyHash = (key: string) => base32(createHash("sha256").update(unb64(key)).digest().subarray(0, 20));

export const PERSON_ID_RE = /^sb_[a-z2-7]{32}$/;
export const DEVICE_ID_RE = /^dv_[a-z2-7]{32}$/;
/** 1人が持てる端末の上限（取り消したものは数えない）。1通の大きさを抑えるため */
export const MAX_DEVICES_PER_PERSON = 10;

/** Person 公開鍵（Ed25519、生の32バイトの base64url）から Person ID を作る。sha256 の先頭160ビットを base32 にしたもの */
export function derivePersonId(personKey: string): string {
  return `sb_${keyHash(personKey)}`;
}

/** 端末の署名公開鍵から Device ID を作る（Person ID と同じ作り方で、頭だけ dv_） */
export function deriveDeviceId(signKey: string): string {
  return `dv_${keyHash(signKey)}`;
}

export function isPersonId(id: unknown): id is string {
  return typeof id === "string" && PERSON_ID_RE.test(id);
}

export function isDeviceId(id: unknown): id is string {
  return typeof id === "string" && DEVICE_ID_RE.test(id);
}

/** 人の鍵。priv は、その人の最初のPCにだけある（docs/architecture.md） */
export type PersonKeys = { personId: string; person: KeyPair };

/** 端末の鍵 */
export type DeviceKeys = {
  personId: string;
  deviceId: string;
  sign: KeyPair;
  enc: KeyPair;
  encKeyVersion: number;
  createdAt: string;
};

/** 端末証明書。Person 鍵で署名する。端末の名前は入れない */
export type DeviceCert = {
  v: 1;
  personId: string;
  deviceId: string;
  signKey: string;
  encKey: string;
  encKeyVersion: number;
  createdAt: string;
  sig: string;
};

/** 端末の取り消し。Person 鍵で署名する。一度取り消した端末は戻せない */
export type DeviceRevocation = { v: 1; personId: string; deviceId: string; revokedAt: string; sig: string };

/** Relay の公開鍵ディレクトリの1人分（Relay は信頼しない。受け取った側が verifyPersonDirectory で確かめる） */
export type PersonDirectory = {
  personId: string;
  personKey: string;
  devices: DeviceCert[];
  revocations: DeviceRevocation[];
};

export function generatePerson(): PersonKeys {
  const person = generateSigningKey();
  return { personId: derivePersonId(person.pub), person };
}

export function generateDevice(personId: string, createdAt: string): DeviceKeys {
  const sign = generateSigningKey();
  return { personId, deviceId: deriveDeviceId(sign.pub), sign, enc: generateEncryptionKey(), encKeyVersion: 1, createdAt };
}

export function deviceCertSigningText(c: Omit<DeviceCert, "sig">): string {
  return ["souieba/v2/device-cert", String(c.v), c.personId, c.deviceId, c.signKey, c.encKey, String(c.encKeyVersion), c.createdAt].join("\n");
}

export function revocationSigningText(r: Omit<DeviceRevocation, "sig">): string {
  return ["souieba/v2/device-revoke", String(r.v), r.personId, r.deviceId, r.revokedAt].join("\n");
}

/** 端末証明書を作る（Person 鍵の秘密鍵が要る） */
export function certifyDevice(person: PersonKeys, d: DeviceKeys): DeviceCert {
  const body: Omit<DeviceCert, "sig"> = {
    v: 1,
    personId: person.personId,
    deviceId: d.deviceId,
    signKey: d.sign.pub,
    encKey: d.enc.pub,
    encKeyVersion: d.encKeyVersion,
    createdAt: d.createdAt,
  };
  return { ...body, sig: signText(person.person, deviceCertSigningText(body)) };
}

export function revokeDevice(person: PersonKeys, deviceId: string, revokedAt: string): DeviceRevocation {
  const body = { v: 1 as const, personId: person.personId, deviceId, revokedAt };
  return { ...body, sig: signText(person.person, revocationSigningText(body)) };
}

const isoLike = (s: unknown): s is string => typeof s === "string" && s.length <= 40 && Number.isFinite(Date.parse(s));

/** 端末証明書が、その Person 鍵で署名された、自己矛盾のないものか */
export function verifyDeviceCert(c: DeviceCert, personKey: string): boolean {
  if (!c || c.v !== 1 || !isPersonId(c.personId) || !isDeviceId(c.deviceId) || !isoLike(c.createdAt)) return false;
  if (!isPublicKey("ed25519", personKey) || derivePersonId(personKey) !== c.personId) return false;
  if (!isPublicKey("ed25519", c.signKey) || !isPublicKey("x25519", c.encKey) || !isUsableX25519Key(c.encKey)) return false;
  if (!Number.isInteger(c.encKeyVersion) || c.encKeyVersion < 1) return false;
  if (deriveDeviceId(c.signKey) !== c.deviceId) return false;
  const { sig, ...body } = c;
  return typeof sig === "string" && verifyText(personKey, deviceCertSigningText(body), sig);
}

export function verifyRevocation(r: DeviceRevocation, personKey: string): boolean {
  if (!r || r.v !== 1 || !isPersonId(r.personId) || !isDeviceId(r.deviceId) || !isoLike(r.revokedAt)) return false;
  if (!isPublicKey("ed25519", personKey) || derivePersonId(personKey) !== r.personId) return false;
  const { sig, ...body } = r;
  return typeof sig === "string" && verifyText(personKey, revocationSigningText(body), sig);
}

export type DirectoryCheck =
  | { ok: true; personKey: string; devices: DeviceCert[]; revoked: string[] }
  | { ok: false; reason: "bad_person_id" | "bad_key" | "key_mismatch" };

/**
 * Relay が返した1人分のディレクトリを確かめ、使ってよい端末（証明書が正しく、取り消されていないもの）を返す。
 * - Person 鍵は Person ID から確かめる。固定した鍵（pinnedKey）があれば、それと同じでなければ使わない
 * - 署名の合わない証明書・取り消しは捨てる（Relay が偽の端末を足しても使われない）
 * - knownRevoked は、前に確かめた取り消し（Relay が取り消しを隠しても、手元で覚えている分は使わない）
 * - 同じ端末の証明書が複数あれば、鍵の版が最も大きいものを使う
 */
export function verifyPersonDirectory(
  dir: PersonDirectory,
  opts: { pinnedKey?: string; knownRevoked?: Iterable<string> } = {},
): DirectoryCheck {
  if (!dir || !isPersonId(dir.personId)) return { ok: false, reason: "bad_person_id" };
  if (!isPublicKey("ed25519", dir.personKey)) return { ok: false, reason: "bad_key" };
  if (derivePersonId(dir.personKey) !== dir.personId) return { ok: false, reason: "bad_person_id" };
  if (opts.pinnedKey && opts.pinnedKey !== dir.personKey) return { ok: false, reason: "key_mismatch" };
  const revoked = new Set(opts.knownRevoked ?? []);
  for (const r of Array.isArray(dir.revocations) ? dir.revocations : []) {
    if (r?.personId === dir.personId && verifyRevocation(r, dir.personKey)) revoked.add(r.deviceId);
  }
  const best = new Map<string, DeviceCert>();
  for (const c of Array.isArray(dir.devices) ? dir.devices : []) {
    if (c?.personId !== dir.personId || revoked.has(c.deviceId) || !verifyDeviceCert(c, dir.personKey)) continue;
    const cur = best.get(c.deviceId);
    if (!cur || cur.encKeyVersion < c.encKeyVersion) best.set(c.deviceId, c);
  }
  const devices = [...best.values()].sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1)).slice(0, MAX_DEVICES_PER_PERSON);
  return { ok: true, personKey: dir.personKey, devices, revoked: [...revoked].sort() };
}

/** Relay への登録や送信で使う、この端末の身元（証明書つき） */
export type DeviceIdentity = DeviceKeys & { cert: DeviceCert };

// ---- Relay への認証（チャレンジ・レスポンス。端末ごと） ----

/** 署名するチャレンジの文面。Relay の origin を含めるので、別の Relay への使い回しはできない */
export function authSigningText(relayOrigin: string, personId: string, deviceId: string, challenge: string): string {
  return ["souieba/v2/device-auth", relayOrigin, personId, deviceId, challenge].join("\n");
}

export function signChallenge(me: Pick<DeviceKeys, "personId" | "deviceId" | "sign">, relayOrigin: string, challenge: string): string {
  return signText(me.sign, authSigningText(relayOrigin, me.personId, me.deviceId, challenge));
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

/** 送信側が書く共有内容と、どう伝えてほしいかの意図（docs/architecture.md） */
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

/** 受信者の端末1台分の、包んだ鍵 */
export type RelayDeviceBox = {
  device: string;
  /** 包むのに使った、その端末の暗号化鍵の版 */
  keyVersion: number;
  /** HPKE のカプセル化した鍵 */
  enc: string;
  /** HPKE で包んだ K */
  wrapped: string;
};

/** 受信者1人分。その人の端末ごとの箱と、送信した端末の署名（この人の分の箱すべてを含めて署名する） */
export type RelayRecipientGroup = {
  person: string;
  boxes: RelayDeviceBox[];
  sig: string;
};

export type RelayEnvelope = {
  v: 3;
  suite: typeof HPKE_SUITE;
  messageId: string;
  /** 送信者の Person ID */
  sender: string;
  /** 送信した端末の Device ID */
  senderDevice: string;
  /** 送信した端末の証明書（受信側は送信者の Person 鍵で確かめる） */
  senderCert: DeviceCert;
  createdAt: string;
  /** Relay が未配送のまま持つ期限 */
  deliveryExpiresAt: string;
  iv: string;
  ciphertext: string;
  /** 送信時は宛先全員分。Relay は各受信者の端末に、その人の分だけを渡す */
  recipients: RelayRecipientGroup[];
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

type Header = Pick<RelayEnvelope, "v" | "suite" | "messageId" | "sender" | "senderDevice" | "createdAt" | "deliveryExpiresAt">;

function headerText(h: Header): string {
  return ["souieba/v2/message", String(h.v), h.suite, h.messageId, h.sender, h.senderDevice, h.createdAt, h.deliveryExpiresAt].join("\n");
}

/** 受信者1人分の署名の対象。ヘッダ・本文の暗号文（のハッシュ）・その人の端末ごとの包んだ鍵（Device ID の順）を含める */
export function recipientSigningText(env: Omit<RelayEnvelope, "recipients">, group: Omit<RelayRecipientGroup, "sig">): string {
  const digest = b64(createHash("sha256").update(env.ciphertext, "utf8").digest());
  const boxes = [...group.boxes].sort((a, b) => (a.device < b.device ? -1 : 1)).map((x) => [x.device, String(x.keyVersion), x.enc, x.wrapped].join(" "));
  return [headerText(env), env.iv, digest, group.person, ...boxes].join("\n");
}

const CEK_INFO = "souieba/v2/cek";
const cekAad = (h: Header, person: string, device: string) => `${headerText(h)}\n${person}\n${device}`;

/** 宛先の1人。devices は、確かめて使ってよいと分かった端末（取り消されていないもの） */
export type RelayRecipient = { personId: string; devices: { deviceId: string; encKey: string; encKeyVersion: number }[] };

/** Narrative Message を宛先の人の端末ごとに暗号化し、人ごとに署名する（docs/architecture.md） */
export function sealRelayMessage(
  message: NarrativeMessage,
  sender: Pick<DeviceIdentity, "personId" | "deviceId" | "sign" | "cert">,
  recipients: RelayRecipient[],
  opts: { createdAt: string; deliveryExpiresAt: string; messageId?: string },
): RelayEnvelope {
  const header: Header = {
    v: 3,
    suite: HPKE_SUITE,
    messageId: opts.messageId ?? newMessageId(),
    sender: sender.personId,
    senderDevice: sender.deviceId,
    createdAt: opts.createdAt,
    deliveryExpiresAt: opts.deliveryExpiresAt,
  };
  const cek = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", cek, iv);
  c.setAAD(Buffer.from(headerText(header), "utf8"));
  const ciphertext = b64(Buffer.concat([c.update(JSON.stringify(message), "utf8"), c.final(), c.getAuthTag()]));
  const body = { ...header, senderCert: sender.cert, iv: b64(iv), ciphertext };
  const seen = new Set<string>();
  const groups: RelayRecipientGroup[] = [];
  for (const r of recipients) {
    if (seen.has(r.personId) || r.devices.length === 0) continue;
    seen.add(r.personId);
    const devSeen = new Set<string>();
    const boxes: RelayDeviceBox[] = [];
    for (const d of r.devices) {
      if (devSeen.has(d.deviceId)) continue;
      devSeen.add(d.deviceId);
      const sealed = hpkeSeal(d.encKey, CEK_INFO, cekAad(header, r.personId, d.deviceId), cek);
      boxes.push({ device: d.deviceId, keyVersion: d.encKeyVersion, enc: sealed.enc, wrapped: sealed.ct });
    }
    boxes.sort((a, b) => (a.device < b.device ? -1 : 1));
    const group = { person: r.personId, boxes };
    groups.push({ ...group, sig: signText(sender.sign, recipientSigningText(body, group)) });
  }
  groups.sort((a, b) => (a.person < b.person ? -1 : a.person > b.person ? 1 : 0));
  return { ...body, recipients: groups };
}

/** 受信者1人分の署名を、送信した端末の署名鍵で確かめる（Relay と受信側の両方で使う） */
export function verifyRecipientGroup(env: RelayEnvelope, group: RelayRecipientGroup, senderSignKey: string): boolean {
  const { recipients: _, ...body } = env;
  const { sig, ...unsigned } = group;
  if (!Array.isArray(unsigned.boxes) || typeof sig !== "string") return false;
  return verifyText(senderSignKey, recipientSigningText(body, unsigned), sig);
}

export class RelayDecryptError extends Error {}

/** 自分（この端末）宛ての K を開いて本文を復号する。署名の検証は呼び出し側で先に行う。中身の検査は normalizeNarrative で行う */
export function openRelayMessage(env: RelayEnvelope, me: { personId: string; deviceId: string; enc: KeyPair }): unknown {
  const group = env.recipients.find((r) => r.person === me.personId);
  const box = group?.boxes.find((b) => b.device === me.deviceId);
  if (!box) throw new RelayDecryptError("この端末宛てではありません");
  try {
    const cek = hpkeOpen(me.enc, { enc: box.enc, ct: box.wrapped }, CEK_INFO, cekAad(env, me.personId, me.deviceId));
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
