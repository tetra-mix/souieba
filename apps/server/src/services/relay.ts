/**
 * v2 の Relay。公開鍵ディレクトリ・チャレンジ認証・接続管理・暗号文の配送と期限管理だけを行う（docs/architecture.md）。
 * メッセージの平文・Note・グループ・アクセス権限・Policy は持たない（それらは各 Client が持つ）。
 * Relay が確かめるのは、サーバで機械的に確かめられること（署名・接続の承認・期限・大きさ）だけ。
 *
 * ID は人ごと。ディレクトリは人ごとに Person 鍵・端末証明書・端末の取り消しを持ち、
 * 認証は端末ごと（端末の署名鍵でチャレンジに署名する）。接続・ブロックは人と人。配送は端末ごと。
 * 旧Relayの表は現行のRelay処理では使わない。
 */
import {
  type DeviceCert,
  type DeviceRevocation,
  MAX_DEVICES_PER_PERSON,
  MAX_MESSAGE_TTL_MS,
  MAX_RELAY_RECIPIENTS,
  MESSAGE_ID_RE,
  type PersonDirectory,
  type RelayEnvelope,
  type RelayRecipientGroup,
  authSigningText,
  derivePersonId,
  isDeviceId,
  isPersonId,
  verifyDeviceCert,
  verifyRecipientGroup,
  verifyRevocation,
  verifyText,
} from "@souieba/core";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { newToken, sha256 } from "../crypto.ts";
import { type DB, MAX_BOUND_PARAMS, chunks } from "../db/index.ts";
import {
  relayDeviceChallenges,
  relayDeviceDeliveries,
  relayDeviceSessions,
  relayDevices,
  relayPersonBlocks,
  relayPersonConnections,
  relayPersonMessages,
  relayPersons,
} from "../db/schema.ts";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../errors.ts";

export const CHALLENGE_TTL_MS = 2 * 60_000;
export const SESSION_TTL_MS = 60 * 60_000;
/** 送信時刻のずれの許容範囲 */
export const CLOCK_SKEW_MS = 10 * 60_000;
/** 1人が受け取れる未処理の接続要求の上限（スパム対策） */
export const MAX_PENDING_INCOMING = 100;
/** 1人が出せる承認待ちの要求の上限（多くの宛先に要求をばらまけないように） */
export const MAX_PENDING_OUTGOING = 50;
/** 承認も拒否もされない要求は、この期間で消す */
export const PENDING_TTL_MS = 14 * 86_400_000;
/** 1人がブロックできる相手の上限 */
export const MAX_BLOCKS = 500;
/** 1回の受信で返すメッセージの上限 */
export const MAX_FETCH = 50;
/** 取り消した端末も含めて、1人が登録できる端末の上限（取り消しを繰り返して表を膨らませないように） */
export const MAX_DEVICE_ROWS_PER_PERSON = 50;

/** maxAgents は、登録できるPersonの数 */
export type RelayLimits = { maxAgents: number };

/** 認証済みの端末 */
export type RelaySession = { personId: string; deviceId: string };

const iso = (d: Date) => d.toISOString();

function getPerson(db: DB, personId: string) {
  return db.select().from(relayPersons).where(eq(relayPersons.personId, personId)).get();
}

function getDevice(db: DB, deviceId: string) {
  return db.select().from(relayDevices).where(eq(relayDevices.deviceId, deviceId)).get();
}

function directoryOf(db: DB, person: typeof relayPersons.$inferSelect): PersonDirectory {
  const rows = db.select().from(relayDevices).where(eq(relayDevices.personId, person.personId)).orderBy(asc(relayDevices.createdAt)).all();
  return {
    personId: person.personId,
    personKey: person.personKey,
    devices: rows.filter((r) => !r.revokedAt).map((r) => JSON.parse(r.cert) as DeviceCert),
    revocations: rows.filter((r) => r.revocation).map((r) => JSON.parse(r.revocation!) as DeviceRevocation),
  };
}

// ---- 公開鍵ディレクトリ ----

/**
 * 人と端末を登録する。初めての人なら人も作る。同じ端末をもう一度登録しても、そのまま返す。
 * 同じ端末で鍵の版が上がった証明書なら置き換える（暗号化鍵の更新）。取り消した端末は戻せない
 */
export function registerDevice(
  db: DB,
  input: { personKey: string; cert: DeviceCert },
  now: Date,
  limits: RelayLimits,
): { directory: PersonDirectory; created: boolean } {
  const { personKey, cert } = input;
  if (derivePersonId(personKey) !== cert.personId) throw badRequest("invalid_bad_person_id", "Person ID と鍵が合いません");
  if (!verifyDeviceCert(cert, personKey)) throw badRequest("invalid_device_cert", "端末証明書を検証できません");
  const ts = iso(now);
  return db.transaction(() => {
    let person = getPerson(db, cert.personId);
    let created = false;
    if (!person) {
      const count = db.select({ n: sql<number>`count(*)` }).from(relayPersons).get()?.n ?? 0;
      if (count >= limits.maxAgents) throw new ApiError(403, "relay_full", "この Relay に登録できる人数が上限に達しています");
      person = { personId: cert.personId, personKey, createdAt: ts, updatedAt: ts };
      db.insert(relayPersons).values(person).run();
      created = true;
    }
    const existing = getDevice(db, cert.deviceId);
    if (existing) {
      if (existing.personId !== cert.personId) throw conflict("device_taken", "この端末は別の人のものとして登録されています");
      if (existing.revokedAt) throw conflict("device_revoked", "この端末は取り消されています");
      if (cert.encKeyVersion > existing.encKeyVersion) {
        db.update(relayDevices).set({ cert: JSON.stringify(cert), encKeyVersion: cert.encKeyVersion }).where(eq(relayDevices.deviceId, cert.deviceId)).run();
      }
      return { directory: directoryOf(db, person), created };
    }
    const rows = db.select({ revokedAt: relayDevices.revokedAt }).from(relayDevices).where(eq(relayDevices.personId, cert.personId)).all();
    if (rows.filter((r) => !r.revokedAt).length >= MAX_DEVICES_PER_PERSON) {
      throw conflict("too_many_devices", `端末は1人 ${MAX_DEVICES_PER_PERSON} 台までです。使っていない端末を取り消してください`);
    }
    if (rows.length >= MAX_DEVICE_ROWS_PER_PERSON) throw conflict("too_many_devices", "これ以上端末を登録できません");
    db.insert(relayDevices)
      .values({ deviceId: cert.deviceId, personId: cert.personId, signKey: cert.signKey, encKeyVersion: cert.encKeyVersion, cert: JSON.stringify(cert), createdAt: ts })
      .run();
    return { directory: directoryOf(db, person), created: true };
  });
}

/** 端末を取り消す（Person 鍵の署名が要る）。その端末のセッションと、まだ受け取っていない配送は消す */
export function revokeDeviceEntry(db: DB, rev: DeviceRevocation, now: Date): PersonDirectory {
  const person = getPerson(db, rev.personId);
  if (!person) throw notFound("人");
  if (!verifyRevocation(rev, person.personKey)) throw badRequest("invalid_revocation", "取り消しの署名を検証できません");
  return db.transaction(() => {
    const d = getDevice(db, rev.deviceId);
    if (!d || d.personId !== rev.personId) throw notFound("端末");
    if (!d.revokedAt) {
      db.update(relayDevices).set({ revokedAt: iso(now), revocation: JSON.stringify(rev) }).where(eq(relayDevices.deviceId, rev.deviceId)).run();
      db.delete(relayDeviceSessions).where(eq(relayDeviceSessions.deviceId, rev.deviceId)).run();
      db.delete(relayDeviceChallenges).where(eq(relayDeviceChallenges.deviceId, rev.deviceId)).run();
      db.delete(relayDeviceDeliveries).where(and(eq(relayDeviceDeliveries.deviceId, rev.deviceId), isNull(relayDeviceDeliveries.deliveredAt))).run();
    }
    return directoryOf(db, person);
  });
}

export function lookup(db: DB, personIds: string[]): PersonDirectory[] {
  const ids = [...new Set(personIds.filter(isPersonId))];
  return chunks(ids, MAX_BOUND_PARAMS).flatMap((part) =>
    db.select().from(relayPersons).where(inArray(relayPersons.personId, part)).all().map((p) => directoryOf(db, p)),
  );
}

// ---- 認証（チャレンジ・レスポンス。端末ごと） ----

function activeDevice(db: DB, deviceId: string) {
  if (!isDeviceId(deviceId)) return undefined;
  const d = getDevice(db, deviceId);
  return d && !d.revokedAt ? d : undefined;
}

export function issueChallenge(db: DB, deviceId: string, now: Date): { challenge: string; expiresAt: string } {
  if (!activeDevice(db, deviceId)) throw notFound("端末");
  const challenge = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const expiresAt = iso(new Date(now.getTime() + CHALLENGE_TTL_MS));
  db.insert(relayDeviceChallenges).values({ challenge, deviceId, expiresAt }).run();
  return { challenge, expiresAt };
}

/** チャレンジへの署名を確かめて、セッショントークンを発行する。チャレンジは成否にかかわらず1回で使い切る */
export function openSession(
  db: DB,
  input: { personId: string; deviceId: string; challenge: string; sig: string },
  relayOrigin: string,
  now: Date,
): { token: string; expiresAt: string } {
  const row = db
    .delete(relayDeviceChallenges)
    .where(and(eq(relayDeviceChallenges.challenge, input.challenge), eq(relayDeviceChallenges.deviceId, input.deviceId)))
    .returning()
    .get();
  const device = activeDevice(db, input.deviceId);
  if (!row || !device || device.personId !== input.personId || row.expiresAt <= iso(now)) throw new ApiError(401, "unauthorized", "認証に失敗しました");
  if (!verifyText(device.signKey, authSigningText(relayOrigin, input.personId, input.deviceId, input.challenge), input.sig)) {
    throw new ApiError(401, "unauthorized", "認証に失敗しました");
  }
  const token = newToken("relay");
  const expiresAt = iso(new Date(now.getTime() + SESSION_TTL_MS));
  db.insert(relayDeviceSessions)
    .values({ tokenHash: sha256(token), deviceId: input.deviceId, personId: input.personId, expiresAt, createdAt: iso(now) })
    .run();
  return { token, expiresAt };
}

/** セッショントークンから端末と人を引く。期限切れ・不明なトークン・取り消した端末は null */
export function sessionOf(db: DB, token: string, now: Date): RelaySession | null {
  const row = db
    .select({ personId: relayDeviceSessions.personId, deviceId: relayDeviceSessions.deviceId })
    .from(relayDeviceSessions)
    .where(and(eq(relayDeviceSessions.tokenHash, sha256(token)), gt(relayDeviceSessions.expiresAt, iso(now))))
    .get();
  if (!row || !activeDevice(db, row.deviceId)) return null;
  return row;
}

// ---- 接続（人と人） ----

export type ConnectionView = {
  peer: string;
  /** accepted: 接続済み / incoming: 相手からの承認待ちの要求 / outgoing: 自分が送った承認待ちの要求 */
  status: "accepted" | "incoming" | "outgoing";
  createdAt: string;
  updatedAt: string;
};

const C = relayPersonConnections;
const B = relayPersonBlocks;

function pairRows(db: DB, a: string, b: string) {
  return db
    .select()
    .from(C)
    .where(or(and(eq(C.requesterId, a), eq(C.recipientId, b)), and(eq(C.requesterId, b), eq(C.recipientId, a))))
    .all();
}

function isBlocked(db: DB, blocker: string, blocked: string): boolean {
  return !!db
    .select({ x: B.blockerId })
    .from(B)
    .where(and(eq(B.blockerId, blocker), eq(B.blockedId, blocked)))
    .get();
}

function view(me: string, row: typeof C.$inferSelect): ConnectionView {
  const peer = row.requesterId === me ? row.recipientId : row.requesterId;
  const status = row.status === "accepted" ? "accepted" : row.requesterId === me ? "outgoing" : "incoming";
  return { peer, status, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/**
 * 接続を要求する。相手からの要求が先に届いていれば、それを承認したことになる（両方が望んでいるので）。
 * 相手にブロックされているときも、ブロックを知られないよう、ふつうの要求と同じく行を作って同じ応答を返す
 */
export function requestConnection(db: DB, me: string, to: string, now: Date): ConnectionView {
  if (!isPersonId(to) || !getPerson(db, to)) throw notFound("相手");
  if (to === me) throw badRequest("self_connection", "自分自身には接続できません");
  if (isBlocked(db, me, to)) throw conflict("blocked", "この相手はブロックしています。先にブロックを解除してください");
  const ts = iso(now);
  return db.transaction(() => {
    const rows = pairRows(db, me, to);
    const accepted = rows.find((r) => r.status === "accepted");
    if (accepted) return view(me, accepted);
    const outgoing = rows.find((r) => r.requesterId === me);
    if (outgoing) return view(me, outgoing);
    const incoming = rows.find((r) => r.requesterId === to);
    if (incoming) {
      db.update(C).set({ status: "accepted", updatedAt: ts }).where(and(eq(C.requesterId, to), eq(C.recipientId, me))).run();
      return view(me, { ...incoming, status: "accepted", updatedAt: ts });
    }
    const count = (col: typeof C.requesterId | typeof C.recipientId, id: string) =>
      db
        .select({ n: sql<number>`count(*)` })
        .from(C)
        .where(and(eq(col, id), eq(C.status, "pending")))
        .get()?.n ?? 0;
    if (count(C.requesterId, me) >= MAX_PENDING_OUTGOING) {
      throw conflict("too_many_pending", `承認待ちの要求が多すぎます（${MAX_PENDING_OUTGOING} 件まで）。承認されない要求を取り消してください`);
    }
    if (count(C.recipientId, to) >= MAX_PENDING_INCOMING) {
      throw conflict("recipient_busy", "相手の承認待ちの要求が多すぎるため、今は要求を送れません。時間をおいてください");
    }
    const row = { requesterId: me, recipientId: to, status: "pending" as const, createdAt: ts, updatedAt: ts };
    db.insert(C).values(row).run();
    return view(me, row);
  });
}

export function acceptConnection(db: DB, me: string, peer: string, now: Date): ConnectionView {
  return db.transaction(() => {
    const row = db
      .select()
      .from(C)
      .where(and(eq(C.requesterId, peer), eq(C.recipientId, me)))
      .get();
    if (!row || (row.status === "pending" && isBlocked(db, me, peer))) throw notFound("接続要求");
    if (row.status === "accepted") return view(me, row);
    const ts = iso(now);
    db.update(C).set({ status: "accepted", updatedAt: ts }).where(and(eq(C.requesterId, peer), eq(C.recipientId, me))).run();
    return view(me, { ...row, status: "accepted", updatedAt: ts });
  });
}

/** 届いた要求を断る。断ったことは相手に知らせない */
export function rejectConnection(db: DB, me: string, peer: string): void {
  db.delete(C)
    .where(and(eq(C.requesterId, peer), eq(C.recipientId, me), eq(C.status, "pending")))
    .run();
}

/** 二人のあいだのまだ配送していないメッセージを消す（接続の解除・ブロックのとき） */
function dropPendingBetween(db: DB, a: string, b: string): void {
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    const ids = db
      .select({ id: relayPersonMessages.id })
      .from(relayPersonMessages)
      .where(eq(relayPersonMessages.senderId, from))
      .all()
      .map((r) => r.id);
    for (const part of chunks(ids, MAX_BOUND_PARAMS - 1)) {
      db.delete(relayDeviceDeliveries)
        .where(and(eq(relayDeviceDeliveries.personId, to), isNull(relayDeviceDeliveries.deliveredAt), inArray(relayDeviceDeliveries.messageId, part)))
        .run();
    }
  }
}

export function disconnect(db: DB, me: string, peer: string): void {
  db.transaction(() => disconnectInTx(db, me, peer));
}

function disconnectInTx(db: DB, me: string, peer: string): void {
  db.delete(C)
    .where(or(and(eq(C.requesterId, me), eq(C.recipientId, peer)), and(eq(C.requesterId, peer), eq(C.recipientId, me))))
    .run();
  dropPendingBetween(db, me, peer);
}

export function block(db: DB, me: string, peer: string, now: Date): void {
  if (!isPersonId(peer) || !getPerson(db, peer)) throw notFound("相手");
  if (peer === me) throw badRequest("self_block", "自分自身はブロックできません");
  db.transaction(() => {
    const n = db.select({ n: sql<number>`count(*)` }).from(B).where(eq(B.blockerId, me)).get()?.n ?? 0;
    if (n >= MAX_BLOCKS && !isBlocked(db, me, peer)) throw conflict("too_many_blocks", `ブロックできるのは ${MAX_BLOCKS} 件までです`);
    disconnectInTx(db, me, peer);
    db.insert(B).values({ blockerId: me, blockedId: peer, createdAt: iso(now) }).onConflictDoNothing().run();
  });
}

export function unblock(db: DB, me: string, peer: string): void {
  db.transaction(() => {
    db.delete(B).where(and(eq(B.blockerId, me), eq(B.blockedId, peer))).run();
    db.delete(C)
      .where(and(eq(C.requesterId, peer), eq(C.recipientId, me), eq(C.status, "pending")))
      .run();
  });
}

export function listConnections(db: DB, me: string): { connections: ConnectionView[]; blocked: string[] } {
  const rows = db
    .select()
    .from(C)
    .where(or(eq(C.requesterId, me), eq(C.recipientId, me)))
    .orderBy(asc(C.createdAt))
    .all();
  const blocked = db
    .select({ id: B.blockedId })
    .from(B)
    .where(eq(B.blockerId, me))
    .all()
    .map((r) => r.id);
  const hidden = new Set(blocked);
  const visible = rows.filter((r) => !(r.status === "pending" && r.recipientId === me && hidden.has(r.requesterId)));
  return { connections: visible.map((r) => view(me, r)), blocked };
}

function acceptedPeers(db: DB, me: string): Set<string> {
  return new Set(
    listConnections(db, me)
      .connections.filter((c) => c.status === "accepted")
      .map((c) => c.peer),
  );
}

// ---- メッセージ ----

export type SendResult = {
  messageId: string;
  visibleAt: string;
  /** 配送を受け付けた宛先の人（少なくとも1台の端末に届く） */
  accepted: string[];
  /** 受け付けなかった宛先の人と理由（not_connected: 接続していない / stale_key: 使える端末の箱がない） */
  skipped: { personId: string; reason: "not_connected" | "stale_key" }[];
};

/**
 * 暗号化したメッセージを受け付ける。送った端末の証明書がこの Relay に登録したものと同じか、
 * 宛先の人ごとに、接続済みか・送信した端末の署名が正しいかを確かめ、端末ごとに今の鍵の版で包んだ箱だけを配送する。
 * 送信時点の宛先にだけ配送レコードを作る（あとから接続した人や、あとから足した端末には届かない。§6.3）。
 */
export function sendMessage(db: DB, me: RelaySession, env: RelayEnvelope, now: Date, graceMs: number): SendResult {
  if (env.sender !== me.personId || env.senderDevice !== me.deviceId) throw forbidden("送信者がこの端末と一致しません");
  if (!MESSAGE_ID_RE.test(env.messageId)) throw badRequest("invalid_message_id", "メッセージ ID の形式が不正です");
  const created = Date.parse(env.createdAt);
  const expires = Date.parse(env.deliveryExpiresAt);
  if (!Number.isFinite(created) || iso(new Date(created)) !== env.createdAt || Math.abs(created - now.getTime()) > CLOCK_SKEW_MS) {
    throw badRequest("bad_created_at", "作成日時が不正か、時計が大きくずれています");
  }
  if (!Number.isFinite(expires) || iso(new Date(expires)) !== env.deliveryExpiresAt || expires <= now.getTime() || expires - created > MAX_MESSAGE_TTL_MS) {
    throw badRequest("bad_delivery_expiry", "配送期限が不正です（作成から7日以内）");
  }
  if (env.recipients.length === 0) throw badRequest("no_recipients", "宛先がありません");
  if (env.recipients.length > MAX_RELAY_RECIPIENTS) throw badRequest("too_many_recipients", `宛先は ${MAX_RELAY_RECIPIENTS} 人までです`);
  if (new Set(env.recipients.map((r) => r.person)).size !== env.recipients.length) throw badRequest("duplicate_recipients", "宛先が重複しています");
  const device = activeDevice(db, me.deviceId);
  if (!device) throw notFound("端末");
  if (!sameCert(JSON.parse(device.cert) as DeviceCert, env.senderCert)) {
    throw badRequest("invalid_sender_cert", "送った端末の証明書が登録したものと違います");
  }
  for (const g of env.recipients) {
    if (!verifyRecipientGroup(env, g, device.signKey)) throw badRequest("invalid_signature", "メッセージの署名を検証できません");
  }

  const { recipients, ...body } = env;
  const visibleAt = iso(new Date(now.getTime() + graceMs));
  return db.transaction(() => {
    if (db.select({ id: relayPersonMessages.id }).from(relayPersonMessages).where(eq(relayPersonMessages.id, env.messageId)).get()) {
      throw conflict("duplicate_message", "同じ ID のメッセージがあります");
    }
    const peers = acceptedPeers(db, me.personId);
    const deviceIds = recipients.flatMap((g) => g.boxes.map((b) => b.device)).filter(isDeviceId);
    const current = new Map(
      chunks([...new Set(deviceIds)], MAX_BOUND_PARAMS).flatMap((part) =>
        db
          .select({ id: relayDevices.deviceId, person: relayDevices.personId, version: relayDevices.encKeyVersion, revokedAt: relayDevices.revokedAt })
          .from(relayDevices)
          .where(inArray(relayDevices.deviceId, part))
          .all()
          .map((r) => [r.id, r] as const),
      ),
    );
    const deliveries: { messageId: string; deviceId: string; personId: string; box: string }[] = [];
    const accepted: string[] = [];
    const skipped: SendResult["skipped"] = [];
    for (const g of recipients) {
      if (!peers.has(g.person) || isBlocked(db, g.person, me.personId)) {
        skipped.push({ personId: g.person, reason: "not_connected" });
        continue;
      }
      const ok = g.boxes.filter((b) => {
        const d = current.get(b.device);
        return d && d.person === g.person && !d.revokedAt && d.version === b.keyVersion;
      });
      if (ok.length === 0) {
        skipped.push({ personId: g.person, reason: "stale_key" });
        continue;
      }
      accepted.push(g.person);
      const box = JSON.stringify(g satisfies RelayRecipientGroup);
      for (const b of ok) deliveries.push({ messageId: env.messageId, deviceId: b.device, personId: g.person, box });
    }
    if (deliveries.length > 0) {
      db.insert(relayPersonMessages)
        .values({
          id: env.messageId,
          senderId: me.personId,
          senderDevice: me.deviceId,
          body: JSON.stringify(body),
          createdAt: env.createdAt,
          visibleAt,
          deliveryExpiresAt: env.deliveryExpiresAt,
        })
        .run();
      for (const part of chunks(deliveries, Math.floor(MAX_BOUND_PARAMS / 5))) db.insert(relayDeviceDeliveries).values(part).run();
    }
    return { messageId: env.messageId, visibleAt, accepted, skipped };
  });
}

const CERT_FIELDS = ["v", "personId", "deviceId", "signKey", "encKey", "encKeyVersion", "createdAt", "sig"] as const;
const sameCert = (a: DeviceCert, b: DeviceCert) => !!b && CERT_FIELDS.every((k) => a[k] === b[k]);

export type InboundMessage = { envelope: RelayEnvelope; receivedAt: string };

/** この端末宛てで、まだ受け取っていないメッセージ。猶予期間中・期限切れ・接続が切れた相手からのものは返さない */
export function fetchMessages(db: DB, me: RelaySession, now: Date): InboundMessage[] {
  const ts = iso(now);
  const peers = acceptedPeers(db, me.personId);
  const rows = db
    .select({ body: relayPersonMessages.body, box: relayDeviceDeliveries.box, sender: relayPersonMessages.senderId })
    .from(relayDeviceDeliveries)
    .innerJoin(relayPersonMessages, eq(relayPersonMessages.id, relayDeviceDeliveries.messageId))
    .where(
      and(
        eq(relayDeviceDeliveries.deviceId, me.deviceId),
        isNull(relayDeviceDeliveries.deliveredAt),
        isNotNull(relayDeviceDeliveries.box),
        lte(relayPersonMessages.visibleAt, ts),
        gt(relayPersonMessages.deliveryExpiresAt, ts),
      ),
    )
    .orderBy(asc(relayPersonMessages.createdAt))
    .limit(MAX_FETCH * 2)
    .all();
  return rows
    .filter((r) => peers.has(r.sender) && r.body && r.box)
    .slice(0, MAX_FETCH)
    .map((r) => ({
      envelope: { ...(JSON.parse(r.body!) as Omit<RelayEnvelope, "recipients">), recipients: [JSON.parse(r.box!) as RelayRecipientGroup] },
      receivedAt: ts,
    }));
}

/**
 * 受け取ったことを記録して、その端末分の箱を消す。宛先の全端末が受け取ったら、本文の暗号文も消す（Relay に長く残さない）。
 * 配送状態は、送信者が確かめられるよう配送期限まで残す
 */
export function ackMessages(db: DB, me: RelaySession, messageIds: string[], now: Date): number {
  const ids = [...new Set(messageIds.filter((id) => MESSAGE_ID_RE.test(id)))];
  if (ids.length === 0) return 0;
  const D = relayDeviceDeliveries;
  const M = relayPersonMessages;
  return db.transaction(() => {
    let n = 0;
    for (const part of chunks(ids, MAX_BOUND_PARAMS - 2)) {
      n += db
        .update(D)
        .set({ box: null, deliveredAt: iso(now) })
        .where(and(eq(D.deviceId, me.deviceId), isNull(D.deliveredAt), inArray(D.messageId, part)))
        .returning({ id: D.messageId })
        .all().length;
      const done = db
        .select({ id: M.id })
        .from(M)
        .where(and(inArray(M.id, part), sql`NOT EXISTS (SELECT 1 FROM ${D} WHERE ${D.messageId} = ${M.id} AND ${D.deliveredAt} IS NULL)`))
        .all()
        .map((r) => r.id);
      if (done.length > 0) db.update(M).set({ body: null }).where(inArray(M.id, done)).run();
    }
    return n;
  });
}

export type SentView = {
  messageId: string;
  createdAt: string;
  visibleAt: string;
  deliveryExpiresAt: string;
  /** 人ごと。どれかの端末が受け取っていれば delivered */
  recipients: { personId: string; status: "pending" | "delivered"; deliveredAt: string | null; devices: number }[];
};

/** 自分（この人のどの端末からでも）が送った、配送期限内のメッセージの配送状態 */
export function listSent(db: DB, me: RelaySession, now: Date): SentView[] {
  const M = relayPersonMessages;
  const msgs = db
    .select()
    .from(M)
    .where(and(eq(M.senderId, me.personId), gt(M.deliveryExpiresAt, iso(now))))
    .orderBy(asc(M.createdAt))
    .all();
  if (msgs.length === 0) return [];
  const deliveries = chunks(
    msgs.map((m) => m.id),
    MAX_BOUND_PARAMS,
  ).flatMap((part) => db.select().from(relayDeviceDeliveries).where(inArray(relayDeviceDeliveries.messageId, part)).all());
  return msgs.map((m) => {
    const byPerson = new Map<string, { delivered: string | null; devices: number }>();
    for (const d of deliveries) {
      if (d.messageId !== m.id) continue;
      const cur = byPerson.get(d.personId) ?? { delivered: null, devices: 0 };
      cur.devices++;
      if (d.deliveredAt && (!cur.delivered || d.deliveredAt < cur.delivered)) cur.delivered = d.deliveredAt;
      byPerson.set(d.personId, cur);
    }
    return {
      messageId: m.id,
      createdAt: m.createdAt,
      visibleAt: m.visibleAt,
      deliveryExpiresAt: m.deliveryExpiresAt,
      recipients: [...byPerson].map(([personId, v]) => ({
        personId,
        status: v.delivered ? ("delivered" as const) : ("pending" as const),
        deliveredAt: v.delivered,
        devices: v.devices,
      })),
    };
  });
}

/** 送ったメッセージを取り消す（同じ人のどの端末からでも）。まだ受け取っていない宛先には届かなくなる */
export function deleteMessage(db: DB, me: RelaySession, messageId: string): void {
  const row = db.select({ sender: relayPersonMessages.senderId }).from(relayPersonMessages).where(eq(relayPersonMessages.id, messageId)).get();
  if (!row || row.sender !== me.personId) throw notFound("メッセージ");
  db.delete(relayPersonMessages).where(eq(relayPersonMessages.id, messageId)).run();
}

/** 期限切れのメッセージ・チャレンジ・セッションと、古い承認待ちの要求を消す */
export function relayRetention(db: DB, now: Date): { messages: number; challenges: number; sessions: number; requests: number } {
  const ts = iso(now);
  const stale = iso(new Date(now.getTime() - PENDING_TTL_MS));
  return db.transaction(() => ({
    requests: db
      .delete(C)
      .where(and(eq(C.status, "pending"), lt(C.createdAt, stale)))
      .returning({ id: C.requesterId })
      .all().length,
    messages: db.delete(relayPersonMessages).where(lt(relayPersonMessages.deliveryExpiresAt, ts)).returning({ id: relayPersonMessages.id }).all().length,
    challenges: db
      .delete(relayDeviceChallenges)
      .where(lt(relayDeviceChallenges.expiresAt, ts))
      .returning({ id: relayDeviceChallenges.challenge })
      .all().length,
    sessions: db.delete(relayDeviceSessions).where(lt(relayDeviceSessions.expiresAt, ts)).returning({ id: relayDeviceSessions.tokenHash }).all().length,
  }));
}
