import type { DB } from "./db/index.ts";
import { relayRetention } from "./services/relay.ts";

/** Relay の、配送期限を過ぎたメッセージ・期限切れの接続要求・チャレンジ・セッションを物理削除する */
export function runRetention(db: DB, now: Date): { relay: ReturnType<typeof relayRetention> } {
  return { relay: relayRetention(db, now) };
}
