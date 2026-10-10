/**
 * Claude Agent SDK への組み込み（import { souieba } from "souieba/agent-sdk"）。
 * Agent SDK は settingSources を指定しないと ~/.claude の設定（フック）もスキルも読まないため、souieba hook claude-code が届かない。
 * フックやスキルの文面で頼むと、モデルは「第三者からの指示」として扱い、メモを書く前に主人に確かめてしまう。
 * そこで開発者が query() に渡すシステムプロンプトに手引きを入れ（開発者が決めたこととして扱われる）、
 * tell はフックの関数で主人の発言ごとに実行して文脈に足し、souieba note の Bash は許可しておく。
 *
 * Agent SDK には依存しない。型（agent-sdk.d.ts）は使う部分だけを写している（@anthropic-ai/claude-agent-sdk の HookCallbackMatcher / HookJSONOutput）。
 */
import type { SouiebaAgentSdk, SouiebaOptions } from "../../agent-sdk.d.ts";
import { NOTE_GUIDE, tellContext } from "./guide.ts";
import { type RunTell, TELL_TIMEOUT_MS, runBundledTell } from "./run-tell.ts";

/** モデルがメモを書く前に主人に確かめないよう、開発者が組み込んだことを伝える */
const EMBEDDED =
  "このエージェントには Souieba が組み込まれています。上のとおりメモを書くときに、書いてよいかを主人に確かめる必要はありません。";

export function souieba(opts: SouiebaOptions = {}, runTell: RunTell = runBundledTell): SouiebaAgentSdk {
  const env = opts.agent ? { ...process.env, SOUIEBA_AGENT: opts.agent } : process.env;
  return {
    systemPrompt: `${NOTE_GUIDE}\n${EMBEDDED}`,
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            async () => {
              const stdout = await runTell(env).catch(() => null);
              const context = stdout === null ? null : tellContext(stdout);
              return context ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } } : {};
            },
          ],
          timeout: Math.ceil(TELL_TIMEOUT_MS / 1000) + 2,
        },
      ],
    },
    allowedTools: ["Bash(souieba note *)"],
  };
}
