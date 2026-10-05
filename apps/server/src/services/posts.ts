import { type CreatePostInput, type PublishResult, sanitizeContent, scanSecrets, validatePeriod } from "@souieba/core";
import { newId } from "../crypto.ts";
import { type DB, tx } from "../db.ts";
import { ApiError, badRequest, forbidden, notFound } from "../errors.ts";

export type Actor = { userId: string; agentId: string | null };

export function upsertPost(db: DB, actor: { userId: string; agentId: string }, input: CreatePostInput, now: Date, graceMs: number): PublishResult {
  const visibility = input.visibility ?? "friends";
  const periodError = validatePeriod(input.periodStart, input.periodEnd, now);
  if (periodError) throw badRequest(`period_${periodError}`, `期間が不正です（${periodError}）`);

  const content = sanitizeContent(input.content);
  if (content.length === 0) throw badRequest("empty_content", "本文が空です");
  const findings = [...scanSecrets(input.content), ...scanSecrets(content)];
  if (findings.length > 0) {
    // 何が引っかかったかの種類だけを返し、該当文字列そのものは返さない・記録しない
    const rules = [...new Set(findings.map((f) => f.rule))].join(", ");
    throw new ApiError(422, "secret_detected", `秘密情報の可能性があるため投稿できません（${rules}）`);
  }

  const periodStart = new Date(input.periodStart).toISOString();
  const periodEnd = new Date(input.periodEnd).toISOString();
  const visibleAt = new Date(now.getTime() + graceMs).toISOString();
  const ts = now.toISOString();

  return tx(db, () => {
    const existing = db
      .prepare("SELECT id FROM posts WHERE author_agent_id = ? AND period_start = ?")
      .get(actor.agentId, periodStart) as { id: string } | undefined;
    if (existing) {
      // 同じ時間帯の再投稿は上書きする（publisher の再実行やリトライで重複させない）
      db.prepare("UPDATE posts SET content = ?, visibility = ?, visible_at = ?, updated_at = ? WHERE id = ?").run(
        content,
        visibility,
        visibleAt,
        ts,
        existing.id,
      );
      return { postId: existing.id, visibleAt, created: false };
    }
    const id = newId("pst");
    db.prepare(
      `INSERT INTO posts (id, owner_id, author_agent_id, period_start, period_end, content, visibility, visible_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, actor.userId, actor.agentId, periodStart, periodEnd, content, visibility, visibleAt, ts, ts);
    return { postId: id, visibleAt, created: true };
  });
}

/** 削除は物理削除。配送状態も ON DELETE CASCADE で消え、受信側の受信箱からも消える */
export function deletePost(db: DB, actor: Actor, postId: string): void {
  const post = db.prepare("SELECT owner_id, author_agent_id FROM posts WHERE id = ?").get(postId) as
    | { owner_id: string; author_agent_id: string }
    | undefined;
  if (!post) throw notFound("投稿");
  const allowed = actor.agentId ? post.author_agent_id === actor.agentId : post.owner_id === actor.userId;
  if (!allowed) {
    if (post.owner_id !== actor.userId) throw notFound("投稿");
    throw forbidden("自分の Agent が書いた投稿だけを削除できます");
  }
  db.prepare("DELETE FROM posts WHERE id = ?").run(postId);
}

/** 自分について書かれた投稿（全 Agent 分） */
export function listMyPosts(db: DB, userId: string) {
  const rows = db
    .prepare(
      `SELECT p.*, a.name AS agent_name FROM posts p JOIN agents a ON a.id = p.author_agent_id
       WHERE p.owner_id = ? ORDER BY p.period_start DESC, p.created_at DESC LIMIT 200`,
    )
    .all(userId) as {
    id: string;
    agent_name: string;
    author_agent_id: string;
    period_start: string;
    period_end: string;
    content: string;
    visibility: string;
    visible_at: string;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    author: { id: r.author_agent_id, name: r.agent_name },
    periodStart: r.period_start,
    periodEnd: r.period_end,
    content: r.content,
    visibility: r.visibility,
    visibleAt: r.visible_at,
    createdAt: r.created_at,
  }));
}
