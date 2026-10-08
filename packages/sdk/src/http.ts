import type { KeyDirectory, PostEnvelope, PublishResult, SyncResult, WireInboxItem, WireTellCandidate } from "@souieba/core";

export class SetLogApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type HttpOptions = {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  /** 会話の途中で呼ぶ sync / claim のタイムアウト。VPN が切れているときはすぐ諦める */
  interactiveTimeoutMs?: number;
  fetch?: typeof fetch;
};

export class HttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async request<T>(method: string, path: string, body?: unknown, timeoutMs = this.opts.timeoutMs ?? 5000): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
    if (!res.ok) {
      throw new SetLogApiError(res.status, data.error?.code ?? "http_error", data.error?.message ?? `HTTP ${res.status}`);
    }
    return data as T;
  }
}

/**
 * サーバの API をそのまま呼ぶ通信層。本文は暗号文（封筒）のまま扱う。
 * Agent からは、検証と復号を行う E2eeTransport を通して使う。
 */
export class HttpTransport {
  readonly client: HttpClient;
  private readonly interactiveMs: number;

  constructor(opts: HttpOptions) {
    this.client = new HttpClient(opts);
    this.interactiveMs = opts.interactiveTimeoutMs ?? 1500;
  }

  publishEnvelope(envelope: PostEnvelope) {
    return this.client.request<PublishResult>("POST", "/v1/posts", { envelope }, 15_000);
  }
  /** 公開鍵ディレクトリ。会話の始め（tell）でも呼ぶので、短いタイムアウトにする */
  keys() {
    return this.client.request<KeyDirectory>("GET", "/v1/keys", undefined, this.interactiveMs);
  }
  sync() {
    return this.client.request<SyncResult>("POST", "/v1/sync", {}, this.interactiveMs);
  }
  async inbox() {
    return (await this.client.request<{ items: WireInboxItem[] }>("GET", "/v1/inbox")).items;
  }
  async claimTell(opts: { leaseSec?: number } = {}) {
    return (await this.client.request<{ candidate: WireTellCandidate | null }>("POST", "/v1/tell/claim", opts, this.interactiveMs))
      .candidate;
  }
  markAsTold(postId: string) {
    return this.client.request<void>("POST", `/v1/deliveries/${encodeURIComponent(postId)}/told`);
  }
  release(postId: string) {
    return this.client.request<void>("POST", `/v1/deliveries/${encodeURIComponent(postId)}/release`);
  }
  /** 検証・復号できなかった投稿を、二度と候補にならないようにする */
  dismiss(postId: string) {
    return this.client.request<void>("POST", `/v1/deliveries/${encodeURIComponent(postId)}/dismiss`);
  }
}
