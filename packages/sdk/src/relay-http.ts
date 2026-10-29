/**
 * v2 の Relay の API を呼ぶ通信層。認証は Identity 鍵でチャレンジに署名して得る、短命のセッショントークン。
 * トークンは Agent の状態ディレクトリに 600 で保存し、期限が切れたら（401 なら）署名し直す。
 */
import {
  CLIENT_VERSION_HEADER,
  type RelayDirectoryEntry,
  type RelayEnvelope,
  type RelayIdentity,
  directoryEntry,
  signChallenge,
} from "@souieba/core";
import { readStateJson, writeSecretJson } from "./config.ts";
import { SouiebaApiError } from "./http.ts";

export type RelayConnection = { peer: string; status: "accepted" | "incoming" | "outgoing"; createdAt: string; updatedAt: string };

export type RelaySendResult = {
  messageId: string;
  visibleAt: string;
  accepted: string[];
  skipped: { agentId: string; reason: "not_connected" | "stale_key" }[];
};

export type RelaySentView = {
  messageId: string;
  createdAt: string;
  visibleAt: string;
  deliveryExpiresAt: string;
  recipients: { agentId: string; status: "pending" | "delivered"; deliveredAt: string | null }[];
};

export type RelayHttpOptions = {
  relayUrl: string;
  identity: RelayIdentity;
  /** セッショントークンの保存先（省略時は保存しない） */
  sessionPath?: string;
  clientVersion?: string;
  timeoutMs?: number;
  /** 会話の途中で呼ぶ受信のタイムアウト */
  interactiveTimeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
};

type Session = { token: string; expiresAt: string; agentId: string; relay: string };

export class RelayHttp {
  readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private session: Session | null;

  constructor(private readonly opts: RelayHttpOptions) {
    this.origin = new URL(opts.relayUrl).origin;
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => new Date());
    const saved = opts.sessionPath ? readStateJson<Session>(opts.sessionPath) : null;
    this.session = saved && saved.agentId === opts.identity.agentId && saved.relay === this.origin ? saved : null;
  }

  get agentId(): string {
    return this.opts.identity.agentId;
  }

  private async raw<T>(method: string, path: string, body: unknown, token: string | null, timeoutMs: number): Promise<T> {
    const res = await this.fetchImpl(`${this.origin}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(this.opts.clientVersion ? { [CLIENT_VERSION_HEADER]: this.opts.clientVersion } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: { error?: { code: string; message: string } } | undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      // 前段のプロキシが返す HTML など
    }
    if (!res.ok) throw new SouiebaApiError(res.status, data?.error?.code ?? "http_error", data?.error?.message ?? `HTTP ${res.status}`);
    if (data === undefined) throw new SouiebaApiError(res.status, "bad_response", `Relay の応答を読めませんでした（HTTP ${res.status}）`);
    return data as T;
  }

  private timeout(interactive: boolean): number {
    return interactive ? (this.opts.interactiveTimeoutMs ?? 2500) : (this.opts.timeoutMs ?? 10_000);
  }

  /** 公開鍵を登録する（初回セットアップ。同じ鍵の再登録はそのまま通る） */
  async register(): Promise<RelayDirectoryEntry> {
    return (await this.raw<{ entry: RelayDirectoryEntry }>("POST", "/v2/agents", { entry: directoryEntry(this.opts.identity) }, null, this.timeout(false)))
      .entry;
  }

  /** チャレンジに署名してセッションを得る */
  private async login(interactive: boolean): Promise<string> {
    const t = this.timeout(interactive);
    const { agentId } = this.opts.identity;
    const ch = await this.raw<{ challenge: string }>("POST", "/v2/auth/challenge", { agentId }, null, t);
    const s = await this.raw<{ token: string; expiresAt: string }>(
      "POST",
      "/v2/auth/session",
      { agentId, challenge: ch.challenge, sig: signChallenge(this.opts.identity, this.origin, ch.challenge) },
      null,
      t,
    );
    this.session = { token: s.token, expiresAt: s.expiresAt, agentId, relay: this.origin };
    if (this.opts.sessionPath) writeSecretJson(this.opts.sessionPath, this.session);
    return s.token;
  }

  /** 認証が要る API。セッションの期限が近ければ取り直し、401 なら1回だけ署名し直して再送する */
  async request<T>(method: string, path: string, body?: unknown, interactive = false): Promise<T> {
    const t = this.timeout(interactive);
    const fresh = this.session && Date.parse(this.session.expiresAt) - this.now().getTime() > 60_000;
    const token = fresh ? this.session!.token : await this.login(interactive);
    try {
      return await this.raw<T>(method, path, body, token, t);
    } catch (err) {
      if (!(err instanceof SouiebaApiError) || err.status !== 401 || !fresh) throw err;
      return this.raw<T>(method, path, body, await this.login(interactive), t);
    }
  }

  async lookup(agentIds: string[], interactive = false): Promise<RelayDirectoryEntry[]> {
    if (agentIds.length === 0) return [];
    return (await this.request<{ entries: RelayDirectoryEntry[] }>("POST", "/v2/agents/lookup", { agentIds }, interactive)).entries;
  }
  connections(interactive = false) {
    return this.request<{ connections: RelayConnection[]; blocked: string[] }>("GET", "/v2/connections", undefined, interactive);
  }
  async connect(to: string): Promise<RelayConnection> {
    return (await this.request<{ connection: RelayConnection }>("POST", "/v2/connections", { to })).connection;
  }
  async accept(peer: string): Promise<RelayConnection> {
    return (await this.request<{ connection: RelayConnection }>("POST", `/v2/connections/${encodeURIComponent(peer)}/accept`)).connection;
  }
  reject(peer: string) {
    return this.request<void>("POST", `/v2/connections/${encodeURIComponent(peer)}/reject`);
  }
  disconnect(peer: string) {
    return this.request<void>("DELETE", `/v2/connections/${encodeURIComponent(peer)}`);
  }
  block(peer: string) {
    return this.request<void>("PUT", `/v2/blocks/${encodeURIComponent(peer)}`);
  }
  unblock(peer: string) {
    return this.request<void>("DELETE", `/v2/blocks/${encodeURIComponent(peer)}`);
  }
  send(envelope: RelayEnvelope) {
    return this.request<RelaySendResult>("POST", "/v2/messages", { envelope });
  }
  async fetchMessages(interactive = false): Promise<{ envelope: RelayEnvelope; receivedAt: string }[]> {
    return (await this.request<{ messages: { envelope: RelayEnvelope; receivedAt: string }[] }>("GET", "/v2/messages", undefined, interactive))
      .messages;
  }
  async ack(messageIds: string[], interactive = false): Promise<number> {
    if (messageIds.length === 0) return 0;
    return (await this.request<{ acked: number }>("POST", "/v2/messages/ack", { messageIds }, interactive)).acked;
  }
  async sent(): Promise<RelaySentView[]> {
    return (await this.request<{ messages: RelaySentView[] }>("GET", "/v2/messages/sent")).messages;
  }
  deleteMessage(messageId: string) {
    return this.request<void>("DELETE", `/v2/messages/${encodeURIComponent(messageId)}`);
  }
}
