/** エージェントが Skill やフックから呼ぶコマンド（tell・told・release・note・compose・publish・hook・mcp） */
import * as agentCmd from "../agent/index.ts";
import { HOOK_TARGETS, hookOutput, isHookTarget } from "../integrations/hook/index.ts";
import { NeedsApprovalError } from "../relay.ts";
import { type CommandContext, readStdin } from "./context.ts";

export async function tellCommand({ flags, values }: CommandContext): Promise<void> {
  await agentCmd.tell(flags, values.reserve);
}

export async function hookCommand({ sub, flags }: CommandContext): Promise<void> {
  if (!isHookTarget(sub)) throw new Error(`souieba hook <${HOOK_TARGETS.join("|")}>`);
  const stdin = process.stdin.isTTY ? "" : await readStdin();
  const output = await hookOutput(
    sub,
    stdin,
    async () => (await agentCmd.tellResult({ ...flags, json: false }, false)).text,
    (sess) => agentCmd.hookSession(flags, sess),
  ).catch(() => null);
  if (output) console.log(output);
}

export async function mcpCommand({ flags }: CommandContext): Promise<void> {
  // 未ログインなどは起動時に止めず、ツールの結果として返す（エージェントが主人に原因を伝えられるように）
  // MCP の SDK は大きいので、ほかのコマンド（発言ごとに呼ばれるフックなど）の起動を遅くしないよう、ここでだけ読み込む
  await (await import("../integrations/mcp/server.ts")).runMcpServer(flags);
}

/** souieba told <postId> | souieba release <postId> */
export async function toldCommand({ cmd, sub, flags }: CommandContext): Promise<void> {
  if (!sub) throw new Error(`souieba ${cmd} <postId>`);
  await (cmd === "told" ? agentCmd.told : agentCmd.release)(flags, sub);
}

export async function noteCommand({ sub, rest, flags, values }: CommandContext): Promise<void> {
  if (sub === "move") {
    const to = rest[0];
    if (!to) throw new Error("souieba note move <移す先のプロジェクト> [--from <プロジェクト>] [--period <開始時刻>]");
    try {
      await agentCmd.noteMove(flags, to, { from: values.from, periodStart: values.period, yes: values.yes, held: values.held, ts: values.note });
    } catch (err) {
      if (!(err instanceof NeedsApprovalError)) throw err;
      console.log(err.message);
      process.exitCode = 3;
    }
    return;
  }
  const text = [sub, ...rest].filter(Boolean).join(" ");
  if (!text) throw new Error("souieba note <メモ>");
  agentCmd.note(flags, text, {
    cwd: values.cwd ?? process.cwd(),
    session: values.session ?? process.env.SOUIEBA_SESSION ?? null,
    guess: values["project-guess"] ?? null,
  });
}

export function composeCommand({ flags, values }: CommandContext): void {
  agentCmd.compose(flags, values.skip, values.project);
}

export async function publishCommand({ sub, rest, flags, values }: CommandContext): Promise<void> {
  const content = [sub, ...rest].filter(Boolean).join(" ");
  if (!content) throw new Error('souieba publish [--period previous|current|<ISO>] "主人は……"');
  const hours = values["expires-in"] !== undefined ? Number(values["expires-in"]) : undefined;
  if (hours !== undefined && !(hours > 0)) throw new Error("--expires-in は時間（1〜168）で指定してください");
  await agentCmd.publish(flags, content, values.period ?? (values.current ? "current" : "previous"), {
    to: values.to,
    purpose: values.purpose,
    nuance: values.nuance,
    context: values.context,
    useTtlMs: hours !== undefined ? hours * 3_600_000 : undefined,
    reshare: values["allow-reshare"] ? "allow" : "deny",
    project: values.project,
  });
}
