import type { DB } from "./db.ts";

/** 保存期間を過ぎた投稿（と配送状態）、使い終わった招待、失効済みの資格情報を物理削除する */
export function runRetention(db: DB, now: Date, retentionMs: number): { posts: number; invites: number; credentials: number } {
  const cutoff = new Date(now.getTime() - retentionMs).toISOString();
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  const posts = db.prepare("DELETE FROM posts WHERE created_at < ?").run(cutoff).changes;
  const invites = db.prepare("DELETE FROM invites WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)").run(dayAgo, dayAgo).changes;
  const credentials = db.prepare("DELETE FROM credentials WHERE revoked_at IS NOT NULL AND revoked_at < ?").run(cutoff).changes;
  return { posts: Number(posts), invites: Number(invites), credentials: Number(credentials) };
}
