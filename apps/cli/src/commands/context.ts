import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import type { AgentFlags } from "../agent/index.ts";

/** 全コマンドで使うオプション。コマンドごとに使うものが違うので、ここにまとめて、使う側が必要なものを読む */
const OPTIONS = {
  name: { type: "string" },
  current: { type: "boolean", default: false },
  period: { type: "string" },
  skip: { type: "string" },
  reserve: { type: "boolean", default: false },
  // publish: 宛先と Narrator の項目
  to: { type: "string", multiple: true },
  purpose: { type: "string" },
  nuance: { type: "string" },
  context: { type: "string" },
  "expires-in": { type: "string" },
  "allow-reshare": { type: "boolean", default: false },
  // relay: 主人の承認を得たあとで、共有を広げる操作を実行する
  yes: { type: "boolean", default: false },
  // プロジェクト（設定・publish・compose --skip・note）
  project: { type: "string" },
  "copy-default": { type: "boolean", default: false },
  from: { type: "string" },
  // relay delegate grant の期限
  for: { type: "string" },
  cwd: { type: "string" },
  // note: 会話の ID（フックが知らせる）と、エージェントの推定
  session: { type: "string" },
  "project-guess": { type: "string" },
  held: { type: "boolean", default: false },
  note: { type: "string" },
  json: { type: "boolean", default: false },
  debug: { type: "boolean", default: false },
  version: { type: "boolean", short: "v", default: false },
} satisfies ParseArgsOptionsConfig;

export function parseCommandLine(argv: string[]) {
  return parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
}

type Parsed = ReturnType<typeof parseCommandLine>;

/** コマンドの実装に渡すもの。`souieba <cmd> [sub] [rest...]` と、読み取ったオプション */
export type CommandContext = {
  cmd: string | undefined;
  sub: string | undefined;
  rest: string[];
  /** cmd を除いた位置引数（sub と rest） */
  args: string[];
  values: Parsed["values"];
  flags: AgentFlags;
};

/** テスト用に現在時刻を固定できる（SOUIEBA_NOW=ISO 8601） */
export const testableNow = () => (process.env.SOUIEBA_NOW ? new Date(process.env.SOUIEBA_NOW) : new Date());

export const log = (line: string) => console.log(line);

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
