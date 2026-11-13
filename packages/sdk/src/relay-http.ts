/**
 * v2 の Relay の API を呼ぶ通信層。認証は端末の署名鍵でチャレンジに署名して得る、短命のセッショントークン。
 * トークンは端末の状態ディレクトリに 600 で保存し、期限が切れたら（401 なら）署名し直す。
 */
import {
  CLIENT_VERSION_HEADER,
  type DeviceCert,
  type DeviceIdentity,
  type DeviceRevocation,
  MESSAGE_ID_RE,
  type PersonDirectory,
  type RelayEnvelope,
  findInstructionLike,
  isCanonicalIso,
  isPersonId,
  sanitizeContent,
  signChallenge,
} from "@souieba/core";
import { readStateJson, writeSecretJson } from "./config.ts";
import { SouiebaApiError } from "./http.ts";

export type RelayConnection = { peer: string; status: "accepted" | "incoming" | "outgoing"; createdAt: string; updatedAt: string };

export type RelaySendResult = {
  messageId: string;
  visibleAt: string;
  accepted: string[];
  skipped: { personId: string; reason: "not_connected" | "stale_key" }[];
};

export type RelaySentView = {
  messageId: string;
  createdAt: string;
  visibleAt: string;
  deliveryExpiresAt: string;
  recipients: { personId: string; status: "pending" | "delivered"; deliveredAt: string | null; devices: number }[];
};

export type RelayHttpOptions = {
  relayUrl: string;
  device: DeviceIdentity;
  /** セッショントークンの保存先（省略時は保存しない） */
  sessionPath?: string;
  clientVersion?: string;
  timeoutMs?: number;
  /** 会話の途中で呼ぶ受信のタイムアウト */
  interactiveTimeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
};

type Session = { token: string; expiresAt: string; deviceId: string; relay: string };

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
  return isPersonId(c?.peer) && isStatus(c.status) && isCanonicalIso(c.createdAt) && isCanonicalIso(c.updatedAt);
}

function validSent(m: RelaySentView): boolean {
  return (
    typeof m?.messageId === "string" &&
    MESSAGE_ID_RE.test(m.messageId) &&
    isCanonicalIso(m.createdAt) &&
    isCanonicalIso(m.visibleAt) &&
    isCanonicalIso(m.deliveryExpiresAt) &&
    Array.isArray(m.recipients) &&
    m.recipients.every((r) => isPersonId(r?.personId) && Number.isInteger(r.devices) && (r.status === "pending" || r.status === "delivered") && (r.deliveredAt === null || isCanonicalIso(r.deliveredAt)))
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
    this.session = saved && saved.deviceId === opts.device.deviceId && saved.relay === this.origin ? saved : null;
  }

  get personId(): string {
    return this.opts.device.personId;
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

  /** 人と端末を登録する（初回は人も作られる。同じ端末の再登録はそのまま通る）。Person 鍵の秘密鍵は要らない（証明書は署名済み） */
  async register(personKey: string, cert: DeviceCert = this.opts.device.cert): Promise<PersonDirectory> {
    return (await this.raw<{ directory: PersonDirectory }>("POST", "/v2/devices", { personKey, cert }, null, this.timeout(false))).directory;
  }

  /** 端末を取り消す（Person 鍵で署名した取り消し） */
  async revoke(revocation: DeviceRevocation): Promise<PersonDirectory> {
    return (await this.raw<{ directory: PersonDirectory }>("POST", "/v2/devices/revoke", { revocation }, null, this.timeout(false))).directory;
  }

  /** チャレンジに署名してセッションを得る */
  private async login(interactive: boolean): Promise<string> {
    const t = this.timeout(interactive);
    const { personId, deviceId } = this.opts.device;
    const ch = await this.raw<{ challenge: string }>("POST", "/v2/auth/challenge", { deviceId }, null, t);
    const s = await this.raw<{ token: string; expiresAt: string }>(
      "POST",
      "/v2/auth/session",
      { personId, deviceId, challenge: ch.challenge, sig: signChallenge(this.opts.device, this.origin, ch.challenge) },
      null,
      t,
    );
    this.session = { token: s.token, expiresAt: s.expiresAt, deviceId, relay: this.origin };
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

  /** 頼んだ人の分だけを返す（中身の検証と、固定した鍵との照合は呼び出し側で verifyPersonDirectory を使って行う） */
  async lookup(personIds: string[], interactive = false): Promise<PersonDirectory[]> {
    if (personIds.length === 0) return [];
    const wanted = new Set(personIds);
    const { directories } = await this.request<{ directories: PersonDirectory[] }>("POST", "/v2/persons/lookup", { personIds }, interactive);
    const seen = new Set<string>();
    return (Array.isArray(directories) ? directories : []).filter((d) => {
      if (!d || !wanted.has(d.personId) || seen.has(d.personId)) return false;
      seen.add(d.personId);
      return true;
    });
  }
  async connections(interactive = false): Promise<{ connections: RelayConnection[]; blocked: string[] }> {
    const r = await this.request<{ connections: RelayConnection[]; blocked: string[] }>("GET", "/v2/connections", undefined, interactive);
    return {
      connections: (Array.isArray(r.connections) ? r.connections : []).filter(validConnection),
      blocked: (Array.isArray(r.blocked) ? r.blocked : []).filter(isPersonId),
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
    const mine = new Set(envelope.recipients.map((g) => g.person));
    return {
      messageId: envelope.messageId,
      visibleAt: isCanonicalIso(r.visibleAt) ? r.visibleAt : envelope.createdAt,
      accepted: (Array.isArray(r.accepted) ? r.accepted : []).filter((id) => mine.has(id)),
      skipped: (Array.isArray(r.skipped) ? r.skipped : [])
        .filter((x) => mine.has(x?.personId))
        .map((x) => ({ personId: x.personId, reason: x.reason === "stale_key" ? "stale_key" : "not_connected" })),
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
