/**
 * v2 の Relay。公開鍵ディレクトリ・チャレンジ認証・接続管理・暗号文の配送と期限管理だけを行う（docs/v2-design.md §2.2）。
 * メッセージの平文・Note・グループ・アクセス権限・Policy は持たない（それらは各 Client が持つ）。
 * Relay が確かめるのは、サーバで機械的に確かめられること（署名・接続の承認・期限・大きさ）だけ。
 */
import {
  MAX_MESSAGE_TTL_MS,
  MAX_RELAY_RECIPIENTS,
  MESSAGE_ID_RE,
  type RelayDirectoryEntry,
  type RelayEnvelope,
  type RelayRecipientBox,
  authSigningText,
  isAgentId,
  verifyDirectoryEntry,
  verifyRecipientBox,
  verifyText,
} from "@souieba/core";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { newToken, sha256 } from "../crypto.ts";
import { type DB, MAX_BOUND_PARAMS, chunks } from "../db/index.ts";
import {
  relayAgents,
  relayBlocks,
  relayChallenges,
  relayConnections,
  relayDeliveries,
  relayMessages,
  relaySessions,
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

export type RelayLimits = { maxAgents: number };

const iso = (d: Date) => d.toISOString();

function entryOf(row: typeof relayAgents.$inferSelect): RelayDirectoryEntry {
  return {
    agentId: row.agentId,
    identityKey: row.identityKey,
    encKey: row.encKey,
    encKeyVersion: row.encKeyVersion,
    encKeySig: row.encKeySig,
  };
}

function getAgent(db: DB, agentId: string) {
  return db.select().from(relayAgents).where(eq(relayAgents.agentId, agentId)).get();
}

// ---- 公開鍵ディレクトリ ----

/** 初回登録。同じ Identity をもう一度登録しても、そのまま返す（Encryption 鍵の更新は rotateEncKey で行う） */
export function register(db: DB, entry: RelayDirectoryEntry, now: Date, limits: RelayLimits): { entry: RelayDirectoryEntry; created: boolean } {
  const check = verifyDirectoryEntry(entry);
  if (!check.ok) throw badRequest(`invalid_${check.reason}`, `鍵情報を検証できません（${check.reason}）`);
  return db.transaction(() => {
    const existing = getAgent(db, entry.agentId);
    if (existing) return { entry: entryOf(existing), created: false };
    const count = db.select({ n: sql<number>`count(*)` }).from(relayAgents).get()?.n ?? 0;
    if (count >= limits.maxAgents) throw new ApiError(403, "relay_full", "この Relay に登録できる Agent の数が上限に達しています");
    const ts = iso(now);
    db.insert(relayAgents)
      .values({ ...entry, createdAt: ts, updatedAt: ts })
      .run();
    return { entry, created: true };
  });
}

export function lookup(db: DB, agentIds: string[]): RelayDirectoryEntry[] {
  const ids = [...new Set(agentIds.filter(isAgentId))];
  return chunks(ids, MAX_BOUND_PARAMS).flatMap((part) =>
    db.select().from(relayAgents).where(inArray(relayAgents.agentId, part)).all().map(entryOf),
  );
}

/** Encryption 鍵を新しい版に替える。署名は Identity 鍵で行い、版は増やすだけ */
export function rotateEncKey(db: DB, agentId: string, input: Pick<RelayDirectoryEntry, "encKey" | "encKeyVersion" | "encKeySig">, now: Date) {
  const cur = getAgent(db, agentId);
  if (!cur) throw notFound("Agent");
  if (input.encKeyVersion <= cur.encKeyVersion) throw conflict("stale_version", "鍵の版は今より大きくしてください");
  const next: RelayDirectoryEntry = { ...entryOf(cur), ...input };
  const check = verifyDirectoryEntry(next);
  if (!check.ok) throw badRequest(`invalid_${check.reason}`, `鍵情報を検証できません（${check.reason}）`);
  db.update(relayAgents)
    .set({ encKey: input.encKey, encKeyVersion: input.encKeyVersion, encKeySig: input.encKeySig, updatedAt: iso(now) })
    .where(eq(relayAgents.agentId, agentId))
    .run();
  return next;
}

// ---- 認証（チャレンジ・レスポンス） ----

export function issueChallenge(db: DB, agentId: string, now: Date): { challenge: string; expiresAt: string } {
  if (!isAgentId(agentId) || !getAgent(db, agentId)) throw notFound("Agent");
  const challenge = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const expiresAt = iso(new Date(now.getTime() + CHALLENGE_TTL_MS));
  db.insert(relayChallenges).values({ challenge, agentId, expiresAt }).run();
  return { challenge, expiresAt };
}

/** チャレンジへの署名を確かめて、セッショントークンを発行する。チャレンジは成否にかかわらず1回で使い切る */
export function openSession(
  db: DB,
  input: { agentId: string; challenge: string; sig: string },
  relayOrigin: string,
  now: Date,
): { token: string; expiresAt: string } {
  // 失敗しても使い切るよう、検証の前に（トランザクションの外で）消す
  const row = db
    .delete(relayChallenges)
    .where(and(eq(relayChallenges.challenge, input.challenge), eq(relayChallenges.agentId, input.agentId)))
    .returning()
    .get();
  const agent = getAgent(db, input.agentId);
  if (!row || !agent || row.expiresAt <= iso(now)) throw new ApiError(401, "unauthorized", "認証に失敗しました");
  if (!verifyText(agent.identityKey, authSigningText(relayOrigin, input.agentId, input.challenge), input.sig)) {
    throw new ApiError(401, "unauthorized", "認証に失敗しました");
  }
  const token = newToken("relay");
  const expiresAt = iso(new Date(now.getTime() + SESSION_TTL_MS));
  db.insert(relaySessions).values({ tokenHash: sha256(token), agentId: input.agentId, expiresAt, createdAt: iso(now) }).run();
  return { token, expiresAt };
}

/** セッショントークンから Agent ID を引く。期限切れや不明なトークンは null */
export function sessionAgent(db: DB, token: string, now: Date): string | null {
  const row = db
    .select({ agentId: relaySessions.agentId })
    .from(relaySessions)
    .where(and(eq(relaySessions.tokenHash, sha256(token)), gt(relaySessions.expiresAt, iso(now))))
    .get();
  return row?.agentId ?? null;
}

// ---- 接続 ----

export type ConnectionView = {
  peer: string;
  /** accepted: 接続済み / incoming: 相手からの承認待ちの要求 / outgoing: 自分が送った承認待ちの要求 */
  status: "accepted" | "incoming" | "outgoing";
  createdAt: string;
  updatedAt: string;
};

function pairRows(db: DB, a: string, b: string) {
  return db
    .select()
    .from(relayConnections)
    .where(
      or(
        and(eq(relayConnections.requesterId, a), eq(relayConnections.recipientId, b)),
        and(eq(relayConnections.requesterId, b), eq(relayConnections.recipientId, a)),
      ),
    )
    .all();
}

function isBlocked(db: DB, blocker: string, blocked: string): boolean {
  return !!db
    .select({ x: relayBlocks.blockerId })
    .from(relayBlocks)
    .where(and(eq(relayBlocks.blockerId, blocker), eq(relayBlocks.blockedId, blocked)))
    .get();
}

function view(me: string, row: typeof relayConnections.$inferSelect): ConnectionView {
  const peer = row.requesterId === me ? row.recipientId : row.requesterId;
  const status = row.status === "accepted" ? "accepted" : row.requesterId === me ? "outgoing" : "incoming";
  return { peer, status, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/**
 * 接続を要求する。相手からの要求が先に届いていれば、それを承認したことになる（両方が望んでいるので）。
 * 相手にブロックされているときも、ブロックを知られないよう、ふつうの要求と同じく行を作って同じ応答を返す
 * （その行はブロックした側には見えず、承認もできない。期限が来れば消える）。
 */
export function requestConnection(db: DB, me: string, to: string, now: Date): ConnectionView {
  if (!isAgentId(to) || !getAgent(db, to)) throw notFound("Agent");
  if (to === me) throw badRequest("self_connection", "自分自身には接続できません");
  if (isBlocked(db, me, to)) throw conflict("blocked", "この Agent はブロックしています。先にブロックを解除してください");
  const ts = iso(now);
  return db.transaction(() => {
    const rows = pairRows(db, me, to);
    const accepted = rows.find((r) => r.status === "accepted");
    if (accepted) return view(me, accepted);
    const outgoing = rows.find((r) => r.requesterId === me);
    if (outgoing) return view(me, outgoing);
    const incoming = rows.find((r) => r.requesterId === to);
    if (incoming) {
      db.update(relayConnections)
        .set({ status: "accepted", updatedAt: ts })
        .where(and(eq(relayConnections.requesterId, to), eq(relayConnections.recipientId, me)))
        .run();
      return view(me, { ...incoming, status: "accepted", updatedAt: ts });
    }
    const count = (col: typeof relayConnections.requesterId | typeof relayConnections.recipientId, id: string) =>
      db
        .select({ n: sql<number>`count(*)` })
        .from(relayConnections)
        .where(and(eq(col, id), eq(relayConnections.status, "pending")))
        .get()?.n ?? 0;
    if (count(relayConnections.requesterId, me) >= MAX_PENDING_OUTGOING) {
      throw conflict("too_many_pending", `承認待ちの要求が多すぎます（${MAX_PENDING_OUTGOING} 件まで）。承認されない要求を取り消してください`);
    }
    // 相手の受信箱を要求で埋められないようにする。黙って捨てると、本当の友人の要求が届いたと誤解させるので、断る
    if (count(relayConnections.recipientId, to) >= MAX_PENDING_INCOMING) {
      throw conflict("recipient_busy", "相手の承認待ちの要求が多すぎるため、今は要求を送れません。時間をおいてください");
    }
    const row = { requesterId: me, recipientId: to, status: "pending" as const, createdAt: ts, updatedAt: ts };
    db.insert(relayConnections).values(row).run();
    return view(me, row);
  });
}

export function acceptConnection(db: DB, me: string, peer: string, now: Date): ConnectionView {
  return db.transaction(() => {
    const row = db
      .select()
      .from(relayConnections)
      .where(and(eq(relayConnections.requesterId, peer), eq(relayConnections.recipientId, me)))
      .get();
    // ブロックした相手からの要求は、ないものとして扱う
    if (!row || (row.status === "pending" && isBlocked(db, me, peer))) throw notFound("接続要求");
    if (row.status === "accepted") return view(me, row);
    const ts = iso(now);
    db.update(relayConnections)
      .set({ status: "accepted", updatedAt: ts })
      .where(and(eq(relayConnections.requesterId, peer), eq(relayConnections.recipientId, me)))
      .run();
    return view(me, { ...row, status: "accepted", updatedAt: ts });
  });
}

/** 届いた要求を断る。断ったことは相手に知らせない（相手からは承認待ちのまま見えなくなるだけ） */
export function rejectConnection(db: DB, me: string, peer: string): void {
  db.delete(relayConnections)
    .where(and(eq(relayConnections.requesterId, peer), eq(relayConnections.recipientId, me), eq(relayConnections.status, "pending")))
    .run();
}

/** 二人のあいだのまだ配送していないメッセージを消す（接続の解除・ブロックのとき） */
function dropPendingBetween(db: DB, a: string, b: string): void {
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    const ids = db
      .select({ id: relayMessages.id })
      .from(relayMessages)
      .where(eq(relayMessages.senderId, from))
      .all()
      .map((r) => r.id);
    for (const part of chunks(ids, MAX_BOUND_PARAMS - 1)) {
      db.delete(relayDeliveries)
        .where(and(eq(relayDeliveries.recipientId, to), isNull(relayDeliveries.deliveredAt), inArray(relayDeliveries.messageId, part)))
        .run();
    }
  }
}

/** 接続を解除する（承認待ちの要求の取り消しも）。まだ配送していないメッセージは、どちら向きも配送しない */
export function disconnect(db: DB, me: string, peer: string): void {
  db.transaction(() => disconnectInTx(db, me, peer));
}

function disconnectInTx(db: DB, me: string, peer: string): void {
  db.delete(relayConnections)
    .where(
      or(
        and(eq(relayConnections.requesterId, me), eq(relayConnections.recipientId, peer)),
        and(eq(relayConnections.requesterId, peer), eq(relayConnections.recipientId, me)),
      ),
    )
    .run();
  dropPendingBetween(db, me, peer);
}

export function block(db: DB, me: string, peer: string, now: Date): void {
  if (!isAgentId(peer) || !getAgent(db, peer)) throw notFound("Agent");
  if (peer === me) throw badRequest("self_block", "自分自身はブロックできません");
  db.transaction(() => {
    const n = db.select({ n: sql<number>`count(*)` }).from(relayBlocks).where(eq(relayBlocks.blockerId, me)).get()?.n ?? 0;
    if (n >= MAX_BLOCKS && !isBlocked(db, me, peer)) throw conflict("too_many_blocks", `ブロックできるのは ${MAX_BLOCKS} 件までです`);
    disconnectInTx(db, me, peer);
    db.insert(relayBlocks).values({ blockerId: me, blockedId: peer, createdAt: iso(now) }).onConflictDoNothing().run();
  });
}

/** ブロックを解除する。ブロック中に相手が出していた（こちらに見えていなかった）要求は消す */
export function unblock(db: DB, me: string, peer: string): void {
  db.transaction(() => {
    db.delete(relayBlocks).where(and(eq(relayBlocks.blockerId, me), eq(relayBlocks.blockedId, peer))).run();
    db.delete(relayConnections)
      .where(and(eq(relayConnections.requesterId, peer), eq(relayConnections.recipientId, me), eq(relayConnections.status, "pending")))
      .run();
  });
}

export function listConnections(db: DB, me: string): { connections: ConnectionView[]; blocked: string[] } {
  const rows = db
    .select()
    .from(relayConnections)
    .where(or(eq(relayConnections.requesterId, me), eq(relayConnections.recipientId, me)))
    .orderBy(asc(relayConnections.createdAt))
    .all();
  const blocked = db
    .select({ id: relayBlocks.blockedId })
    .from(relayBlocks)
    .where(eq(relayBlocks.blockerId, me))
    .all()
    .map((r) => r.id);
  const hidden = new Set(blocked);
  // ブロックした相手からの承認待ちの要求は見せない
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
  /** 配送を受け付けた宛先 */
  accepted: string[];
  /** 受け付けなかった宛先と理由（not_connected: 接続していない / stale_key: 古い Encryption 鍵で包んでいる） */
  skipped: { agentId: string; reason: "not_connected" | "stale_key" }[];
};

/**
 * 暗号化したメッセージを受け付ける。宛先ごとに、接続済みか・最新の鍵で包んでいるか・送信者の署名が正しいかを確かめる。
 * 送信時点の宛先にだけ配送レコードを作る（あとから接続した人には届かない。§6.3）。
 */
export function sendMessage(db: DB, me: string, env: RelayEnvelope, now: Date, graceMs: number): SendResult {
  if (env.sender !== me) throw forbidden("送信者がこの Agent と一致しません");
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
  if (env.recipients.length > MAX_RELAY_RECIPIENTS) throw badRequest("too_many_recipients", `宛先は ${MAX_RELAY_RECIPIENTS} 件までです`);
  if (new Set(env.recipients.map((r) => r.agentId)).size !== env.recipients.length) {
    throw badRequest("duplicate_recipients", "宛先が重複しています");
  }
  const sender = getAgent(db, me);
  if (!sender) throw notFound("Agent");
  for (const box of env.recipients) {
    if (!verifyRecipientBox(env, box, sender.identityKey)) throw badRequest("invalid_signature", "メッセージの署名を検証できません");
  }

  const { recipients, ...body } = env;
  const visibleAt = iso(new Date(now.getTime() + graceMs));
  return db.transaction(() => {
    if (db.select({ id: relayMessages.id }).from(relayMessages).where(eq(relayMessages.id, env.messageId)).get()) {
      throw conflict("duplicate_message", "同じ ID のメッセージがあります");
    }
    const peers = acceptedPeers(db, me);
    const current = new Map(lookup(db, recipients.map((r) => r.agentId)).map((e) => [e.agentId, e.encKeyVersion]));
    const accepted: RelayRecipientBox[] = [];
    const skipped: SendResult["skipped"] = [];
    for (const box of recipients) {
      if (!peers.has(box.agentId) || isBlocked(db, box.agentId, me)) skipped.push({ agentId: box.agentId, reason: "not_connected" });
      else if (current.get(box.agentId) !== box.keyVersion) skipped.push({ agentId: box.agentId, reason: "stale_key" });
      else accepted.push(box);
    }
    if (accepted.length > 0) {
      db.insert(relayMessages)
        .values({
          id: env.messageId,
          senderId: me,
          body: JSON.stringify(body),
          createdAt: env.createdAt,
          visibleAt,
          deliveryExpiresAt: env.deliveryExpiresAt,
        })
        .run();
      for (const part of chunks(accepted, Math.floor(MAX_BOUND_PARAMS / 4))) {
        db.insert(relayDeliveries)
          .values(part.map((box) => ({ messageId: env.messageId, recipientId: box.agentId, box: JSON.stringify(box) })))
          .run();
      }
    }
    return { messageId: env.messageId, visibleAt, accepted: accepted.map((b) => b.agentId), skipped };
  });
}

export type InboundMessage = { envelope: RelayEnvelope; receivedAt: string };

/** 自分宛てで、まだ受け取っていないメッセージ。猶予期間中・期限切れ・接続が切れた相手からのものは返さない */
export function fetchMessages(db: DB, me: string, now: Date): InboundMessage[] {
  const ts = iso(now);
  const peers = acceptedPeers(db, me);
  const rows = db
    .select({ body: relayMessages.body, box: relayDeliveries.box, sender: relayMessages.senderId })
    .from(relayDeliveries)
    .innerJoin(relayMessages, eq(relayMessages.id, relayDeliveries.messageId))
    .where(
      and(
        eq(relayDeliveries.recipientId, me),
        isNull(relayDeliveries.deliveredAt),
        isNotNull(relayDeliveries.box),
        lte(relayMessages.visibleAt, ts),
        gt(relayMessages.deliveryExpiresAt, ts),
      ),
    )
    .orderBy(asc(relayMessages.createdAt))
    .limit(MAX_FETCH * 2)
    .all();
  return rows
    .filter((r) => peers.has(r.sender) && r.body && r.box)
    .slice(0, MAX_FETCH)
    .map((r) => ({
      envelope: { ...(JSON.parse(r.body!) as Omit<RelayEnvelope, "recipients">), recipients: [JSON.parse(r.box!) as RelayRecipientBox] },
      receivedAt: ts,
    }));
}

/**
 * 受け取ったことを記録して、その受信者分の鍵を消す。宛先全員が受け取ったら、本文の暗号文も消す（Relay に長く残さない）。
 * 配送状態は、送信者が確かめられるよう配送期限まで残す
 */
export function ackMessages(db: DB, me: string, messageIds: string[], now: Date): number {
  const ids = [...new Set(messageIds.filter((id) => MESSAGE_ID_RE.test(id)))];
  if (ids.length === 0) return 0;
  return db.transaction(() => {
    let n = 0;
    for (const part of chunks(ids, MAX_BOUND_PARAMS - 2)) {
      n += db
        .update(relayDeliveries)
        .set({ box: null, deliveredAt: iso(now) })
        .where(and(eq(relayDeliveries.recipientId, me), isNull(relayDeliveries.deliveredAt), inArray(relayDeliveries.messageId, part)))
        .returning({ id: relayDeliveries.messageId })
        .all().length;
      const done = db
        .select({ id: relayMessages.id })
        .from(relayMessages)
        .where(
          and(
            inArray(relayMessages.id, part),
            sql`NOT EXISTS (SELECT 1 FROM ${relayDeliveries} WHERE ${relayDeliveries.messageId} = ${relayMessages.id} AND ${relayDeliveries.deliveredAt} IS NULL)`,
          ),
        )
        .all()
        .map((r) => r.id);
      if (done.length > 0) db.update(relayMessages).set({ body: null }).where(inArray(relayMessages.id, done)).run();
    }
    return n;
  });
}

export type SentView = {
  messageId: string;
  createdAt: string;
  visibleAt: string;
  deliveryExpiresAt: string;
  recipients: { agentId: string; status: "pending" | "delivered"; deliveredAt: string | null }[];
};

/** 自分が送った、配送期限内のメッセージの配送状態 */
export function listSent(db: DB, me: string, now: Date): SentView[] {
  const msgs = db
    .select()
    .from(relayMessages)
    .where(and(eq(relayMessages.senderId, me), gt(relayMessages.deliveryExpiresAt, iso(now))))
    .orderBy(asc(relayMessages.createdAt))
    .all();
  if (msgs.length === 0) return [];
  const deliveries = chunks(
    msgs.map((m) => m.id),
    MAX_BOUND_PARAMS,
  ).flatMap((part) => db.select().from(relayDeliveries).where(inArray(relayDeliveries.messageId, part)).all());
  return msgs.map((m) => ({
    messageId: m.id,
    createdAt: m.createdAt,
    visibleAt: m.visibleAt,
    deliveryExpiresAt: m.deliveryExpiresAt,
    recipients: deliveries
      .filter((d) => d.messageId === m.id)
      .map((d) => ({ agentId: d.recipientId, status: d.deliveredAt ? "delivered" : "pending", deliveredAt: d.deliveredAt })),
  }));
}

/** 送ったメッセージを取り消す。まだ受け取っていない宛先には届かなくなる（受け取った人の手元からは消せない） */
export function deleteMessage(db: DB, me: string, messageId: string): void {
  const row = db.select({ sender: relayMessages.senderId }).from(relayMessages).where(eq(relayMessages.id, messageId)).get();
  if (!row || row.sender !== me) throw notFound("メッセージ");
  db.delete(relayMessages).where(eq(relayMessages.id, messageId)).run();
}

/** 期限切れのメッセージ・チャレンジ・セッションと、古い承認待ちの要求を消す */
export function relayRetention(db: DB, now: Date): { messages: number; challenges: number; sessions: number; requests: number } {
  const ts = iso(now);
  const stale = iso(new Date(now.getTime() - PENDING_TTL_MS));
  return db.transaction(() => ({
    requests: db
      .delete(relayConnections)
      .where(and(eq(relayConnections.status, "pending"), lt(relayConnections.createdAt, stale)))
      .returning({ id: relayConnections.requesterId })
      .all().length,
    messages: db.delete(relayMessages).where(lt(relayMessages.deliveryExpiresAt, ts)).returning({ id: relayMessages.id }).all().length,
    challenges: db.delete(relayChallenges).where(lt(relayChallenges.expiresAt, ts)).returning({ id: relayChallenges.challenge }).all()
      .length,
    sessions: db.delete(relaySessions).where(lt(relaySessions.expiresAt, ts)).returning({ id: relaySessions.tokenHash }).all().length,
  }));
}
