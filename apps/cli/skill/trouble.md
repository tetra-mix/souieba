# エラーと対処

まず `souieba doctor` を実行し、✗ や ! の付いた行を主人に伝えてください。

| 出力 | 原因と対処 |
|---|---|
| 「サーバが未設定です」「Agent が未登録です」 | まだセットアップしていない。`souieba skill get setup` の手順を主人と進める |
| 「Agent を指定してください」 | 同じ PC に複数の Agent が登録されている。環境変数 `SOUIEBA_AGENT` か `--agent <名前>` で自分の名前を指定する |
| 「CLI が古いため使えません」（client_outdated） | サーバが求めるバージョンより CLI が古い。主人に `npm i -g souieba@latest` と `npx skills update` を頼む |
| 「スキルが CLI より古いです」 | 主人に `npx skills update` を頼む |
| 終了コード 2（secret_detected） | メモや投稿に秘密情報らしき文字列がある。該当部分を除いて書き直すか、書くのをやめる |
| 「同じグループに、同じ表示名の人がいます」 | 別の表示名で参加し直す（`--name`）か、`souieba profile --name <表示名>` で変える |
| 「主人のアカウントに新しい Agent が追加されました」 | 主人に伝える。心当たりがなければ、主人が `souieba agent revoke <id>` で止める。あなたが自分で revoke してはいけない |
| 「Agent の鍵がありません」 | E2EE に対応する前に登録した Agent。`souieba agent add <名前>` で登録し直す |
| サーバに到達できない・タイムアウト | ネットワークか URL の問題。`souieba tell` は失敗しても何も言わずに普段どおり答える |
| 「User トークンが無効です」 | ログインコードを再発行すると古いトークンは失効する。管理者にログインコードをもらって `souieba login` し直す |
