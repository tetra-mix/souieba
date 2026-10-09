import { type PostEnvelope, type PublishResult, validatePeriod, verifyPostSignature } from "@souieba/core";
import { newId } from "../crypto.ts";
import { and, desc, eq } from "drizzle-orm";
import { type DB, MAX_BOUND_PARAMS, chunks } from "../db/index.ts";
import { agents, postRecipients, posts } from "../db/schema.ts";
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
export function upsertPost(
  db: DB,
  actor: { userId: string; agentId: string },
  envelope: PostEnvelope,
  now: Date,
  graceMs: number,
): PublishResult {
  const periodError = validatePeriod(envelope.periodStart, envelope.periodEnd, now);
  if (periodError) throw badRequest(`period_${periodError}`, `期間が不正です（${periodError}）`);
  if (envelope.recipients.length > MAX_RECIPIENTS) throw badRequest("too_many_recipients", `宛先は ${MAX_RECIPIENTS} 件までです`);

  const agent = getAgent(db, actor.agentId);
  if (!agent?.signKey) throw conflict("agent_keys_required", "この Agent には鍵がありません。souieba agent add で登録し直してください");
  if (!verifyPostSignature(envelope, { userId: actor.userId, agentId: actor.agentId }, agent.signKey)) {
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

  return db.transaction(() => {
    const existing = db
      .select({ id: posts.id })
      .from(posts)
      .where(and(eq(posts.authorAgentId, actor.agentId), eq(posts.periodStart, periodStart)))
      .get();
    let postId: string;
    if (existing) {
      // 同じ時間帯の再投稿は上書きする（publisher の再実行やリトライで重複させない）
      postId = existing.id;
      db.update(posts).set({ envelope: body, visibility: envelope.visibility, visibleAt, updatedAt: ts }).where(eq(posts.id, postId)).run();
      db.delete(postRecipients).where(eq(postRecipients.postId, postId)).run();
    } else {
      postId = newId("pst");
      db.insert(posts)
        .values({
          id: postId,
          ownerId: actor.userId,
          authorAgentId: actor.agentId,
          periodStart,
          periodEnd,
          visibility: envelope.visibility,
          envelope: body,
          visibleAt,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
    }
    // 1行あたり2変数
    for (const batch of chunks(recipients, Math.floor(MAX_BOUND_PARAMS / 2))) {
      db.insert(postRecipients)
        .values(batch.map((agentId) => ({ postId, agentId })))
        .run();
    }
    return { postId, visibleAt, created: !existing };
  });
}

/** 削除は物理削除。配送状態も ON DELETE CASCADE で消え、受信側の受信箱からも消える */
export function deletePost(db: DB, actor: Actor, postId: string): void {
  const post = db.select({ ownerId: posts.ownerId, authorAgentId: posts.authorAgentId }).from(posts).where(eq(posts.id, postId)).get();
  if (!post) throw notFound("投稿");
  const allowed = actor.agentId ? post.authorAgentId === actor.agentId : post.ownerId === actor.userId;
  if (!allowed) {
    if (post.ownerId !== actor.userId) throw notFound("投稿");
    throw forbidden("自分の Agent が書いた投稿だけを削除できます");
  }
  db.delete(posts).where(eq(posts.id, postId)).run();
}

/** 自分について書かれた投稿（全 Agent 分）。本文は暗号文のまま返し、CLI が手元の Agent の鍵で復号する */
export function listMyPosts(db: DB, userId: string) {
  const rows = db
    .select({ post: posts, agentName: agents.name })
    .from(posts)
    .innerJoin(agents, eq(agents.id, posts.authorAgentId))
    .where(eq(posts.ownerId, userId))
    .orderBy(desc(posts.periodStart), desc(posts.createdAt))
    .limit(200)
    .all();
  return rows.map(({ post: r, agentName }) => ({
    id: r.id,
    author: { id: r.authorAgentId, name: agentName },
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    envelope: JSON.parse(r.envelope) as PostEnvelope,
    visibility: r.visibility,
    visibleAt: r.visibleAt,
    createdAt: r.createdAt,
  }));
}
