/**
 * OpenClaw のプラグイン（openclaw plugins install souieba）。
 * スキルだけだと、「会話の始めに tell」「主人のしていることが分かったら note」をモデルが実行するかどうかが、モデルの判断に任される。
 * OpenClaw は1つの会話がずっと続くため、「会話の始め」がほとんど来ない。
 * そこで主人の発言ごとにフックで souieba tell を実行して結果をプロンプトに差し込み、メモの手引きも毎回システムプロンプトに足す。
 * tell は発言ごとに呼ばれるので、10分空いたら新しい会話として扱われ（SOUIEBA_SESSION_GAP_MIN）、また1件伝える。
 * 続けて話していても、前に伝えてから10分たてば次の1件を伝える（SOUIEBA_TELL_INTERVAL_MIN）。
 *
 * OpenClaw の SDK には依存しない（definePluginEntry と同じ形のオブジェクトを自分で返す）。
 * 型は使う部分だけを写している（openclaw 2026.8 の PluginHookAgentContext / PluginHookBeforePromptBuildResult）。
 */
import { NOTE_GUIDE, tellContext } from "../shared/guide.ts";
import { type RunTell, TELL_TIMEOUT_MS, runBundledTell } from "../shared/run-tell.ts";

export type { RunTell };

type HookContext = { trigger?: string };

type BeforePromptBuildResult = { prependContext?: string; appendSystemContext?: string };

type PluginApi = {
  on(
    hook: "before_prompt_build",
    handler: (event: unknown, ctx: HookContext) => Promise<BeforePromptBuildResult>,
    opts?: { timeoutMs?: number },
  ): void;
};

/**
 * 設定はない。以前の版にあった agent（Agent の名前）は効果がなくなったが、書いたままの設定を壊さないよう、読んで捨てる。
 * それ以外のキーは、書き間違いに気づけるよう断る
 */
function parseConfig(value: unknown): { success: true; data: undefined } | { success: false; error: { issues: { path: string[]; message: string }[] } } {
  const fail = (message: string, path: string[] = []) => ({ success: false as const, error: { issues: [{ path, message }] } });
  if (value === undefined) return { success: true, data: undefined };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("expected config object");
  for (const [k, v] of Object.entries(value)) {
    if (k !== "agent") return fail(`unknown key: ${k}`, [k]);
    if (typeof v !== "string") return fail("agent must be a string", [k]);
  }
  return { success: true, data: undefined };
}

export function createPlugin(runTell: RunTell = runBundledTell) {
  return {
    id: "souieba",
    name: "Souieba",
    description: "主人の発言ごとに友人の近況（souieba tell）を確かめ、近況のメモの手引きをエージェントに渡す",
    configSchema: {
      safeParse: parseConfig,
      jsonSchema: { type: "object", additionalProperties: false, properties: { agent: { type: "string", deprecated: true } } },
    },
    register(api: PluginApi) {
      api.on(
        "before_prompt_build",
        async (_event, ctx) => {
          // 主人の発言で始まった実行だけで伝える（cron や heartbeat で Session を進めたり、近況を消費したりしない）
          if (ctx.trigger !== undefined && ctx.trigger !== "user") return { appendSystemContext: NOTE_GUIDE };
          const stdout = await runTell(process.env).catch(() => null);
          const context = stdout === null ? null : tellContext(stdout);
          return context ? { prependContext: context, appendSystemContext: NOTE_GUIDE } : { appendSystemContext: NOTE_GUIDE };
        },
        { timeoutMs: TELL_TIMEOUT_MS + 2_000 },
      );
    },
  };
}

export default createPlugin();
