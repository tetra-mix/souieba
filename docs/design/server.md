# Relay サーバの構成と運用

Relay サーバ（`apps/server`）の構成、DB とマイグレーション、入口の防御、バージョンの扱い、デプロイとリリースを決める。Relay が何を運びどう検証するかは [relay-protocol.md](relay-protocol.md)。

## 1. 構成

サーバは Hono のアプリ（`app.ts`）1つで、2つの実行環境で同じコードを動かす。

| | セルフホスト | Cloudflare Workers |
|---|---|---|
| 入口 | `main.ts`（`@hono/node-server`） | `worker.ts`（Worker）。検査とレート制限をして Durable Object に渡す |
| DB | `node:sqlite`（`NodeSqlStorage` が Durable Object の `ctx.storage` と同じ形に包む） | Durable Object の SQLite（`ctx.storage`） |
| HTTPS | Caddy が終端する | Cloudflare が終端する |
| 送信元 IP | 直前の接続元。`SOUIEBA_TRUST_PROXY` で信頼する場合だけ `X-Forwarded-For` の末尾の値 | `CF-Connecting-IP`（`X-Forwarded-For` は使わない） |
| 定期削除 | 起動時と24時間ごと | cron（毎日 03:17 UTC） |

Workers では、インスタンスは Durable Object 1個（名前は `default`）で、アプリはその中で動く。将来インスタンスを分けるときは Worker で名前を引き分ける。

DB は Drizzle（`drizzle-orm/durable-sqlite`）で扱う。どちらの環境も同じドライバを使うため、`node:sqlite` を Durable Object の storage と同じ形に見せている。どちらも同期 API なので、読んでから書く処理を `db.transaction` の中でそのまま書ける。`node:sqlite` の側は `BEGIN IMMEDIATE` で書き込みを直列化し、入れ子はセーブポイントにする。

サーバが公開するのは `GET /healthz` と `/v2/*`（[relay-protocol.md](relay-protocol.md) の API）だけ。管理用の API やトークンはない。サーバ上の管理操作は、DB を直接開く `souieba-admin backup` だけ。

応答は `{ "error": { "code", "message" } }` の形で、すべて `X-Content-Type-Options: nosniff` と `Cache-Control: no-store` を付ける。アクセスログ（JSON の1行）には、メソッド・経路・状態コード・所要時間・送信元 IP を記録し、本文とトークンは記録しない。

## 2. 設定（環境変数）

起動時に検証し、不正なら起動しない。

| 変数 | 既定 | 内容 |
|---|---|---|
| `SOUIEBA_PUBLIC_URL` | （必須） | 公開 URL。`https` でなければ起動しない（開発用の `localhost`・ループバックの `http` だけ許す）。認証の署名に入れる Relay の origin になる |
| `SOUIEBA_BIND` / `PORT` | `127.0.0.1` / `8080` | 待ち受け |
| `SOUIEBA_TRUST_PROXY` | `loopback` | `X-Forwarded-For` を信頼する直前の接続元。`loopback`・`private`（Docker のブリッジ上のプロキシ用）・`none` |
| `SOUIEBA_DATA_DIR` | `/data` | DB（`souieba.db`）とバックアップ（`backups/`）の置き場 |
| `SOUIEBA_POST_GRACE_MINUTES` | `10` | 投稿が受信側に見えるまでの猶予（分）。Workers の `wrangler.toml` は `0` |
| `SOUIEBA_LOG_LEVEL` | `info` | `error` 以外ではアクセスログを出す |
| `SOUIEBA_RELAY` | `open` | `off` なら `/v2/*` は 404（`relay_disabled`）を返す |
| `SOUIEBA_MAX_RELAY_AGENTS` | `1000` | 登録できる Person の数の上限 |

`X-Forwarded-For` は、信頼するプロキシが付け足した**末尾の値**だけを使う。先頭の値はクライアントが偽れるので使わない。Workers では `SOUIEBA_TRUST_PROXY` を `none` に固定する。

## 3. DB とマイグレーション

- テーブル定義は `src/db/schema.ts`（Drizzle）。Relay の表は、`relay_persons`・`relay_devices`・`relay_device_challenges`・`relay_device_sessions`・`relay_person_connections`・`relay_person_blocks`・`relay_person_messages`・`relay_device_deliveries`
- Relay は、メッセージの平文・メモ・グループ・共有先・Policy を持たない
- マイグレーションは `pnpm --filter @souieba/server db:generate --name <名前>` で作る。`drizzle-kit` が `drizzle/` に SQL を作り、`scripts/bundle-migrations.mjs` がそれを `src/db/migrations.gen.ts` に埋め込む（`.sql` を直接読み込むと Node と Workers でそれぞれ設定が要るため）
- 適用は起動時に行う。セルフホストはサーバが待ち受ける前、Workers は Durable Object のコンストラクタの `blockConcurrencyWhile` の中（終わるまでリクエストを受け付けない）。適用済みかは `__drizzle_migrations` の `created_at`（journal の `when`）で判断し、トランザクションの中で確かめ直す（サーバと `souieba-admin` が同時に移行することがあるため）
- 旧 v1 の表は 0005 で、初期の Relay（Agent ID 版）の表と `instance_meta` は 0006 で落とした。0000〜0004 は、それらの表がある古い DB を移行するために残している
- 0.2 系の手書きのマイグレーションで作った DB（`PRAGMA user_version = 2`）は、ベースライン（0000）と同じ形として引き継ぐ。`user_version` が2以外の旧 DB は断る
- 生成物（`drizzle/`・`migrations.gen.ts`・`worker-configuration.d.ts`）が `schema.ts`・`wrangler.toml` に対して最新かは、`scripts/check-generated.sh` が確かめる（CI とデプロイの前に走る）

### バックアップ

- セルフホスト: 未適用のマイグレーションがあり、DB が空でなければ、適用の前に `backups/pre-<バージョン>-<時刻>.db` を SQLite のオンラインバックアップで必ず取る。手動は `souieba-admin backup [path]`（既定は `backups/manual-<時刻>.db`）。サーバより先に新しい版の `souieba-admin` を実行した場合も、同じくバックアップしてから移行する
- Workers: Durable Object の SQLite の PITR（Cloudflare の機能）を使う。表を落とすような破壊的なマイグレーションは、PITR で戻せることを確かめてから main に入れる

### 定期削除

`runRetention` が、配送期限を過ぎたメッセージ・期限切れのチャレンジとセッション・14日を過ぎた承認待ちの要求を物理削除する。

## 4. 入口の防御

### 本文の大きさ

`/v2/*` の本文は16KiBまで。ただし `POST /v2/messages` は宛先の端末の数だけ大きくなるので256KiBまで（Caddy の `request_body` も同じ256KiB）。`Content-Length` がない（chunked の）要求も、読みながら数えて上限を超えたところで打ち切る。断るときは、残りの本文を（1MiBまで）読み捨ててから 413 を返す。読みかけで応答すると、Workers では入口の Worker が本文を送り続けてエラーになるため。

### Workers の入口（`edge.ts`）

Durable Object へのリクエストは課金と無料枠に数えられるので、明らかに通らない要求は入口で返す。

1. `CF-Connecting-IP` がなければ 400（Cloudflare を通った要求には必ず付くので、全員が同じ制限のキーを共有しないようにする）
2. `/healthz` と `/v2/` 以外の経路は 404
3. `Content-Length` が256KiBを超えれば 413
4. 認証なしで呼べる経路（`/healthz`、端末の登録・取り消し、認証のチャレンジ・セッション）以外で、`Authorization: Bearer sou_r_…` の形のトークンがなければ 401
5. 送信元 IP ごとのレート制限（`RATE_LIMITER`: 1分120回）。認証なしの POST は、さらに別の制限（`AUTH_RATE_LIMITER`: 1分10回）。IPv6 は /64 でまとめて数える

トークンの検証と詳細なレート制限は、これまでどおり Durable Object の中（`app.ts`・`relay-routes.ts`）で行う。`[[ratelimits]]` が `wrangler.toml` になければ、警告を出して入口の制限を使わない。

### アプリのレート制限（`relay-routes.ts`）

メモリ上の固定ウィンドウ方式（1インスタンス・少人数の前提）。覚えるキーは1万個までで、超えたら古いものから忘れる。Durable Object が入れ替わると数え直しになるため、認証なしの POST は入口でも数える。

| 対象 | キー | 上限 |
|---|---|---|
| 認証のチャレンジ・セッション | IP | 10分に30回 |
| 端末の登録・取り消し | IP | 1時間に10回。登録はさらに1日に20回 |
| 認証済みのすべての API | Person | 1分に60回 |
| メッセージの送信 | Person | 1時間に30回 |
| 接続の要求 | Person | 1時間に30回 |

そのほか、Relay の中の上限（接続要求・ブロック・未受信の配送・登録できる Person の数）は [relay-protocol.md](relay-protocol.md) と `SOUIEBA_MAX_RELAY_AGENTS` を見る。

## 5. クライアントのバージョン

- クライアントは、すべての `/v2/*` の要求に `x-souieba-client` ヘッダでバージョンを付ける
- サーバは `MIN_CLIENT_VERSION`（`app.ts`）より古いクライアントと、バージョンを送らないクライアントを 426（`client_outdated`）で断る。黙って壊れないように、更新を促す
- `MIN_CLIENT_VERSION` は、API に互換性のない変更をしたときに**手で**上げる。リリースの手順では自動で上がらない
- 公開しているバージョンは CLI（`apps/cli/package.json`）・サーバ（`app.ts` の `VERSION`）・スキル（`skills/souieba/SKILL.md`）で揃える。`node scripts/set-version.mjs <x.y.z>` で3か所を書き換え、`scripts/check-version.mjs` が揃っているかと `x.y.z` の形かを確かめる

## 6. デプロイ

### セルフホスト（Docker Compose）

`deploy/compose.yml` に、Caddy とサーバの2つのコンテナを置く。

- サーバのイメージは `apps/server/Dockerfile`（Node 24 の2段ビルド。`esbuild` で `main.mjs` と `admin-cli.mjs` の単一ファイルにまとめ、`node:sqlite` は Node 組み込みなのでネイティブの依存はない）。`node` ユーザーで動かし、`/data` をボリュームにする。`souieba-admin` はイメージに入れたコマンド
- サーバは `ports` を公開せず、同じ Docker ネットワークの Caddy からだけ届く。`SOUIEBA_BIND=0.0.0.0`、`SOUIEBA_TRUST_PROXY=private`
- Caddy（`deploy/Caddyfile`）は、Let's Encrypt の証明書を自動で取得・更新し、本文を256KiBまでに絞り、`Server` ヘッダを消して HSTS を付け、`server:8080` に中継する
- 設定は `deploy/.env`（`SOUIEBA_DOMAIN` が必須。`.env.example` が雛形）
- 公開するときは HTTPS が必須で、`SOUIEBA_PUBLIC_URL` が https でなければ起動しない

### Cloudflare Workers

`apps/server/wrangler.toml` が設定。Durable Object のバインディング `INSTANCE`（クラス `SouiebaInstance`、SQLite）、`[vars]`（公開 URL・猶予0分・Relay の設定）、cron（毎日の定期削除）、`[[ratelimits]]`（上記の2つ）を持つ。公開中のインスタンスは `*.workers.dev` で、このドメインでは WAF のレート制限ルールを使えないため、Worker 内のレート制限だけで守る。自分のドメインに移すときは、`workers_dev = false` にして `routes` を足す。

デプロイは `.github/workflows/server.yml` が行う。

- main に入った `apps/server/**`・`packages/core/**`・`pnpm-lock.yaml` の変更で動く（手動実行もできるが、main 以外はデプロイしない）。同時に2つはデプロイせず、実行中のデプロイは途中で止めない
- 先に型チェック・サーバと core のテスト・生成物の確認（`check-generated.sh`）を通し、通ったら `wrangler deploy` する。そのあと `/healthz` で応答を確かめる（マイグレーションに失敗していると、ここで 5xx になる）
- 秘密情報（`CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`）は Environment `cloudflare-workers` の secret に置き、その Environment のデプロイ元ブランチは main だけにする
- マイグレーションは、デプロイのあと最初のリクエストで Durable Object が適用する

## 7. リリース（CLI の配布）

CLI は npm の `souieba` として配る。`.github/workflows/release.yml`（Actions の画面から main で手動実行）が行う。

1. `build` ジョブ（書き込み・OIDC の権限なし）: バージョンが `x.y.z` で揃っているか確かめ、npm と GitHub Release に公開済みかを調べ、型チェック・テスト・CLI のビルドをして、ビルド済みの `dist` を成果物として渡す
2. `publish` ジョブ（Environment `npm`）: 依存を入れずに、ビルド済みの `dist` だけで公開する。npm への publish は Trusted Publishing（OIDC）で行い、長期のトークンは使わない（provenance は自動で付く）。そのあと、タグ（`v<バージョン>`）と GitHub Release を作る
3. 公開済みの手順は飛ばすので、途中で失敗したら同じ main でもう一度実行すればよい。ただし、公開済みで Release がなく、公開したコミットが今の main と違うときは、違うコミットにタグを付けないよう止める

サーバのデプロイと `MIN_CLIENT_VERSION` の引き上げは、このワークフローでは行わない（サーバのデプロイは上の `server.yml`）。CI（`.github/workflows/ci.yml`）は、バージョンの揃い・型チェック・生成物・テスト・CLI とサイトのビルドを確かめる。

## なぜこうしたか

- **2つの実行環境で同じアプリ**: セルフホストも Workers も同じコードで動かすため、`node:sqlite` を Durable Object の storage と同じ形に包み、同じ Drizzle のドライバを使う。同期 API なので、トランザクションの書き方も同じになる
- **Workers は1つの Durable Object**: 少人数の利用を前提に、全体を1つの SQLite で持つ。入口の Worker は、Durable Object に届く前に弾ける要求を弾き、課金を抑える
- **レート制限を入口とアプリの両方に置く**: アプリ内の制限はメモリ上にあって、Durable Object が入れ替わると数え直しになるため、総当たりの対象になる認証なしの POST は入口でも数える
- **管理用 API を作らない**: 管理操作は DB を直接開く `souieba-admin backup` だけにして、攻撃面を増やさない
- **`MIN_CLIENT_VERSION` を手で上げる**: 互換性を壊すかどうかは人が判断する。古いクライアントには更新を促して断る
- **Trusted Publishing**: npm の長期トークンを持たないため。依存を入れる `build` ジョブには書き込みと OIDC の権限を渡さず、`publish` ジョブは依存を入れずにビルド済みの成果物だけを使う
- **v1 を移行なしで削除**: 旧 v1（アカウント・グループ・投稿）は、CLI・SDK・サーバのコードと DB の表を削除した。v1 のアカウントやグループを v2 に移す手段は提供しない

## 関連するコード

- `apps/server/src/app.ts` — アプリ本体、IP の判定、アクセスログ、本文の上限、バージョンの確認（`VERSION`・`MIN_CLIENT_VERSION`）
- `apps/server/src/main.ts`、`config.ts` — セルフホストの入口と設定の検証
- `apps/server/src/worker.ts`、`edge.ts` — Workers の入口と Durable Object
- `apps/server/src/relay-routes.ts`、`ratelimit.ts`、`net.ts`、`body-limit.ts` — ルート・レート制限・IP と本文の上限
- `apps/server/src/db/` — スキーマ（`schema.ts`）・マイグレーションの適用（`index.ts`）・`node:sqlite` のアダプタ（`node.ts`）・生成物（`migrations.gen.ts`）
- `apps/server/src/retention.ts`、`admin-cli.ts` — 定期削除とバックアップ
- `apps/server/drizzle/`、`apps/server/scripts/bundle-migrations.mjs` — マイグレーションの SQL と埋め込み
- `apps/server/wrangler.toml`、`apps/server/Dockerfile`、`deploy/` — Workers とセルフホストの設定
- `.github/workflows/`（`server.yml`・`release.yml`・`ci.yml`）、`scripts/`（`set-version.mjs`・`check-version.mjs`・`check-generated.sh`）
