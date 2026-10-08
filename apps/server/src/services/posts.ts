import { type PostEnvelope, type PublishResult, validatePeriod, verifyPostSignature } from "@souieba/core";
import { newId } from "../crypto.ts";
import { type DB, tx } from "../db.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { getAgent } from "./accounts.ts";
import { allowedRecipientAgents } from "./groups.ts";

export type Actor = { userId: string; agentId: string | null };

export const MAX_RECIPIENTS = 200;

/**
 * 暗号化された投稿を保存する。サーバは本文を読めないので、確かめるのは
 * 期間・署名（投稿した Agent 本人か）・宛先（同じグループの Agent か）だけ。
 * 秘密情報の検査と本文の正規化はクライアント側で行う。
 */
export function upsertPost(db: DB, actor: { userId: string; agentId: string }, envelope: PostEnvelope, now: Date, graceMs: number): PublishResult {
  const periodError = validatePeriod(envelope.periodStart, envelope.periodEnd, now);
  if (periodError) throw badRequest(`period_${periodError}`, `期間が不正です（${periodError}）`);
  if (envelope.recipients.length > MAX_RECIPIENTS) throw badRequest("too_many_recipients", `宛先は ${MAX_RECIPIENTS} 件までです`);

  const agent = getAgent(db, actor.agentId);
  if (!agent?.sign_key) throw conflict("agent_keys_required", "この Agent には鍵がありません。souieba agent add で登録し直してください");
  if (!verifyPostSignature(envelope, { userId: actor.userId, agentId: actor.agentId }, agent.sign_key)) {
    throw badRequest("invalid_signature", "投稿の署名を検証できません");
  }

  // 宛先は、今その時点で届けてよい Agent だけに絞る（古いディレクトリで作った封筒も受け付けるため、拒否はしない）
  const allowed = allowedRecipientAgents(db, actor.userId, envelope.visibility);
  const recipients = [...new Set(envelope.recipients.map((r) => r.agentId))].filter((id) => allowed.has(id));

  const periodStart = new Date(envelope.periodStart).toISOString();
  const periodEnd = new Date(envelope.periodEnd).toISOString();
  if (periodStart !== envelope.periodStart || periodEnd !== envelope.periodEnd) {
    // 署名は送られてきた文字列に対して行われているので、正規化した値に置き換えられない
    throw badRequest("period_not_canonical", "期間は ISO 8601（toISOString の形式）で指定してください");
  }
  const visibleAt = new Date(now.getTime() + graceMs).toISOString();
  const ts = now.toISOString();
  const body = JSON.stringify(envelope);

  return tx(db, () => {
    const existing = db
      .prepare("SELECT id FROM posts WHERE author_agent_id = ? AND period_start = ?")
      .get(actor.agentId, periodStart) as { id: string } | undefined;
    let postId: string;
    if (existing) {
      // 同じ時間帯の再投稿は上書きする（publisher の再実行やリトライで重複させない）
      postId = existing.id;
      db.prepare("UPDATE posts SET envelope = ?, visibility = ?, visible_at = ?, updated_at = ? WHERE id = ?").run(
        body,
        envelope.visibility,
        visibleAt,
        ts,
        postId,
      );
      db.prepare("DELETE FROM post_recipients WHERE post_id = ?").run(postId);
    } else {
      postId = newId("pst");
      db.prepare(
        `INSERT INTO posts (id, owner_id, author_agent_id, period_start, period_end, visibility, envelope, visible_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(postId, actor.userId, actor.agentId, periodStart, periodEnd, envelope.visibility, body, visibleAt, ts, ts);
    }
    const insert = db.prepare("INSERT INTO post_recipients (post_id, agent_id) VALUES (?, ?)");
    for (const id of recipients) insert.run(postId, id);
    return { postId, visibleAt, created: !existing };
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

/** 自分について書かれた投稿（全 Agent 分）。本文は暗号文のまま返し、CLI が手元の Agent の鍵で復号する */
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
    envelope: string;
    visibility: string;
    visible_at: string;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    author: { id: r.author_agent_id, name: r.agent_name },
    periodStart: r.period_start,
    periodEnd: r.period_end,
    envelope: JSON.parse(r.envelope) as PostEnvelope,
    visibility: r.visibility,
    visibleAt: r.visible_at,
    createdAt: r.created_at,
  }));
}
