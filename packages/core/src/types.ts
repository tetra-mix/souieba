export type Visibility = "friends" | "private";

export type FriendshipStatus = "pending" | "accepted" | "blocked";

export type Scope = "posts:write" | "sync" | "tell";

export const AGENT_SCOPES: readonly Scope[] = ["posts:write", "sync", "tell"];

export type CreatePostInput = {
  periodStart: string;
  periodEnd: string;
  content: string;
  visibility?: Visibility;
};

export type PublishResult = {
  postId: string;
  visibleAt: string;
  created: boolean;
};

export type SyncResult = {
  received: number;
  inboxSize: number;
};

/** Tell の候補としてサーバが予約した1件 */
export type TellCandidate = {
  postId: string;
  owner: { id: string; handle: string; displayName: string };
  authorAgentName: string;
  periodStart: string;
  periodEnd: string;
  content: string;
  reservedUntil: string;
};

export type InboxItem = Omit<TellCandidate, "reservedUntil"> & {
  receivedAt: string;
};
