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

/** Agent 1つ宛てに封をしたグループ名。封をした Agent（sender）の署名つき */
export type GroupNameBox = {
  v: 1;
  groupId: string;
  /** グループ名の版。名前を変えるたびに増える */
  version: number;
  senderAgentId: string;
  recipientAgentId: string;
  epk: string;
  iv: string;
  ciphertext: string;
  sig: string;
};

/** GET /v1/groups の1件 */
export type WireGroup = {
  id: string;
  role: "owner" | "member";
  memberCount: number;
  createdAt: string;
  nameVersion: number;
  /** 暗号化する前に作られたグループの平文の名前。メンバーが封をし直すと消える */
  legacyName: string | null;
  /** 自分の Agent 宛ての封（Agent トークンならその Agent の分だけ） */
  nameBoxes: GroupNameBox[];
  /** 今の版の封をまだ持っていない、メンバーの有効な Agent */
  missingAgentIds: string[];
};

// ---- 公開鍵ディレクトリ（GET /v1/keys） ----
// サーバを信頼する前提で、クライアントはここにある鍵をそのまま使う（docs/public-deployment-plan.md §5）

export type DirectoryAgent = { id: string; name: string; encKey: string; signKey: string; createdAt: string };

export type DirectoryUser = {
  id: string;
  handle: string;
  displayName: string;
  /** 自分といっしょにいるグループの ID（自分自身なら、自分が入っているすべてのグループ） */
  groupIds: string[];
  /** 有効な（失効していない）Agent */
  agents: DirectoryAgent[];
};

export type KeyDirectory = {
  me: { userId: string; agentId: string | null };
  /** 自分と、今いっしょにいるグループがあるユーザー */
  users: DirectoryUser[];
};
