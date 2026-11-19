import { parseArgs } from "node:util";
import * as agentCmd from "./agent.ts";
import { NeedsApprovalError, OwnerOnlyError, isInteractive, relayCommand, ttyAsk } from "./relay.ts";
import {
  SouiebaApiError,
  configPath,
  loadClientConfig,
  saveClientConfig,
} from "@souieba/sdk";
import { HOOK_TARGETS, hookOutput, isHookTarget } from "./integrations/hook/index.ts";
import { initCommand } from "./person.ts";
import { SKILL_TOPICS, installedSkills, isSkillTopic, skillText, skillVersionAdvice } from "./skill.ts";
import { latestVersion, newerThanCurrent, updateAdvice } from "./update-check.ts";
import { CLI_VERSION } from "./version.ts";

const USAGE = `使い方: souieba <command>

  config [show]                    CLIの設定（間隔・更新確認）を見る
  config set <項目> <値>            CLIの設定を保存する（session-gap / tell-interval / update-check）
  config unset <項目>              CLIの設定を既定に戻す
  doctor                           Person IDとRelayへの接続を確認する
  --version                        CLI のバージョン

エージェント用（Skill から呼ぶ。--json で JSON 出力）:
  skill get <topic>                詳しい手順（${Object.keys(SKILL_TOPICS).join(" / ")}）。skill list で一覧
  tell [--reserve]                 主人の発言ごとに呼ぶ。伝える近況が1件あれば表示する
  hook <${HOOK_TARGETS.join("|")}>   エージェントのフックから呼ぶ。tell の結果とメモの手引きを、そのエージェントの形式で出力する
  mcp                              MCP サーバ（stdio）として動く。シェルを使えない MCP クライアント（Claude Desktop など）用
  told <postId> | release <postId> --reserve で予約したものを確定・解除する
  note <メモ> [--cwd <ディレクトリ>] [--session <会話の ID>] [--project-guess <プロジェクト>]
                                   主人について知ったことをローカルに書き溜める（v2 では規則・会話の指定・作業場所・推定の順にプロジェクトを決める）
  note move <プロジェクト> [--from <プロジェクト>] [--period <開始時刻>] [--held] [--note <メモの時刻>]
                                   v2: まだ送っていないメモを別のプロジェクトに移す（主人が振り分けたことになる）
  compose [--skip <periodStart> [--project <名前>]]   投稿待ちの時間帯とメモを表示する
  publish [--period previous|current|<ISO>] <本文>   1時間分の投稿をする
    v2 のPersonでは: [--project <名前>] [--to <相手|group:<グループ>>]... [--purpose <理由>] [--nuance <調子>] [--context <合う話題>]
                      [--expires-in <時間>] [--allow-reshare]

v2（Relay。Person IDで、アカウントなしで共有する）:
  init <Relay の URL> [--name <内部名>]   Person IDを作って Relay に登録する
  relay ...                        souieba relay help で一覧（id / contacts / connect / accept / allow / policy / project など）

<グループ> は名前か ID。設定ファイル: ${configPath()}（環境変数 SOUIEBA_HOME で場所を変更できます）`;

/** テスト用に現在時刻を固定できる（SOUIEBA_NOW=ISO 8601） */
const testableNow = () => (process.env.SOUIEBA_NOW ? new Date(process.env.SOUIEBA_NOW) : new Date());

function configCommand(sub: string | undefined, rest: string[]): void {
  const cfg = loadClientConfig();
  if (!sub || sub === "show") {
    console.log(JSON.stringify({ client: cfg.client ?? {} }, null, 2));
    return;
  }
  if (sub !== "set" && sub !== "unset") throw new Error("souieba config [show] | config set <session-gap|tell-interval|update-check> <値> | config unset <項目>");
  const key = rest[0];
  if (!key || !["session-gap", "tell-interval", "update-check"].includes(key)) {
    throw new Error("設定項目は session-gap / tell-interval / update-check です");
  }
  cfg.client ??= {};
  const field = key === "session-gap" ? "sessionGapMinutes" : key === "tell-interval" ? "tellIntervalMinutes" : "updateCheck";
  if (sub === "unset") {
    delete cfg.client[field];
    saveClientConfig(cfg);
    console.log(`${key} を既定に戻しました`);
    return;
  }
  const value = rest[1];
  if (value === undefined) throw new Error(`souieba config set ${key} <値>`);
  if (field === "updateCheck") {
    if (value !== "on" && value !== "off") throw new Error("update-check は on または off で指定してください");
    cfg.client.updateCheck = value === "on";
  } else {
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes < 0) throw new Error(`${key} は0以上の分数で指定してください`);
    cfg.client[field] = minutes;
  }
  saveClientConfig(cfg);
  console.log(`${key} を ${value} に設定しました（${configPath()}）`);
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      current: { type: "boolean", default: false },
      period: { type: "string" },
      skip: { type: "string" },
      reserve: { type: "boolean", default: false },
      // v2（Relay）の publish: 宛先と Narrator の項目
      to: { type: "string", multiple: true },
      purpose: { type: "string" },
      nuance: { type: "string" },
      context: { type: "string" },
      "expires-in": { type: "string" },
      "allow-reshare": { type: "boolean", default: false },
      // souieba relay: 主人の承認を得たあとで、共有を広げる操作を実行する
      yes: { type: "boolean", default: false },
      // v2 のプロジェクト（設定・publish・compose --skip・note）
      project: { type: "string" },
      "copy-default": { type: "boolean", default: false },
      from: { type: "string" },
      // souieba relay delegate grant の期限
      for: { type: "string" },
      cwd: { type: "string" },
      // v2 の note: 会話の ID（フックが知らせる）と、エージェントの推定
      session: { type: "string" },
      "project-guess": { type: "string" },
      held: { type: "boolean", default: false },
      note: { type: "string" },
      json: { type: "boolean", default: false },
      debug: { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  const [cmd, sub, ...rest] = positionals;
  if (values.version || cmd === "version") {
    console.log(CLI_VERSION);
    return;
  }
  const flags: agentCmd.AgentFlags = { json: values.json, debug: values.debug, now: testableNow };

  switch (cmd) {
    case "tell":
      await agentCmd.tell(flags, values.reserve);
      break;
    case "hook": {
      if (!isHookTarget(sub)) throw new Error(`souieba hook <${HOOK_TARGETS.join("|")}>`);
      const stdin = process.stdin.isTTY ? "" : await readStdin();
      const output = await hookOutput(
        sub,
        stdin,
        async () => (await agentCmd.tellResult({ ...flags, json: false }, false)).text,
        (sess) => agentCmd.hookSession(flags, sess),
      ).catch(() => null);
      if (output) console.log(output);
      break;
    }
    case "mcp":
      // 未ログインなどは起動時に止めず、ツールの結果として返す（エージェントが主人に原因を伝えられるように）
      // MCP の SDK は大きいので、ほかのコマンド（発言ごとに呼ばれるフックなど）の起動を遅くしないよう、ここでだけ読み込む
      await (await import("./integrations/mcp/server.ts")).runMcpServer(flags);
      break;
    case "told":
    case "release": {
      if (!sub) throw new Error(`souieba ${cmd} <postId>`);
      await (cmd === "told" ? agentCmd.told : agentCmd.release)(flags, sub);
      break;
    }
    case "note": {
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
        break;
      }
      const text = [sub, ...rest].filter(Boolean).join(" ");
      if (!text) throw new Error("souieba note <メモ>");
      agentCmd.note(flags, text, {
        cwd: values.cwd ?? process.cwd(),
        session: values.session ?? process.env.SOUIEBA_SESSION ?? null,
        guess: values["project-guess"] ?? null,
      });
      break;
    }
    case "compose":
      agentCmd.compose(flags, values.skip, values.project);
      break;
    case "publish": {
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
      break;
    }
    case "init":
      await initCommand({ url: sub, name: values.name }, { log: (l) => console.log(l), now: testableNow });
      break;
    case "relay": {
      try {
        await relayCommand(
          {
            sub,
            rest,
            name: values.name,
            yes: values.yes,
            project: values.project,
            copyDefault: values["copy-default"],
            term: values.for,
            session: values.session,
            // 承認のあとに実行するコマンドは、読み取った値から組み立て直す
            raw: [
              ...positionals.slice(1),
              ...(values.name !== undefined ? ["--name", values.name] : []),
              ...(values.project !== undefined ? ["--project", values.project] : []),
              ...(values["copy-default"] ? ["--copy-default"] : []),
              ...(values.session !== undefined ? ["--session", values.session] : []),
            ],
          },
          { log: (l) => console.log(l), interactive: isInteractive(), ask: ttyAsk, now: testableNow },
        );
      } catch (err) {
        if (err instanceof OwnerOnlyError) {
          // 任せる操作を端末の外から呼んだとき。--yes を付け直しても通らないので、終了コード 3 ではなく 4 にする
          console.log(err.message);
          process.exitCode = 4;
          break;
        }
        if (!(err instanceof NeedsApprovalError)) throw err;
        // エージェントが --yes なしで実行したとき。案内は標準出力に出し、終了コード 3 で止める
        console.log(err.message);
        process.exitCode = 3;
      }
      break;
    }
    case "doctor": {
      const latest = await latestVersion(testableNow(), { force: true });
      if (newerThanCurrent(latest)) console.log(updateAdvice(latest!));
      for (const skill of installedSkills()) {
        const advice = skillVersionAdvice(skill);
        if (advice) console.log(advice);
      }
      await relayCommand({ sub: "id", rest: [], raw: ["id"] }, { log: (l) => console.log(l), interactive: false, ask: async () => false, now: testableNow });
      await relayCommand({ sub: "contacts", rest: [], raw: ["contacts"] }, { log: (l) => console.log(l), interactive: false, ask: async () => false, now: testableNow });
      break;
    }
    case "config": {
      configCommand(sub, rest);
      break;
    }
    case "skill": {
      if (sub === "get" && isSkillTopic(rest[0])) {
        // 手順の先頭に、どのバージョンの CLI の手順かを出す（スキルとのずれに気づけるように）
        console.log(`<!-- souieba ${CLI_VERSION} / skill get ${rest[0]} -->`);
        for (const s of installedSkills()) {
          const advice = skillVersionAdvice(s);
          if (advice) console.log(`> 注意: ${advice}`);
        }
        console.log(skillText(rest[0]));
      } else if (sub === "list" || sub === undefined) {
        for (const [t, d] of Object.entries(SKILL_TOPICS)) console.log(`${t}\t${d}`);
      } else {
        throw new Error(`souieba skill get <${Object.keys(SKILL_TOPICS).join("|")}>`);
      }
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof SouiebaApiError ? `エラー（${err.code}）: ${err.message}` : err instanceof Error ? err.message : err);
  process.exit(1);
});
