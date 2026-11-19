import { composeCommand, hookCommand, mcpCommand, noteCommand, publishCommand, tellCommand, toldCommand } from "./agent.ts";
import { configCommand } from "./config.ts";
import type { CommandContext } from "./context.ts";
import { doctorCommand, initCommand, relayCommand } from "./person.ts";
import { skillCommand } from "./skill.ts";

/** コマンド名 → 実装。名前を足すときは、commands/usage.ts のヘルプにも書く */
export const COMMANDS: Record<string, (ctx: CommandContext) => void | Promise<void>> = {
  tell: tellCommand,
  hook: hookCommand,
  mcp: mcpCommand,
  told: toldCommand,
  release: toldCommand,
  note: noteCommand,
  compose: composeCommand,
  publish: publishCommand,
  init: initCommand,
  relay: relayCommand,
  doctor: doctorCommand,
  config: configCommand,
  skill: skillCommand,
};
