/**
 * OpenClaw のプラグイン（openclaw plugins install souieba）。
 * スキルだけだと、「会話の始めに tell」「主人のしていることが分かったら note」をモデルが実行するかどうかが、モデルの判断に任される。
 * OpenClaw は1つの会話がずっと続くため、「会話の始め」がほとんど来ない。
 * そこで主人の発言ごとにフックで souieba tell を実行して結果をプロンプトに差し込み、メモの手引きも毎回システムプロンプトに足す。
 * tell は発言ごとに呼ばれるので、30分空いたら新しい会話として扱われ（SOUIEBA_SESSION_GAP_MIN）、また1件伝える。
 *
 * OpenClaw の SDK には依存しない（definePluginEntry と同じ形のオブジェクトを自分で返す）。
 * 型は使う部分だけを写している（openclaw 2026.8 の PluginHookAgentContext / PluginHookBeforePromptBuildResult）。
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NOTE_GUIDE, tellContext } from "./guide.ts";

type PluginConfig = { agent?: string };

type HookContext = { trigger?: string };

type BeforePromptBuildResult = { prependContext?: string; appendSystemContext?: string };

type PluginApi = {
  pluginConfig?: unknown;
  on(
    hook: "before_prompt_build",
    handler: (event: unknown, ctx: HookContext) => Promise<BeforePromptBuildResult>,
    opts?: { timeoutMs?: number },
  ): void;
};

/** souieba tell を実行して標準出力を返す。失敗したら null（主人の会話を止めない） */
export type RunTell = (env: NodeJS.ProcessEnv) => Promise<string | null>;

const TELL_TIMEOUT_MS = 10_000;

/** バンドル後は dist/openclaw.mjs の隣に CLI 本体（dist/souieba.mjs）がある。PATH の souieba とバージョンがずれないよう、こちらを使う */
const runBundledTell: RunTell = (env) =>
  new Promise((resolve) => {
    const cli = fileURLToPath(new URL("./souieba.mjs", import.meta.url));
    execFile(process.execPath, [cli, "tell"], { env, timeout: TELL_TIMEOUT_MS }, (err, stdout) => resolve(err ? null : stdout));
  });

function parseConfig(value: unknown): { success: true; data: PluginConfig | undefined } | { success: false; error: { issues: { path: string[]; message: string }[] } } {
  const fail = (message: string, path: string[] = []) => ({ success: false as const, error: { issues: [{ path, message }] } });
  if (value === undefined) return { success: true, data: undefined };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("expected config object");
  for (const [k, v] of Object.entries(value)) {
    if (k !== "agent") return fail(`unknown key: ${k}`, [k]);
    if (typeof v !== "string") return fail("agent must be a string", [k]);
  }
  return { success: true, data: value as PluginConfig };
}

export function createPlugin(runTell: RunTell = runBundledTell) {
  return {
    id: "souieba",
    name: "Souieba",
    description: "主人の発言ごとに友人の近況（souieba tell）を確かめ、近況のメモの手引きをエージェントに渡す",
    configSchema: {
      safeParse: parseConfig,
      jsonSchema: { type: "object", additionalProperties: false, properties: { agent: { type: "string" } } },
    },
    register(api: PluginApi) {
      const config = (parseConfig(api.pluginConfig).success ? api.pluginConfig : undefined) as PluginConfig | undefined;
      const env = config?.agent ? { ...process.env, SOUIEBA_AGENT: config.agent } : process.env;
      api.on(
        "before_prompt_build",
        async (_event, ctx) => {
          // 主人の発言で始まった実行だけで伝える（cron や heartbeat で Session を進めたり、近況を消費したりしない）
          if (ctx.trigger !== undefined && ctx.trigger !== "user") return { appendSystemContext: NOTE_GUIDE };
          const stdout = await runTell(env).catch(() => null);
          const context = stdout === null ? null : tellContext(stdout);
          return context ? { prependContext: context, appendSystemContext: NOTE_GUIDE } : { appendSystemContext: NOTE_GUIDE };
        },
        { timeoutMs: TELL_TIMEOUT_MS + 2_000 },
      );
    },
  };
}

export default createPlugin();
