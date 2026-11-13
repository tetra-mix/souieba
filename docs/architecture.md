# Souieba 現行アーキテクチャ

この文書を、古い設計案ではなく現在の実装を説明する唯一の概要とする。

## 1. 2つの共有方式

- **v1**: サーバのアカウントとログインコードを使う。アカウントには複数のAgentを登録でき、それぞれが投稿・復号用の鍵を持つ。
- **v2 Relay**: アカウントを使わず、Person鍵から作る `sb_...` のPerson IDで人と人を接続する。共有設定・連絡先・グループ・プロジェクト・メモはPerson単位で保存する。

v2の外部インターフェースにAgent選択はない。Relay通信に必要なDevice鍵はPersonの内部実装で、CLIが有効な1台を自動選択する。同じPCで別のPersonを動かす場合は `SOUIEBA_HOME` を分ける。

## 2. v2の保存場所

`SOUIEBA_HOME`（既定は `~/.souieba`）に次を置く。

- `config.json`: v1のアカウント情報と、v2のPerson鍵・Relay URL・内部Device鍵・クライアント設定
- `person/relay-state.json`: v2の連絡先、ローカルグループ、プロジェクト、共有方針、委任、変更記録
- `person/notes.jsonl`: まだ投稿していないメモ
- `person/inbox.jsonl`: 受け取った近況
- `person/devices/<deviceId>/`: 内部DeviceのRelayセッションと会話セッション

Personの秘密鍵を含むため、設定ファイルとPersonディレクトリは所有者だけが読める権限で扱う。
Tellのセッション間隔・再通知間隔・更新確認は `souieba config` で変更できる。対応する環境変数は設定ファイルを一時的に上書きする。

## 3. v2の通信

1. `souieba init <Relay URL>` がPerson鍵と最初の内部Device鍵を作り、Relayへ登録する。
2. `relay connect` と `relay accept` でPerson同士を接続する。
3. `relay allow` またはグループ単位の許可で、プロジェクトごとの共有先を決める。既定は共有しない。
4. 投稿はクライアント側で署名・暗号化し、Relayは配送と期限管理を行う。
5. 受信側は、Personに紐付いた送信元Deviceを検証して復号する。

共有範囲を広げる操作は、CLIの `--yes` またはMCPの `confirm: true` が必要。主人がTUIで委任した範囲内の操作だけは、個別確認なしで実行できる。

## 4. 近況の流れ

会話中のメモはローカルに保存し、時間帯ごとに `compose` でまとめる。共有先が決まった投稿だけを `publish` し、受信側の `tell` が会話に添える。投稿の公開猶予はサーバ設定、Tellのセッション間隔・再通知間隔はクライアント設定で決まり、デモでは `souieba config set ... 0` で待ち時間をなくせる。

## 5. デプロイ

- セルフホスト: `apps/server` のNode/HonoサーバをDocker Composeで動かし、CaddyなどでHTTPSを終端する。
- Cloudflare Workers: `apps/server/wrangler.toml` のWorkerとDurable Object SQLiteを使う。`pnpm --filter @souieba/server cf-typegen` でWorker型を更新し、`pnpm --filter @souieba/server deploy` でデプロイする。
- 公開するRelayはHTTPS必須。管理操作は管理者CLIと管理者トークンで行い、一般クライアントへ管理APIを渡さない。

## 6. 変更時の確認

```bash
pnpm typecheck
pnpm test
pnpm --filter @souieba/site build
```

v2の動作確認は `scripts/v2-try.sh check --yes` を使う。人物ごとに `SOUIEBA_HOME` を分け、内部Device名や `SOUIEBA_AGENT` を使って切り替えない。
