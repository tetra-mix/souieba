/**
 * Hermes Agent: ~/.hermes/config.yaml の pre_llm_call シェルフックで souieba hook hermes を呼ぶ。
 * 標準入力に {hook_event_name, session_id, extra: {platform, ...}} の JSON が来る。
 * 返すのは {"context": "..."} の JSON だけで、素の文章は無視される。文脈は主人の発言の後ろに足される。
 * cron の実行は extra.platform が "cron" になる。
 */
import type { HookAdapter } from "./hook.ts";

export const hermes: HookAdapter = {
  isOwnerTurn: (input) => (input as { extra?: { platform?: unknown } } | null)?.extra?.platform !== "cron",
  format: (context) => JSON.stringify({ context }),
};
