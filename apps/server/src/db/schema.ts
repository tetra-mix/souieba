/**
 * テーブル定義。マイグレーションはここから drizzle-kit で生成する（pnpm --filter @souieba/server db:generate）。
 * v1（アカウント・グループ・投稿）の表は 0005 で、初期の Relay（Agent ID 版）の表と instance_meta は 0006 で落とした。
 * 0000〜0004 は、それらの表がある古い DB を移行するために残している（test/db.test.ts で確かめる）。
 */
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Relay はメッセージの平文・Note・グループ・Policy を持たない（docs/design/relay-protocol.md）
// 端末ごとに認証・配送し、接続とブロックは人と人のあいだに持つ

/** 人。Person ID は Person 公開鍵のハッシュ */
export const relayPersons = sqliteTable("relay_persons", {
  personId: text("person_id").primaryKey(),
  personKey: text("person_key").notNull().unique(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** 端末。cert は Person 鍵で署名した端末証明書の JSON（受け取った側が確かめる）。取り消したら revocation に署名つきの取り消しを入れる */
export const relayDevices = sqliteTable(
  "relay_devices",
  {
    deviceId: text("device_id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => relayPersons.personId, { onDelete: "cascade" }),
    signKey: text("sign_key").notNull().unique(),
    encKeyVersion: integer("enc_key_version").notNull(),
    cert: text().notNull(),
    revocation: text(),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (t) => [index("relay_devices_person").on(t.personId)],
);

/** 認証のチャレンジ（端末ごと）。1回だけ使える */
export const relayDeviceChallenges = sqliteTable(
  "relay_device_challenges",
  {
    challenge: text().primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => relayDevices.deviceId, { onDelete: "cascade" }),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("relay_device_challenges_expires").on(t.expiresAt)],
);

/** セッション。端末と人に結び付ける（sha256 だけを持つ） */
export const relayDeviceSessions = sqliteTable(
  "relay_device_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => relayDevices.deviceId, { onDelete: "cascade" }),
    personId: text("person_id").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("relay_device_sessions_expires").on(t.expiresAt)],
);

/** 人と人の接続 */
export const relayPersonConnections = sqliteTable(
  "relay_person_connections",
  {
    requesterId: text("requester_id")
      .notNull()
      .references(() => relayPersons.personId, { onDelete: "cascade" }),
    recipientId: text("recipient_id")
      .notNull()
      .references(() => relayPersons.personId, { onDelete: "cascade" }),
    status: text({ enum: ["pending", "accepted"] }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.requesterId, t.recipientId] }),
    index("relay_person_connections_recipient").on(t.recipientId, t.status),
    check("relay_person_connections_status_check", sql`${t.status} IN ('pending','accepted')`),
  ],
);

export const relayPersonBlocks = sqliteTable(
  "relay_person_blocks",
  {
    blockerId: text("blocker_id")
      .notNull()
      .references(() => relayPersons.personId, { onDelete: "cascade" }),
    blockedId: text("blocked_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] })],
);

/** 暗号化したメッセージの共通部分。送信者は人と、送った端末。全端末に配送し終えたら body を消す */
export const relayPersonMessages = sqliteTable(
  "relay_person_messages",
  {
    id: text().primaryKey(),
    senderId: text("sender_id")
      .notNull()
      .references(() => relayPersons.personId, { onDelete: "cascade" }),
    senderDevice: text("sender_device").notNull(),
    body: text(),
    createdAt: text("created_at").notNull(),
    visibleAt: text("visible_at").notNull(),
    deliveryExpiresAt: text("delivery_expires_at").notNull(),
  },
  (t) => [index("relay_person_messages_sender").on(t.senderId, t.createdAt), index("relay_person_messages_expires").on(t.deliveryExpiresAt)],
);

/** 端末ごとの配送レコード。box は受信者の人の分（RelayRecipientGroup）の JSON（その端末が受け取ったら null） */
export const relayDeviceDeliveries = sqliteTable(
  "relay_device_deliveries",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => relayPersonMessages.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    personId: text("person_id").notNull(),
    box: text(),
    deliveredAt: text("delivered_at"),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.deviceId] }),
    index("relay_device_deliveries_device").on(t.deviceId, t.deliveredAt),
    index("relay_device_deliveries_person").on(t.personId),
  ],
);
