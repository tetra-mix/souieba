import { configPath } from "@souieba/sdk";
import { HOOK_TARGETS } from "../integrations/hook/index.ts";
import { SKILL_TOPICS } from "../skill.ts";

export const USAGE = `使い方: souieba <command>

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
                                   主人について知ったことをローカルに書き溜める（規則・会話の指定・作業場所・推定の順にプロジェクトを決める）
  note move <プロジェクト> [--from <プロジェクト>] [--period <開始時刻>] [--held] [--note <メモの時刻>]
                                   まだ送っていないメモを別のプロジェクトに移す（主人が振り分けたことになる）
  compose [--skip <periodStart> [--project <名前>]]   投稿待ちの時間帯とメモを表示する
  publish [--period previous|current|<ISO>] <本文>   1時間分の投稿をする
    [--project <名前>] [--to <相手|group:<グループ>>]... [--purpose <理由>] [--nuance <調子>] [--context <合う話題>]
                      [--expires-in <時間>] [--allow-reshare]

Relay（Person IDで、アカウントなしで共有する）:
  init <Relay の URL>              Person ID を作って Relay に登録する
  relay ...                        souieba relay help で一覧（id / contacts / connect / accept / allow / policy / project など）

<グループ> は名前か ID。設定ファイル: ${configPath()}（環境変数 SOUIEBA_HOME で場所を変更できます）`;

