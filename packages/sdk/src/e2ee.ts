import {
  type CreatePostInput,
  DecryptError,
  MAX_POST_LENGTH,
  type DirectoryAgent,
  type DirectoryUser,
  type InboxItem,
  type KeyDirectory,
  MIN_TELL_CONTENT_LENGTH,
  type PublishResult,
  type TellCandidate,
  type WireInboxItem,
  openPost,
  findInstructionLike,
  sanitizeContent,
  scanSecrets,
  sealPost,
  verifyPostSignature,
} from "@souieba/core";
import type { AgentKeys } from "./config.ts";
import type { HttpTransport } from "./http.ts";
import type { SetLogTransport } from "./transport.ts";

export class SecretInPostError extends Error {
  constructor(readonly rules: string[]) {
    super(`秘密情報の可能性があるため投稿できません（${rules.join(", ")}）`);
  }
}

/** 読み手のエージェントへの命令に見える投稿。受信側で捨てられるので、送る前に断る */
export class InstructionLikePostError extends Error {
  constructor(readonly rules: string[]) {
    super(`友人のエージェントへの命令に見える表現があるため投稿できません（${rules.join(", ")}）`);
  }
}

export class PostTooLongError extends Error {
  constructor(readonly length: number) {
    super(`投稿が長すぎます（${length}字。${MAX_POST_LENGTH}字まで）`);
  }
}

export type RejectReason =
  | "unknown_author"
  | "unknown_agent"
  | "header_mismatch"
  | "bad_signature"
  | "decrypt_failed"
  | "too_short"
  | "too_long"
  | "instruction_like"
  | "bad_display_name";

export type E2eeOptions = {
  userId: string;
  agentId: string;
  keys: AgentKeys;
  onReject?: (postId: string, reason: RejectReason) => void;
};

type Directory = {
  users: Map<string, DirectoryUser>;
  agents: Map<string, DirectoryAgent & { userId: string }>;
};

/**
 * SetLogTransport の E2EE 実装。HttpTransport を包み、
 * 送信時は封筒にして署名し、受信時は署名を確かめてから復号する。
 * 宛先の鍵と投稿者の鍵は、サーバが配る公開鍵ディレクトリをそのまま使う（サーバを信頼する。DB が漏れても本文は読めない）。
 * SetLog クラスやエージェント向けのコマンドからは、平文の Transport と同じに見える。
 */
export class E2eeTransport implements SetLogTransport {
  private dir: Promise<Directory> | null = null;

  constructor(
    readonly inner: HttpTransport,
    private readonly opts: E2eeOptions,
  ) {}

  /** 公開鍵ディレクトリ。1つのインスタンス（＝1回のコマンド）の中だけキャッシュする */
  directory(): Promise<Directory> {
    this.dir ??= this.inner.keys().then((d: KeyDirectory) => {
      if (d.me.userId !== this.opts.userId || d.me.agentId !== this.opts.agentId) {
        throw new Error("サーバが返したディレクトリの持ち主が、この Agent と一致しません");
      }
      const users = new Map(d.users.map((u) => [u.id, u]));
      const agents = new Map(d.users.flatMap((u) => u.agents.map((a) => [a.id, { ...a, userId: u.id }] as const)));
      return { users, agents };
    });
    this.dir.catch(() => {
      this.dir = null;
    });
    return this.dir;
  }

  /** 自分のアカウントに登録されている、有効な Agent */
  async ownAgents(): Promise<DirectoryAgent[]> {
    return (await this.directory()).users.get(this.opts.userId)?.agents ?? [];
  }

  async publish(post: CreatePostInput): Promise<PublishResult> {
    // サーバは本文を見られないので、秘密情報の検査と正規化は送る前にここで行う
    const content = sanitizeContent(post.content);
    const rules = [...new Set([...scanSecrets(post.content), ...scanSecrets(content)].map((f) => f.rule))];
    if (rules.length > 0) throw new SecretInPostError(rules);
    if (content.length === 0) throw new Error("本文が空です");
    if (content.length > MAX_POST_LENGTH) throw new PostTooLongError(content.length);
    const suspicious = findInstructionLike(content);
    if (suspicious.length > 0) throw new InstructionLikePostError(suspicious);

    const visibility = post.visibility ?? "groups";
    const { userId, agentId, keys } = this.opts;
    const dir = await this.directory();
    const recipients = [...dir.agents.values()]
      .filter((a) => visibility === "groups" || a.userId === userId)
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
    const dir = await this.directory();
    const items = await this.inner.inbox();
    return items.flatMap((item) => {
      const r = this.open(item, dir);
      return r.ok ? [{ ...r.item, receivedAt: item.receivedAt }] : [];
    });
  }

  /**
   * サーバが予約した候補を検証・復号して返す。検証や復号に失敗したものは dismiss して、
   * 次の候補を試す（何度も同じ壊れた投稿が候補にならないように）。
   */
  async claimTell(opts: { leaseSec?: number } = {}): Promise<TellCandidate | null> {
    const dir = await this.directory();
    for (let i = 0; i < 3; i++) {
      const c = await this.inner.claimTell(opts);
      if (!c) return null;
      const r = this.open(c, dir);
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
    dir: Directory,
  ): { ok: true; item: Omit<TellCandidate, "reservedUntil"> } | { ok: false; reason: RejectReason } {
    // 今いっしょにいるグループがない人（抜けた人など）や、失効した Agent の投稿は伝えない
    const owner = dir.users.get(item.owner.id);
    if (!owner || owner.id === this.opts.userId) return { ok: false, reason: "unknown_author" };
    const agent = dir.agents.get(item.authorAgentId);
    if (!agent || agent.userId !== owner.id) return { ok: false, reason: "unknown_agent" };

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
    if (content.length > MAX_POST_LENGTH) return { ok: false, reason: "too_long" };
    if (findInstructionLike(content).length > 0) return { ok: false, reason: "instruction_like" };
    // 表示名も Tell 文に入るので、本文と同じく信頼できない入力として確かめる
    const name = owner.displayName;
    if (sanitizeContent(name) !== name || findInstructionLike(name).length > 0) return { ok: false, reason: "bad_display_name" };

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
