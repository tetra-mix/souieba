import type { CreatePostInput, InboxItem, PublishResult, SyncResult, TellCandidate } from "@souieba/core";
import type { SetLogTransport } from "./transport.ts";

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

export class HttpTransport implements SetLogTransport {
  readonly client: HttpClient;
  private readonly interactiveMs: number;

  constructor(opts: HttpOptions) {
    this.client = new HttpClient(opts);
    this.interactiveMs = opts.interactiveTimeoutMs ?? 1500;
  }

  publish(post: CreatePostInput) {
    return this.client.request<PublishResult>("POST", "/v1/posts", post, 15_000);
  }
  sync() {
    return this.client.request<SyncResult>("POST", "/v1/sync", {}, this.interactiveMs);
  }
  async inbox() {
    return (await this.client.request<{ items: InboxItem[] }>("GET", "/v1/inbox")).items;
  }
  async claimTell(opts: { leaseSec?: number } = {}) {
    return (await this.client.request<{ candidate: TellCandidate | null }>("POST", "/v1/tell/claim", opts, this.interactiveMs)).candidate;
  }
  markAsTold(postId: string) {
    return this.client.request<void>("POST", `/v1/deliveries/${encodeURIComponent(postId)}/told`);
  }
  release(postId: string) {
    return this.client.request<void>("POST", `/v1/deliveries/${encodeURIComponent(postId)}/release`);
  }
}
