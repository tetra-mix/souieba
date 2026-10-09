/**
 * Codex: ~/.codex/hooks.json の UserPromptSubmit フックで souieba hook codex を呼ぶ。
 * 入出力は Claude Code と同じ形で、終了コード 0 の標準出力が文脈として足される。
 * JSON に見えてスキーマに合わない出力はエラーになるため、素の文章で返す。
 */
import type { HookAdapter } from "./hook.ts";

export const codex: HookAdapter = {
  isOwnerTurn: () => true,
  format: (context) => context,
};
