/**
 * v2 の Relay の API を呼ぶ通信層。認証は Identity 鍵でチャレンジに署名して得る、短命のセッショントークン。
 * トークンは Agent の状態ディレクトリに 600 で保存し、期限が切れたら（401 なら）署名し直す。
 */
import {
  CLIENT_VERSION_HEADER,
  MESSAGE_ID_RE,
  type RelayDirectoryEntry,
  type RelayEnvelope,
  type RelayIdentity,
  directoryEntry,
  findInstructionLike,
  isAgentId,
  isCanonicalIso,
  sanitizeContent,
  signChallenge,
  verifyDirectoryEntry,
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

/**
 * Relay は信頼しない（鍵をすり替えたり、文字列にエージェントへの指示を混ぜたりしうる）。
 * Relay から来た文字列は、エージェントが読む出力に入りうるので、ここで形を確かめてから使う
 */
function relayErrorMessage(status: number, message: string | undefined): string {
  const m = message ? sanitizeContent(message).slice(0, 200) : "";
  return m && findInstructionLike(m).length === 0 ? m : `Relay がエラーを返しました（HTTP ${status}）`;
}

const isStatus = (s: unknown): s is RelayConnection["status"] => s === "accepted" || s === "incoming" || s === "outgoing";

function validConnection(c: RelayConnection): boolean {
  return isAgentId(c?.peer) && isStatus(c.status) && isCanonicalIso(c.createdAt) && isCanonicalIso(c.updatedAt);
}

function validSent(m: RelaySentView): boolean {
  return (
    typeof m?.messageId === "string" &&
    MESSAGE_ID_RE.test(m.messageId) &&
    isCanonicalIso(m.createdAt) &&
    isCanonicalIso(m.visibleAt) &&
    isCanonicalIso(m.deliveryExpiresAt) &&
    Array.isArray(m.recipients) &&
    m.recipients.every((r) => isAgentId(r?.agentId) && (r.status === "pending" || r.status === "delivered") && (r.deliveredAt === null || isCanonicalIso(r.deliveredAt)))
  );
}

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
    if (!res.ok) {
      const code = typeof data?.error?.code === "string" && /^[a-z_]{1,40}$/.test(data.error.code) ? data.error.code : "http_error";
      throw new SouiebaApiError(res.status, code, relayErrorMessage(res.status, data?.error?.message));
    }
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

  /** 頼んだ Agent の分だけを、検証を通ったものだけ返す（固定した鍵との照合は呼び出し側で行う） */
  async lookup(agentIds: string[], interactive = false): Promise<RelayDirectoryEntry[]> {
    if (agentIds.length === 0) return [];
    const wanted = new Set(agentIds);
    const { entries } = await this.request<{ entries: RelayDirectoryEntry[] }>("POST", "/v2/agents/lookup", { agentIds }, interactive);
    return (Array.isArray(entries) ? entries : []).filter((e) => wanted.has(e?.agentId) && verifyDirectoryEntry(e).ok);
  }
  async connections(interactive = false): Promise<{ connections: RelayConnection[]; blocked: string[] }> {
    const r = await this.request<{ connections: RelayConnection[]; blocked: string[] }>("GET", "/v2/connections", undefined, interactive);
    return {
      connections: (Array.isArray(r.connections) ? r.connections : []).filter(validConnection),
      blocked: (Array.isArray(r.blocked) ? r.blocked : []).filter(isAgentId),
    };
  }
  private async connection(method: string, path: string, body?: unknown): Promise<RelayConnection> {
    const { connection } = await this.request<{ connection: RelayConnection }>(method, path, body);
    if (!validConnection(connection)) throw new SouiebaApiError(200, "bad_response", "Relay の応答の形が不正です");
    return connection;
  }
  connect(to: string): Promise<RelayConnection> {
    return this.connection("POST", "/v2/connections", { to });
  }
  accept(peer: string): Promise<RelayConnection> {
    return this.connection("POST", `/v2/connections/${encodeURIComponent(peer)}/accept`);
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
  async send(envelope: RelayEnvelope): Promise<RelaySendResult> {
    const r = await this.request<RelaySendResult>("POST", "/v2/messages", { envelope });
    const mine = new Set(envelope.recipients.map((b) => b.agentId));
    return {
      messageId: envelope.messageId,
      visibleAt: isCanonicalIso(r.visibleAt) ? r.visibleAt : envelope.createdAt,
      accepted: (Array.isArray(r.accepted) ? r.accepted : []).filter((id) => mine.has(id)),
      skipped: (Array.isArray(r.skipped) ? r.skipped : [])
        .filter((x) => mine.has(x?.agentId))
        .map((x) => ({ agentId: x.agentId, reason: x.reason === "stale_key" ? "stale_key" : "not_connected" })),
    };
  }
  /** 中身の検証は受け取る側（RelayTransport）で行う */
  async fetchMessages(interactive = false): Promise<{ envelope: RelayEnvelope; receivedAt: string }[]> {
    const { messages } = await this.request<{ messages: { envelope: RelayEnvelope; receivedAt: string }[] }>("GET", "/v2/messages", undefined, interactive);
    return (Array.isArray(messages) ? messages : []).filter((m) => m && typeof m.envelope === "object" && m.envelope !== null);
  }
  async ack(messageIds: string[], interactive = false): Promise<void> {
    if (messageIds.length === 0) return;
    await this.request<{ acked: number }>("POST", "/v2/messages/ack", { messageIds }, interactive);
  }
  async sent(): Promise<RelaySentView[]> {
    const { messages } = await this.request<{ messages: RelaySentView[] }>("GET", "/v2/messages/sent");
    return (Array.isArray(messages) ? messages : []).filter(validSent);
  }
  deleteMessage(messageId: string) {
    return this.request<void>("DELETE", `/v2/messages/${encodeURIComponent(messageId)}`);
  }
}
