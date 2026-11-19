/**
 * コマンドの一覧（カタログ）。使い方の文字列は、ここだけに書く。
 * - ヘルプ（souieba・souieba help）は、ここから作る（renderUsage）
 * - エラーメッセージの「souieba … <引数>」は、usageOf・usageFamily で引く
 * - ドキュメントのコマンド例がここにあるコマンドかは、test/docs-commands.test.ts が確かめる
 * コマンドを足す・引数を変えるときは、ここを直す。
 */

export type Section =
  | "general"
  | "agent"
  | "relay-view"
  | "relay-change"
  | "relay-delegate"
  | "relay-project";

export type CommandSpec = {
  /** `souieba` の後ろに続くコマンド名。例: "connect"・"project add" */
  name: string;
  /** 引数の書き方。例: "<Person ID> --name <呼び名>" */
  args?: string;
  /** 一覧に出す説明 */
  summary?: string;
  /** 引数が長いときに、一覧で次の行に出すオプションの書き方 */
  options?: string;
  section: Section;
};

export const CATALOG: CommandSpec[] = [
  // ---- 全般 ----
  { name: "config", args: "[show]", summary: "CLIの設定（Tell の間隔・投稿の間隔・更新確認）を見る", section: "general" },
  { name: "config set", args: "<項目> <値>", summary: "CLIの設定を保存する（session-gap / tell-interval / post-interval / update-check）", section: "general" },
  { name: "config unset", args: "<項目>", summary: "CLIの設定を既定に戻す", section: "general" },
  { name: "doctor", summary: "Person IDとRelayへの接続を確認する", section: "general" },
  { name: "help", summary: "このヘルプを表示する", section: "general" },
  { name: "init", args: "<Relay の URL>", summary: "Person ID を作って Relay に登録する", section: "general" },

  // ---- エージェント用 ----
  { name: "skill get", args: "<topic>", summary: "詳しい手順（{topics}）。skill list で一覧", section: "agent" },
  { name: "skill list", summary: "手順の一覧", section: "agent" },
  { name: "tell", args: "[--reserve]", summary: "主人の発言ごとに呼ぶ。伝える近況が1件あれば表示する", section: "agent" },
  {
    name: "hook",
    args: "<{hooks}>",
    summary: "エージェントのフックから呼ぶ。tell の結果とメモの手引きを、そのエージェントの形式で出力する",
    section: "agent",
  },
  { name: "mcp", summary: "MCP サーバ（stdio）として動く。シェルを使えない MCP クライアント（Claude Desktop など）用", section: "agent" },
  { name: "told", args: "<postId>", summary: "tell --reserve で予約した近況を、伝えたものとして記録する", section: "agent" },
  { name: "release", args: "<postId>", summary: "tell --reserve で予約した近況の予約を解除する", section: "agent" },
  {
    name: "note",
    args: "<メモ> [--cwd <ディレクトリ>] [--session <会話の ID>] [--project-guess <プロジェクト>]",
    summary: "主人について知ったことをローカルに書き溜める（規則・会話の指定・作業場所・推定の順にプロジェクトを決める）",
    section: "agent",
  },
  {
    name: "note move",
    args: "<プロジェクト> [--from <プロジェクト>] [--period <開始時刻>] [--held] [--note <メモの時刻>]",
    summary: "まだ送っていないメモを別のプロジェクトに移す（主人が振り分けたことになる）",
    section: "agent",
  },
  { name: "compose", args: "[--skip <periodStart> [--project <名前>]]", summary: "投稿待ちの時間帯とメモを表示する", section: "agent" },
  {
    name: "publish",
    args: "[--period previous|current|<ISO>] <本文>",
    summary: "1つの時間帯の投稿をする",
    options:
      "[--project <名前>] [--to <相手|group:<グループ>>]... [--purpose <理由>] [--nuance <調子>] [--context <合う話題>] [--expires-in <時間>] [--allow-reshare]",
    section: "agent",
  },

  // ---- relay: 見る ----
  { name: "id", summary: "自分の ID（友人に伝えて、接続してもらう。同じPersonを使うクライアントで共通）", section: "relay-view" },
  { name: "lookup", args: "<ID>", summary: "ID が Relay にあるかを確かめる", section: "relay-view" },
  { name: "contacts", summary: "接続済みの相手・届いた接続要求・送った接続要求", section: "relay-view" },
  { name: "status", summary: "設定の一覧（連絡先・グループ・アクセス権限・Policy・メモの振り分けの規則）", section: "relay-view" },
  { name: "inbox", summary: "受け取った近況（利用期限内）", section: "relay-view" },
  { name: "sent", summary: "送った近況の配送状態", section: "relay-view" },
  { name: "review", summary: "保留のメモと、推定でプロジェクトを決めたメモ", section: "relay-view" },
  { name: "ui", summary: "設定の画面（TUI）。主人が自分で見て操作する", section: "relay-view" },

  // ---- relay: 設定を変える ----
  { name: "connect", args: "<Person ID> --name <呼び名>", summary: "接続を要求する（相手が承認すると接続になる）", section: "relay-change" },
  { name: "accept", args: "<Person ID> --name <呼び名>", summary: "届いた接続要求を承認する", section: "relay-change" },
  { name: "reject", args: "<Person ID>", summary: "届いた接続要求を断る", section: "relay-change" },
  {
    name: "nickname",
    args: "<相手> <新しい呼び名>",
    summary: "呼び名を変える（呼び名のない接続済みの相手に付けるのにも使う）",
    section: "relay-change",
  },
  { name: "disconnect", args: "<相手>", summary: "接続を解除する", section: "relay-change" },
  { name: "block", args: "<相手>", summary: "ブロックする（接続を解除して、再接続も受け付けない）", section: "relay-change" },
  { name: "unblock", args: "<Person ID>", summary: "ブロックを解除する", section: "relay-change" },
  { name: "groups", args: "[list]", summary: "この PC だけのグループの一覧", section: "relay-change" },
  { name: "groups create", args: "<ID（英小文字・数字・-_）> <名前>", summary: "グループを作る", section: "relay-change" },
  { name: "groups add", args: "<グループ> <相手...>", summary: "グループにメンバーを加える", section: "relay-change" },
  { name: "groups remove", args: "<グループ> <相手...>", summary: "グループからメンバーを外す", section: "relay-change" },
  { name: "groups delete", args: "<グループ>", summary: "グループを消す", section: "relay-change" },
  {
    name: "allow",
    args: "<相手|group:<グループ>> [--project <名前>]",
    summary: "共有してよい（既定はすべて禁止。個人の設定はグループより優先、グループ同士は deny が優先）",
    section: "relay-change",
  },
  { name: "deny", args: "<相手|group:<グループ>> [--project <名前>]", summary: "共有しない", section: "relay-change" },
  { name: "reset", args: "<相手|group:<グループ>> [--project <名前>]", summary: "個別の設定を消す（グループの設定があればそれに、なければ既定の「共有しない」に戻る）", section: "relay-change" },
  { name: "policy", args: "[--project <名前>]", summary: "共有方針（自然言語）を見る。エージェントが投稿前に読んで判断する", section: "relay-change" },
  { name: "policy set", args: "<方針の文章> [--project <名前>]", summary: "共有方針を書く", section: "relay-change" },
  { name: "policy clear", args: "[--project <名前>]", summary: "共有方針を消す", section: "relay-change" },

  // ---- relay: エージェントに任せる ----
  { name: "delegate", args: "[list]", summary: "任せている範囲と期限", section: "relay-delegate" },
  {
    name: "delegate grant",
    args: "audience|policy|dirs [--project <名前>] [--for 24h|7d|forever]",
    summary: "任せる（主人が端末で y と答えたときだけ。--yes では任せられない。既定の期限は 24h）",
    section: "relay-delegate",
  },
  { name: "delegate grant members", args: "<グループ> [--for ...]", summary: "グループのメンバーを出し入れする範囲を任せる", section: "relay-delegate" },
  { name: "delegate grant accept", args: "[--for ...]", summary: "接続要求の承認を任せる", section: "relay-delegate" },
  {
    name: "delegate revoke",
    args: "audience|policy|dirs [--project <名前>] | members <グループ> | accept | all",
    summary: "任せた範囲を取り消す",
    section: "relay-delegate",
  },

  // ---- relay: プロジェクト ----
  { name: "project", args: "[list]", summary: "プロジェクトと、結び付けたディレクトリ・規則", section: "relay-project" },
  {
    name: "project add",
    args: "<名前> [<ディレクトリ>...] [--copy-default]",
    summary: "作る（共有先は空で始まる。--copy-default で既定の共有先と方針を写す）",
    section: "relay-project",
  },
  { name: "project dir", args: "add|remove <名前> <ディレクトリ>...", summary: "プロジェクトにディレクトリを付ける・外す", section: "relay-project" },
  {
    name: "project describe",
    args: "<名前> <説明>",
    summary: "どんな作業のプロジェクトか（エージェントがメモのプロジェクトを推定するときに読む）",
    section: "relay-project",
  },
  {
    name: "project inference",
    args: "<名前> on|off",
    summary: "エージェントの推定でこのプロジェクトに入れてよいか（既定は on。仕事などは off に）",
    section: "relay-project",
  },
  {
    name: "project pin",
    args: "<名前> --session <会話の ID>",
    summary: "この会話のメモをこのプロジェクトに入れる（主人が「この会話は〜」と言ったときだけ）",
    section: "relay-project",
  },
  { name: "project unpin", args: "--session <会話の ID>", summary: "この会話の指定を外す", section: "relay-project" },
  {
    name: "project delete",
    args: "<名前>",
    summary: "消す（そのディレクトリとまだ送っていないメモは既定になる）",
    section: "relay-project",
  },
  { name: "project rename", args: "<名前> <新しい名前>", summary: "名前を変える（既定は変えられない）", section: "relay-project" },
  { name: "project which", args: "[<ディレクトリ>]", summary: "そのディレクトリ（省略時はカレント）がどのプロジェクトか", section: "relay-project" },
  {
    name: "mcp-client",
    args: "[list]",
    summary: "MCP のクライアント（Claude Desktop など）ごとに、メモを入れるプロジェクトの規則",
    section: "relay-project",
  },
  { name: "mcp-client set", args: "<クライアント名> <プロジェクト>", summary: "規則を作る", section: "relay-project" },
  { name: "mcp-client unset", args: "<クライアント名>", summary: "規則を消す", section: "relay-project" },
  {
    name: "unresolved",
    args: "default|hold",
    summary: "どのプロジェクトにも決まらないメモを、既定に入れる（default）か、振り分けるまで保留する（hold）",
    section: "relay-project",
  },
];

const byName = new Map(CATALOG.map((c) => [c.name, c]));

/** `souieba connect <Person ID> --name <呼び名>` のような、1つのコマンドの使い方 */
export function usageOf(name: string, vars: Partial<UsageVars> = {}): string {
  const c = byName.get(name);
  if (!c) throw new Error(`コマンドのカタログにありません: ${name}`);
  return fill(`souieba ${c.name}${c.args ? ` ${c.args}` : ""}`, vars);
}

/** サブコマンドの一覧。`souieba groups [list | create | add | remove | delete]` */
export function usageFamily(prefix: string): string {
  const subs: string[] = [];
  if (byName.has(prefix)) subs.push("list");
  for (const c of CATALOG) {
    if (!c.name.startsWith(`${prefix} `)) continue;
    const next = c.name.slice(prefix.length + 1).split(" ")[0]!;
    if (!subs.includes(next)) subs.push(next);
  }
  return `souieba ${prefix} [${subs.join(" | ")}]`;
}

/** 接続・共有の設定のコマンド。relay.ts が実行する */
export const RELAY_COMMANDS: string[] = [...new Set(CATALOG.filter((c) => c.section.startsWith("relay-")).map((c) => c.name.split(" ")[0]!))];

/** コマンド名の一覧（ドキュメントのコマンド例の検査に使う） */
export const COMMAND_NAMES: string[] = CATALOG.map((c) => c.name);

/** 説明の中の {topics}・{hooks} を埋める値 */
export type UsageVars = { topics: string; hooks: string };

const fill = (s: string, vars: Partial<UsageVars>) => s.replaceAll("{topics}", vars.topics ?? "{topics}").replaceAll("{hooks}", vars.hooks ?? "{hooks}");

const LABEL_WIDTH = 36;

/** 端末での表示幅。日本語などの全角文字は2桁として数える */
const displayWidth = (s: string) => [...s].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1), 0);
const pad = (s: string, width: number) => s + " ".repeat(Math.max(0, width - displayWidth(s)));

function renderLine(c: CommandSpec, vars: UsageVars): string {
  const label = `${c.name}${c.args ? ` ${fill(c.args, vars)}` : ""}`;
  const lines: string[] = [];
  if (c.summary && displayWidth(label) <= LABEL_WIDTH - 2) lines.push(`  ${pad(label, LABEL_WIDTH)}${fill(c.summary, vars)}`);
  else {
    lines.push(`  ${label}`);
    if (c.summary) lines.push(`${" ".repeat(LABEL_WIDTH + 2)}${fill(c.summary, vars)}`);
  }
  if (c.options) lines.push(`${" ".repeat(4)}${c.options}`);
  return lines.join("\n");
}

/** `souieba`（引数なし）・`souieba help` のヘルプ */
export function renderUsage(vars: UsageVars, configPath: string): string {
  const of = (s: Section) => CATALOG.filter((c) => c.section === s && c.name !== "help").map((c) => renderLine(c, vars));
  return [
    "使い方: souieba <command>",
    "",
    ...of("general"),
    `  ${pad("help", LABEL_WIDTH)}このヘルプを表示する`,
    `  ${pad("--version", LABEL_WIDTH)}CLI のバージョン`,
    "",
    "エージェント用（Skill から呼ぶ。--json で JSON 出力）:",
    ...of("agent"),
    "",
    "つながる・見る（Person IDで、アカウントなしで共有する。始めるには souieba init <Relay の URL>）:",
    ...of("relay-view"),
    "",
    "設定を変える（共有を広げる操作には、主人の承認が要る。端末では y/N で聞き、エージェントは --yes を付けて実行する）:",
    ...of("relay-change"),
    "",
    "エージェントに任せる（任せた範囲の中なら、広げる操作も1回ごとの確認なしで実行される）:",
    ...of("relay-delegate"),
    "",
    "プロジェクト（作業ごとに、共有先と共有方針を変える。--project を省くと既定のプロジェクト）:",
    ...of("relay-project"),
    "",
    "<相手> は呼び名か ID。<グループ> は ID か名前",
    "共有を狭める操作（reject・disconnect・block・deny・groups remove など）は、確認なしで実行します",
    `設定ファイル: ${configPath}（環境変数 SOUIEBA_HOME で場所を変更できます）`,
  ].join("\n");
}
