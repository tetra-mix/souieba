# 設計: Cloudflare Workers 対応

> **状態:** §11 の手順 1〜4 を実装済み（ブランチ `feat/workers`）。設計から変えた点は §13 にまとめた。Cloudflare への実際のデプロイは未確認（workerd でのテストまで）。

E2EE を入れたことで、サーバに置かれるのは暗号文とメタデータだけになった（[公開の設計 §9](public-deployment-plan.md)）。
VPN の内側に閉じる必要がなくなったのと同じ理由で、サーバを自宅・VPS・Cloudflare のどこに置いても守れるものは変わらない。

そこで、**セルフホスト（自宅・VPS）を今のまま残しつつ、Cloudflare Workers でも動かせる**ようにする。
どちらの環境でも、**1つのインスタンスに複数の集まり（グループ）を載せる**使い方を基本にする。

## 1. 決めたこと

| 項目 | 決定 |
|---|---|
| 対応する環境 | セルフホスト（Node.js + `node:sqlite`、今のまま）と Cloudflare Workers の両方。片方のためにもう片方を崩さない |
| インスタンスと集まり | **1つのデプロイ = 1つのインスタンス**。集まりはインスタンスの中のグループで分ける。アカウントは全員で共通で、1人が複数のグループに入れる（§3） |
| Workers での DB | **Durable Object（SQLite）を1個**。D1 は使わない（§4） |
| アプリ本体 | `app.ts` とサービス層は共通。DB だけを小さなインターフェース越しに使う（§5） |
| 管理操作 | アプリ内の admin API を本体にし、`souieba-admin` から HTTP で呼べるようにする。Cloudflare では Cloudflare Access を外側にかぶせる（§7） |
| 乱用への対策 | Durable Object に届く前に Worker で弾き、Cloudflare のレート制限ルールも使う（§8） |
| 投稿の保存期間 | 既定を **30 日**にする（以前は 14 日）。セルフホストも同じ |
| 利用者用の CLI | `souieba`（Skill に同梱。今は npm で配る）は変えない。サーバの URL が変わるだけ。admin の機能は入れない（§7.4） |

## 2. 全体像

```
セルフホスト:
  souieba / Agent ─HTTPS─▶ Caddy ─▶ main.ts（@hono/node-server）─▶ app.ts ─▶ db/node.ts（node:sqlite）
  souieba-admin ───────────────────────────────────────────────────────────▶ DB ファイルを直接開く

Cloudflare:
  souieba / Agent ─HTTPS─▶ worker.ts ─▶ Durable Object（1個）─▶ app.ts ─▶ db/do.ts（ctx.storage.sql）
                           ↑ ここで検査とレート制限（§8）
  souieba-admin --url ─HTTPS─▶ [Cloudflare Access] ─▶ /v1/admin/* （同じ経路）
  Cron Trigger ─▶ worker.ts ─▶ Durable Object ─▶ retention

どちらも、インスタンスの中:
  ├ グループ「大学」
  ├ グループ「SecHack」    ← 中身は E2EE。ほかのグループからもサーバからも読めない
  └ グループ「家族」
```

## 3. 1つのインスタンスに複数の集まりを載せる

### 3.1 考え方

集まりの単位は、インスタンスではなく**グループ**にする。グループと E2EE はすでに実装済みなので、アプリの変更は要らない。

| | この設計（1インスタンス・複数グループ） | 採らなかった形: 1デプロイに複数インスタンス |
|---|---|---|
| アカウント | 全員で共通。1つのアカウントで複数の集まりに入れる | インスタンスごとに別。複数の集まりに入る人はアカウントが複数になる |
| クライアント | 今のまま（`serverUrl` は1つでよい） | 複数サーバへの対応が必要 |
| 集まりどうしの分離 | グループの可視性と E2EE で分ける | DB ごと分かれる |
| admin | インスタンス全体で1つ（運営者） | インスタンスごと |
| 追加で作るもの | なし | パスでの振り分け、インスタンスの一覧、運営者の API など |

集まりごとに完全に独立させたい人は、自分でもう1つデプロイすればよい（セルフホストでも Workers でも同じ手順）。

### 3.2 これによって引き受けること

- **admin はインスタンス全体で1つ**: 運営者（デプロイした人）が全員のアカウントの管理を担う。グループの中身には関与しない（[公開の設計 §3.3](public-deployment-plan.md)）
- **handle は全員で一意**: 別の集まりの人と handle がぶつかることがある
- **グループの作成**: 誰でも作れる（`SOUIEBA_GROUP_CREATE_BY=member`）か、admin だけ（`admin`）かを運営の方針で選ぶ。不特定の人を受け入れるなら、新規ユーザーは招待コードからしか作れない今の仕組みのままにする
- **上限**: 無料枠と含まれる量はインスタンス全体で共有なので、1つのグループが使い切らないように上限を置く
  - グループの人数の上限（書き込みの量は人数に比例するため。§9）
  - 1人が入れるグループの数の上限
  - ユーザー数の上限（インスタンス全体）

### 3.3 規模の目安

Durable Object 1個は1スレッドでリクエストを1つずつ処理するので、規模には上限がある。
1人あたり 1日 100〜200 件のリクエストで、1件の処理が数ミリ秒なら、数百人までは余裕がある見込み。
それを超えそうになったら分割を考える。将来分けられるよう、Durable Object は固定名（`idFromName("default")`）で作っておき、今は分割の仕組みを作らない。

## 4. D1 ではなく Durable Object にする理由

| | D1 | Durable Object の SQLite |
|---|---|---|
| API | 非同期 | **同期**（`ctx.storage.sql.exec`） |
| トランザクション | `batch()` だけ。読んでから書く処理は書けない | `transactionSync` が使える |
| 並行性 | 複数の Worker から同時にアクセスされる | 1つのインスタンスは1スレッドで、リクエストを1つずつ処理する |
| SQL を直接実行 | `wrangler d1 execute` で実行できる | できない（admin API を自分で用意する） |

サービス層は `node:sqlite` の同期 API と `tx()`（`BEGIN IMMEDIATE`）で、読んでから書く処理（招待の使用、配送の予約、グループへの参加など）を守っている。

- **Durable Object** なら、同期のロジックとトランザクションをほぼそのまま移せる。1つずつ処理されるので、招待コードの二重使用のような競合も構造的に起きない
- **D1** にすると、サービス層をすべて async にしたうえで、条件付き UPDATE と `batch()` に作り直す必要がある

D1 の利点（SQL を直接実行できること）は、admin API を用意すれば不要になる。

## 5. DB の抽象化

サービス層が使う操作だけを持つ、小さなインターフェースにする。

```ts
export interface Db {
  get<T>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T>(sql: string, ...params: SqlValue[]): T[];
  run(sql: string, ...params: SqlValue[]): { changes: number };
  exec(sql: string): void;
  tx<T>(fn: () => T): T;
}
```

| ファイル | 実装 |
|---|---|
| `apps/server/src/db/node.ts` | `node:sqlite`。`tx` は今の `BEGIN IMMEDIATE` |
| `apps/server/src/db/do.ts` | `ctx.storage.sql`。`tx` は `ctx.storage.transactionSync` |

インターフェースを同期にしておくのが要点。async にすると、セルフホスト側まで書き換えることになる。

## 6. 環境ごとの違い

| 項目 | セルフホスト | Workers |
|---|---|---|
| 入口 | `main.ts`（`@hono/node-server`） | `worker.ts`。検査とレート制限（§8）のあと Durable Object へ転送し、Durable Object の中で `app.fetch` を呼ぶ |
| スキーマのバージョン | `PRAGMA user_version` → **`instance_meta` に移す（両方とも）** | 同左。Durable Object では `PRAGMA user_version` が使えない可能性が高いため |
| マイグレーション | 起動時 | Durable Object のコンストラクタで `blockConcurrencyWhile` の中で実行する |
| マイグレーション前のバックアップ | `VACUUM INTO` | Durable Object の PITR（過去 30 日の任意の時点に戻せる）に任せる |
| retention | `setInterval` | Cron Trigger（または Durable Object の alarm） |
| 接続元の IP | `getConnInfo` + `X-Forwarded-For`（`TRUST_PROXY`） | `CF-Connecting-IP`。`createApp` の `deps.remoteAddr` で差し替える |
| レート制限 | メモリ上 | Worker の段階（§8）＋ Durable Object のメモリ上（今の `RateLimiter` がそのまま動く） |
| 設定 | `process.env` | Worker の env bindings を `loadConfig(env)` に渡す |
| https の終端 | Caddy | Cloudflare。`TRUST_PROXY` は使わない |
| `node:net`（`isIP` など） | そのまま | 自前の小さな関数に置き換える（両方とも） |
| `node:crypto` | そのまま | サーバが使うのは sha256・乱数・Ed25519 の検証だけ。`nodejs_compat` で動くか確かめ、動かなければ WebCrypto に寄せる |
| バックアップの取り出し | `souieba-admin backup` | admin API に export を足すか、PITR だけにするか（§12） |

## 7. 管理操作

### 7.1 方針

**A（アプリ内の admin API）を本体にし、Cloudflare では B（Cloudflare Access）を外側にかぶせる。**

| | A: アプリ内の admin API | B: Cloudflare Access |
|---|---|---|
| セルフホスト | 同じコードがそのまま動く | 使えない（Cloudflare 専用） |
| 守りの位置 | アプリの中 | Cloudflare の手前。認証を通らないリクエストはアプリに届かない |
| 弱点 | トークンが漏れると使われる。admin のルートのバグが外から突かれる | 設定を誤ると素通しになる |

B だけに頼らない。Access は自分のドメインにかける設定なので、`*.workers.dev` の URL から入ると素通りになりえる。
アプリ側の認証（A）は必ず残し、workers.dev のルートは無効にする。

### 7.2 admin API

- 有効・無効を切り替えられるようにする。セルフホストは `SOUIEBA_ADMIN_API=off|on`（**既定は off**。今は HTTP の admin API がないので、既定の挙動は変わらない）。Workers ではシェルがないので常に on
- 認証には、普段のユーザートークンとは別の **admin 専用トークン**（scope `admin`）を使う
  - 以前の admin API（VPN モードだけで使えた）は `role = admin` のユーザーのトークンで呼べたが、VPN の廃止とともに削除した。作り直すときは admin 専用トークンに限る
  - Agent のトークンには admin の scope を付けられないようにする
- `souieba-admin` の操作（create-user / login-code / invite / list-groups / disable-user / list-users）を API に揃える
- admin API の呼び出しはすべてログに残す

### 7.3 最初の admin の作成（ブートストラップ）

- `SOUIEBA_BOOTSTRAP_TOKEN` を secret で渡す（Workers は `wrangler secret put`、セルフホストは `.env`）
- **admin が1人もいないあいだだけ有効**。最初の admin を作ると自動で使えなくなる
- 応答で admin 専用トークンを返す。以降はこのトークンで操作する
- セルフホストで admin API を使わない場合は、今どおりサーバ上の `souieba-admin create-user` で作る

### 7.4 CLI

| CLI | 使う人 | 変更 |
|---|---|---|
| `souieba`（`apps/cli`） | 利用者と AI エージェント | なし。admin の機能は入れない |
| `souieba-admin` | 運営者（インスタンスの admin） | `--url <サーバURL>` を足し、admin API を HTTP で呼べるようにする。指定しなければ今どおり DB を直接開く |

`souieba` に admin の機能を入れない理由:

- `souieba` は AI エージェントが実行する（当時は Skill に同梱、今は npm で配る）。admin のコマンドがあると、エージェントが（プロンプトインジェクション経由も含めて）実行できてしまう
- `~/.souieba/config.json` はエージェントから読める。admin のトークンがそこに置かれてしまう

`souieba-admin --url` の admin トークンは、環境変数か毎回の入力で渡す。`~/.souieba` には保存しない。
Access をかけている場合は、service token を `CF-Access-Client-Id` / `CF-Access-Client-Secret` ヘッダで付ける（これも環境変数で渡す）。

### 7.5 セルフホストでの外側の壁

- admin API を使わないなら off のままにし、今どおりサーバ上の `souieba-admin` だけで管理する（推奨）
- 使うなら、Caddy で `/v1/admin/*` を特定の IP に絞る

## 8. 乱用への対策

Workers では、認証の前のリクエストも Durable Object に届けると、そのぶんリクエスト数と稼働時間を使う。無料枠と含まれる量はアカウント全体で共有なので、**Durable Object に届く前に Worker で弾く**。

**Worker の段階（Durable Object に渡す前）**

- パスの形式（`/v1/...`）を検査し、知らないパスはその場で 404 にする
- 認証が必要なエンドポイントで `Authorization` ヘッダがなければ、その場で 401 にする（トークンの検証自体は Durable Object で行う）
- リクエストの本文の大きさに上限を置く
- Workers の Rate Limiting バインディングで、IP 単位に数える

**Cloudflare のレート制限ルール（WAF）**

- 招待コードの使用とログインは、IP 単位で厳しく絞る
- `/v1/admin/*` は Access に加えて、回数も絞る

**Durable Object の中**

- 今の `RateLimiter`（認証の失敗、投稿、読み取り）はそのまま残す。Durable Object が退避されるとカウントは消えるが、Worker の段階と WAF で守っているので許容する

## 9. コストの見積もり

2026-10 時点の公式の料金で見積もる。

| | Workers Free | Workers Paid（月 $5〜） |
|---|---|---|
| Worker のリクエスト | 10 万/日 | 1,000 万/月まで込み |
| Durable Object のリクエスト | 10 万/日 | 100 万/月まで込み、以降 $0.15/100 万 |
| Durable Object の稼働時間 | 13,000 GB-s/日 | 40 万 GB-s/月まで込み |
| SQLite の書き込み行数 | 10 万行/日 | 5,000 万行/月まで込み、以降 $1/100 万行 |
| 保存容量 | 5GB | 5GB まで込み、以降 $0.20/GB・月 |

**前提**: 1人あたり Agent 2つ、1日 12 件くらい投稿、グループの人数は 10 人。

- **リクエスト**: 1人あたり 1日 100〜200 件。Free でも 500 人以上入る
- **稼働時間**: Durable Object が 24 時間起きていても 1日 約 10,800 GB-s で、Free の枠にも Paid の枠にも収まる
- **保存容量**: 投稿は 30 日で消え、暗号文で数 KB なので問題にならない。保存期間を 14 日から 30 日にしても、保存量が約2倍になるだけで、書き込み行数は変わらない（1件につき1回書いて1回消すのは同じ）
- **書き込み行数がボトルネック**: 投稿1件ごとに、宛先の Agent（`post_recipients`）と宛先のユーザー（`deliveries`）の行、それぞれのインデックス、既読化、retention での削除を書く。グループが 10 人なら 1 投稿あたり 100〜150 行、1人あたり 1日 約 1,500 行（月 約 4.5 万行）

| プラン | 収まる目安 |
|---|---|
| Free | 数十人（〜60 人くらい） |
| Paid の $5 | 〜1,000 人くらい（ただし §3.3 の処理の上限が先に来る可能性がある） |
| それ以上 | 100 人増えるごとに 月 約 $4.5 |

1人が複数のグループに入ると、投稿の宛先はその全グループのメンバーになるので、書き込みはそのぶん増える。グループの人数が増えたときも同じく比例して増える（30 人のグループなら約3倍）。
この見積もりは前提を置いた概算なので、実装時に 1 投稿あたりの書き込み行数をテストで実測する。多ければ、`deliveries` の行を受け取るときに作るなどで減らす。

## 10. 脅威モデル（[公開の設計 §9](public-deployment-plan.md) からの変更）

- **Cloudflare から見えるもの**: 誰がどのグループにいるか、投稿の時刻とサイズ、IP。自宅や VPS で Caddy を使って公開するのと同じ量で、見る主体が Cloudflare になる
- **運営者（admin）から見えるもの**: 上と同じメタデータを、すべてのグループについて見られる。本文は読めない。複数の集まりを1つのインスタンスに載せるので、**運営者は、自分が入っていない集まりのメタデータも見られる**。これを受け入れられない集まりは、自分でデプロイする
- **本文**: E2EE なので、TLS を Cloudflare が終端しても、Durable Object のストレージや PITR のバックアップを見ても読めない。ただし鍵はサーバが配る（[公開の設計 §5](public-deployment-plan.md)。2026-10-09 にサーバを信頼する方式に変えた）ので、**運営者が能動的に偽の鍵を配れば読める**。複数の集まりを載せるインスタンスでは、どの集まりも運営者を信頼することになる。これを受け入れられない集まりは、自分でデプロイする
- **集まりどうしの分離**: グループの可視性（共通のグループがない相手には届かない）と E2EE で分ける。サーバのバグで別のグループの封筒が届いても、宛先の鍵がないので読めない
- **管理の経路が外に開く**: admin 専用トークン、ブートストラップの制限、Access、レート制限で守る
- **ログ**: Workers のログには IP・handle・グループ ID などが載る。本文を E2EE にしても、ログから人間関係が読めてしまうので、出す項目を絞る

## 11. 進め方

PR #1（公開・グループ・E2EE）をマージしてから、別の PR で進める。

1. **DB の抽象化（セルフホストの動作は変えない）**: `Db` インターフェースを作り、サービス層を乗せ替える。スキーマのバージョンを `instance_meta` に移す（マイグレーション3）。`node:net` を置き換える。今のテストがそのまま安全網になる
2. **admin API の整備**: admin 専用トークン、`SOUIEBA_ADMIN_API`、ブートストラップ、`souieba-admin --url`。セルフホストでも使える
3. **上限**: グループの人数、1人が入れるグループの数、ユーザー数の上限（セルフホストでも使える）
4. **Workers の入口**: `worker.ts`、Durable Object のクラス、`db/do.ts`、`wrangler.toml`、Cron Trigger、Worker の段階の検査とレート制限。`@cloudflare/vitest-pool-workers` で主な流れをテストする。ここで書き込み行数を実測する
5. **ドキュメント**: README と `deploy/` に Workers でのデプロイ手順（Access、workers.dev の無効化、WAF のルールを含む）を書く

## 12. 未決事項・確認すること

- **上限の値**: グループの人数・1人が入れるグループの数・ユーザー数を、それぞれいくつにするか
- **Durable Object の制約の確認**: `PRAGMA` のどれが使えるか、外部キーの制約が有効か、`transactionSync` の中で例外を投げたときの挙動
- **`node:crypto` の互換性**: workerd の `nodejs_compat` で Ed25519 の `verify`（KeyObject を使う形）が動くか
- **Workers の Rate Limiting バインディング**: 今の提供状況と、数え方の粒度
- **バックアップ**: Workers では PITR だけにするか、admin API に DB のエクスポートを足すか（中身は暗号文とメタデータ）
- **Durable Object の場所**: 最初のリクエストの近くに置かれる。日本から使うなら、location hint を指定するか
- **別のデプロイにも入る人**: 自分でデプロイした集まりと、共有のインスタンスの両方に入る人は、今のクライアントでは扱えない（`serverUrl` が1つ）。需要が出てから考える

## 13. 実装メモ（設計からの差分）

- **DB は Drizzle にした（§5 の自前の `Db` インターフェースはやめた）**。SQL をアプリに直書きしないため
  - Drizzle の Durable Object 用ドライバ（`drizzle-orm/durable-sqlite`）を、セルフホストでも使う。node:sqlite を `ctx.storage` と同じ形（`sql.exec` と `transactionSync`）に見せるアダプタ（`apps/server/src/db/node.ts`）を挟む。better-sqlite3 用のドライバはネイティブモジュールを要求するため使わない
  - 同期 API のままなので、読んでから書く処理は `db.transaction` の中でそのまま書ける。Durable Object のドライバの `run()` は変更行数を返さないので、変更の有無は `.returning()` で確かめる
  - テーブル定義は `src/db/schema.ts`。マイグレーションは drizzle-kit で生成し（`drizzle/`）、Node と Workers の両方で読めるよう `src/db/migrations.gen.ts` に埋め込む（`pnpm --filter @souieba/server db:generate`）。適用の記録は drizzle-kit と同じ `__drizzle_migrations`
  - 0.2 系の手書きのマイグレーションで作った DB（`PRAGMA user_version = 2`）は、ベースラインを適用済みとして引き継ぐ。スキーマが同じ形であることを `test/db.test.ts` で確かめている（違いは、一意制約のインデックスが無名なことと、主キーの列に NOT NULL がないことだけ）。v1（Friend の時代）の DB は、先に 0.2 系で移行するよう求めて起動を止める
  - SQL が残っているのは DB 層だけ（マイグレーションの記録と、node:sqlite のトランザクション制御）
  - node:sqlite の `setReturnArrays`・`backup()` を使うので、サーバは Node.js 24 以上にした。`VACUUM INTO` は `backup()` に置き換えた
- **admin API**（§7）
  - admin 専用トークンは `sou_m_` で始まり、credentials の `kind = 'user'`・`scopes = 'admin'` の行に入れる（CHECK 制約を変えないため）。admin API にだけ使え、普段の API には使えない（逆も同じ）。持ち主が admin でなくなると使えなくなる。ログインコードでの再ログイン（User トークンの失効）では失効しない
  - エンドポイント: `POST /v1/admin/bootstrap`（認証なし。`SOUIEBA_BOOTSTRAP_TOKEN` と照合し、admin がいないときだけ）、`GET|POST /v1/admin/users`、`POST /v1/admin/users/:handle/{login-code,disable,admin-token}`、`POST /v1/admin/invites`、`GET /v1/admin/groups`。呼び出しは `msg: "admin"` でログに残す
  - `souieba-admin --url`（または `SOUIEBA_ADMIN_URL`）で HTTP から使う。トークンは `SOUIEBA_ADMIN_TOKEN`・`SOUIEBA_BOOTSTRAP_TOKEN`、Access の service token は `CF_ACCESS_CLIENT_ID`・`CF_ACCESS_CLIENT_SECRET` で渡す。`admin-token` コマンドは、サーバ上（DB を直接開く）でも使える
- **上限**（§3.2）: `SOUIEBA_MAX_USERS`（既定 500）・`SOUIEBA_MAX_GROUP_MEMBERS`（50）・`SOUIEBA_MAX_GROUPS_PER_USER`（20）。超えると 409（`limit_users`・`limit_group_members`・`limit_groups_per_user`）
- **Worker の入口**（§8）: `src/edge.ts`。API 以外のパスは 404、認証の要るエンドポイントで `Authorization` の形が正しくなければ 401、本文が 64KB を超えれば 413。Rate Limiting バインディングで IP ごとに 1分 120 回。WAF のルールと Access は Cloudflare 側で設定する（README）
- **Workers の設定**: `apps/server/wrangler.toml`。当初は `workers_dev = false`（Access のかからない URL を作らない）にしていたが、2026-10-09 の最初のデプロイでは、自分のドメインを用意せず `*.workers.dev` で公開した（Access と WAF のルールなし。admin API は admin 専用トークンと Worker 内のレート制限で守る）、Cron で毎日 03:17 UTC に retention。Durable Object は `idFromName("default")` の1個
- **型検査**: Workers の入口（`src/worker.ts`）だけを `wrangler types` で作った型（`worker-configuration.d.ts`）で検査する（`apps/server/tsconfig.worker.json`）。他は今どおり Node の型
- **workerd での確認**: Ed25519 の署名・検証と sha256 は `nodejs_compat` で動く。X25519 の鍵交換は動かないが、暗号化と復号はクライアントだけで行うので影響しない。`test/worker.test.ts` で、wrangler の `unstable_dev` を使い、ブートストラップから E2EE の投稿・Tell・アカウント削除までを HTTP 越しに通している
- **未対応**: Cloudflare への実際のデプロイ、Access と WAF の設定手順の検証、Durable Object の location hint、Workers からの DB のエクスポート（§12）

