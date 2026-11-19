# Souieba のドキュメント

このディレクトリは、決まっていて実装が終わったことだけを書く。計画中・検討中のことは置かない。コードと食い違ったら、コードを正として文書を直す。

紹介サイト（`apps/site`）の内容は、こことは別に管理している。

## 2つの層

| 層 | 答える問い | 置き場所 |
|---|---|---|
| **L1 概要** | 何を作っていて、どう動くか。数分で全体を掴む | [architecture.md](architecture.md) |
| **L2 詳細** | 実際にはどう決まっていて、なぜそうしたか。領域ごとの仕様と設計判断 | [design/](design/) |

L1 から各領域の L2 へリンクしている。まず L1 を読み、必要な領域の L2 に進む。

## L2 の一覧

| ファイル | 領域 |
|---|---|
| [projects.md](design/projects.md) | プロジェクトごとの共有設定。共有先の決め方、メモのプロジェクトの決め方、広げる／狭める操作 |
| [delegation.md](design/delegation.md) | 主人がエージェントに任せる範囲 |
| [relay-protocol.md](design/relay-protocol.md) | ID と鍵、接続、メッセージの暗号化と署名、Relay に見える情報、信頼モデルと限界 |
| [server.md](design/server.md) | Relay サーバの構成、DB、入口の防御、デプロイ、リリース |
| [post-flow.md](design/post-flow.md) | note → compose → publish → tell の流れ、安全対策 |
| [local-state.md](design/local-state.md) | 手元の状態（`SOUIEBA_HOME`）と設定 |
| [agents.md](design/agents.md) | スキル・フック・MCP・プラグインなど、エージェントとの接点 |
| [code-layout.md](design/code-layout.md) | コードの構成、依存の向き、テスト、主なコマンド |

## 書き方

- L2 は、冒頭で「何を決めているか」を示し、仕様、「なぜこうしたか」、「関連するコード」の順に書く。
- 設計を変えたら、同じ変更の中で該当する L2 を直す。L1 は、柱や部品が変わるときだけ直す。
- 経緯の記録（いつ誰と決めたか）は書かない。仕様として読める文にする。
