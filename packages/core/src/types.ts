/** groups: 所属しているグループのメンバー全員へ / private: 自分の Agent だけ */
export type Visibility = "groups" | "private";

export type Scope = "posts:write" | "sync" | "tell";

export const AGENT_SCOPES: readonly Scope[] = ["posts:write", "sync", "tell"];

/** Agent が書く投稿（平文）。SDK が封筒にしてからサーバへ送る */
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

/** Tell の候補としてサーバが予約し、SDK が検証・復号した1件 */
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

// ---- 暗号化した投稿（サーバが保存・配送するもの） ----

export type EnvelopeRecipient = { agentId: string; iv: string; wrapped: string };

export type PostEnvelope = {
  v: 1;
  periodStart: string;
  periodEnd: string;
  visibility: Visibility;
  /** 一時鍵（X25519）の公開鍵 */
  epk: string;
  iv: string;
  ciphertext: string;
  /** agentId の昇順 */
  recipients: EnvelopeRecipient[];
  /** 投稿した Agent の署名鍵（Ed25519）による署名 */
  sig: string;
};

/** サーバが返す受信箱の1件（本文は暗号文のまま） */
export type WireInboxItem = {
  postId: string;
  owner: { id: string; handle: string; displayName: string };
  authorAgentId: string;
  authorAgentName: string;
  periodStart: string;
  periodEnd: string;
  envelope: PostEnvelope;
  receivedAt: string;
};

export type WireTellCandidate = WireInboxItem & { reservedUntil: string };

// ---- 公開鍵ディレクトリ（GET /v1/keys） ----

export type DirectoryAgent = { id: string; name: string; encKey: string; signKey: string; cert: string };

export type DirectoryUser = {
  id: string;
  handle: string;
  displayName: string;
  identityKey: string | null;
  agents: DirectoryAgent[];
};

export type DirectoryMember = {
  userId: string;
  role: "owner" | "member";
  invitedBy: string | null;
  inviteCode: string | null;
  inviteSig: string | null;
  joinSig: string | null;
  joinedAt: string;
  leftAt: string | null;
};

export type DirectoryGroup = {
  id: string;
  name: string;
  createdBy: string | null;
  createSig: string;
  /** 抜けたメンバー（leftAt あり）も含む。その人が招待した人の証明を検証するため */
  members: DirectoryMember[];
};

export type KeyDirectory = {
  me: { userId: string; agentId: string | null };
  users: DirectoryUser[];
  groups: DirectoryGroup[];
};
