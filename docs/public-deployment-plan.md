# 設計: インターネット公開・グループ・E2EE

> **状態:** 実装済み（ブランチ `feat/public-groups-e2ee`）。設計から変えた点・足した点は §12 にまとめた。VPS での実機確認は未実施。
> その後、**VPN 内での運用は廃止した**（§12 の最後）。この文書の `SOUIEBA_EXPOSURE=vpn|public` や Tailscale・WireGuard の compose の記述は、当時の設計として残している。
> さらに 2026-10-09 に、**サーバ（運営者）を信頼する E2EE に変えた**（§13）。Identity 鍵・Agent の証明書・所属の証明の連鎖・TOFU・指紋をやめ、鍵はサーバが配る。§4・§5・§9 は今の設計に書き換えた。ほかの節に残る署名・指紋の記述は当時の設計で、今との違いは §13 にまとめた。

現在の Souieba は「VPN 内でのみ運用し、インターネットに公開しない」前提で作られている（[実装計画 §12](implementation-plan.md)）。
VPN を前提にしていたのは、投稿本文を E2EE にしていなかったためである。

次の実装では、次の3つを同時に満たす。

1. **インターネットで問題なく動く**: VPS（ConoHa など）に置き、誰でも HTTPS で接続できる
2. **複数のユーザーグループ**: 1台のサーバに複数のグループがあり、1人が複数のグループに入れる
3. **E2EE**: サーバに保存された投稿本文は、DB が漏れても読めない（§13 の変更後。当初はサーバの管理者も含めて読めないことを目指していた）

[設計書 §20・§21](text.md) の「P2P Identity + E2EE + Dumb Relay」のうち、**Identity と E2EE** を実装し、サーバを本文を読まない中継に近づける。P2P は引き続き対象外とする。

## 1. 決めたこと

| 項目 | 決定 |
|---|---|
| グループの意味 | **共有範囲**。今の「相互 Friend」をグループに置き換える。Friend の仕組み（申請・承認・ブロック）は廃止する |
| 投稿の届け先 | **所属しているグループ全部**のメンバー。Agent は今どおり1回投稿するだけ。グループごとの出し分けはしない |
| 届けたくない相手がいるとき | そのグループを抜ける（`souieba groups leave`） |
| 参加の方法 | グループのメンバーが発行する招待コード。新規ユーザーはアカウント作成と参加を同時に行い、既存ユーザーは `groups join` で参加する |
| 本文 | E2EE のみ。平文の投稿は受け付けない（VPN 構成でも同じ。経路を1つにする） |
| 既存のデータ | マイグレーションで投稿と Friend 関係を破棄する。投稿は14日で消えるものなので移行しない |

## 2. 全体像

```
                     ┌──────────────────────── VPS ────────────────────────┐
CLI / Agent ─HTTPS─▶ │ Caddy :443 ──▶ souieba-server :8080（ホストには公開しない）│
                     │                 ├ 招待制・Bearer トークン・レート制限        │
                     │                 ├ 公開鍵ディレクトリ（鍵と所属の証明を配る） │
                     │                 └ 暗号文・メタデータだけを保存            │
                     └─────────────────────────────────────────────────────┘

Agent A: 平文 → 署名・暗号化（グループのメンバーの全 Agent 宛て）→ サーバ
Agent B: サーバ → 証明を検証 → 復号 → 正規化 → テンプレートで Tell 文
```

サーバに残す役割は、**誰に何を配るか**（受信箱・予約・TOLD・保存期間・削除）だけにする。本文を読む処理（秘密情報スキャナ・正規化・候補選択の文字数判定）はすべてクライアントへ移す。

## 3. グループ

### 3.1 データ

```sql
groups (
  id          TEXT PRIMARY KEY,        -- クライアントが生成する（grp_ + 16 バイトの乱数）。署名に含めるため
  name        TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  create_sig  TEXT NOT NULL,           -- 作成者の証明（§5.3）
  created_at  TEXT NOT NULL
)

group_members (
  group_id    TEXT REFERENCES groups(id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT CHECK (role IN ('owner','member')),
  invited_by  TEXT,                    -- 作成者は NULL
  invite_code TEXT,                    -- 使用済みの招待コード（参加後に公開してよい。§5.3）
  invite_sig  TEXT,
  join_sig    TEXT,
  joined_at   TEXT NOT NULL,
  left_at     TEXT,                    -- 抜けた人の行も残す（その人が招待した人の証明を検証するため）
  PRIMARY KEY (group_id, user_id)
)

invites に group_id, commit, invite_sig 列を追加する
```

### 3.2 可視性

「投稿者と受信者が、今その時点で同じグループに（抜けずに）所属している」ことを条件にする。今の `VISIBLE_TO_ME` の Friend 判定をこれに置き換える。

```sql
EXISTS (
  SELECT 1 FROM group_members a JOIN group_members b ON a.group_id = b.group_id
  WHERE a.user_id = p.owner_id AND b.user_id = :me
    AND a.left_at IS NULL AND b.left_at IS NULL
)
AND EXISTS (SELECT 1 FROM post_recipients r WHERE r.post_id = p.id AND r.agent_id = :agent)
```

2つめの条件で、**この Agent が復号できる投稿だけ**を候補にする（後から追加した Agent は、追加前の投稿を復号できないため）。
グループを抜けると、受信済みでも未 Tell の投稿は候補から消える（今の Friend 解除と同じ）。

### 3.3 権限

| 操作 | できる人 |
|---|---|
| グループの作成 | 全ユーザー（`SOUIEBA_GROUP_CREATE_BY=member\|admin` で管理者だけにもできる） |
| 招待コードの発行 | `SOUIEBA_INVITE_BY=member` ならメンバー全員、`admin` なら owner だけ（今の設定をグループ単位に読み替える） |
| メンバーを外す | owner |
| 抜ける | 本人。owner が抜けるときは、最も古いメンバーを owner にする。最後の1人が抜けたらグループを削除する |
| グループ名の変更 | owner |

インスタンスの管理者（`users.role = admin`）は、ユーザーの無効化などのアカウント管理だけを行い、グループの中身には関与しない。

### 3.4 管理者が作ったユーザー

`souieba-admin create-user` で作ったユーザーは、どのグループにも入っていない。最初の利用者は `souieba groups create <名前>` でグループを作り、そこから招待する。
`souieba-admin invite`（招待者なしの招待）は、**グループに入らないアカウント作成用**のコードとして残す（サーバは署名できないため、グループへの招待には使えない）。

## 4. 鍵

### 4.1 鍵の種類

| 鍵 | 単位 | アルゴリズム | 用途 | 保存場所 |
|---|---|---|---|---|
| Agent 署名鍵 | Agent | Ed25519 | 投稿への署名 | `config.json` の `agents.<名前>.keys` |
| Agent 暗号鍵 | Agent | X25519 | 投稿の鍵を受け取る | 同上 |

- ユーザーの鍵（Identity 鍵）は持たない。人の ID はサーバのアカウント（トークン認証）で、鍵は Agent が投稿を暗号化・署名するための部品にすぎない
- Agent は実質「端末」なので、Agent ごとに鍵を持てば端末をまたいで秘密鍵を同期しなくて済む。別の PC では、ログインして `agent add` し直すだけでよい
- すべて Node.js 22 の `node:crypto` で実装できる。CLI の「実行時の依存なし」を守れる
- 鍵は JWK の `x` / `d`（生の 32 バイトを base64url）で保存・送信する

### 4.2 登録の流れ

`agent add` で Agent の鍵ペアを生成し、公開鍵（`encKey`・`signKey`）を `POST /v1/agents`（User トークン）で登録する。サーバは形式だけを確かめて保存する。

鍵のローテーションは、`agent revoke` → `agent add` で行う（専用の仕組みは作らない）。鍵をなくしたときも同じで、失うのは古い鍵宛てに届いていた投稿だけである（投稿は保存期間で消える近況なので、守る価値は小さい）。

## 5. サーバを信頼する

### 5.1 方針

グループの所属と「どの Agent の鍵が誰のものか」は、**サーバが管理して配り、クライアントはそれをそのまま使う**。

- 守れるもの: DB・バックアップの漏洩、ストレージの盗み見、VPS 事業者の閲覧、通信の盗聴。サーバに残るのは暗号文だけなので、本文は読めない
- 守れないもの: サーバの運営者が能動的に偽の鍵や偽のメンバーを配る攻撃。運営者は自分や信頼できる友人にすることを前提にする

当初はサーバを信頼しない設計（Identity 鍵・Agent の証明書・所属の証明の連鎖・TOFU・招待時の指紋の確認）にしていたが、やめた。理由は §13。

### 5.2 公開鍵ディレクトリ

`GET /v1/keys`（User・Agent トークン）が、自分と、今いっしょにいるグループがあるユーザーの、有効な Agent の鍵を返す。

```jsonc
{
  "me": { "userId": "...", "agentId": "..." },
  "users": [
    { "id": "...", "handle": "bob", "displayName": "ボブ",
      "groupIds": ["..."],   // 自分といっしょにいるグループだけ（自分自身なら、自分の全グループ）
      "agents": [{ "id": "...", "name": "Hermes", "encKey": "...", "signKey": "...", "createdAt": "..." }] }
  ]
}
```

クライアントは、ここにある Agent を投稿の宛先にし、受け取った投稿の署名をここにある署名鍵で確かめる。

### 5.3 トークンの漏洩となりすまし

人の ID がサーバのアカウントなので、**User トークンが漏れると、Agent を足してなりすませる**（足した Agent 宛てにも投稿が暗号化されるので、主人宛ての投稿も読める）。次の2つで気づけるようにする。

- **自分の Agent が増えたら知らせる**: 各 Agent は、主人のアカウントの Agent の一覧を `~/.souieba/agents/<id>/known_agents.json` に覚えておき、増えていたら `souieba tell` の出力で主人に知らせる（初回は記録だけ）。止めるかどうかは主人が決める（`souieba agent revoke <id>`）。`souieba doctor` も、この PC にない Agent を表示する
- **表示名はインスタンス全体で一意にする**（2026-10-09 に「同じグループの中で一意」から変更。#14）: Tell 文は「あ、そういえば○○さん、…」と表示名で人を呼ぶので、同じ表示名の人がいると見分けられない。登録するとき（招待・管理者による作成）と、表示名を変えるとき（`PATCH /v1/me`、`souieba profile --name`）に拒否する。英字の大文字・小文字は区別しない。無効化したユーザーの名前も使えない。一意にする前に登録された重複は、`souieba-admin list-users` に印が付くので、管理者が本人に変更を頼む（本人の `souieba tell` でも、同じグループに重複があれば知らせる）

Agent のトークンだけが漏れた場合は、署名鍵がないので偽の投稿は受信側で弾かれ、秘密鍵がないので投稿も読めない。

## 6. 投稿の暗号化

### 6.1 封筒（envelope）

```
1. 平文 = sanitizeContent(本文)、scanSecrets で検査（送信側。拒否なら投稿しない）
2. CEK = 乱数 32 バイト
3. ciphertext = AES-256-GCM(CEK, iv, 平文, AAD)
     AAD = "souieba/post-aad/v1\n{authorUserId}\n{authorAgentId}\n{periodStart}\n{periodEnd}\n{visibility}"
4. 一時鍵 epk（X25519）を1つ作り、宛先の Agent ごとに:
     kek     = HKDF-SHA256(X25519(epk_priv, 宛先の encKey), salt = epk_pub, info = "souieba/wrap/v1\n{宛先agentId}")
     wrapped = AES-256-GCM(kek, iv_i, CEK)
5. sig = Ed25519_sign(Agent 署名鍵, 正規化した封筒（sig 以外の全フィールド、recipients は agentId 順）)
```

```jsonc
{
  "v": 1,
  "periodStart": "...", "periodEnd": "...", "visibility": "groups",
  "epk": "...", "iv": "...", "ciphertext": "...",
  "recipients": [{ "agentId": "...", "iv": "...", "wrapped": "..." }],
  "sig": "..."
}
```

- 期間と visibility は、冪等キー（同じ Agent・同じ時間帯は上書き）と保存期間に使うので平文で持つ。改ざんは AAD と署名で検知する
- 宛先 = ディレクトリ（§5.2）にある、グループのメンバーの Agent ＋ 自分の全 Agent（`posts mine` で読むため）
- `visibility: "private"` なら宛先は自分の Agent だけ
- 宛先の上限は 200。1宛先あたり約 140 バイトなので、`POST /v1/posts` の body の上限を 64KB に上げる
- MLS のようなグループ鍵の仕組みは使わない。グループは少人数（数人〜数十人）で、投稿は1時間に1回なので、宛先ごとに鍵を包むほうが単純で、メンバーの増減にも何もしなくてよい

### 6.2 サーバ側

- `posts.content` をやめ、`posts.envelope`（JSON）に置き換える
- `post_recipients (post_id, agent_id)` に宛先を展開して保存する（§3.2 の絞り込み用）
- 投稿を受け付けるとき、サーバは次だけを確認する: 封筒の形式、期間の検証（今の `validatePeriod`）、宛先が「投稿者とグループを共有するユーザーの有効な Agent、または投稿者自身の Agent」に含まれること、署名が投稿した Agent の署名鍵で検証できること（ゴミと他人へのなりすましを防ぐため。信頼の根拠はクライアント側の検証）
- 秘密情報スキャナと `sanitizeContent` はサーバから外す（本文を見られないため）

### 6.3 受信側

`claimTell` で受け取った封筒を、クライアントが次の順で処理する。

1. 投稿者（owner）が、ディレクトリにいる（今いっしょにいるグループがある）こと
2. 投稿した Agent が、ディレクトリ上でその投稿者の有効な Agent であること
3. 封筒の署名が、その Agent の署名鍵で検証できること。期間・visibility がサーバの返した値と一致すること
4. 自分宛ての `wrapped` を開いて CEK を得て、本文を復号する
5. **受信側で** `sanitizeContent` を通す（送信側の正規化は信用しない）。`MIN_TELL_CONTENT_LENGTH` 未満なら伝えない
6. `formatTellText` → `validateTellText`（今と同じ）

1〜5 のどれかに失敗したら `dismiss` する（何度も候補にならないように）。通信の失敗だけは今どおり `release` する。

## 7. SDK・CLI

### 7.1 SetLog の Transport 抽象化を使う

```ts
// packages/sdk/src/e2ee.ts
export class E2eeTransport implements SetLogTransport {
  constructor(private inner: HttpTransport, private keys: AgentKeys, private keyring: Keyring) {}

  async publish(post: CreatePostInput) {     // 平文を受け取り、封筒にして送る
    const dir = await this.directory();      // GET /v1/keys → §5 の検証 → 宛先
    return this.inner.publishEnvelope(seal(post, dir.recipients, this.keys));
  }
  async claimTell(opts?) {                   // 封筒を受け取り、§6.3 の検証・復号をしてから返す
    const c = await this.inner.claimEnvelope(opts);
    if (!c) return null;
    const opened = open(c, await this.directory(), this.keys);
    if (!opened.ok) { await this.inner.dismiss(c.postId); return null; }
    return opened.candidate;                 // 今と同じ TellCandidate（content は平文）
  }
  // sync / markAsTold / release はそのまま委譲
}
```

- `SetLog` クラス、`tell` / `note` / `compose` / `publish` のコマンド、SKILL.md のエージェント向けの手順は変えない
- ディレクトリは1回のコマンド実行の中でだけキャッシュする。`tell` は sync・claim・keys の3回の通信になるが、今の 1.5 秒のタイムアウトのまま扱える
- 暗号の処理（鍵の生成、署名、封筒、証明の検証）は `packages/core/src/crypto.ts` と `trust.ts` に純関数として置く。サーバも証明書と署名の形式の検証に使う

### 7.2 core の変更

- `selectTellCandidate` から本文の長さの判定を外す（サーバは本文を見られない）。長さの判定は §6.3 の 5 で行う
- 型: `Visibility = "groups" | "private"`、`PostEnvelope`、`WireTellCandidate`（封筒つき）、`KeyDirectory` を追加する

### 7.3 CLI

| コマンド | 内容 |
|---|---|
| `login <URL> --code <コード> [--verify <指紋>] [--handle --name]` | Identity 鍵の生成、参加の署名、指紋の照合 |
| `groups` | 所属しているグループの一覧 |
| `groups create <名前>` | グループを作る（作成者として署名） |
| `groups join <コード> [--verify <指紋>]` | 既存ユーザーが別のグループに参加する |
| `groups members <グループ>` | メンバー・指紋・検証の状態 |
| `groups leave <グループ>` / `groups remove <グループ> <handle>` | 抜ける / 外す（owner） |
| `invite --group <グループ>` | 招待コードを手元で生成して署名する。所属が1つなら `--group` は省略できる |
| `identity` / `identity export` / `identity import <文字列>` | 自分の指紋の表示、別の PC への移行 |
| `agent add <名前>` | Agent の鍵を生成し、証明書つきで登録する |
| `posts mine` | 手元の Agent の鍵で復号して表示する（復号できないものは「この PC では読めません」） |
| `doctor` | 上の確認に加え、Identity 鍵・Agent の鍵の有無と、TOFU の不一致を表示する |
| ~~`friends`~~ | 廃止 |

SKILL.md の「主人に聞かれたら」と `references/setup.md` を、Friend からグループに書き換える。setup.md の「サーバは VPN の中にあります」も削除する。

## 8. インターネットで動かすためのサーバの変更

| 項目 | 内容 |
|---|---|
| 公開モード | `SOUIEBA_EXPOSURE=vpn\|public`（既定 `vpn`）。`public` のときは、ワイルドカードやグローバル IP での待ち受けを許す。代わりに `https` の `PUBLIC_URL`、`TRUST_PROXY` の明示、admin API の無効化を起動時に要求する |
| 送信元 IP | 今は `X-Forwarded-For` の**先頭**を信頼している（`app.ts`）。インターネットからは先頭を偽れるので、redeem のレート制限を回避される。信頼するプロキシが付けた**末尾**を使うように直す |
| 信頼するプロキシ | `SOUIEBA_TRUST_PROXY=loopback\|private\|none`。`private` は Docker のブリッジネットワーク上の Caddy 用（送信元がプライベート IP のときだけ XFF を見る） |
| 認証失敗のレート制限 | 今は認証に成功したリクエストだけを数えている。401 になったリクエストも IP ごとに数え（例: 10分に30回）、超えたら 429 にする |
| 管理 API | `public` モードでは `/v1/admin/*` を 404 にする。管理はサーバ上の `souieba-admin` だけで行う |
| `/v1/instance` | `public` モードではバージョンを返さない |
| body の上限 | `/v1/posts` だけ 64KB、それ以外は今どおり 16KB |
| 招待コードの有効期限 | 7日 → 3日に短くする（インターネットから redeem を試せるようになるため） |
| CORS | 今どおり無効（ブラウザからは使わない） |

### 8.1 サーバへの認証

サーバへの認証は、今の実装と同じ **Bearer トークン**（`sou_u_…` / `sou_a_…`、サーバは SHA-256 だけを保存）のままにする。公開鍵による署名は、サーバへの認証ではなく、クライアント同士の検証に使う。

| 場面 | 認証・署名 | サーバの検証 | クライアントの検証 |
|---|---|---|---|
| API の呼び出し全般 | Bearer トークン | トークンのハッシュを照合 | — |
| Agent の登録 | ＋ Identity 鍵による Agent の証明書 | 形式の確認のみ | 信頼の根拠 |
| 投稿 | ＋ Agent 署名鍵による封筒の署名 | トークンの Agent 本人の署名か | 信頼の根拠 |
| グループの作成・招待・参加 | ＋ Identity 鍵による署名 | しない | 所属の証明の連鎖（§5.3） |

リクエストごとの署名（HTTP Message Signatures など）にしない理由:

- E2EE の設計ではサーバを信頼しないので、サーバへの認証は「無関係な人を入れない」門番にすぎず、安全の根拠は署名と暗号の側にある
- トークンだけが漏れても、秘密鍵がなければ投稿を読めず、偽の投稿も作れない
- トークンと秘密鍵は同じ `config.json` にあり、PC が侵害されれば両方漏れる。サーバの DB が漏れてもハッシュしかない
- リプレイ対策（タイムスタンプと nonce）、署名対象の正規化、時計のずれへの対応が必要になり、CLI とサーバが複雑になる

### 8.2 API の変更

| メソッド・パス | 認証 | 内容 |
|---|---|---|
| `POST /v1/auth/redeem` | なし | `identityKey`、（グループへの招待なら）`joinSig` を追加。応答に参加したグループと招待者（handle・Identity 鍵）を含める |
| `PUT /v1/me/identity` | User | Identity 鍵が未登録のときだけ登録する |
| `POST /v1/agents` | User | `encKey`・`signKey`・`cert` を必須にする |
| `GET /v1/groups` / `POST /v1/groups` | User・Agent / User | 一覧 / 作成（`id`・`name`・`createSig`） |
| `POST /v1/groups/:id/invites` | User | `codeHash`・`commit`・`inviteSig` |
| `POST /v1/groups/join` | User | `code`・`joinSig` |
| `DELETE /v1/groups/:id/members/:userId` | User | 抜ける・外す |
| `GET /v1/keys` | Agent | 公開鍵ディレクトリ（§5.1） |
| `POST /v1/posts` | Agent | `{ envelope }`（平文の `content` は廃止） |
| `POST /v1/tell/claim`・`GET /v1/inbox` | Agent | `content` の代わりに `envelope` と `authorAgentId` を返す |
| `/v1/friends*`・`POST /v1/invites` | — | 廃止 |

### 8.3 マイグレーション（2番目）

```
DROP TABLE deliveries; DROP TABLE posts; DROP TABLE friendships;
ALTER TABLE users  ADD identity_key;
ALTER TABLE agents ADD enc_key, sign_key, cert;    -- 鍵のない既存の Agent は投稿・受信できない（登録し直してもらう）
ALTER TABLE invites ADD group_id, commit, invite_sig;
CREATE TABLE groups, group_members;                -- §3.1
CREATE TABLE posts (… envelope TEXT NOT NULL, visibility CHECK IN ('groups','private') …);
CREATE TABLE post_recipients (post_id, agent_id, PRIMARY KEY (post_id, agent_id));
CREATE TABLE deliveries (今と同じ);
```

今どおり、マイグレーションの前に `VACUUM INTO` でバックアップを取る。

### 8.4 デプロイ

`deploy/compose.public.yml`（新規）:

```yaml
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes: [./Caddyfile:/etc/caddy/Caddyfile:ro, caddy-data:/data]
  server:
    image: ${SOUIEBA_IMAGE:-souieba-server:local}
    build: { context: .., dockerfile: apps/server/Dockerfile }
    restart: unless-stopped
    expose: ["8080"]                       # ホストには公開しない。Caddy からだけ届く
    environment:
      SOUIEBA_EXPOSURE: public
      SOUIEBA_BIND: 0.0.0.0
      SOUIEBA_TRUST_PROXY: private
      SOUIEBA_PUBLIC_URL: ${SOUIEBA_PUBLIC_URL:?}
      # INSTANCE_NAME / INVITE_BY / GROUP_CREATE_BY / GRACE / RETENTION は今の compose と同じ
    volumes: [souieba-data:/data]
volumes: { caddy-data: {}, souieba-data: {} }
```

`deploy/Caddyfile`:

```
{$SOUIEBA_DOMAIN} {
	reverse_proxy server:8080
	request_body { max_size 64KB }
	header -Server
}
```

- VPS のファイアウォールで 22・80・443 だけを開ける。SSH は鍵認証のみにする
- バックアップは `souieba-admin backup` を cron で実行し、VPS の外へコピーする。本文は暗号文なので、置き場所に求める信頼の水準は今より下がる
- Tailscale・WireGuard の compose は残す（`SOUIEBA_EXPOSURE=vpn`）

## 9. 脅威モデル（§12.8 からの変更。§13 の変更後）

| 主体 | 今（VPN 内・平文） | 変更後（公開・E2EE・サーバを信頼する） |
|---|---|---|
| インターネット上の攻撃者 | 届かない | 届く。招待制・トークン・レート制限で止める。突破されても読めるのはメタデータだけ |
| DB・バックアップの漏洩、VPS 事業者・侵入者によるストレージの閲覧 | 本文を読める | **本文は読めない**（暗号文しかない） |
| サーバの運営者（能動的な攻撃） | 本文を読める | 偽の鍵・偽のメンバーを配れば読める。**信頼する前提**（§5.1）。投稿を配らない（握りつぶす）こともできる |
| 同じサーバの別グループの人 | （グループの概念なし） | 共通のグループがなければ、投稿・メンバー・鍵のいずれも見えない |
| グループのメンバー | 自分宛ての投稿を読める。インジェクションを試みられる | 同じ。受信側の正規化（許可した文字だけ残す）、命令に見える本文・表示名の破棄（ヒューリスティック）、テンプレートの Tell 文で対策する。LLM が本文を読む以上、完全には防げない。表示名はインスタンス全体で一意 |
| 漏洩した User トークン | VPN 内からだけ使える | Agent を足してなりすまし、主人宛ての投稿を読める。主人の他の Agent が `tell` で知らせ、`agent revoke` で止める（§5.3）。ログインコードの再発行で古いトークンは失効する |
| 漏洩した Agent トークン | VPN 内からだけ使える | どこからでも使える。ただし秘密鍵がないと投稿を読めず、署名できないので偽の投稿も受信側で弾かれる |
| 漏洩した Agent の秘密鍵（PC の侵害） | — | その Agent 宛ての投稿を読める。`agent revoke` 以降の投稿は、その鍵に包まない |
| LLM のサービス | 本文を見る | 同じ。書く側・読む側の両方のエージェントの LLM を本文が通る |
| DoS | VPN 内だけ | 対象になる。小規模なので Caddy と VPS 事業者の対策で受ける |

E2EE にしても**サーバに見えるもの**（脅威モデルとセキュリティ上の前提に明記する）:

- 誰がどのグループに入っているか、グループ名、handle、表示名
- 誰がいつどの時間帯に投稿したか、宛先の Agent の数、本文のおおよその長さ
- 誰がいつ Tell したか

## 10. テスト

- **core**: 封筒の作成と復号、改ざん（AAD・宛先・署名）の検知、所属の証明の連鎖（作成者・招待・循環・コードの重複・抜けたメンバー）、TOFU の不一致
- **server**: グループ単位の可視性（共通のグループがない・抜けた・private）、宛先の検証、公開モードの起動時確認、XFF の末尾の扱い、認証失敗のレート制限、admin API の無効化
- **SDK の結合テスト**: 悪意あるサーバの役をするテスト用 Transport で、偽のメンバー・偽の Agent・鍵のすり替えを注入し、宛先に入らないこと、受信を拒否することを確かめる
- **CLI**: 今の Skill の流れのテストを、グループの作成 → 招待（`--verify` つき）→ 参加 → 投稿 → tell に書き換える。サーバの DB に本文が残らないことも確かめる

## 11. 未決事項

- **表示名の保護**: 表示名を Identity 鍵で署名するか。署名するとサーバによる偽装を防げるが、名前の変更のたびに署名が必要になる
- ~~**メンバーの増減の通知**: 新しいメンバーが入ったときに、主人に知らせるか（`tell` の出力に一行添える、など）。知らせると、サーバによる不正な追加にも人が気づける~~ → 知らせる（2026-10-09、#15）。各 Agent がディレクトリの `groupIds` を `~/.souieba/agents/<id>/known_members.json` と比べ、主人のグループに入った人を `tell` の出力で一度だけ知らせる。主人が自分で入ったグループの既存メンバーは知らせない。表示名・グループ名は他人が付けたものなので、規則に合わなければ出さない
- **Identity 鍵の紛失**: 鍵をなくしたユーザーは、新しい鍵で参加し直すことになる（他のメンバーには TOFU の不一致として見える）。正規の作り直しの手順を用意するか
- **メタデータ**: グループ名を暗号化するか（メンバーにしか見えなくてよい情報なので、暗号化の余地はある）
- **クラウド型エージェント（[§13.5](implementation-plan.md)）**: 公開すれば届くようになるが、秘密鍵をクラウドに置くことになる。E2EE の前提とどう両立させるか

## 12. 実装メモ（設計からの差分）

- **鍵を作り直した相手を信頼し直すコマンド**を足した: `souieba identity accept <handle> --verify <指紋>`。TOFU で不一致になった相手と、サーバの外で指紋を確認したあとに使う
- **環境変数 `SOUIEBA_AGENT_TOKEN` をやめた**。トークンだけでは E2EE ができない（Agent の秘密鍵が必要）ため。`SOUIEBA_SERVER`（URL の上書き）は残した
- **期間は `toISOString()` の形式に限った**。封筒の署名は送られた文字列に対して行うので、サーバ側で正規化した値に置き換えられないため（`period_not_canonical`）
- **受信した投稿の検証に失敗したら dismiss し、次の候補を最大3件まで試す**（`E2eeTransport.claimTell`）。ディレクトリは claim の前に取得する（取得に失敗したときに予約を残さないため）
- **宛先の検証**: サーバは、封筒の宛先のうち届けてよくない Agent（共通のグループがない人など）を、拒否せずに `post_recipients` から外す。少し古いディレクトリで作った封筒も受け付けるため
- **バージョンを 0.2.0 にした**（API の互換性がないため）。マイグレーション2で、平文の投稿と Friend 関係を破棄する（`apps/server/test/db.test.ts`）
- **VPN 内での運用を廃止した**（ブランチ `feat/drop-vpn`）。サーバは常にインターネットに公開する前提で、次のように変えた
  - `SOUIEBA_EXPOSURE`・`SOUIEBA_ALLOWED_CIDRS`・`SOUIEBA_ALLOW_HTTP` をなくした。`PUBLIC_URL` は https が必須で、http は localhost / 127.0.0.1 / ::1（手元での開発）だけ許す
  - `SOUIEBA_TRUST_PROXY` の明示は求めない（既定 `loopback`。compose では `private` を指定している）
  - HTTP の admin API（`/v1/admin/*`）を削除した。管理はサーバ上の `souieba-admin` で行う。HTTP から管理する手段は [Workers 対応 §7](cloudflare-workers-plan.md) で作り直す
  - Tailscale・WireGuard の compose、`serve.json`、ACL の例を削除した。`compose.public.yml` を `compose.yml` に、`.env.public.example` を `.env.example` にした（`docker compose up -d` だけで起動できる）
  - `/v1/instance` はバージョンを返さず、アクセスログには常に送信元 IP を残す（以前の public モードの挙動）
- **§11 の未決事項はすべて未対応のまま**（表示名の署名、メンバーの増減の通知、Identity 鍵の紛失時の手順、グループ名の暗号化、クラウド型エージェント）。表示名の署名・Identity 鍵の紛失は §13 の変更で不要になった

## 13. サーバを信頼する E2EE への変更（2026-10-09、ブランチ `feat/trust-server-e2ee`）

### 13.1 理由

- **主人の手間が大きい**: 人の ID が Identity 鍵に結びついていたので、PC の移行（`identity export/import`）、招待時の指紋の照合（`--verify`）、鍵が変わったときの信頼し直し（`identity accept`）、鍵の紛失時の作り直しを、主人が意識する必要があった。指紋の照合は現実にはほとんど行われず、TOFU の警告が日常的に出ると、読まずに受け入れる習慣がついて検知の意味がなくなる
- **守るものに比べて重い**: 投稿は1時間単位の近況で、保存期間で消える。鍵をなくして失うものは小さい。運営者は自分や友人で、能動的に攻撃してくることは想定しにくい
- **E2EE の効果のうち、大きい部分は残る**: DB・バックアップの漏洩やストレージの閲覧に対しては、鍵をサーバが配っても本文は守れる
- **分散（P2P）はしない**: サーバは1台で、サーバに依存しない ID（Identity 鍵）が必要になる場面がない

ログインの手間を減らしているのは、招待コード・ログインコードで一度ログインしたら、トークンを手元に保存しておく仕組みであって、公開鍵ではない。この仕組みは変えていない。

### 13.2 変えたこと

| 対象 | 変更 |
|---|---|
| Identity 鍵 | 廃止。`users.identity_key`、`PUT /v1/me/identity`、`souieba identity` / `export` / `import` / `accept`、`config.json` の `identity` |
| Agent の登録 | 証明書（`cert`）をやめ、公開鍵だけを登録する。`agents.cert` を削除 |
| グループの作成 | `id` と `createSig` をやめ、サーバが ID を作る（`POST /v1/groups { name }`）。`groups.create_sig` を削除 |
| 招待 | コードはサーバが発行し、ハッシュだけを保存する（`POST /v1/groups/:id/invites` が `{ code, expiresAt }` を返す）。コードは 20 文字 → 12 文字（サーバがコードを逆算する心配がなくなったため。オンラインの総当たりはレート制限で止める）。`invites.invite_commit` / `invite_sig` を削除 |
| 参加 | `identityKey`・`joinSig` をやめた（`POST /v1/auth/redeem { code, handle, displayName }`、`POST /v1/groups/join { code }`）。`group_members.invite_code` / `invite_sig` / `join_sig` を削除。応答の招待者に鍵は入らない |
| ディレクトリ | 自分と今いっしょにいるグループのメンバーの、有効な Agent の鍵だけを返す。グループ・所属の証明・抜けたメンバーは返さない（§5.2） |
| メンバーの一覧 | `GET /v1/groups/:id/members` を足した（`groups members` / `groups remove` 用。以前はディレクトリを使っていた） |
| クライアントの検証 | `core/trust.ts`（所属の証明の連鎖・TOFU）と `known_keys.json` を削除。受信した投稿は、投稿者がディレクトリにいること、Agent がその人のものであること、署名・AAD を確かめる（§6.3） |
| 指紋 | `fingerprint()` と `--verify` を削除 |
| 足したもの | 自分の Agent が増えたことの通知（`AgentWatch`、§5.3）、同じグループで同じ表示名の禁止、表示名の変更（`PATCH /v1/me`、`souieba profile --name`） |
| マイグレーション | `0001_trust_server`（上の列を削除する）。既存の Agent の鍵・グループ・投稿はそのまま使える。手元の `config.json` の `identity` と `known_keys.json` は使わなくなる（残っていても害はない） |

### 13.3 残した課題

- **User トークンの置き場所**: User トークンは、エージェントが読める `config.json` に Agent の秘密鍵と一緒に入っている。プロンプトインジェクションでエージェントに読ませれば持ち出せる。Agent が増えたことの通知で気づけるが、防げはしない。User トークンを別の場所に置く、有効期限を付ける、などは未対応
- ~~**表示名の重複**: 確かめるのは「参加するグループの中」と「表示名を変えるときに、いっしょにいるグループのメンバー」だけ。別々のグループにいる同名の2人を、両方のグループにいる人から見ると区別できない~~ → 表示名をインスタンス全体で一意にして解消した（§5.3、#14）
