---
version: 1
slug: "src-content-docs-index-mdx"
primary_target: "src/content/docs/index.mdx"
related_targets: []
---

# トップページ（apps/site/src/content/docs/index.mdx）

Mode: Persuade。読み手は招待コードを受け取った友人（多くは AI エージェントを使う開発者）。知りたいのは「これは何か」「自分の生活がどう扱われるか」「どう参加するか」。
行動: はじめかたへ進む。証拠: 実物の素材はなし。端末の会話は架空の例として作り、例と明記する。

## Direction contract

THESIS: 開発者向けサービスの定番（Vercel・Linear）を、皮肉も独自の飾りもなしに、その品質で作る。主役は端末の中の会話で、回答の最後に「あ、そういえば」の一行が出る場面。手紙・伝言板などの比喩は使わない。

OWN-WORLD: 無彩色（ほぼ黒の地と白、zinc 系のグレー）、1px の細い罫線、角丸 6〜12px、影は使わず罫線で区切る。Geist と Geist Mono、日本語は Noto Sans JP。色は控えめな青を1つだけ、リンクと端末の中の Tell の一行に使う。背景は無地（グリッド線は生成 UI の定番の印として検出されたため使わない）。

STORY: 見出しで仕組みを一文で言う → 端末の例で「回答の最後に一行」を見せる → 3つのコマンド（note / compose・publish / tell）で動きを示す → サーバに見えるもの・見えないものを表で正直に示す → はじめかたへ。

FIRST VIEWPORT: 中央揃えの大きな見出し（文字詰め強め）と一文の説明、その下に白い主ボタン「はじめかた」と枠線のボタン「GitHub」。その下に横幅いっぱいの端末ウィンドウ（Claude Code の会話の例）。端末の最後の行が Tell の一文で、青く表示される。

FORM: カテゴリの定番（standing exit / canon）。ユーザーが「開発者によくある感じ」を選び、手本に Vercel・Linear を指定。seed key be34a2eb。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
