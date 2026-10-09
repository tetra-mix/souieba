import { and, isNotNull, lt, or } from "drizzle-orm";
import type { DB } from "./db/index.ts";
import { credentials, invites, posts } from "./db/schema.ts";

/** 保存期間を過ぎた投稿（と配送状態）、使い終わった招待、失効済みの資格情報を物理削除する */
export function runRetention(db: DB, now: Date, retentionMs: number): { posts: number; invites: number; credentials: number } {
  const cutoff = new Date(now.getTime() - retentionMs).toISOString();
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  return db.transaction(() => ({
    posts: db.delete(posts).where(lt(posts.createdAt, cutoff)).returning({ id: posts.id }).all().length,
    invites: db
      .delete(invites)
      .where(or(lt(invites.expiresAt, dayAgo), and(isNotNull(invites.usedAt), lt(invites.usedAt, dayAgo))))
      .returning({ id: invites.id })
      .all().length,
    credentials: db
      .delete(credentials)
      .where(and(isNotNull(credentials.revokedAt), lt(credentials.revokedAt, cutoff)))
      .returning({ id: credentials.id })
      .all().length,
  }));
}
