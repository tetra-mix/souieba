# 設計: Cloudflare Workers 対応

> **状態:** 方針のみ（未実装）。前提は [インターネット公開・グループ・E2EE](public-deployment-plan.md) の実装（ブランチ `feat/public-groups-e2ee`）。

E2EE を入れたことで、サーバに置かれるのは暗号文とメタデータだけになった（[公開の設計 §9](public-deployment-plan.md)）。
VPN の内側に閉じる必要がなくなったのと同じ理由で、サーバを自宅・VPS・Cloudflare のどこに置いても守れるものは変わらない。

そこで、**セルフホスト（自宅・VPS）を今のまま残しつつ、Cloudflare Workers でも動かせる**ようにする。

## 1. 決めたこと

| 項目 | 決定 |
|---|---|
| 対応する環境 | セルフホスト（Node.js + `node:sqlite`、今のまま）と Cloudflare Workers の両方。片方のためにもう片方を崩さない |
| Workers での DB | **Durable Object（SQLite）**。1インスタンス = Durable Object 1個。D1 は使わない（§3） |
| アプリ本体 | `app.ts` とサービス層は共通。DB だけを小さなインターフェース越しに使う（§4） |
| 管理操作 | アプリ内の admin API を本体にし、`souieba-admin` から HTTP で呼べるようにする。Cloudflare では Cloudflare Access を外側にかぶせる（§6） |
| 利用者用の CLI | `souieba`（Skill に同梱）は変えない。サーバの URL が変わるだけ。admin の機能は入れない（§6.4） |

## 2. 全体像

```
セルフホスト:
  souieba / Agent ─HTTPS─▶ Caddy ─▶ main.ts（@hono/node-server）─▶ app.ts ─▶ db/node.ts（node:sqlite）
  souieba-admin ───────────────────────────────────────────────────────────▶ DB ファイルを直接開く

Cloudflare:
  souieba / Agent ─HTTPS─▶ worker.ts ─▶ Durable Object（1個）─▶ app.ts ─▶ db/do.ts（ctx.storage.sql）
  souieba-admin --url ─HTTPS─▶ [Cloudflare Access] ─▶ /v1/admin/* （同じ経路）
  Cron Trigger ─▶ worker.ts ─▶ Durable Object ─▶ retention
```

## 3. D1 ではなく Durable Object にする理由

| | D1 | Durable Object の SQLite |
|---|---|---|
| API | 非同期 | **同期**（`ctx.storage.sql.exec`） |
| トランザクション | `batch()` だけ。読んでから書く処理は書けない | `transactionSync` が使える |
| 並行性 | 複数の Worker から同時にアクセスされる | 1つのインスタンスは1スレッドで、リクエストを1つずつ処理する |
| SQL を直接実行 | `wrangler d1 execute` で実行できる | できない（admin API を自分で用意する） |

サービス層は `node:sqlite` の同期 API と `tx()`（`BEGIN IMMEDIATE`）で、読んでから書く処理（招待の使用、配送の予約、グループへの参加など）を守っている。

- **Durable Object** なら、同期のロジックとトランザクションをほぼそのまま移せる。1つずつ処理されるので、招待コードの二重使用のような競合も構造的に起きない
- **D1** にすると、サービス層をすべて async にしたうえで、条件付き UPDATE と `batch()` に作り直す必要がある

1インスタンスの利用者は数人なので、Durable Object 1個で処理は足りる。
D1 の利点（SQL を直接実行できること）は、admin API を用意すれば不要になる。

## 4. DB の抽象化

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

## 5. 環境ごとの違い

| 項目 | セルフホスト | Workers |
|---|---|---|
| 入口 | `main.ts`（`@hono/node-server`） | `worker.ts`。fetch を Durable Object へ転送し、Durable Object の中で `app.fetch` を呼ぶ |
| スキーマのバージョン | `PRAGMA user_version` → **`instance_meta` に移す（両方とも）** | 同左。Durable Object では `PRAGMA user_version` が使えない可能性が高いため |
| マイグレーション | 起動時 | Durable Object のコンストラクタで `blockConcurrencyWhile` の中で実行する |
| マイグレーション前のバックアップ | `VACUUM INTO` | Durable Object の PITR（過去 30 日の任意の時点に戻せる）に任せる |
| retention | `setInterval` | Cron Trigger（または Durable Object の alarm） |
| 接続元の IP | `getConnInfo` + `X-Forwarded-For`（`TRUST_PROXY`） | `CF-Connecting-IP`。`createApp` の `deps.remoteAddr` で差し替える |
| レート制限 | メモリ上 | Durable Object のメモリ上（そのまま動く）。Durable Object が退避されるとカウントは消えるが、許容する |
| 設定 | `process.env` | Worker の env bindings を `loadConfig(env)` に渡す |
| 公開モード | `SOUIEBA_EXPOSURE=vpn\|public` | 常に public 相当。https は Cloudflare が終端する。`TRUST_PROXY` は使わない |
| `node:net`（`isIP` など） | そのまま | 自前の小さな関数に置き換える（両方とも） |
| `node:crypto` | そのまま | サーバが使うのは sha256・乱数・Ed25519 の検証だけ。`nodejs_compat` で動くか確かめ、動かなければ WebCrypto に寄せる |
| バックアップの取り出し | `souieba-admin backup` | admin API に export を足すか、PITR だけにするか（§9） |

## 6. 管理操作

### 6.1 方針

**A（アプリ内の admin API）を本体にし、Cloudflare では B（Cloudflare Access）を外側にかぶせる。**

| | A: アプリ内の admin API | B: Cloudflare Access |
|---|---|---|
| セルフホスト | 同じコードがそのまま動く | 使えない（Cloudflare 専用） |
| 守りの位置 | アプリの中 | Cloudflare の手前。認証を通らないリクエストはアプリに届かない |
| 弱点 | トークンが漏れると使われる。admin のルートのバグが外から突かれる | 設定を誤ると素通しになる |

B だけに頼らない。Access は自分のドメインにかける設定なので、`*.workers.dev` の URL から入ると素通りになりえる。
アプリ側の認証（A）は必ず残し、workers.dev のルートは無効にする。

### 6.2 admin API

- 設定 `SOUIEBA_ADMIN_API=off|on` で有効にする。**既定は off**。今の「public モードでは `/v1/admin/*` を 404 にする」を引き継ぎ、明示的に有効にしたときだけ開く
- 認証には、普段のユーザートークンとは別の **admin 専用トークン**（scope `admin`）を使う
  - 今の admin API（VPN モードだけで使える）は、`role = admin` のユーザーのトークンで呼べる。これを admin 専用トークンに限る
  - Agent のトークンには admin の scope を付けられないようにする
- `souieba-admin` の操作（create-user / login-code / invite / list-groups / disable-user / list-users）を API に揃える
- admin API の呼び出しはすべてログに残す

### 6.3 最初の admin の作成（ブートストラップ）

- `SOUIEBA_BOOTSTRAP_TOKEN` を secret で渡す（Workers は `wrangler secret put`、セルフホストは `.env`）
- **admin が1人もいないあいだだけ有効**。最初の admin を作ると自動で使えなくなる
- 応答で admin 専用トークンを返す。以降はこのトークンで操作する

### 6.4 CLI

| CLI | 使う人 | 変更 |
|---|---|---|
| `souieba`（`apps/cli`） | 利用者と AI エージェント | なし。admin の機能は入れない |
| `souieba-admin` | サーバの管理者 | `--url <サーバURL>` を足し、admin API を HTTP で呼べるようにする。指定しなければ今どおり DB を直接開く |

`souieba` に admin の機能を入れない理由:

- `souieba` は Skill に同梱されて AI エージェントに渡る。admin のコマンドがあると、エージェントが（プロンプトインジェクション経由も含めて）実行できてしまう
- `~/.souieba/config.json` はエージェントから読める。admin のトークンがそこに置かれてしまう

`souieba-admin --url` の admin トークンは、環境変数か毎回の入力で渡す。`~/.souieba` には保存しない。
Access をかけている場合は、service token を `CF-Access-Client-Id` / `CF-Access-Client-Secret` ヘッダで付ける（これも環境変数で渡す）。

### 6.5 セルフホストでの外側の壁

- admin API を使わないなら off のままにし、今どおりサーバ上の `souieba-admin` だけで管理する（推奨）
- 使うなら、Caddy で `/v1/admin/*` を特定の IP に絞る

## 7. 脅威モデル（[公開の設計 §9](public-deployment-plan.md) からの変更）

- **Cloudflare から見えるもの**: 誰がどのグループにいるか、投稿の時刻とサイズ、IP。自宅や VPS で Caddy を使って公開するのと同じ量で、見る主体が Cloudflare になる
- **本文**: E2EE なので、TLS を Cloudflare が終端しても読めない。所属の証明の連鎖と TOFU（[公開の設計 §5](public-deployment-plan.md)）により、サーバ（Cloudflare を含む）が偽のメンバーや鍵を足しても宛先には入らない
- **管理の経路が外に開く**（admin API を有効にした場合）: admin 専用トークン、ブートストラップの制限、Access の三段で守る

## 8. 進め方

PR #1（公開・グループ・E2EE）をマージしてから、別の PR で進める。

1. **DB の抽象化（セルフホストの動作は変えない）**: `Db` インターフェースを作り、サービス層を乗せ替える。スキーマのバージョンを `instance_meta` に移す（マイグレーション3）。`node:net` を置き換える。今のテストがそのまま安全網になる
2. **admin API の整備**: admin 専用トークン、`SOUIEBA_ADMIN_API`、ブートストラップ、`souieba-admin --url`。セルフホストでも使える
3. **Workers の入口**: `worker.ts`、Durable Object のクラス、`db/do.ts`、`wrangler.toml`、Cron Trigger。`@cloudflare/vitest-pool-workers` で主な流れをテストする
4. **ドキュメント**: README と `deploy/` に Workers でのデプロイ手順（Access と workers.dev の無効化を含む）を書く

## 9. 未決事項・確認すること

- **Durable Object の制約の確認**: `PRAGMA` のどれが使えるか、外部キーの制約が有効か、`transactionSync` の中で例外を投げたときの挙動
- **`node:crypto` の互換性**: workerd の `nodejs_compat` で Ed25519 の `verify`（KeyObject を使う形）が動くか
- **無料プランの上限**: Durable Object のリクエスト数・CPU 時間・保存容量の最新の値。毎時の同期と数人の利用で収まるかを見積もる
- **バックアップ**: Workers では PITR だけにするか、admin API に DB のエクスポートを足すか（中身は暗号文とメタデータ）
- **Durable Object の場所**: 最初のリクエストの近くに置かれる。日本から使うなら、location hint を指定するか
