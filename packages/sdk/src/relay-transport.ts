/**
 * SouiebaTransport の v2 実装。Note → Publish → Tell の流れはそのままに、送受信を Relay 経由の E2EE にする。
 * - Publish: 宛先の解決 → アクセス権限の確認 → 鍵の検証 → Narrative Message を受信者ごとに暗号化 → Relay へ
 * - Tell: Relay から受け取る → 送信者の認証（署名）→ 復号 → 中身の検査 → 手元の受信箱へ（利用期限まで）
 * 受信箱・予約・TOLD は手元（Agent の状態ディレクトリ）で管理する。Relay は受け取ったら鍵を消す。
 */
import {
  type CreatePostInput,
  DEFAULT_DELIVERY_TTL_MS,
  DEFAULT_USE_TTL_MS,
  type InboxItem,
  MAX_MESSAGE_TTL_MS,
  type NarrativeIssue,
  type NarrativeMessage,
  type PublishResult,
  RelayDecryptError,
  type RelayEnvelope,
  type RelayIdentity,
  type Reshare,
  type SyncResult,
  type TellCandidate,
  normalizeNarrative,
  openRelayMessage,
  sealRelayMessage,
  verifyRecipientBox,
} from "@souieba/core";
import { checkPostContent } from "./e2ee.ts";
import type { RelayConnection, RelayHttp } from "./relay-http.ts";
import {
  type Contact,
  type RelayInboxItem,
  RelayInboxStore,
  type RelayState,
  type RelayStateStore,
  type ResolvedTargets,
  checkPinnedKey,
  contactFrom,
  resolveTargets,
} from "./relay-state.ts";
import type { SouiebaTransport } from "./transport.ts";

/** 作成時刻が未来にずれていてよい範囲 */
const FUTURE_SKEW_MS = 10 * 60_000;
const MIN_TTL_MS = 60 * 60_000;
const DEFAULT_LEASE_SEC = 600;

export type RelayRejectReason =
  | "not_for_me"
  | "unknown_sender"
  | "stale_key"
  | "bad_signature"
  | "replay"
  | "expired"
  | "bad_time"
  | "decrypt_failed"
  | NarrativeIssue;

export type RelayPublishOptions = {
  /** 宛先。"all"（既定）・"group:<グループ>"・呼び名・Agent ID */
  to?: string[];
  purpose?: string;
  nuance?: string;
  context?: string;
  /** 利用期限（作成から）。1時間〜7日 */
  useTtlMs?: number;
  /** 配送期限（作成から）。1時間〜7日 */
  deliveryTtlMs?: number;
  reshare?: Reshare;
};

export type RelayPublishResult = PublishResult & {
  /** 送った相手の呼び名 */
  recipients: string[];
  /** 宛先に含めたが、アクセス権限がないので送らなかった相手 */
  denied: string[];
  /** 宛先に含めたが、接続していない相手 */
  notConnected: string[];
  /** 鍵を確かめられなかったので送らなかった相手（Relay による鍵のすり替えの疑い） */
  keyProblems: { agentId: string; reason: string }[];
  /** Relay が受け付けなかった相手 */
  skipped: { agentId: string; reason: string }[];
};

/** Narrator の項目などが規則に合わない（書き直しを求める） */
export class NarrativeRejectedError extends Error {
  constructor(readonly reason: NarrativeIssue) {
    super(`共有内容か伝え方の項目が規則に合いません（${reason}）`);
  }
}

/** 送ってよい相手が1人もいない */
export class NoRecipientsError extends Error {
  constructor(readonly targets: ResolvedTargets) {
    super(
      targets.denied.length > 0
        ? "宛先の全員について、主人がまだ共有を許可していません"
        : "送れる相手がいません（接続済みの相手がいないか、宛先が接続していません）",
    );
  }
}

export type RelayNotices = {
  /** 届いた接続要求（まだ主人に知らせていないもの） */
  incomingRequests: string[];
  /** 接続済みだが、呼び名がまだない相手（呼び名を付けるまで、この人からの近況は受け取らない） */
  unnamedPeers: string[];
  /** Encryption 鍵が新しい版に替わった連絡先 */
  keyChanges: { agentId: string; name: string; at: string }[];
};

export type RelayTransportOptions = {
  http: RelayHttp;
  identity: RelayIdentity;
  state: RelayStateStore;
  inbox: RelayInboxStore;
  now?: () => Date;
  random?: () => number;
  onReject?: (messageId: string, reason: RelayRejectReason) => void;
};

export class RelayTransport implements SouiebaTransport {
  private readonly now: () => Date;
  private readonly random: () => number;
  private lastConnections: RelayConnection[] | null = null;

  constructor(private readonly opts: RelayTransportOptions) {
    this.now = opts.now ?? (() => new Date());
    this.random = opts.random ?? Math.random;
  }

  get agentId(): string {
    return this.opts.identity.agentId;
  }

  /** この Agent の手元の状態（連絡先・グループ・アクセス権限・Policy） */
  localState(): RelayState {
    return this.opts.state.load();
  }

  /** 接続の一覧をもう取ったか（tell のついでの確認で、取っていなければ取りに行くため） */
  get hasConnections(): boolean {
    return this.lastConnections !== null;
  }

  /**
   * Relay の接続一覧を取り、新しく接続した相手を連絡先に加える（鍵を検証して固定する）。
   * 呼び名は、接続要求を送った・承認したときに主人が付けたもの。なければ連絡先に加えず、知らせる
   */
  async syncContacts(interactive = false): Promise<{ connections: RelayConnection[]; connected: Set<string> }> {
    const { connections } = await this.opts.http.connections(interactive);
    this.lastConnections = connections;
    const accepted = connections.filter((c) => c.status === "accepted").map((c) => c.peer);
    const state = this.opts.state.load();
    const missing = accepted.filter((id) => !state.contacts[id] && state.pendingNames[id]);
    if (missing.length > 0) {
      const entries = await this.opts.http.lookup(missing, interactive);
      const now = this.now();
      this.opts.state.update((s) => {
        for (const e of entries) {
          const name = s.pendingNames[e.agentId];
          if (!name || s.contacts[e.agentId] || !checkPinnedKey(undefined, e).ok) continue;
          s.contacts[e.agentId] = contactFrom(e, name, now);
          delete s.pendingNames[e.agentId];
        }
      });
    }
    return { connections, connected: new Set(accepted) };
  }

  // ---- Publish ----

  publish(post: CreatePostInput): Promise<RelayPublishResult> {
    return this.publishNarrative(post, {});
  }

  async publishNarrative(post: CreatePostInput, o: RelayPublishOptions): Promise<RelayPublishResult> {
    if (post.visibility === "private") throw new Error("v2 では自分だけに向けた投稿（private）はできません");
    const content = checkPostContent(post.content);
    const now = this.now();
    const createdAt = now.toISOString();
    const ttl = (v: number | undefined, d: number) => Math.min(MAX_MESSAGE_TTL_MS, Math.max(MIN_TTL_MS, v ?? d));
    const draft: NarrativeMessage = {
      v: 1,
      content,
      ...(o.purpose ? { purpose: o.purpose } : {}),
      ...(o.nuance ? { nuance: o.nuance } : {}),
      ...(o.context ? { context: o.context } : {}),
      useExpiresAt: new Date(now.getTime() + ttl(o.useTtlMs, DEFAULT_USE_TTL_MS)).toISOString(),
      reshare: o.reshare ?? "deny",
      periodStart: post.periodStart,
      periodEnd: post.periodEnd,
    };
    const checked = normalizeNarrative(draft, { createdAt });
    if (!checked.ok) throw new NarrativeRejectedError(checked.reason);
    // 送る前の正規化で、Narrator の項目の中身が変わったら（記号を落とした等）、そのまま送る。空になった項目は落ちる
    const message = checked.message;

    const { connected } = await this.syncContacts();
    const state = this.opts.state.load();
    const targets = resolveTargets(state, o.to ?? [], connected);
    if (targets.recipients.length === 0) throw new NoRecipientsError(targets);

    // 宛先の今の鍵を Relay から取り、固定した鍵と照らし合わせる
    const entries = new Map((await this.opts.http.lookup(targets.recipients.map((c) => c.agentId))).map((e) => [e.agentId, e]));
    const keyProblems: RelayPublishResult["keyProblems"] = [];
    const ready: Contact[] = [];
    const rotated: Contact[] = [];
    for (const c of targets.recipients) {
      const e = entries.get(c.agentId);
      if (!e) {
        keyProblems.push({ agentId: c.agentId, reason: "not_found" });
        continue;
      }
      const k = checkPinnedKey(c, e);
      if (!k.ok) {
        keyProblems.push({ agentId: c.agentId, reason: k.reason });
        continue;
      }
      const next = k.changed
        ? { ...c, encKey: e.encKey, encKeyVersion: e.encKeyVersion, encKeySig: e.encKeySig, keyChangedAt: createdAt }
        : c;
      if (k.changed) rotated.push(next);
      ready.push(next);
    }
    if (rotated.length > 0) {
      this.opts.state.update((s) => {
        for (const c of rotated) if (s.contacts[c.agentId]) s.contacts[c.agentId] = c;
      });
    }
    if (ready.length === 0) throw new NoRecipientsError({ ...targets, recipients: [] });

    const envelope = sealRelayMessage(
      message,
      this.opts.identity,
      ready.map((c) => ({ agentId: c.agentId, encKey: c.encKey, encKeyVersion: c.encKeyVersion })),
      { createdAt, deliveryExpiresAt: new Date(now.getTime() + ttl(o.deliveryTtlMs, DEFAULT_DELIVERY_TTL_MS)).toISOString() },
    );
    const r = await this.opts.http.send(envelope);
    const names = new Map(ready.map((c) => [c.agentId, c.name]));
    return {
      postId: r.messageId,
      visibleAt: r.visibleAt,
      created: true,
      recipients: r.accepted.map((id) => names.get(id) ?? id),
      denied: targets.denied,
      notConnected: targets.notConnected,
      keyProblems,
      skipped: r.skipped,
    };
  }

  // ---- 受信 ----

  /** Relay から受け取り、検証・復号して手元の受信箱に入れる。受け取ったものは Relay に知らせて消してもらう */
  async sync(): Promise<SyncResult> {
    const { connected } = await this.syncContacts(true);
    const fetched = await this.opts.http.fetchMessages(true);
    const state = this.opts.state.load();
    const now = this.now();
    const ack: string[] = [];
    let received = 0;
    const size = this.opts.inbox.update((f) => {
      RelayInboxStore.prune(f, now);
      for (const { envelope, receivedAt } of fetched) {
        const r = this.open(envelope, state, connected, f.seen, now);
        if (r === "hold") continue;
        ack.push(envelope.messageId);
        if (!r.ok) {
          this.opts.onReject?.(envelope.messageId, r.reason);
          continue;
        }
        f.seen[envelope.messageId] = envelope.deliveryExpiresAt;
        f.items.push({
          messageId: envelope.messageId,
          sender: envelope.sender,
          createdAt: envelope.createdAt,
          receivedAt,
          deliveryExpiresAt: envelope.deliveryExpiresAt,
          message: r.message,
        });
        received++;
      }
      return f.items.filter((i) => !i.toldAt).length;
    });
    await this.opts.http.ack(ack, true);
    return { received, inboxSize: size };
  }

  /**
   * 受け取った1件の検証と復号（§3.3・§15）。送信者の認証 → 期限 → 再配送 → 復号 → 中身の検査の順。
   * 接続済みだが呼び名のない相手からのものは、呼び名が付くまで Relay に残す（"hold"）
   */
  private open(
    env: RelayEnvelope,
    state: RelayState,
    connected: Set<string>,
    seen: Record<string, string>,
    now: Date,
  ): "hold" | { ok: true; message: NarrativeMessage } | { ok: false; reason: RelayRejectReason } {
    const me = this.opts.identity;
    const box = env.recipients[0];
    if (env.recipients.length !== 1 || !box || box.agentId !== me.agentId) return { ok: false, reason: "not_for_me" };
    const contact = state.contacts[env.sender];
    if (!contact) return connected.has(env.sender) ? "hold" : { ok: false, reason: "unknown_sender" };
    if (box.keyVersion !== me.encKeyVersion) return { ok: false, reason: "stale_key" };
    if (!verifyRecipientBox(env, box, contact.identityKey)) return { ok: false, reason: "bad_signature" };
    if (seen[env.messageId]) return { ok: false, reason: "replay" };
    const t = now.getTime();
    if (Date.parse(env.deliveryExpiresAt) <= t) return { ok: false, reason: "expired" };
    if (!(Date.parse(env.createdAt) <= t + FUTURE_SKEW_MS)) return { ok: false, reason: "bad_time" };
    let raw: unknown;
    try {
      raw = openRelayMessage(env, me);
    } catch (err) {
      if (err instanceof RelayDecryptError) return { ok: false, reason: "decrypt_failed" };
      throw err;
    }
    const n = normalizeNarrative(raw, { createdAt: env.createdAt });
    if (!n.ok) return n;
    if (Date.parse(n.message.useExpiresAt) <= t) return { ok: false, reason: "expired" };
    return n;
  }

  /** 前回の syncContacts で分かった、主人に知らせることを返し、知らせたことにする */
  takeNotices(): RelayNotices {
    const conns = this.lastConnections;
    return this.opts.state.update((s) => {
      const keyChanges = Object.values(s.contacts)
        .filter((c) => c.keyChangedAt)
        .map((c) => ({ agentId: c.agentId, name: c.name, at: c.keyChangedAt! }));
      for (const c of Object.values(s.contacts)) delete c.keyChangedAt;
      // 接続の一覧をまだ取っていなければ、接続要求については何も言わない（知らせ済みの記録も変えない）
      if (!conns) return { incomingRequests: [], unnamedPeers: [], keyChanges };
      const incoming = conns.filter((c) => c.status === "incoming").map((c) => c.peer);
      const fresh = incoming.filter((id) => !s.notifiedRequests.includes(id));
      // 取り消された要求は忘れる（同じ人からまた届いたら知らせ直す）
      s.notifiedRequests = incoming;
      const unnamedPeers = conns.filter((c) => c.status === "accepted" && !s.contacts[c.peer]).map((c) => c.peer);
      return { incomingRequests: fresh, unnamedPeers, keyChanges };
    });
  }

  // ---- Tell ----

  private candidateOf(item: RelayInboxItem, contact: Contact, reservedUntil: string): TellCandidate {
    const m = item.message;
    return {
      postId: item.messageId,
      owner: { id: item.sender, handle: item.sender, displayName: contact.name },
      authorAgentName: contact.name,
      periodStart: m.periodStart ?? item.createdAt,
      periodEnd: m.periodEnd ?? item.createdAt,
      content: m.content,
      reservedUntil,
      narrative: {
        ...(m.purpose ? { purpose: m.purpose } : {}),
        ...(m.nuance ? { nuance: m.nuance } : {}),
        ...(m.context ? { context: m.context } : {}),
        reshare: m.reshare,
        useExpiresAt: m.useExpiresAt,
      },
    };
  }

  /**
   * 手元の受信箱から1件を選んで予約する。新しいものほど選ばれやすく（上位3件を 0.6/0.3/0.1）、
   * 直前に伝えた相手は他に候補があれば避け、同じ相手・同じ時間帯のものは最新の1件にまとめる（v1 と同じ選び方）
   */
  async claimTell(opts: { leaseSec?: number } = {}): Promise<TellCandidate | null> {
    const now = this.now();
    const t = now.toISOString();
    const state = this.opts.state.load();
    return this.opts.inbox.update((f) => {
      RelayInboxStore.prune(f, now);
      const open = f.items.filter((i) => !i.toldAt && !(i.reservedUntil && i.reservedUntil > t) && state.contacts[i.sender]);
      const latest = new Map<string, RelayInboxItem>();
      for (const i of open) {
        const key = `${i.sender}\u0000${i.message.periodStart ?? i.messageId}`;
        const cur = latest.get(key);
        if (!cur || cur.createdAt < i.createdAt) latest.set(key, i);
      }
      let pool = [...latest.values()];
      if (pool.length === 0) return null;
      const others = pool.filter((i) => i.sender !== state.lastToldSender);
      if (others.length > 0) pool = others;
      pool.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      const weights = [0.6, 0.3, 0.1].slice(0, Math.min(3, pool.length));
      let x = this.random() * weights.reduce((s, w) => s + w, 0);
      let pick = pool[weights.length - 1]!;
      for (let i = 0; i < weights.length; i++) {
        x -= weights[i]!;
        if (x < 0) {
          pick = pool[i]!;
          break;
        }
      }
      const reservedUntil = new Date(now.getTime() + (opts.leaseSec ?? DEFAULT_LEASE_SEC) * 1000).toISOString();
      pick.reservedUntil = reservedUntil;
      return this.candidateOf(pick, state.contacts[pick.sender]!, reservedUntil);
    });
  }

  async markAsTold(messageId: string): Promise<void> {
    const now = this.now().toISOString();
    const sender = this.opts.inbox.update((f) => {
      const item = f.items.find((i) => i.messageId === messageId);
      if (!item) throw new Error("この近況は受信箱にありません（利用期限が切れた可能性があります）");
      item.toldAt ??= now;
      delete item.reservedUntil;
      return item.sender;
    });
    this.opts.state.update((s) => {
      s.lastToldSender = sender;
    });
  }

  async release(messageId: string): Promise<void> {
    this.opts.inbox.update((f) => {
      const item = f.items.find((i) => i.messageId === messageId);
      if (item) delete item.reservedUntil;
    });
  }

  async inbox(): Promise<InboxItem[]> {
    const state = this.opts.state.load();
    const now = this.now();
    const f = this.opts.inbox.load();
    RelayInboxStore.prune(f, now);
    return f.items.flatMap((i) => {
      const c = state.contacts[i.sender];
      if (!c) return [];
      const { reservedUntil: _, narrative: __, ...rest } = this.candidateOf(i, c, "");
      return [{ ...rest, receivedAt: i.receivedAt }];
    });
  }
}
