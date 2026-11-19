# エージェントに任せる範囲（委任）

主人が範囲と期限を決めて任せると、エージェントは、その範囲の中の「共有を広げる操作」を1回ごとの同意なしで実行できる。このファイルは、任せられる範囲、任せ方・取り消し方、記録と知らせ方、この仕組みの限界を決める。広げる操作・狭める操作の定義と、通常の2段階（1回ごとの同意）は [projects.md](projects.md) の 5 章にある。

共有の設定をエージェントに変えてもらう方法は2つある。

1. **1回ごとの同意**。CLI は `--yes`、MCP は `confirm: true`。シェルのない MCP クライアント（Claude Desktop など）のために、設定の操作を MCP のツールとしても出す（`souieba_relay_*`）。中身は CLI と同じで、同じ2段階・同じ記録を使う。
2. **任せる範囲**（このファイル）。主人が範囲と期限を決めて任せると、その範囲の中の広げる操作は、1回ごとの同意なしで実行できる。

## 1. 範囲

| 範囲（CLI） | 入る操作 |
|---|---|
| `audience --project P` | プロジェクト P の共有先: 連絡先・グループの allow / deny / reset |
| `policy --project P` | プロジェクト P の共有方針の set / clear |
| `dirs --project P`（default 以外） | プロジェクト P のディレクトリの付け外し。ほかのプロジェクトからディレクトリを取ってくるときは、そちらの `dirs` も要る。MCP クライアントの規則を作る操作（`mcp-client set`）、プロジェクトの説明（`project describe`）、推定を受け付ける設定（`project inference on`）も、対象のプロジェクトの `dirs` に入る（メモが入るプロジェクトを変える操作のため） |
| `members <グループ>` | グループのメンバーの出し入れ。そのグループを許可しているどのプロジェクトにも効くことを、主人に見せる文面に書く |
| `accept` | 届いた接続要求の承認。承認しても共有は始まらない（共有には別に allow が要る） |

- 範囲は5種類で、どれも「範囲そのものを作る・広げる」ことを含まない。default プロジェクトにはディレクトリがないので、`dirs` は任せられない。
- 1つの操作が複数の範囲にかかるときは、すべてを任されているときだけ通す。
- 範囲に入らない広げる操作は、いつも1回ごとの同意が要る: `connect`・`unblock`・プロジェクトの作成と削除・`unresolved default`・`note move`・`project pin`。範囲の外のプロジェクトの設定も同じ。
- ホームディレクトリやその上のディレクトリを足す操作（ほとんどの作業場所が入ってしまう）は、`dirs` を任されていても1回ごとの同意が要る。

## 2. 決まり

- **任せる（範囲を作る・期限を延ばす）のは主人だけ。**
  - TUI（`souieba ui`）で行う。プロジェクトのタブに P の範囲（`audience`・`policy`、default 以外は `dirs`）、「連絡先」のタブに `accept` と各グループの `members` を出す。範囲の行で Enter を押し、期限を選び、y と答える。
  - または端末（TTY）での `souieba delegate grant ...` に y と答える。`--yes` を付けても端末で聞き、端末でなければ断る（終了コード 4）。`--yes` を付け直しても通らないので、承認待ちの終了コード 3 とは分けている。
  - MCP には任せるツールを出さない。どの範囲も範囲を作ることを含まないので、エージェントは自分の権限を広げられない。
- **取り消すのはどこからでもよい**（狭める操作）。`souieba delegate revoke <範囲>|all`、MCP の `souieba_relay_delegation_revoke`、TUI。
- 期限は `--for 24h`（既定）・`7d`・`forever`。切れた範囲は効かない（`souieba delegate` の一覧には「期限切れ」と出る）。同じ範囲を任せ直すと、期限が置き換わる。
- 任せた範囲で変えたことも `changeLog` に残し（`delegated: true`）、次の `tell` で「（任せた範囲での変更）」と印を付けて主人に知らせる。実行したときの出力にも、任された範囲での変更だと書く。
- プロジェクトの名前を変えると範囲も付いていく。プロジェクト・グループを消すと、その範囲も消える。
- 状態は `relay-state.json` の `delegations` に持つ（状態の版は 3）。

### CLI

```
souieba delegate [list]
souieba delegate grant audience|policy|dirs [--project <名前>] [--for 24h|7d|forever]
souieba delegate grant members <グループ> [--for ...]
souieba delegate grant accept [--for ...]
souieba delegate revoke audience|policy|dirs [--project <名前>] | members <グループ> | accept | all
```

## 3. 限界

これは、だまされた・取り違えたエージェントが主人の意図を越えて共有を広げないための UX のガードレールで、同じユーザー権限で動くプログラムに対するセキュリティ境界ではない。設定ファイルは同じユーザーが書け、端末かどうかも擬似端末でごまかせる。

任せた範囲の中でも、エージェントは主人の言葉による依頼なしに変えてはいけない（ツールの説明とスキルの手引きに書く）。

## なぜこうしたか

- **1回ごとの同意と、範囲を任せる方法の両方を用意した。** 1回ごとの同意は、変更の内容を見て決めたいときのため。任せる範囲は、範囲と期限を決めて、その中の変更を確認なしで進めたいときのため。
- **範囲を小さく、はっきりしたものに限る。** 任せる範囲は「共有先」「Policy」「ディレクトリ」「グループのメンバー」「接続要求の承認」だけにし、どれも「任せる範囲そのものを作る・広げる」ことを含めない。新しい接続の要求・ブロック解除・プロジェクトの作成と削除・メモの付け替えは、範囲に入れない。
- **任せることをエージェントにさせない。** エージェントが自分で権限を広げられると、任せる範囲の意味がなくなる。任せるのは、TUI か、端末の y/N だけにした。
- **取り消しは誰でもできる。** 取り消しは狭める操作で、間違っても漏れない。
- **任せた範囲での変更も、主人に知らせる。** だまされたエージェントに設定を変えられても、主人が気づけるようにするため。

## 関連するコード

- `apps/cli/src/relay-ops/delegation.ts` — 任せる・取り消す・範囲の中か・変更の記録
- `apps/cli/src/relay-ops/helpers.ts` — 範囲の読み取り（`parseScope`）、期限（`DELEGATION_TERMS`）、ディレクトリの付け外しの範囲（`dirScopes`）
- `apps/cli/src/relay-ops/access.ts`・`projects.ts`・`contacts.ts` — 操作ごとの `scopes`
- `apps/cli/src/relay.ts` — 実行の流れ（`ownerOnly` の扱い・任された範囲での実行）、`commands/person.ts` — 終了コード 3・4
- `packages/sdk/src/relay-state.ts` — `Delegation`・`DelegationScope`・`delegationCovers`・`SettingsChange`
- `packages/sdk/src/relay-transport.ts` — 次の tell への知らせ（`takeNotices`）
- `apps/cli/src/integrations/mcp/relay-tools.ts` — MCP の取り消しツール
- `apps/cli/src/relay-tui.ts` — TUI の任せる・取り消す操作
