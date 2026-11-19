# コードの構成

リポジトリのどこに何があるか、パッケージの依存の向き、テストとビルドの置き場所を決める。仕組みの説明は [../architecture.md](../architecture.md) と、この `design/` の各文書にある。

## 1. 全体

pnpm のワークスペース（`packages/*` と `apps/*`）。言語は TypeScript（strict）。実行時は Node.js（サーバは 24 以上、配布する CLI は 22 以上）。

```
packages/core     型・鍵と署名・HPKE・メッセージ形式・本文の検査（秘密情報・正規化）・Tell 文・Session の判定
packages/sdk      クライアントの土台（通信層・ローカルの状態・メモ・プロジェクト・設定）
apps/server       Relay（Hono + Drizzle）と、バックアップ用の管理 CLI
apps/cli          CLI（npm の `souieba`）と、エージェントごとのフック・プラグイン・MCP
apps/site         紹介サイト（Astro Starlight）。この文書の対象外
skills/souieba    Agent Skill（薄い SKILL.md）
deploy/           セルフホスト用の compose と Caddyfile
scripts/          バージョン管理・生成物の確認・手元で試す v2-try.sh
.github/          CI・リリース・サーバのデプロイ・サイトのワークフロー
```

## 2. 依存の向き

```
core ← sdk ← cli
core ← server
```

- `core` はワークスペースの他のパッケージに依存しない（外部は `zod` と `node:crypto` だけ。鍵・署名・HPKE は `node:crypto` で実装している）
- `sdk` は `core` だけに依存する
- `server` は `core` だけに依存する。`sdk`・`cli` を import しない
- `cli` は `core` と `sdk` に依存する。`server` を import しない
- `server` を import するのはテストだけ。CLI と SDK のテストは、本物のサーバのアプリをプロセス内で起動して通す（`apps/cli/test/relay-flow.test.ts`、`packages/sdk/test/relay.test.ts`）。そのため `apps/cli`・`packages/sdk` の `devDependencies` に `@souieba/server` がある

`core` はサーバとクライアントで共有する決まり（メッセージ形式・署名の検証・本文の長さの上限など）を置く場所で、サーバとクライアントが同じ判定を使うためにある。詳しい仕様は [relay-protocol.md](relay-protocol.md)。

## 3. `packages/core/src`

| ファイル | 内容 |
|---|---|
| `relay.ts` | Person・端末の鍵、署名、メッセージ（Narrative Message）の形式と暗号化・検証 |
| `hpke.ts`・`crypto.ts`・`base64.ts` | HPKE の Seal / Open、署名と鍵の扱い、base64url（`base64.ts` は core の内部用で、`index.ts` から出さない） |
| `sanitize.ts`・`scanner.ts`・`tell-text.ts` | 本文の正規化と命令に見える表現の検出、秘密情報の検査、Tell 文の組み立てと検証 |
| `session.ts`・`period.ts` | 会話の Session と Tell の間隔、投稿の時間帯と保持期間 |
| `types.ts`・`version.ts` | 共通の型、クライアントのバージョンのヘッダとバージョンの比較 |
| `index.ts` | 公開する名前をまとめて出す |

## 4. `packages/sdk/src`

| ファイル | 内容 |
|---|---|
| `relay-http.ts` | Relay の API を呼ぶ通信層（端末の署名鍵でチャレンジに署名して得る短命のセッション） |
| `relay-transport.ts` | `transport.ts` の実装。送受信を E2EE にして Relay 経由で行う |
| `relay-state.ts` | この PC が持つ共有の状態（連絡先・グループ・プロジェクト・共有先・Policy・任せた範囲・変更記録）と、共有先の判定 |
| `project.ts` | 作業ディレクトリとメモからのプロジェクトの決め方、会話ごとの記録（`SessionStore`） |
| `notes.ts` | まだ投稿していないメモの保存と、ファイルロック（`withFileLock`） |
| `souieba.ts`・`transport.ts` | Note → Publish → Tell の流れと、通信層の型 |
| `post-content.ts` | 投稿本文を送る前に断る検査（秘密情報・命令に見える表現・長さ） |
| `config.ts` | `SOUIEBA_HOME` の `config.json`、状態ファイルの読み書き（`readStateJson`・`writeSecretJson`）、クライアントの設定 |

ローカルの状態ファイルの置き場所と内容は [local-state.md](local-state.md)。

## 5. `apps/cli/src`

`main.ts` は、引数を読んで `commands/` のコマンドに振り分けるだけ。コマンドの一覧と使い方の文字列は `commands/catalog.ts` だけに書き、ヘルプ（`commands/usage.ts`）とエラー文は、そこから作る。

| 場所 | 内容 |
|---|---|
| `commands/` | コマンドごとの実装。`agent.ts`（`tell`・`note`・`compose`・`publish`・`told`・`release`・`hook`・`mcp`）、`person.ts`（主人が使う `init`・`doctor`・共有の設定）、`config.ts`、`skill.ts`。ほかに、コマンドの表（`index.ts`）、コマンドの一覧（`catalog.ts`）、ヘルプ（`usage.ts`）、オプションの解釈（`context.ts`） |
| `agent/` | エージェント用コマンドの本体。`context.ts`（Person の実行環境・出力・書き直しを求める結果）、`note.ts`、`compose.ts`、`publish.ts`、`tell.ts` |
| `relay.ts` | 共有の設定のコマンド（`connect`・`allow`・`project` など）。広げる操作の2段階の確認はここ |
| `relay-ops/` | 共有の設定を変える操作。CLI・TUI・MCP で共通に使う。`contacts.ts`・`access.ts`・`projects.ts`・`delegation.ts`（共通の道具は `env.ts`・`helpers.ts`） |
| `relay-tui.ts` | `souieba ui`。主人が自分で見て操作する画面 |
| `integrations/` | エージェントごとの組み込み（[agents.md](agents.md)）。`agents/`（エージェントごとに1ファイル）、`hook/`（フックの共通部分）、`mcp/`（MCP サーバと共有設定のツール）、`shared/`（手引きの文面・tell の実行） |
| `person.ts` | `souieba init`（Person と内部の端末の作成と Relay への登録） |
| `skill.ts` | `souieba skill get` が出す手順の取り出し、スキルと CLI の版のずれの確認 |
| `update-check.ts` | 新しい版の確認 |
| `tty.ts`・`version.ts` | 端末かどうかの判定、CLI の版（`package.json` の版をビルドで埋め込む） |

ほかに、CLI のパッケージが持つのは次のもの。

- `skill/`: `souieba skill get` が出す手順の Markdown。パッケージに同梱する
- `openclaw.plugin.json`・`agent-sdk.d.ts`: OpenClaw のプラグインのマニフェストと、Agent SDK 組み込みの型
- ビルド: esbuild が `dist/souieba.mjs`（本体。MCP などは分割して遅延読み込み）・`dist/openclaw.mjs`・`dist/agent-sdk.mjs` を作る（`pnpm build:cli`）。依存は束ねるので、利用者は `npm i -g souieba` だけで動く

## 6. `apps/server/src`

セルフホストの Node サーバと Cloudflare Workers が、同じアプリ（`app.ts`）を動かす。

| 場所 | 内容 |
|---|---|
| `app.ts` | Hono のアプリ。古いクライアントの拒否（`MIN_CLIENT_VERSION`）、本文の大きさの上限、`/v2` の入口 |
| `relay-routes.ts`・`services/relay.ts` | Relay の API と、公開鍵の一覧・認証・接続の管理・暗号文の配送と期限管理 |
| `retention.ts` | 期限を過ぎたものの削除 |
| `db/` | Drizzle のテーブル定義（`schema.ts`）、Workers 用の DB（`index.ts`）、Node の `node:sqlite` を同じ形に包むもの（`node.ts`）、生成されたマイグレーション（`migrations.gen.ts`）。SQL は `drizzle/` |
| `main.ts` | セルフホストの入口 |
| `worker.ts`・`edge.ts` | Workers の入口と、Durable Object に渡す前の検査 |
| `ratelimit.ts`・`net.ts`・`body-limit.ts` | レート制限、送信元の IP の扱い、本文の大きさの上限 |
| `config.ts`・`errors.ts`・`crypto.ts` | 環境変数の読み取り、API のエラー、乱数 |
| `admin-cli.ts` | バックアップ用の管理 CLI（`souieba-admin`） |

仕様と運用は [server.md](server.md)。

## 7. テスト

テストは、各パッケージの `test/` にある。実行は `vitest`（ルートの `vitest.config.ts`）で、`packages/*/test/**/*.test.ts` と `apps/*/test/**/*.test.ts` を全部走らせる。テストから npm に新しい版を問い合わせないよう、`SOUIEBA_NO_UPDATE_CHECK=1` を設定している。

- `packages/core/test`: 暗号・形式・検査の単体テスト
- `packages/sdk/test`: 設定・メモ・プロジェクトの単体テストと、本物のサーバを立てた Relay の通しテスト
- `apps/server/test`: API・DB のマイグレーション・Workers の入口・設定。`harness.ts` がテスト用のアプリを作る
- `apps/cli/test`: CLI の通しテスト（`person-flow`・`relay-flow`）、フック・プラグイン・Agent SDK の出力（`integrations/`）、更新の確認、投稿間隔。`docs-commands.test.ts` は、ドキュメントに書いたコマンドが `commands/catalog.ts` にあるかを確かめる

## 8. 主なコマンド

```bash
pnpm install
pnpm typecheck                                       # tsc -b と、Workers の入口の型検査
pnpm test                                            # vitest
pnpm build:cli                                       # CLI のバンドル
pnpm build:server                                    # サーバのバンドル
pnpm --filter @souieba/site build                    # サイトのビルド
pnpm souieba <コマンド>                              # ソースから CLI を実行する
pnpm server                                          # ローカルでサーバを起動する
pnpm --filter @souieba/server db:generate --name <名前>   # schema.ts からマイグレーションを作る
pnpm --filter @souieba/server cf-typegen             # wrangler.toml から Workers の型を作る
./scripts/check-generated.sh                         # 生成物が最新かの確認
node scripts/check-version.mjs                       # CLI・サーバ・スキルの版が揃っているかの確認
node scripts/set-version.mjs <x.y.z>                 # 3か所の版をそろえて書き換える
scripts/v2-try.sh check                              # アリスとボブの2人分で、一通りの流れを確かめる
```

- DB の定義（`schema.ts`）か `wrangler.toml` を変えたら、`db:generate` と `cf-typegen` で生成物（`apps/server/drizzle/`・`migrations.gen.ts`・`worker-configuration.d.ts`）を作り直してコミットする。作り直し忘れは `check-generated.sh` が見つける
- `scripts/v2-try.sh` は、リポジトリのソースをビルドし、ローカルの Relay とアリス・ボブの2人分を `.v2-try/` に用意する。`~/.souieba` には触らない。`up`（起動）・`as <名前> -- <コマンド>`・`reset` も使える
- CI（`.github/workflows/ci.yml`）は、版の確認・型検査・生成物の確認・テスト・CLI とサイトのビルドを走らせる。リリースは Release ワークフローが npm への publish を行い、サーバは `main` への変更で Server ワークフローが Workers にデプロイする（[server.md](server.md)）

## 関連するコード

- `package.json`・`pnpm-workspace.yaml`・`tsconfig.base.json`・`tsconfig.json`: ワークスペースと型検査の設定
- `vitest.config.ts`: テストの設定
- `packages/core/src/index.ts`・`packages/sdk/src/index.ts`: 各パッケージが公開する名前
- `apps/cli/src/main.ts`・`apps/cli/src/commands/`: CLI の入口とコマンド
- `apps/cli/package.json`: CLI のビルドと配布の設定
- `scripts/`: バージョン・生成物・手元確認のスクリプト
