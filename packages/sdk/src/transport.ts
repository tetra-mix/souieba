import type { CreatePostInput, InboxItem, PublishResult, SyncResult, TellCandidate } from "@souieba/core";

/**
 * Agent SDK が依存する通信層。本文は平文で受け渡しし、暗号化・復号は実装側（E2eeTransport）が行う。
 * 将来 P2P / Relay に差し替えられるようにする。
 */
export interface SetLogTransport {
  publish(post: CreatePostInput): Promise<PublishResult>;
  sync(): Promise<SyncResult>;
  inbox(): Promise<InboxItem[]>;
  claimTell(opts?: { leaseSec?: number }): Promise<TellCandidate | null>;
  markAsTold(postId: string): Promise<void>;
  release(postId: string): Promise<void>;
}
