import {
  type PostEnvelope,
  type SyncResult,
  TELL_WINDOW_MS,
  type WireInboxItem,
  type WireTellCandidate,
  selectTellCandidate,
} from "@souieba/core";
import { and, desc, eq, exists, gte, isNotNull, isNull, lt, lte, ne, notExists, or } from "drizzle-orm";
import { type DB, MAX_BOUND_PARAMS, chunks } from "../db/index.ts";
import { agents, deliveries, postRecipients, posts, users } from "../db/schema.ts";
import { conflict, notFound } from "../errors.ts";
import { sharesGroup } from "./groups.ts";

export type AgentActor = { userId: string; agentId: string };

export const DEFAULT_LEASE_MS = 10 * 60_000;

/**
 * 「今この瞬間にこの Agent が見てよい投稿」の条件。
 * 所属は毎回その時点で判定し（抜けたら受信済みでも候補から消える）、
 * この Agent が復号できる（宛先に含まれる）投稿だけに絞る。
 */
function visibleToMe(db: DB, actor: AgentActor, now: Date) {
  return and(
    ne(posts.ownerId, actor.userId),
    eq(posts.visibility, "groups"),
    lte(posts.visibleAt, now.toISOString()),
    gte(posts.createdAt, new Date(now.getTime() - TELL_WINDOW_MS).toISOString()),
    sharesGroup(db, posts.ownerId, actor.userId),
    exists(
      db
        .select({ postId: postRecipients.postId })
        .from(postRecipients)
        .where(and(eq(postRecipients.postId, posts.id), eq(postRecipients.agentId, actor.agentId))),
    ),
  );
}

/** 同じグループのメンバーの新着投稿を受信箱へ取り込む（RECEIVED にする） */
export function sync(db: DB, actor: AgentActor, now: Date): SyncResult {
  const received = db.transaction(() => {
    // 受け取り済みの投稿は選ばない（毎回窓の中の全件を INSERT し直さない）
    const ids = db
      .select({ id: posts.id })
      .from(posts)
      .where(
        and(
          visibleToMe(db, actor, now),
          notExists(
            db
              .select({ postId: deliveries.postId })
              .from(deliveries)
              .where(and(eq(deliveries.postId, posts.id), eq(deliveries.recipientUserId, actor.userId))),
          ),
        ),
      )
      .all();
    let received = 0;
    // 1行あたり4変数
    for (const batch of chunks(ids, Math.floor(MAX_BOUND_PARAMS / 4))) {
      received += db
        .insert(deliveries)
        .values(
          batch.map((p) => ({ postId: p.id, recipientUserId: actor.userId, receivedAt: now.toISOString(), receivedByAgentId: actor.agentId })),
        )
        .onConflictDoNothing()
        .returning({ postId: deliveries.postId })
        .all().length;
    }
    return received;
  });
  return { received, inboxSize: inboxRows(db, actor, now, false).length };
}

function inboxRows(db: DB, actor: AgentActor, now: Date, onlyClaimable: boolean) {
  const nowIso = now.toISOString();
  return db
    .select({
      postId: deliveries.postId,
      ownerId: posts.ownerId,
      ownerHandle: users.handle,
      ownerName: users.displayName,
      authorAgentId: posts.authorAgentId,
      agentName: agents.name,
      periodStart: posts.periodStart,
      periodEnd: posts.periodEnd,
      envelope: posts.envelope,
      createdAt: posts.createdAt,
      receivedAt: deliveries.receivedAt,
      reservedByAgentId: deliveries.reservedByAgentId,
      reservedUntil: deliveries.reservedUntil,
    })
    .from(deliveries)
    .innerJoin(posts, eq(posts.id, deliveries.postId))
    .innerJoin(users, eq(users.id, posts.ownerId))
    .innerJoin(agents, eq(agents.id, posts.authorAgentId))
    .where(
      and(
        eq(deliveries.recipientUserId, actor.userId),
        isNull(deliveries.toldAt),
        isNull(deliveries.dismissedAt),
        onlyClaimable
          ? or(isNull(deliveries.reservedUntil), lt(deliveries.reservedUntil, nowIso), eq(deliveries.reservedByAgentId, actor.agentId))
          : undefined,
        visibleToMe(db, actor, now),
      ),
    )
    .orderBy(desc(posts.createdAt))
    .all();
}

type InboxRow = ReturnType<typeof inboxRows>[number];

function toItem(r: InboxRow): WireInboxItem {
  return {
    postId: r.postId,
    owner: { id: r.ownerId, handle: r.ownerHandle, displayName: r.ownerName },
    authorAgentId: r.authorAgentId,
    authorAgentName: r.agentName,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    envelope: JSON.parse(r.envelope) as PostEnvelope,
    receivedAt: r.receivedAt,
  };
}

export function inbox(db: DB, actor: AgentActor, now: Date): WireInboxItem[] {
  return inboxRows(db, actor, now, false).map(toItem);
}

/**
 * Tell する1件をサーバ側で選び、リース付きで予約する。
 * 同じ User の複数 Agent が同じ投稿を同時に伝えないようにするため。
 */
export function claimTell(
  db: DB,
  actor: AgentActor,
  now: Date,
  opts: { leaseMs?: number; random?: () => number } = {},
): WireTellCandidate | null {
  return db.transaction(() => {
    const rows = inboxRows(db, actor, now, true);
    const last = db
      .select({ ownerId: posts.ownerId })
      .from(deliveries)
      .innerJoin(posts, eq(posts.id, deliveries.postId))
      .where(and(eq(deliveries.recipientUserId, actor.userId), isNotNull(deliveries.toldAt)))
      .orderBy(desc(deliveries.toldAt))
      .limit(1)
      .get();

    const pick = selectTellCandidate(rows, { now, lastToldOwnerId: last?.ownerId ?? null, random: opts.random });
    if (!pick) return null;

    const reservedUntil = new Date(now.getTime() + (opts.leaseMs ?? DEFAULT_LEASE_MS)).toISOString();
    db.update(deliveries)
      .set({ reservedByAgentId: actor.agentId, reservedUntil })
      .where(and(eq(deliveries.postId, pick.postId), eq(deliveries.recipientUserId, actor.userId)))
      .run();
    return { ...toItem(pick), reservedUntil };
  });
}

function deliveryOf(actor: { userId: string }, postId: string) {
  return and(eq(deliveries.postId, postId), eq(deliveries.recipientUserId, actor.userId));
}

function assertDelivery(db: DB, actor: AgentActor, postId: string) {
  if (!db.select({ postId: deliveries.postId }).from(deliveries).where(deliveryOf(actor, postId)).get()) {
    throw notFound("受信箱の投稿");
  }
}

/** 予約している Agent だけが TOLD にできる */
export function markTold(db: DB, actor: AgentActor, postId: string, now: Date): void {
  const nowIso = now.toISOString();
  const updated = db
    .update(deliveries)
    .set({ toldAt: nowIso, toldByAgentId: actor.agentId, reservedByAgentId: null, reservedUntil: null })
    .where(
      and(
        deliveryOf(actor, postId),
        isNull(deliveries.toldAt),
        eq(deliveries.reservedByAgentId, actor.agentId),
        gte(deliveries.reservedUntil, nowIso),
      ),
    )
    .returning({ postId: deliveries.postId })
    .all();
  if (updated.length === 0) {
    assertDelivery(db, actor, postId);
    throw conflict("not_reserved", "この Agent が予約していないか、予約の期限が切れています");
  }
}

export function releaseTell(db: DB, actor: AgentActor, postId: string): void {
  const updated = db
    .update(deliveries)
    .set({ reservedByAgentId: null, reservedUntil: null })
    .where(and(deliveryOf(actor, postId), eq(deliveries.reservedByAgentId, actor.agentId)))
    .returning({ postId: deliveries.postId })
    .all();
  if (updated.length === 0) {
    assertDelivery(db, actor, postId);
    throw conflict("not_reserved", "この Agent は予約していません");
  }
}

export function dismiss(db: DB, userId: string, postId: string, now: Date): void {
  const updated = db
    .update(deliveries)
    .set({ dismissedAt: now.toISOString() })
    .where(and(deliveryOf({ userId }, postId), isNull(deliveries.dismissedAt)))
    .returning({ postId: deliveries.postId })
    .all();
  if (updated.length === 0) throw notFound("受信箱の投稿");
}
