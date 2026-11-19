/** groups: 所属しているグループのメンバー全員へ / private: 自分の Agent だけ */
export type Visibility = "groups" | "private";

/** Agent が書く投稿（平文）。SDK が暗号化してから Relay へ送る */
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

/** Tell の候補として予約し、SDK が検証・復号した1件 */
export type TellCandidate = {
  postId: string;
  owner: { id: string; handle: string; displayName: string };
  authorAgentName: string;
  periodStart: string;
  periodEnd: string;
  content: string;
  reservedUntil: string;
  /** v2 の Narrative Message のとき、送信側の Agent が添えた伝え方の意図（信頼できない入力。参考にするだけ） */
  narrative?: TellNarrative;
};

export type TellNarrative = {
  purpose?: string;
  nuance?: string;
  context?: string;
  /** 他の人へ伝え直してよいか */
  reshare: "deny" | "allow";
  useExpiresAt: string;
};

export type InboxItem = Omit<TellCandidate, "reservedUntil"> & {
  receivedAt: string;
};
