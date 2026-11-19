---
target: astroページ
total_score: 19
max_score: 32
na_heuristics: 7,10
p0_count: 0
p1_count: 3
target_identity: "file:/Users/ryouma/Documents/sechack/souieba/apps/site/src/content/docs"
timestamp: 2026-10-08T14-52-17Z
slug: apps-site-src-content-docs
---
Method: dual-agent (A: design review · B: detector + browser evidence). Chrome extension not connected; no overlay. Evidence from headless Chrome screenshots (1440/390) and detect URL mode. Dark mode not verified.

## Design Health Score: 19/32 (Acceptable). n/a: 7, 10 (Persuade landing)
1 状態 2 / 2 実世界 1 (主人・指紋・E2EE 未定義、図が英語) / 3 制御 3 / 4 一貫性 3 / 5 エラー予防 2 / 6 認識 2 (スマホで図の凡例が切れる) / 8 美的 3 / 9 回復 1 (トラブルシュートなし)

## Specificity: 入れ替え可能（Starlight 標準のまま）。核の「そういえば」体験は index.mdx:31 の小さな引用だけ。
Detector: source 0 件。live 9 件中 8 件が Starlight/Pagefind 由来の誤検知。有効なのは landing の line-length (~135 chars/line)。dist の flat-type-hierarchy ×4 は base path で CSS 未読込の誤検知。

## Priority issues
- [P1] 個性がなく核の体験が見えない → チャットのモック、マーク、favicon(404)、og:image、customCss（/impeccable bolder）
- [P1] モバイルで図が切れる（index.mdx:25, how-it-works.md:11-14） → 縦の HTML/SVG 図、日本語ラベル（/impeccable adapt）
- [P1] 初見の人がサーバの入手で行き止まり（getting-started.md:13） → 招待された / 自分で立てる の分岐（/impeccable onboard）
- [P2] 用語と呼び方の揺れ（主人/あなた、指紋、E2EE）（/impeccable clarify）
- [P2] 安心材料が遅い。トップから privacy へ導線なし。メタデータと鍵の紛失が未記載（/impeccable clarify）

## Personas
Jordan: 名前の意味・主人・指紋・サーバ入手で停止。Riley: 誤投稿の通知、メタデータ、鍵紛失、グループ脱退時の過去投稿。Casey: 図の切れ、GitHub ボタンの孤立、中央寄せ/左寄せの不一致、表見出しの折れ、コードの横スクロール。

## Minor
H2 の文法、タグラインの「そうい/えば」分割、本文の全幅（50字+/行）、和文フォント未指定、seti:lock、og:image なし。

## Questions
トップ自体を体験に？ 誰向け（初見 vs 招待された友人）？ 「主人」はブランドの声か内部用語か？
