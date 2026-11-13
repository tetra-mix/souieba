/**
 * SouiebaTransport の v2 実装。Note → Publish → Tell の流れはそのままに、送受信を Relay 経由の E2EE にする。
 * - Publish: 宛先の解決 → アクセス権限の確認 → 鍵の検証 → Narrative Message を受信者ごとに暗号化 → Relay へ
 * - Tell: Relay から受け取る → 送信者の認証（署名）→ 復号 → 中身の検査 → 手元の受信箱へ（利用期限まで）
 * 受信箱・予約・TOLD は手元（人の状態ディレクトリ。この PC の端末で共有）で管理する。Relay は受け取ったら鍵を消す。
 * 2.1.0 から、宛先は人。その人の取り消されていない端末すべてに鍵を包む。同じ PC のほかの端末が同じメッセージを受け取っても、
 * 受信箱は1つなので、伝えるのは1回だけ（先に tell した会話）。
 */
import {
  type CreatePostInput,
  DEFAULT_DELIVERY_TTL_MS,
  HPKE_SUITE,
  MESSAGE_ID_RE,
  DEFAULT_USE_TTL_MS,
  type InboxItem,
  MAX_MESSAGE_TTL_MS,
  type NarrativeIssue,
  type NarrativeMessage,
  type PublishResult,
  type DeviceIdentity,
  type PersonDirectory,
  RelayDecryptError,
  type RelayEnvelope,
  type RelayRecipient,
  type Reshare,
  type SyncResult,
  type TellCandidate,
  isCanonicalIso,
  isDeviceId,
  isPersonId,
  normalizeNarrative,
  openRelayMessage,
  sealRelayMessage,
  verifyDeviceCert,
  verifyPersonDirectory,
  verifyRecipientGroup,
} from "@souieba/core";
import { checkPostContent } from "./e2ee.ts";
import type { RelayConnection, RelayHttp } from "./relay-http.ts";
import {
  type Contact,
  type HeldEnvelope,
  type RelayInboxItem,
  RelayInboxStore,
  type RelayState,
  type RelayStateStore,
  type ResolvedTargets,
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
  | "bad_sender_device"
  | "stale_key"
  | "bad_signature"
  | "replay"
  | "expired"
  | "bad_time"
  | "decrypt_failed"
  | "bad_header"
  | NarrativeIssue;

export type RelayPublishOptions = {
  /** 宛先。"all"（既定）・"group:<グループ>"・呼び名・Person ID */
  to?: string[];
  purpose?: string;
  nuance?: string;
  context?: string;
  /** 利用期限（作成から）。1時間〜7日 */
  useTtlMs?: number;
  /** 配送期限（作成から）。1時間〜7日 */
  deliveryTtlMs?: number;
  reshare?: Reshare;
  /** どのプロジェクトの投稿か。共有先はこのプロジェクトの設定だけで決める（既定は default） */
  project?: string;
};

export type RelayPublishResult = PublishResult & {
  /** 送った相手の呼び名 */
  recipients: string[];
  /** 宛先に含めたが、アクセス権限がないので送らなかった相手 */
  denied: string[];
  /** 宛先に含めたが、接続していない相手 */
  notConnected: string[];
  /** 鍵を確かめられなかったので送らなかった相手（Relay による鍵のすり替えの疑い） */
  keyProblems: { personId: string; reason: string }[];
  /** Relay が受け付けなかった相手 */
  skipped: { personId: string; reason: string }[];
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
  /** 端末が増えた・暗号化鍵が替わった連絡先 */
  keyChanges: { personId: string; name: string; at: string }[];
  /** 端末の外（エージェント）から変えた共有の設定で、まだ主人に知らせていないもの */
  settingsChanges: { at: string; summary: string; widens: boolean; delegated: boolean }[];
};

export type RelayTransportOptions = {
  http: RelayHttp;
  device: DeviceIdentity;
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

  get personId(): string {
    return this.opts.device.personId;
  }

  /** この人の手元の状態（連絡先・グループ・アクセス権限・Policy。この PC の端末で共有） */
  localState(): RelayState {
    return this.opts.state.load();
  }

  /** 接続の一覧をもう取ったか（tell のついでの確認で、取っていなければ取りに行くため） */
  get hasConnections(): boolean {
    return this.lastConnections !== null;
  }

  /**
   * Relay の接続一覧を取り、新しく接続した相手を連絡先に加える（Person ID から Person 鍵を確かめて固定する）。
   * 呼び名は、接続要求を送った・承認したときに主人が付けたもの。なければ連絡先に加えず、知らせる
   */
  async syncContacts(interactive = false): Promise<{ connections: RelayConnection[]; connected: Set<string>; blocked: string[] }> {
    const { connections, blocked } = await this.opts.http.connections(interactive);
    this.lastConnections = connections;
    const accepted = connections.filter((c) => c.status === "accepted").map((c) => c.peer);
    const state = this.opts.state.load();
    const missing = accepted.filter((id) => !state.contacts[id] && state.pendingNames[id]);
    if (missing.length > 0) {
      const dirs = await this.opts.http.lookup(missing, interactive);
      const now = this.now();
      this.opts.state.update((s) => {
        for (const d of dirs) {
          const name = s.pendingNames[d.personId];
          if (!name || s.contacts[d.personId]) continue;
          const v = verifyPersonDirectory(d);
          if (!v.ok) continue;
          s.contacts[d.personId] = contactFrom(d.personId, v.personKey, v.devices, v.revoked, name, now);
          delete s.pendingNames[d.personId];
        }
      });
    }
    return { connections, connected: new Set(accepted), blocked };
  }

  /**
   * 宛先の人の、今使ってよい端末を決める。Relay が返したディレクトリを、固定した Person 鍵と、覚えている取り消しで確かめる。
   * 鍵の版が戻った端末（Relay が古い証明書を返した）は使わない。端末が増えた・鍵が替わったら、連絡先を更新して主人に知らせる
   */
  private checkRecipients(
    contacts: Contact[],
    dirs: PersonDirectory[],
    at: string,
  ): { ready: RelayRecipient[]; problems: RelayPublishResult["keyProblems"]; updated: Contact[] } {
    const byId = new Map(dirs.map((d) => [d.personId, d]));
    const ready: RelayRecipient[] = [];
    const problems: RelayPublishResult["keyProblems"] = [];
    const updated: Contact[] = [];
    for (const c of contacts) {
      const d = byId.get(c.personId);
      if (!d) {
        problems.push({ personId: c.personId, reason: "not_found" });
        continue;
      }
      const v = verifyPersonDirectory(d, { pinnedKey: c.personKey, knownRevoked: c.revoked });
      if (!v.ok) {
        problems.push({ personId: c.personId, reason: v.reason });
        continue;
      }
      const devices = v.devices.filter((x) => (c.devices[x.deviceId] ?? 0) <= x.encKeyVersion);
      if (devices.length === 0) {
        problems.push({ personId: c.personId, reason: v.devices.length ? "key_rollback" : "no_devices" });
        continue;
      }
      const changed = devices.some((x) => c.devices[x.deviceId] !== x.encKeyVersion);
      const revoked = [...new Set([...c.revoked, ...v.revoked])].sort();
      const next: Contact = {
        ...c,
        devices: { ...Object.fromEntries(Object.entries(c.devices).filter(([id]) => !revoked.includes(id))), ...Object.fromEntries(devices.map((x) => [x.deviceId, x.encKeyVersion])) },
        revoked,
        ...(changed ? { devicesChangedAt: at } : {}),
      };
      if (changed || revoked.length !== c.revoked.length) updated.push(next);
      ready.push({ personId: c.personId, devices: devices.map((x) => ({ deviceId: x.deviceId, encKey: x.encKey, encKeyVersion: x.encKeyVersion })) });
    }
    return { ready, problems, updated };
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
    const targets = resolveTargets(state, o.to ?? [], connected, o.project);
    if (targets.recipients.length === 0) throw new NoRecipientsError(targets);

    // 宛先の人の、今の端末を Relay から取り、固定した Person 鍵で確かめる
    const dirs = await this.opts.http.lookup(targets.recipients.map((c) => c.personId));
    const { ready, problems: keyProblems, updated } = this.checkRecipients(targets.recipients, dirs, createdAt);
    if (updated.length > 0) {
      this.opts.state.update((s) => {
        for (const c of updated) {
          const cur = s.contacts[c.personId];
          // 端末が増えたことは、主人に知らせるまで覚えておく（前の知らせがまだなら、その日時のまま）
          if (cur) s.contacts[c.personId] = { ...c, ...(cur.devicesChangedAt && c.devicesChangedAt ? { devicesChangedAt: cur.devicesChangedAt } : {}) };
        }
      });
    }
    if (ready.length === 0) throw new NoRecipientsError({ ...targets, recipients: [] });

    const envelope = sealRelayMessage(message, this.opts.device, ready, {
      createdAt,
      deliveryExpiresAt: new Date(now.getTime() + ttl(o.deliveryTtlMs, DEFAULT_DELIVERY_TTL_MS)).toISOString(),
    });
    const r = await this.opts.http.send(envelope);
    // Relay が誰も受け付けなかった（接続が切れた・鍵が替わった直後など）
    if (r.accepted.length === 0) {
      throw new NoRecipientsError({ recipients: [], denied: targets.denied, notConnected: [...targets.notConnected, ...r.skipped.map((x) => x.personId)] });
    }
    const names = new Map(targets.recipients.map((c) => [c.personId, c.name]));
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
      // 前に呼び名がなくて開けずに置いておいたものも、もう一度試す
      const held = f.held ?? [];
      f.held = [];
      const fresh = fetched.filter((m) => !held.some((h) => h.envelope.messageId === m.envelope.messageId));
      for (const { envelope, receivedAt } of [...held, ...fresh]) {
        const isNew = fresh.some((m) => m.envelope === envelope);
        if (isNew) ack.push(typeof envelope.messageId === "string" ? envelope.messageId : "");
        const r = this.open(envelope, state, connected, f.seen, now);
        if (r === "hold") {
          // Relay の受信の列をふさがないよう、受け取ったことにして手元に置く（配送期限まで）
          f.held.push({ envelope, receivedAt } satisfies HeldEnvelope);
          continue;
        }
        if (!r.ok) {
          this.opts.onReject?.(String(envelope.messageId).slice(0, 40), r.reason);
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
      RelayInboxStore.prune(f, now);
      return f.items.filter((i) => !i.toldAt).length;
    });
    await this.opts.http.ack(
      ack.filter((id) => MESSAGE_ID_RE.test(id)),
      true,
    );
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
    const me = this.opts.device;
    // ヘッダの文字列は、署名つきでも Tell の出力（post_id）などに入るので、形を確かめる
    if (
      env.v !== 3 ||
      env.suite !== HPKE_SUITE ||
      typeof env.messageId !== "string" ||
      !MESSAGE_ID_RE.test(env.messageId) ||
      !isPersonId(env.sender) ||
      !isDeviceId(env.senderDevice) ||
      !isCanonicalIso(env.createdAt) ||
      !isCanonicalIso(env.deliveryExpiresAt) ||
      !Array.isArray(env.recipients)
    ) {
      return { ok: false, reason: "bad_header" };
    }
    const group = env.recipients[0];
    if (env.recipients.length !== 1 || !group || group.person !== me.personId || !Array.isArray(group.boxes)) return { ok: false, reason: "not_for_me" };
    const box = group.boxes.find((b) => b?.device === me.deviceId);
    if (!box) return { ok: false, reason: "not_for_me" };
    const contact = state.contacts[env.sender];
    if (!contact) return connected.has(env.sender) ? "hold" : { ok: false, reason: "unknown_sender" };
    // 送った端末が、その人の（固定した Person 鍵で署名された、取り消していない）端末か
    const cert = env.senderCert;
    if (!cert || cert.personId !== env.sender || cert.deviceId !== env.senderDevice || contact.revoked.includes(cert.deviceId) || !verifyDeviceCert(cert, contact.personKey)) {
      return { ok: false, reason: "bad_sender_device" };
    }
    if (box.keyVersion !== me.encKeyVersion) return { ok: false, reason: "stale_key" };
    if (!verifyRecipientGroup(env, group, cert.signKey)) return { ok: false, reason: "bad_signature" };
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
        .filter((c) => c.devicesChangedAt)
        .map((c) => ({ personId: c.personId, name: c.name, at: c.devicesChangedAt! }));
      for (const c of Object.values(s.contacts)) delete c.devicesChangedAt;
      const settingsChanges = (s.changeLog ?? []).filter((c) => !c.notified).map(({ at, summary, widens, delegated }) => ({ at, summary, widens, delegated: !!delegated }));
      for (const c of s.changeLog ?? []) c.notified = true;
      // 接続の一覧をまだ取っていなければ、接続要求については何も言わない（知らせ済みの記録も変えない）
      if (!conns) return { incomingRequests: [], unnamedPeers: [], keyChanges, settingsChanges };
      const incoming = conns.filter((c) => c.status === "incoming").map((c) => c.peer);
      const fresh = incoming.filter((id) => !s.notifiedRequests.includes(id));
      // 取り消された要求は忘れる（同じ人からまた届いたら知らせ直す）
      s.notifiedRequests = incoming;
      const unnamedPeers = conns.filter((c) => c.status === "accepted" && !s.contacts[c.peer]).map((c) => c.peer);
      return { incomingRequests: fresh, unnamedPeers, keyChanges, settingsChanges };
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
