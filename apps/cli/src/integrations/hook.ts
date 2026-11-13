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

/** フックの入力にある、会話の ID と作業ディレクトリ（Claude Code・Codex は session_id と cwd、Hermes は session_id） */
export function hookSession(input: unknown): { id: string; cwd: string | null } | null {
  const i = input as { session_id?: unknown; cwd?: unknown } | null;
  if (!i || typeof i.session_id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(i.session_id)) return null;
  return { id: i.session_id, cwd: typeof i.cwd === "string" && i.cwd.startsWith("/") ? i.cwd : null };
}

/**
 * フックの出力を作る。何も渡さないときは null。
 * runTell は tell の文面を返す（失敗したら例外か null）。
 * onSession は、会話の ID が分かったときに呼ぶ（v2: 作業ディレクトリを覚え、会話の ID の手引きを返す。v1 なら null）
 */
export async function hookOutput(
  target: HookTarget,
  stdin: string,
  runTell: () => Promise<string | null>,
  onSession?: (s: { id: string; cwd: string | null }) => string | null,
): Promise<string | null> {
  const adapter = ADAPTERS[target];
  let input: unknown = null;
  try {
    input = stdin.trim() ? JSON.parse(stdin) : null;
  } catch {
    // 入力の形が想定と違っても、主人の発言として扱う
  }
  if (!adapter.isOwnerTurn(input)) return null;

  const text = await runTell().catch(() => null);
  const sess = hookSession(input);
  let sessionGuide: string | null = null;
  if (sess && onSession) {
    try {
      sessionGuide = onSession(sess);
    } catch {
      // 覚えられなくても、tell とメモの手引きは渡す
    }
  }
  const context = [text === null ? null : tellContext(text), NOTE_GUIDE, sessionGuide].filter((x): x is string => !!x).join("\n\n");
  return adapter.format(context);
}
