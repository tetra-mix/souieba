/**
 * souieba の入口。引数を読み、commands/ のコマンドに振り分ける。
 *   commands/agent.ts   エージェントが呼ぶコマンド（tell・note・compose・publish・hook・mcp など）
 *   commands/person.ts  主人が使うコマンド（init・relay・doctor）
 *   commands/config.ts・skill.ts  設定と手順書
 */
import { SouiebaApiError } from "@souieba/sdk";
import { COMMANDS } from "./commands/index.ts";
import { type CommandContext, parseCommandLine, testableNow } from "./commands/context.ts";
import { USAGE } from "./commands/usage.ts";
import { CLI_VERSION } from "./version.ts";

async function main(argv: string[]) {
  const { values, positionals } = parseCommandLine(argv);
  const [cmd, sub, ...rest] = positionals;
  if (values.version || cmd === "version") {
    console.log(CLI_VERSION);
    return;
  }
  const run = cmd !== undefined && Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  if (!run) {
    console.log(USAGE);
    process.exitCode = cmd ? 1 : 0;
    return;
  }
  const ctx: CommandContext = {
    cmd,
    sub,
    rest,
    args: positionals.slice(1),
    values,
    flags: { json: values.json, debug: values.debug, now: testableNow },
  };
  await run(ctx);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof SouiebaApiError ? `エラー（${err.code}）: ${err.message}` : err instanceof Error ? err.message : err);
  process.exit(1);
});
