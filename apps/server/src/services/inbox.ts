import { type InboxItem, type SyncResult, type TellCandidate, TELL_WINDOW_MS, selectTellCandidate } from "@souieba/core";
import { type DB, tx } from "../db.ts";
import { conflict, notFound } from "../errors.ts";

export type AgentActor = { userId: string; agentId: string };

export const DEFAULT_LEASE_MS = 10 * 60_000;

/** 「今この瞬間に受信者が見てよい投稿」の条件。Friend 状態は毎回その時点で判定する */
const VISIBLE_TO_ME = `
  p.owner_id != :me
  AND p.visibility = 'friends'
  AND p.visible_at <= :now
  AND p.created_at >= :minCreated
  AND EXISTS (
    SELECT 1 FROM friendships f
    WHERE f.status = 'accepted'
      AND f.user_low_id = min(p.owner_id, :me)
      AND f.user_high_id = max(p.owner_id, :me)
  )`;

function params(me: string, now: Date) {
  return { me, now: now.toISOString(), minCreated: new Date(now.getTime() - TELL_WINDOW_MS).toISOString() };
}

/** 友人の新着投稿を受信箱へ取り込む（RECEIVED にする） */
export function sync(db: DB, actor: AgentActor, now: Date): SyncResult {
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO deliveries (post_id, recipient_user_id, received_at, received_by_agent_id)
       SELECT p.id, :me, :now, :agent FROM posts p WHERE ${VISIBLE_TO_ME}`,
    )
    .run({ ...params(actor.userId, now), agent: actor.agentId });
  return { received: Number(r.changes), inboxSize: inboxRows(db, actor, now, false).length };
}

type InboxRow = {
  post_id: string;
  owner_id: string;
  owner_handle: string;
  owner_name: string;
  agent_name: string;
  period_start: string;
  period_end: string;
  content: string;
  created_at: string;
  received_at: string;
  reserved_by_agent_id: string | null;
  reserved_until: string | null;
};

function inboxRows(db: DB, actor: AgentActor, now: Date, onlyClaimable: boolean): InboxRow[] {
  const reservation = onlyClaimable
    ? "AND (d.reserved_until IS NULL OR d.reserved_until < :now OR d.reserved_by_agent_id = :agent)"
    : "";
  return db
    .prepare(
      `SELECT d.post_id, p.owner_id, u.handle AS owner_handle, u.display_name AS owner_name, a.name AS agent_name,
              p.period_start, p.period_end, p.content, p.created_at, d.received_at,
              d.reserved_by_agent_id, d.reserved_until
       FROM deliveries d
       JOIN posts p ON p.id = d.post_id
       JOIN users u ON u.id = p.owner_id
       JOIN agents a ON a.id = p.author_agent_id
       WHERE d.recipient_user_id = :me AND d.told_at IS NULL AND d.dismissed_at IS NULL
         ${reservation}
         AND ${VISIBLE_TO_ME}
       ORDER BY p.created_at DESC`,
    )
    .all(onlyClaimable ? { ...params(actor.userId, now), agent: actor.agentId } : params(actor.userId, now)) as InboxRow[];
}

function toItem(r: InboxRow): InboxItem {
  return {
    postId: r.post_id,
    owner: { id: r.owner_id, handle: r.owner_handle, displayName: r.owner_name },
    authorAgentName: r.agent_name,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    content: r.content,
    receivedAt: r.received_at,
  };
}

export function inbox(db: DB, actor: AgentActor, now: Date): InboxItem[] {
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
): TellCandidate | null {
  return tx(db, () => {
    const rows = inboxRows(db, actor, now, true);
    const last = db
      .prepare(
        `SELECT p.owner_id FROM deliveries d JOIN posts p ON p.id = d.post_id
         WHERE d.recipient_user_id = ? AND d.told_at IS NOT NULL ORDER BY d.told_at DESC LIMIT 1`,
      )
      .get(actor.userId) as { owner_id: string } | undefined;

    const pick = selectTellCandidate(
      rows.map((r) => ({ ...r, postId: r.post_id, ownerId: r.owner_id, periodStart: r.period_start, createdAt: r.created_at })),
      { now, lastToldOwnerId: last?.owner_id ?? null, random: opts.random },
    );
    if (!pick) return null;

    const reservedUntil = new Date(now.getTime() + (opts.leaseMs ?? DEFAULT_LEASE_MS)).toISOString();
    db.prepare(
      "UPDATE deliveries SET reserved_by_agent_id = ?, reserved_until = ? WHERE post_id = ? AND recipient_user_id = ?",
    ).run(actor.agentId, reservedUntil, pick.post_id, actor.userId);
    return { ...toItem(pick), reservedUntil } satisfies TellCandidate & { receivedAt: string };
  });
}

function assertDelivery(db: DB, actor: AgentActor, postId: string) {
  const d = db.prepare("SELECT 1 FROM deliveries WHERE post_id = ? AND recipient_user_id = ?").get(postId, actor.userId);
  if (!d) throw notFound("受信箱の投稿");
}

/** 予約している Agent だけが TOLD にできる */
export function markTold(db: DB, actor: AgentActor, postId: string, now: Date): void {
  const r = db
    .prepare(
      `UPDATE deliveries SET told_at = ?, told_by_agent_id = ?, reserved_by_agent_id = NULL, reserved_until = NULL
       WHERE post_id = ? AND recipient_user_id = ? AND told_at IS NULL
         AND reserved_by_agent_id = ? AND reserved_until >= ?`,
    )
    .run(now.toISOString(), actor.agentId, postId, actor.userId, actor.agentId, now.toISOString());
  if (r.changes === 0) {
    assertDelivery(db, actor, postId);
    throw conflict("not_reserved", "この Agent が予約していないか、予約の期限が切れています");
  }
}

export function releaseTell(db: DB, actor: AgentActor, postId: string): void {
  const r = db
    .prepare(
      `UPDATE deliveries SET reserved_by_agent_id = NULL, reserved_until = NULL
       WHERE post_id = ? AND recipient_user_id = ? AND reserved_by_agent_id = ?`,
    )
    .run(postId, actor.userId, actor.agentId);
  if (r.changes === 0) {
    assertDelivery(db, actor, postId);
    throw conflict("not_reserved", "この Agent は予約していません");
  }
}

export function dismiss(db: DB, userId: string, postId: string, now: Date): void {
  const r = db
    .prepare("UPDATE deliveries SET dismissed_at = ? WHERE post_id = ? AND recipient_user_id = ? AND dismissed_at IS NULL")
    .run(now.toISOString(), postId, userId);
  if (r.changes === 0) throw notFound("受信箱の投稿");
}
