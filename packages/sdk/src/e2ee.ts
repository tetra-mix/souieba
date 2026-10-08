import {
  type CreatePostInput,
  DecryptError,
  type InboxItem,
  MIN_TELL_CONTENT_LENGTH,
  type PublishResult,
  type TellCandidate,
  type TrustProblem,
  type TrustResult,
  type WireInboxItem,
  openPost,
  sanitizeContent,
  scanSecrets,
  sealPost,
  verifyPostSignature,
} from "@souieba/core";
import type { AgentKeys } from "./config.ts";
import type { HttpTransport } from "./http.ts";
import { Keyring } from "./keyring.ts";
import type { SetLogTransport } from "./transport.ts";

export class SecretInPostError extends Error {
  constructor(readonly rules: string[]) {
    super(`秘密情報の可能性があるため投稿できません（${rules.join(", ")}）`);
  }
}

export type RejectReason =
  | "untrusted_author"
  | "untrusted_agent"
  | "header_mismatch"
  | "bad_signature"
  | "decrypt_failed"
  | "too_short";

export type E2eeOptions = {
  userId: string;
  agentId: string;
  keys: AgentKeys;
  /** 自分の Identity 公開鍵（ディレクトリ上で自分の鍵がすり替えられていないかの確認に使う） */
  identityKey: string;
  keyring?: Keyring;
  onProblem?: (p: TrustProblem) => void;
  onReject?: (postId: string, reason: RejectReason) => void;
};

/**
 * SetLogTransport の E2EE 実装。HttpTransport を包み、
 * 送信時は封筒にして署名し、受信時はサーバを信頼せずに検証してから復号する。
 * SetLog クラスやエージェント向けのコマンドからは、平文の Transport と同じに見える。
 */
export class E2eeTransport implements SetLogTransport {
  private trust: Promise<TrustResult> | null = null;
  private readonly keyring: Keyring;

  constructor(
    readonly inner: HttpTransport,
    private readonly opts: E2eeOptions,
  ) {
    this.keyring = opts.keyring ?? new Keyring();
  }

  /** 公開鍵ディレクトリを取得して検証する。1つのインスタンス（＝1回のコマンド）の中だけキャッシュする */
  directory(): Promise<TrustResult> {
    this.trust ??= this.inner.keys().then((dir) => {
      if (dir.me.userId !== this.opts.userId || dir.me.agentId !== this.opts.agentId) {
        throw new Error("サーバが返したディレクトリの持ち主が、この Agent と一致しません");
      }
      const result = this.keyring.evaluate(dir, this.opts.identityKey);
      for (const p of result.problems) this.opts.onProblem?.(p);
      return result;
    });
    this.trust.catch(() => {
      this.trust = null;
    });
    return this.trust;
  }

  async publish(post: CreatePostInput): Promise<PublishResult> {
    // サーバは本文を見られないので、秘密情報の検査と正規化は送る前にここで行う
    const content = sanitizeContent(post.content);
    const rules = [...new Set([...scanSecrets(post.content), ...scanSecrets(content)].map((f) => f.rule))];
    if (rules.length > 0) throw new SecretInPostError(rules);
    if (content.length === 0) throw new Error("本文が空です");

    const visibility = post.visibility ?? "groups";
    const { userId, agentId, keys } = this.opts;
    const trust = await this.directory();
    const recipients = [...trust.agents.values()]
      .filter((a) => visibility === "groups" || a.user.id === userId)
      .map((a) => ({ agentId: a.id, encKey: a.encKey }));
    if (!recipients.some((r) => r.agentId === agentId)) recipients.push({ agentId, encKey: keys.enc.pub });

    const envelope = sealPost(
      { periodStart: post.periodStart, periodEnd: post.periodEnd, visibility, content },
      { userId, agentId, signKey: keys.sign },
      recipients,
    );
    return this.inner.publishEnvelope(envelope);
  }

  sync() {
    return this.inner.sync();
  }

  async inbox(): Promise<InboxItem[]> {
    const trust = await this.directory();
    const items = await this.inner.inbox();
    return items.flatMap((item) => {
      const r = this.open(item, trust);
      return r.ok ? [{ ...r.item, receivedAt: item.receivedAt }] : [];
    });
  }

  /**
   * サーバが予約した候補を検証・復号して返す。検証や復号に失敗したものは dismiss して、
   * 次の候補を試す（何度も同じ壊れた投稿が候補にならないように）。
   */
  async claimTell(opts: { leaseSec?: number } = {}): Promise<TellCandidate | null> {
    const trust = await this.directory();
    for (let i = 0; i < 3; i++) {
      const c = await this.inner.claimTell(opts);
      if (!c) return null;
      const r = this.open(c, trust);
      if (r.ok) return { ...r.item, reservedUntil: c.reservedUntil };
      this.opts.onReject?.(c.postId, r.reason);
      await this.inner.dismiss(c.postId).catch(() => {});
    }
    return null;
  }

  markAsTold(postId: string) {
    return this.inner.markAsTold(postId);
  }

  release(postId: string) {
    return this.inner.release(postId);
  }

  /** 受け取った投稿の検証と復号（docs/public-deployment-plan.md §6.3） */
  private open(
    item: WireInboxItem,
    trust: TrustResult,
  ): { ok: true; item: Omit<TellCandidate, "reservedUntil"> } | { ok: false; reason: RejectReason } {
    const owner = trust.users.get(item.owner.id);
    if (!owner || owner.id === this.opts.userId) return { ok: false, reason: "untrusted_author" };
    const agent = trust.agents.get(item.authorAgentId);
    if (!agent || agent.user.id !== owner.id) return { ok: false, reason: "untrusted_agent" };

    const env = item.envelope;
    if (env.periodStart !== item.periodStart || env.periodEnd !== item.periodEnd || env.visibility !== "groups") {
      return { ok: false, reason: "header_mismatch" };
    }
    const author = { userId: owner.id, agentId: agent.id };
    if (!verifyPostSignature(env, author, agent.signKey)) return { ok: false, reason: "bad_signature" };

    let plain: string;
    try {
      plain = openPost(env, author, { agentId: this.opts.agentId, encKey: this.opts.keys.enc });
    } catch (err) {
      if (err instanceof DecryptError) return { ok: false, reason: "decrypt_failed" };
      throw err;
    }
    // 送信側の正規化は信用せず、受信側でもう一度通す（友人の投稿は信頼できない入力として扱う）
    const content = sanitizeContent(plain);
    if (content.length < MIN_TELL_CONTENT_LENGTH) return { ok: false, reason: "too_short" };

    return {
      ok: true,
      item: {
        postId: item.postId,
        owner: { id: owner.id, handle: owner.handle, displayName: owner.displayName },
        authorAgentName: agent.name,
        periodStart: item.periodStart,
        periodEnd: item.periodEnd,
        content,
      },
    };
  }
}
