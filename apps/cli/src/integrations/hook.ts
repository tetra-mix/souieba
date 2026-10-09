/**
 * souieba hook <エージェント>: エージェントのフックから、主人の発言ごとに呼ぶ。
 * tell の結果とメモの手引きを、そのエージェントが文脈として受け取れる形で出力する。
 * スキルだけだと tell や note を実行するかがモデルの判断に任されるため、フックで毎回確実に渡す。
 * エージェントごとの違い（入力の読み方・出力の形）は、それぞれのファイルの HookAdapter に閉じ込める。
 *
 * どんな失敗でも終了コード 0 で終わる（Claude Code の UserPromptSubmit は終了コード 2 で主人の発言を止めてしまうため）。
 */
import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { NOTE_GUIDE, tellContext } from "./guide.ts";
import { hermes } from "./hermes.ts";

export type HookAdapter = {
  /** フックの入力（標準入力の JSON。読めなければ null）から、主人の発言で始まった実行かを判断する。cron などでは tell しない */
  isOwnerTurn(input: unknown): boolean;
  /** エージェントに渡す文脈を、そのエージェントのフックの出力の形にする */
  format(context: string): string;
};

const ADAPTERS = { "claude-code": claudeCode, codex, hermes } satisfies Record<string, HookAdapter>;

export type HookTarget = keyof typeof ADAPTERS;

export const HOOK_TARGETS = Object.keys(ADAPTERS) as HookTarget[];

export function isHookTarget(t: string | undefined): t is HookTarget {
  return !!t && Object.hasOwn(ADAPTERS, t);
}

/**
 * フックの出力を作る。何も渡さないときは null。
 * runTell は tell の文面を返す（失敗したら例外か null）。
 */
export async function hookOutput(target: HookTarget, stdin: string, runTell: () => Promise<string | null>): Promise<string | null> {
  const adapter = ADAPTERS[target];
  let input: unknown = null;
  try {
    input = stdin.trim() ? JSON.parse(stdin) : null;
  } catch {
    // 入力の形が想定と違っても、主人の発言として扱う
  }
  if (!adapter.isOwnerTurn(input)) return null;

  const text = await runTell().catch(() => null);
  const context = [text === null ? null : tellContext(text), NOTE_GUIDE].filter((x): x is string => !!x).join("\n\n");
  return adapter.format(context);
}
