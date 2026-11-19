# エラーと対処

- Personがない場合は `souieba init <RelayのURL>` で初期化します。既存の鍵やIDを引き継ぎたい場合は、初期化する前に設定を確認してください。
- `souieba id` で設定中のPerson IDとRelay URLを確認できます。
- 認証や通信に失敗したときは、URLとネットワーク、CLIとRelayのバージョンを確認してください。
- CLIが古い場合は `npm i -g souieba@latest`、スキルが古い場合は `npx skills update` で更新します。
- メモや投稿に秘密情報らしき文字列があると、CLI が書き直しを求めます（終了コード 2。`--json` では `secret_detected`）。該当箇所を除くか、投稿をやめてください。
