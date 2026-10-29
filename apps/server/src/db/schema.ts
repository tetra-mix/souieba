/**
 * テーブル定義。マイグレーションはここから drizzle-kit で生成する（pnpm --filter @souieba/server db:generate）。
 * 0.2 系の手書きのマイグレーション（2番目まで）で作った DB と同じ形にしている（test/db.test.ts で確かめる）。
 */
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const instanceMeta = sqliteTable("instance_meta", {
  key: text().primaryKey(),
  value: text().notNull(),
});

export const users = sqliteTable(
  "users",
  {
    id: text().primaryKey(),
    handle: text().notNull().unique(),
    displayName: text("display_name").notNull(),
    role: text({ enum: ["admin", "member"] })
      .notNull()
      .default("member"),
    disabledAt: text("disabled_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [check("users_role_check", sql`${t.role} IN ('admin','member')`)],
);

export const agents = sqliteTable("agents", {
  id: text().primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text().notNull(),
  provider: text(),
  publicKey: text("public_key"),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull(),
  encKey: text("enc_key"),
  signKey: text("sign_key"),
});

export const credentials = sqliteTable(
  "credentials",
  {
    id: text().primaryKey(),
    kind: text({ enum: ["user", "agent"] }).notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    scopes: text().notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [check("credentials_kind_check", sql`${t.kind} IN ('user','agent')`)],
);

export const groups = sqliteTable("groups", {
  id: text().primaryKey(),
  /** 暗号化する前の平文の名前。封をし直したら空文字にする（名前は group_name_boxes にある） */
  name: text().notNull(),
  /** グループ名の版。名前を変えるたびに増える */
  nameVersion: integer("name_version").notNull().default(1),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull(),
});

export const groupMembers = sqliteTable(
  "group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text({ enum: ["owner", "member"] }).notNull(),
    invitedBy: text("invited_by"),
    joinedAt: text("joined_at").notNull(),
    leftAt: text("left_at"),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index("group_members_user").on(t.userId, t.leftAt),
    check("group_members_role_check", sql`${t.role} IN ('owner','member')`),
  ],
);

export const invites = sqliteTable(
  "invites",
  {
    id: text().primaryKey(),
    codeHash: text("code_hash").notNull().unique(),
    kind: text({ enum: ["invite", "login"] }).notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "cascade" }),
    targetUserId: text("target_user_id").references(() => users.id, { onDelete: "cascade" }),
    /** Friend の時代の名残。今は使わない */
    autoFriend: integer("auto_friend").notNull().default(1),
    expiresAt: text("expires_at").notNull(),
    usedBy: text("used_by"),
    usedAt: text("used_at"),
    createdAt: text("created_at").notNull(),
    groupId: text("group_id").references(() => groups.id, { onDelete: "cascade" }),
    /** 招待コードから作った鍵で封をしたグループ名（招待者が添える。参加する前の人が読む） */
    nameBox: text("name_box"),
  },
  (t) => [check("invites_kind_check", sql`${t.kind} IN ('invite','login')`)],
);

export const posts = sqliteTable(
  "posts",
  {
    id: text().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    authorAgentId: text("author_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    visibility: text({ enum: ["groups", "private"] }).notNull(),
    envelope: text().notNull(),
    visibleAt: text("visible_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique("posts_author_period").on(t.authorAgentId, t.periodStart),
    index("posts_owner_created").on(t.ownerId, t.createdAt),
    check("posts_visibility_check", sql`${t.visibility} IN ('groups','private')`),
  ],
);

export const postRecipients = sqliteTable(
  "post_recipients",
  {
    postId: text("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.agentId] }), index("post_recipients_agent").on(t.agentId)],
);

export const deliveries = sqliteTable(
  "deliveries",
  {
    postId: text("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    recipientUserId: text("recipient_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    receivedAt: text("received_at").notNull(),
    receivedByAgentId: text("received_by_agent_id").notNull(),
    reservedByAgentId: text("reserved_by_agent_id"),
    reservedUntil: text("reserved_until"),
    toldAt: text("told_at"),
    toldByAgentId: text("told_by_agent_id"),
    dismissedAt: text("dismissed_at"),
  },
  (t) => [primaryKey({ columns: [t.postId, t.recipientUserId] }), index("deliveries_recipient").on(t.recipientUserId, t.toldAt)],
);

export type UserRow = typeof users.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type MemberRow = typeof groupMembers.$inferSelect;

/** Agent ごとに封をしたグループ名（GroupNameBox の JSON）。サーバは中身を読めない */
export const groupNameBoxes = sqliteTable(
  "group_name_boxes",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    box: text().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.agentId] })],
);

// ---- v2（Relay）。docs/v2-design.md・docs/v2-relay-plan.md ----
// v1 のユーザー・Agent とは独立している。Relay はメッセージの平文・Note・グループ・Policy を持たない

/** 公開鍵ディレクトリ。Agent ID は Identity 公開鍵のハッシュ */
export const relayAgents = sqliteTable("relay_agents", {
  agentId: text("agent_id").primaryKey(),
  identityKey: text("identity_key").notNull().unique(),
  encKey: text("enc_key").notNull(),
  encKeyVersion: integer("enc_key_version").notNull(),
  encKeySig: text("enc_key_sig").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** 認証のチャレンジ。1回だけ使える */
export const relayChallenges = sqliteTable(
  "relay_challenges",
  {
    challenge: text().primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => relayAgents.agentId, { onDelete: "cascade" }),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("relay_challenges_expires").on(t.expiresAt)],
);

/** チャレンジ・レスポンスで発行した、短命のセッショントークン（sha256 だけを持つ） */
export const relaySessions = sqliteTable(
  "relay_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => relayAgents.agentId, { onDelete: "cascade" }),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("relay_sessions_expires").on(t.expiresAt)],
);

/** 接続。requester が要求し、recipient が承認すると accepted（承認後は向きを区別しない） */
export const relayConnections = sqliteTable(
  "relay_connections",
  {
    requesterId: text("requester_id")
      .notNull()
      .references(() => relayAgents.agentId, { onDelete: "cascade" }),
    recipientId: text("recipient_id")
      .notNull()
      .references(() => relayAgents.agentId, { onDelete: "cascade" }),
    status: text({ enum: ["pending", "accepted"] }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.requesterId, t.recipientId] }),
    index("relay_connections_recipient").on(t.recipientId, t.status),
    check("relay_connections_status_check", sql`${t.status} IN ('pending','accepted')`),
  ],
);

export const relayBlocks = sqliteTable(
  "relay_blocks",
  {
    blockerId: text("blocker_id")
      .notNull()
      .references(() => relayAgents.agentId, { onDelete: "cascade" }),
    blockedId: text("blocked_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] })],
);

/** 暗号化したメッセージの共通部分（受信者ごとの鍵は relay_deliveries）。全員に配送し終えたら body を消す */
export const relayMessages = sqliteTable(
  "relay_messages",
  {
    id: text().primaryKey(),
    senderId: text("sender_id")
      .notNull()
      .references(() => relayAgents.agentId, { onDelete: "cascade" }),
    /** RelayEnvelope から recipients を除いた JSON。配送し終えたら null */
    body: text(),
    createdAt: text("created_at").notNull(),
    /** 猶予期間のあいだは配送しない（送信者が取り消せる） */
    visibleAt: text("visible_at").notNull(),
    deliveryExpiresAt: text("delivery_expires_at").notNull(),
  },
  (t) => [index("relay_messages_sender").on(t.senderId, t.createdAt), index("relay_messages_expires").on(t.deliveryExpiresAt)],
);

/** 受信者ごとの配送レコード。box は受信者分の RelayRecipientBox の JSON（配送したら null） */
export const relayDeliveries = sqliteTable(
  "relay_deliveries",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => relayMessages.id, { onDelete: "cascade" }),
    recipientId: text("recipient_id").notNull(),
    box: text(),
    deliveredAt: text("delivered_at"),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.recipientId] }), index("relay_deliveries_recipient").on(t.recipientId, t.deliveredAt)],
);
