import { newId } from "../crypto.ts";
import { type DB, tx } from "../db.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";

type FriendshipRow = {
  id: string;
  user_low_id: string;
  user_high_id: string;
  requested_by: string;
  status: "pending" | "accepted" | "blocked";
  blocked_by: string | null;
  created_at: string;
  updated_at: string;
};

const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

function findPair(db: DB, a: string, b: string): FriendshipRow | undefined {
  const [low, high] = pair(a, b);
  return db.prepare("SELECT * FROM friendships WHERE user_low_id = ? AND user_high_id = ?").get(low, high) as
    | FriendshipRow
    | undefined;
}

/** 招待経由など、申請を経ずに Friend にする */
export function acceptFriendshipDirect(db: DB, a: string, b: string, now: Date): void {
  if (a === b || findPair(db, a, b)) return;
  const [low, high] = pair(a, b);
  db.prepare(
    "INSERT INTO friendships (id, user_low_id, user_high_id, requested_by, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'accepted', ?, ?)",
  ).run(newId("frd"), low, high, a, now.toISOString(), now.toISOString());
}

export function requestFriendship(db: DB, from: string, to: string, now: Date) {
  if (from === to) throw badRequest("self_friend", "自分自身には申請できません");
  return tx(db, () => {
    const existing = findPair(db, from, to);
    if (existing) {
      // 相手から申請が来ていれば、この申請で承認したことにする
      if (existing.status === "pending" && existing.requested_by === to) {
        db.prepare("UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ?").run(now.toISOString(), existing.id);
        return { id: existing.id, status: "accepted" as const };
      }
      // blocked かどうかは相手に知らせない
      throw conflict("already_exists", "すでに申請済みか Friend です");
    }
    const [low, high] = pair(from, to);
    const id = newId("frd");
    db.prepare(
      "INSERT INTO friendships (id, user_low_id, user_high_id, requested_by, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
    ).run(id, low, high, from, now.toISOString(), now.toISOString());
    return { id, status: "pending" as const };
  });
}

function getForMember(db: DB, id: string, userId: string): FriendshipRow {
  const f = db.prepare("SELECT * FROM friendships WHERE id = ?").get(id) as FriendshipRow | undefined;
  if (!f || (f.user_low_id !== userId && f.user_high_id !== userId)) throw notFound("Friend");
  return f;
}

export function acceptFriendship(db: DB, id: string, userId: string, now: Date): void {
  const f = getForMember(db, id, userId);
  if (f.status !== "pending") throw conflict("not_pending", "承認待ちではありません");
  if (f.requested_by === userId) throw forbidden("申請された側だけが承認できます");
  db.prepare("UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ?").run(now.toISOString(), id);
}

export function removeFriendship(db: DB, id: string, userId: string): void {
  const f = getForMember(db, id, userId);
  if (f.status === "blocked" && f.blocked_by !== userId) throw notFound("Friend");
  db.prepare("DELETE FROM friendships WHERE id = ?").run(id);
}

export function blockFriendship(db: DB, id: string, userId: string, now: Date): void {
  getForMember(db, id, userId);
  db.prepare("UPDATE friendships SET status = 'blocked', blocked_by = ?, updated_at = ? WHERE id = ?").run(
    userId,
    now.toISOString(),
    id,
  );
}

export function listFriendships(db: DB, userId: string) {
  const rows = db
    .prepare(
      `SELECT f.*, u.id AS other_id, u.handle AS other_handle, u.display_name AS other_name
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.user_low_id = ? THEN f.user_high_id ELSE f.user_low_id END
       WHERE (f.user_low_id = ? OR f.user_high_id = ?)
         AND NOT (f.status = 'blocked' AND f.blocked_by != ?)
       ORDER BY f.created_at`,
    )
    .all(userId, userId, userId, userId) as (FriendshipRow & { other_id: string; other_handle: string; other_name: string })[];
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    direction: r.status === "pending" ? (r.requested_by === userId ? "outgoing" : "incoming") : null,
    user: { id: r.other_id, handle: r.other_handle, displayName: r.other_name },
    createdAt: r.created_at,
  }));
}
