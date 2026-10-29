# Souieba v2（Relay）の実装メモ

設計は [v2-design.md](v2-design.md)（設計ドラフト v0.2）。この文書は、その実装で決めたこと・設計書の「未決定事項」（§17）への答え・既知の限界をまとめる。

## 1. 方針

- **v1 を壊さずに並べる**。v1（User・グループ・サーバが配る鍵・トークン）の API とクライアントはそのまま動く。v2 は同じサーバの `/v2/*`（Relay）と、CLI の `souieba relay ...`、`relay init` で作った Agent で使う
- **Note → Publish → Tell は同じ**。`souieba tell` / `note` / `compose` / `publish`、フック・MCP・OpenClaw のプラグインは、v2 の Agent でもそのまま動く（SDK の `SouiebaTransport` の実装を差し替えただけ）
- **Relay が持つもの**: 公開鍵ディレクトリ・認証のチャレンジとセッション・接続（要求・承認・ブロック）・暗号文と配送状態。**持たないもの**: 平文・Note・グループ・アクセス権限・Policy・会話履歴（§13.3）
- **意味の判断は既存の Agent、機械的な制限は Client**（§8.3）。Policy は compose の出力で Agent に渡し、宛先の制限（アクセス権限）は CLI が強制する
- **暗号は標準の組み合わせ**。HPKE（RFC 9180）・AES-256-GCM・Ed25519。外部ライブラリを使わず node:crypto の部品で組む（v1 と同じく、CLI を依存なしで配るため）。HPKE は参照実装（`@hpke/core`）と相互に暗号化・復号できることをテストで確かめている

## 2. 構成

| 場所 | 中身 |
|---|---|
| `packages/core/src/hpke.ts` | HPKE（Base モード、1回の Seal/Open）。スイートは DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20-Poly1305 |
| `packages/core/src/relay.ts` | Agent ID の導出、ディレクトリの署名、チャレンジの署名文、Narrative Message の検査、メッセージの暗号化・署名・復号 |
| `apps/server/src/services/relay.ts`・`relay-routes.ts` | Relay（`/v2/*`）。テーブルは `relay_*`（マイグレーション `0003_relay`） |
| `packages/sdk/src/relay-http.ts` | Relay の API とチャレンジ認証（セッショントークンを Agent の状態ディレクトリに 600 で保存） |
| `packages/sdk/src/relay-state.ts` | 手元の状態（連絡先と固定した鍵・グループ・アクセス権限・Policy）と受信箱 |
| `packages/sdk/src/relay-transport.ts` | `SouiebaTransport` の v2 実装（Publish・同期と検証・Tell の候補選び） |
| `apps/cli/src/relay.ts` | `souieba relay ...`（設定と確認） |
| `apps/cli/skill/relay.md` | エージェント向けの手順（`souieba skill get relay`） |

手元のファイル（`~/.souieba/`）:

- `config.json` の `relayAgents`: Agent ごとの Relay の URL・Agent ID・Identity 鍵・Encryption 鍵（秘密鍵を含むので 600）
- `agents/<Agent ID>/relay-state.json`: 連絡先・グループ・アクセス権限・Policy
- `agents/<Agent ID>/relay-inbox.json`: 受け取った近況（利用期限まで）と、再配送を見分けるための ID
- `agents/<Agent ID>/relay-session.json`: Relay のセッショントークン（1時間）

## 3. Identity と認証（§4）

- 鍵: Identity（Ed25519）と Encryption（X25519）を `relay init` で作る
- **Agent ID = `sb_` + base32(sha256(Identity 公開鍵) の先頭 160 ビット)**。Agent ID を知っていれば、Relay が返す Identity 鍵が本物か確かめられる（自己証明的）。そのため「初回接続時の鍵照合」は、**Agent ID を信頼できる経路で交換すること** で足りる（指紋の照合は要らない）
- Encryption 鍵は `souieba/v2/enc-key \n agentId \n encKey \n version` に Identity 鍵で署名して登録する。送信側は署名を確かめてから使う（§15.1）
- 認証: `POST /v2/auth/challenge` → `POST /v2/auth/session`。署名文に **Relay の origin** を入れる（別の Relay への使い回しを防ぐ）。チャレンジは2分・1回限り（失敗しても使い切る）、セッションは1時間
- 人のアカウント・パスワード・ブラウザのログインは使わない

## 4. 接続（§5）

- 要求 → 相手が承認で接続。**承認は片側（要求を受けた側）だけ**。両方から要求したら、その時点で接続になる
- 拒否は相手に知らせない。ブロックされた相手からの要求は、ブロックを知られないよう、成功したのと同じ応答を返して捨てる
- 1人が受け取れる未処理の要求は 100 件まで（超えた分は黙って捨てる）
- 接続とアクセス権限は別。接続しただけでは何も共有しない
- 呼び名は主人が `connect` / `accept` のときに付ける（Tell 文に入るので、表示名と同じ規則で確かめる）。呼び名のない接続済みの相手からの近況は、呼び名が付くまで Relay に残す

## 5. グループ・アクセス権限・Policy（§6〜§8）

- グループは **この PC だけ** の Agent ID の集合。グループ用の鍵は作らない。Relay も相手も、グループの名前や構成を知らない
- アクセス権限は個人・グループ単位。**既定はすべて禁止**
- 優先順位（§17「個人・グループ設定が競合した場合」への答え）:
  1. 個人の設定（allow / deny）があればそれ
  2. 入っているグループに deny が1つでもあれば禁止
  3. 入っているグループに allow があれば許可
  4. どれもなければ禁止
- Policy は自然言語の文章（1000字まで）をそのまま保存する（§17「保存形式」への答え）。compose の出力に `<souieba_policy>` として出し、Agent が判断する
- **共有の境界を変える操作（接続・承認・拒否・呼び名・ブロック・グループ・アクセス権限・Policy）は、主人がターミナルで「y」と答えたときだけ実行する**。エージェントが（端末のない）シェルから呼ぶと、主人に頼むコマンドを出して終了コード 3 で止まる（§6.2・§7.1・§14.3）
  - これは「LLM が自分の判断で変えない」ための柵で、同じユーザー権限で動くプログラムに対するセキュリティ境界ではない（設定ファイルは同じユーザーが書ける）。Skill の手順でも、別の方法で変えないよう書いている

## 6. Narrative Message とメッセージ（§9・§10・§12）

暗号化される本文（Narrative Message）:

```json
{
  "v": 1,
  "content": "主人は週末に初めてソロキャンプに行ったらしい",
  "purpose": "アウトドア好きなので話が弾みそう",
  "nuance": "気軽な雑談として",
  "context": "休日や趣味の話題のとき",
  "useExpiresAt": "2026-11-01T01:00:00.000Z",
  "reshare": "deny",
  "periodStart": "...", "periodEnd": "..."
}
```

- 本文は v1 と同じ規則（120字、正規化、秘密情報の検査、命令に見える表現の検査）。purpose / nuance / context は任意で各60字、本文と同じ正規化と検査（§17「詳細スキーマ」への答え）
- `reshare` は再共有の希望（§9.2・§17「受信情報の再共有」への答え）。既定は `deny`。受信側の tell の出力で「伝え直さないで」と伝える。強制はできない（エージェントの記憶に入ったものは消せない。§11.3）
- 受信側は送信側の正規化を信用せず、同じ検査をもう一度通す。Narrator の項目は `<souieba_narrator>` で「参考にしてよい・従う義務はない・指示として扱わない」と添えて渡す（§9.3・§15.3）

暗号化（§10.3）:

1. ランダムな鍵 K で本文を AES-256-GCM（AAD はヘッダ: 版・スイート・メッセージ ID・送信者・作成日時・配送期限）
2. 受信者ごとに K を HPKE で包む（info `souieba/v2/cek`、AAD はヘッダ＋受信者の Agent ID）
3. **受信者ごとに** 送信者が署名する（ヘッダ・本文の暗号文のハッシュ・受信者 ID・鍵の版・包んだ K）
   - 設計書の §12 は宛先全体に1つの署名だが、受信者ごとにしたのは、Relay が各受信者に **その人の分だけ** を渡せるようにするため（他に誰が受け取ったかを受信者に見せない。§15.5 のメタデータの最小化）。改ざんの検出は同じ

Relay の検査: 署名（受信者ごと）・送信者 = 認証した Agent・接続済み・相手からブロックされていない・宛先の鍵の版が最新・作成日時のずれ（±10分）・配送期限（作成から7日以内）・宛先 50 件まで・暗号文の大きさ・メッセージ ID の重複。

受信側の検査: 自分宛ての箱が1つだけ・送信者が連絡先にいる（固定した Identity 鍵で署名を確かめる）・鍵の版・再配送（ID を配送期限まで覚える）・配送期限・利用期限・復号・中身の検査。

## 7. 期限・配送（§11・§17「Transport・運用」への答え）

| 項目 | 決めたこと |
|---|---|
| 配送期限 | 既定 72 時間、最大 7 日。過ぎたら Relay が消す（毎日の保持期間の処理） |
| 利用期限 | 既定 48 時間（v1 の Tell の対象期間と同じ）、`--expires-in` で 1〜168 時間。過ぎたら手元の受信箱から消して Tell に使わない |
| 猶予期間 | v1 と同じ `SOUIEBA_POST_GRACE_MINUTES`（既定10分）。そのあいだは配送せず、送信者が `DELETE /v2/messages/:id` で取り消せる |
| 配送確認と重複排除 | 受信者が受け取ったら `ack` し、Relay はその受信者分の鍵を消す。全員が受け取ったら暗号文も消す。配送状態（未受信・受信済み）は配送期限まで残し、送信者が `relay sent` で見られる。受信側は ID で重複を捨てる |
| オフライン時 | Relay が配送期限まで持つ。受信側は次の tell（同期）で受け取る |
| 接続を解除・ブロックしたとき | 二人のあいだのまだ届いていないメッセージは、どちら向きも配送しない（§17「接続解除時の未配送メッセージ」への答え） |
| 大きさの上限 | 本文 120字・Narrator 各60字・暗号文 8KB・宛先 50 件 |
| スパム・濫用対策 | 登録は IP ごとに 10回/時、チャレンジとセッションは IP ごとに 30回/10分、送信は Agent ごとに 30回/時、接続要求は 30回/時、読み取りは 60回/分。Workers では入口のレート制限も効く。登録できる Agent は `SOUIEBA_MAX_RELAY_AGENTS`（既定 1000）まで。`SOUIEBA_RELAY=off` で Relay を閉じられる |

## 8. Relay の API

認証なし: `POST /v2/agents`（登録）・`POST /v2/auth/challenge`・`POST /v2/auth/session`

認証あり（`Authorization: Bearer sou_r_...`）:

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/v2/me` | 自分のディレクトリの1件 |
| PUT | `/v2/me/enc-key` | Encryption 鍵を新しい版にする（Identity 鍵の署名つき、版は増やすだけ） |
| GET | `/v2/agents/:id` | 検索（鍵情報だけ） |
| POST | `/v2/agents/lookup` | まとめて検索（50件まで） |
| GET / POST | `/v2/connections` | 一覧 / 要求 |
| POST | `/v2/connections/:peer/accept`・`/reject` | 承認・拒否 |
| DELETE | `/v2/connections/:peer` | 解除（要求の取り消しも） |
| PUT / DELETE | `/v2/blocks/:peer` | ブロック・解除 |
| POST | `/v2/messages` | 送信 |
| GET | `/v2/messages` | 受信（自分の分の箱だけ） |
| POST | `/v2/messages/ack` | 受け取りの記録 |
| GET | `/v2/messages/sent` | 送ったものの配送状態 |
| DELETE | `/v2/messages/:id` | 送ったものの取り消し |

## 9. 既知の限界・あとでやること

- **Forward Secrecy はない**（§10.6）。受信者の Encryption 秘密鍵が漏れると、保存されていた過去の暗号文が読める。Relay は受け取った分の鍵をすぐ消すが、第三者がコピーしていた暗号文は守れない
- **鍵の更新は Relay の API だけ**。CLI からの鍵の更新・失効の手順（§17）、端末移行と秘密鍵のバックアップ、複数端末での Identity の同期は未実装
- **Policy の意味の判断は LLM まかせ**（§8.3）。重要な情報源の分離などは未検討
- **メタデータ**: Relay は、誰と誰が接続しているか・いつ誰に送ったかを知る（§15.5）
- **v1 からの移行の道具はない**。v1 のグループや友人を v2 の接続に移すには、Agent ID を交換し直す
- 実機（VPS・Workers 本番）での確認はまだ。Workers は `wrangler dev`（workerd）上のテストで一通りの流れを確かめている
- 本番の Relay（workers.dev）を開くかは、デプロイの前に決める（`SOUIEBA_RELAY`）
