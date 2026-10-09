/**
 * Claude Code: ~/.claude/settings.json の UserPromptSubmit フックで souieba hook claude-code を呼ぶ。
 * 終了コード 0 の標準出力が、そのまま主人の発言の文脈として足される（終了コード 2 は発言を止めるので使わない）。
 * cron はないので、すべて主人の発言として扱う。
 */
import type { HookAdapter } from "./hook.ts";

export const claudeCode: HookAdapter = {
  isOwnerTurn: () => true,
  format: (context) => context,
};
