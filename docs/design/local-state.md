# 手元の状態（SOUIEBA_HOME）

主人の PC に置く状態ファイルの場所・中身・権限・書き方を決める。連絡先・グループ・プロジェクト・Policy・呼び名・メモ・受信箱は、すべてこの PC にだけ置き、Relay には送らない。何が Relay に見えるかは [relay-protocol.md](relay-protocol.md) を参照する。

## 場所

状態は `SOUIEBA_HOME`（既定は `~/.souieba`）の下に置く。同じ PC で別の Person を動かす（2人分のデモなど）ときは、`SOUIEBA_HOME` を分けて、それぞれで `souieba init` する。

```
$SOUIEBA_HOME/
├─ config.json              Person 鍵・内部端末の鍵・Relay の URL・クライアント設定
├─ update-check.json        npm の最新版の確認結果（1日覚える）
└─ person/                  人ごとの状態。この PC のすべてのエージェントが共有する
   ├─ relay-state.json      連絡先・グループ・プロジェクト・共有方針・委任・変更記録 ほか
   ├─ relay-inbox.json      受け取った近況（受信箱）
   ├─ notes.jsonl           まだ投稿していないメモ
   ├─ periods.json          投稿済み・スキップにした（時間帯, プロジェクト）の記録
   ├─ sessions.json         会話ごとの、主人の指定（pin）と作業ディレクトリ
   ├─ *.lock                書き込みのロック（relay-state・relay-inbox・sessions・notes）
   └─ devices/<deviceId>/   内部の転送端末ごとの状態
      ├─ relay-session.json  Relay とのセッション
      └─ session.json        会話の Session（tell の間隔を決める）
```

- 外から見える主体は Person だけである。Relay との通信に使う内部の転送端末は、Person の内部実装で、CLI が最初の有効な1台を自動で選ぶ。端末の名前は手元だけのもので、Relay にも友人にも送らない。
- エージェントごとに状態を分けない。同じ PC のエージェントは、ID・連絡先・設定・メモ・受信箱を共有する。そのため、同じ近況を2つのエージェントが伝えることはない（[post-flow.md](post-flow.md)）。
- 環境変数 `SOUIEBA_RELAY_URL` があれば、`config.json` の Relay の URL を一時的に上書きする。

## config.json

| 項目 | 中身 |
|---|---|
| `person.relayUrl` | 登録した Relay の origin（https。localhost だけ http を許す） |
| `person.personId` | Person ID（`sb_…`。Person 鍵から作る） |
| `person.person` | Person 鍵（`pub` と、最初の PC にだけある `priv`） |
| `person.devices` | 内部の転送端末。手元の名前 → 端末の ID・署名鍵・暗号化鍵・鍵の版・Person 鍵による証明書・取り消した日時 |
| `client` | クライアント設定（下記）。秘密情報は置かない |

`souieba init <Relay の URL>` が Person 鍵と最初の内部端末を作り、Relay に登録して書く。すでに Person があれば断る。

### クライアント設定

`souieba config set <項目> <値>` / `unset` / `show` で変える。環境変数があれば、設定ファイルを一時的に上書きする。

| 項目 | 意味 | 既定 | 環境変数 |
|---|---|---|---|
| `session-gap` | 会話の区切りとみなす無通信時間（分）。0なら発話ごとに新しい Session | 10 | `SOUIEBA_SESSION_GAP_MIN` |
| `tell-interval` | 同じ Session で次の近況を伝えるまでの間隔（分）。0なら待たない | 10 | `SOUIEBA_TELL_INTERVAL_MIN` |
| `post-interval` | 投稿の時間帯の長さ（分）。5〜1440で、1440を割り切る値 | 60 | `SOUIEBA_POST_INTERVAL_MIN` |
| `update-check` | npm の更新確認をするか（on / off） | on | `SOUIEBA_NO_UPDATE_CHECK`（あれば確認しない） |

デモでは `session-gap`・`tell-interval` を0にして、待ち時間をなくせる。

## relay-state.json

この PC の共有に関する状態を持つファイル。版は `v: 3`。主な内容は次のとおり。

| 項目 | 中身 |
|---|---|
| `contacts` | 接続済みの人。主人が付けた呼び名、接続時に Person ID から確かめて固定した Person 鍵、知っている端末とその鍵の版、取り消しを確かめた端末 |
| `pendingNames` | 接続要求を送った・承認したときに付けた呼び名（相手が承認して連絡先になるまで覚える） |
| `groups` | この PC だけのグループ（Person ID の集合。上限50）。他のメンバーとは共有しない |
| `projects` | プロジェクト（上限50）。ディレクトリ・共有先・Policy・説明・推定を受け付けるか。`default` は常にある。詳細は [projects.md](projects.md) |
| `delegations` | 主人がエージェントに任せた範囲と期限（[delegation.md](delegation.md)） |
| `clients` | MCP クライアントごとの、メモを入れるプロジェクト |
| `unresolved` | どのプロジェクトにも決まらなかったメモの扱い（`default` / `hold`） |
| `changeLog` | 端末の外から変えた設定の記録（下記） |
| `notifiedRequests` | 主人に知らせ済みの接続要求 |
| `lastToldSender` | 最後に近況を伝えた相手（次は別の人を優先する） |
| `sent` | 送った近況の記録（プロジェクトと「推定」の印）。7日で消える |

- 版が違う、または壊れたファイルは読まない。次に書くとき、空で上書きして消さないよう、`relay-state.json.unreadable-<時刻>` に脇へ移してから作り直す。
- 呼び名は、Tell 文に入るので、表示名と同じ規則（1〜40字、使える文字を制限）に従う。ほかの連絡先・グループと重ならず、`all` は使えない。

### 変更記録（changeLog）

- エージェントなど端末の外から共有の設定を変えると、その内容（`summary`）・広げる操作か・任せた範囲での変更か・主人に知らせたかを記録する。主人が端末で直接変えたもの（端末での y/N と、`souieba ui`）は記録しない。
- 次の `tell` が、まだ知らせていない変更を「ユーザーへの回答のあとで、そのまま主人に伝える」よう案内し、知らせたものは `notified` にする。だまされたエージェントに設定を変えられても、主人が気づけるようにするためである。
- 記録は最新の50件だけ残す。

## notes.jsonl と periods.json

- `notes.jsonl`: 1行1メモ（`{"ts", "text", "project", "via"}`）。書き方と使われ方は [post-flow.md](post-flow.md)、`via` の意味は [projects.md](projects.md)。投稿の時間帯を過ぎて約48時間たつと消える。
- `periods.json`: 投稿済み・スキップの記録。キーは、default なら時間帯の開始時刻、それ以外は `<開始時刻>#<プロジェクト名>`。プロジェクトの名前を変えると、メモと記録を付け替える。

## relay-inbox.json

- `items`: 検証・復号した近況（送り主・本文・Narrator・予約期限・伝えた時刻）。利用期限（既定は作成から2日）を過ぎたものと、伝えて1日たったものを消す。
- `seen`: 再配送を見分けるための、受け取ったメッセージの ID と配送期限。配送期限まで覚える。
- `held`: 接続済みだが呼び名がない相手から届いた、まだ開けていないメッセージ（最大200件）。呼び名が付いたら検証して開く。

## sessions.json と、端末ごとのファイル

- `person/sessions.json`: フックが知らせた会話の ID ごとに、作業ディレクトリと、主人の指定（pin）を持つ。24時間で消える。使われ方は [projects.md](projects.md)。
- `person/devices/<deviceId>/session.json`: 会話の Session（tell の間隔の判定）。端末ごとに持つ。受信箱と伝え済みは人ごとに1つなので、Session が端末ごとでも同じ近況を2回伝えることはない。
- `person/devices/<deviceId>/relay-session.json`: Relay が発行したセッショントークン。

## 権限と書き方

- 秘密鍵やトークンを含むため、状態のディレクトリは所有者だけ（700）、ファイルは所有者だけが読み書きできる（600）権限で作る。`config.json` が他人に読める権限で残っていれば、読むときに600に直す。Windows では権限の扱いが違うので何もしない。
- 書くときは、一時ファイルに書いてディスクに同期してから置き換える。途中で落ちても元のファイルが残り、空にならない。
- フック・MCP・CLI が同時に動いても変更を取り合わないよう、`relay-state.json`・`relay-inbox.json`・`sessions.json`・`notes.jsonl` の更新は、ロックファイルを取って行う。持ち主が落ちて残ったロックは5秒で奪い、手放すときは自分のロックだけを消す。
- 作り直せる状態ファイル（Session・受信箱・メモの記録など）が壊れていても、tell などが落ちないよう、空として扱う。Person 鍵を持つ `config.json` は壊れていれば落とす（空に戻して鍵を失わないため）。

## なぜこうしたか

- **連絡先・共有方針・プロジェクト・呼び名を Relay に置かない。** Relay に見えるのは、配送に要る Person ID と公開鍵、接続関係、誰がいつ誰に送ったかまでにする。誰に何を話してよいかは、主人のこの PC だけが知る。
- **状態を Person ごとに1組にした。** 友人からは1人に見える。エージェントごとに状態を分けると、同じ近況を二重に伝えたり、共有の設定がエージェントごとにずれたりする。
- **広げる操作を端末の外から行ったら、次の tell で知らせる。** 同じユーザー権限で動くプログラムに対するセキュリティ境界ではないが、だまされたエージェントが主人の意図を越えて共有を広げても、主人が気づけるようにするためである。

## 関連するコード

- `packages/sdk/src/config.ts`: `SOUIEBA_HOME`・`config.json`・クライアント設定・権限・一時ファイルからの書き込み
- `packages/sdk/src/relay-state.ts`: `relay-state.json` と `relay-inbox.json` の型・版・読み書き・アクセス判定
- `packages/sdk/src/notes.ts`: `notes.jsonl`・`periods.json`・ファイルロック
- `packages/sdk/src/project.ts`: `sessions.json`（`SessionStore`）
- `apps/cli/src/person.ts`: `souieba init`
- `apps/cli/src/relay.ts`: 状態・受信箱・メモ・端末ごとのファイルの配置（`relayParts`）
- `apps/cli/src/commands/config.ts`: `souieba config`
- `apps/cli/src/relay-ops/delegation.ts`: 変更記録（`record`）
- `apps/cli/src/update-check.ts`: `update-check.json`
