---
name: Souieba
description: 開発者向けサービスの定番（Vercel・Linear）に並ぶ、無彩色と細い罫線の世界。色は控えめな青ひとつ。
colors:
  sl-color-white: "hsl(0, 0%, 98%)"
  sl-color-gray-1: "hsl(240, 5%, 88%)"
  sl-color-gray-2: "hsl(240, 5%, 70%)"
  sl-color-gray-3: "hsl(240, 4%, 52%)"
  sl-color-gray-4: "hsl(240, 4%, 32%)"
  sl-color-gray-5: "hsl(240, 4%, 17%)"
  sl-color-gray-6: "hsl(240, 5%, 9%)"
  sl-color-black: "hsl(0, 0%, 4%)"
  sl-color-accent-low: "hsl(214, 60%, 16%)"
  sl-color-accent: "hsl(212, 100%, 62%)"
  sl-color-accent-high: "hsl(212, 100%, 80%)"
  sb-border: "hsl(240, 4%, 16%)"
  sb-surface: "hsl(240, 5%, 7%)"
  sb-tell: "hsl(212, 100%, 72%)"
  light-sl-color-white: "hsl(240, 10%, 6%)"
  light-sl-color-gray-1: "hsl(240, 6%, 14%)"
  light-sl-color-gray-2: "hsl(240, 5%, 28%)"
  light-sl-color-gray-3: "hsl(240, 4%, 44%)"
  light-sl-color-gray-4: "hsl(240, 4%, 62%)"
  light-sl-color-gray-5: "hsl(240, 5%, 87%)"
  light-sl-color-gray-6: "hsl(240, 5%, 94%)"
  light-sl-color-gray-7: "hsl(240, 5%, 97%)"
  light-sl-color-black: "hsl(0, 0%, 100%)"
  light-sl-color-accent-low: "hsl(212, 100%, 94%)"
  light-sl-color-accent: "hsl(212, 100%, 45%)"
  light-sl-color-accent-high: "hsl(214, 100%, 35%)"
  light-sb-border: "hsl(240, 5%, 89%)"
  light-sb-surface: "hsl(240, 5%, 98%)"
  light-sb-tell: "hsl(212, 100%, 42%)"
typography:
  display:
    fontFamily: "Geist Variable, Noto Sans JP Variable, Hiragino Sans, Yu Gothic UI, Meiryo"
    fontSize: "clamp(2.25rem, 1.3rem + 4.2vw, 4.25rem)"
    fontWeight: 600
    lineHeight: 1.12
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Geist Variable, Noto Sans JP Variable, Hiragino Sans, Yu Gothic UI, Meiryo"
    fontSize: "clamp(1.6rem, 1.1rem + 1.8vw, 2.5rem)"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Geist Variable, Noto Sans JP Variable, Hiragino Sans, Yu Gothic UI, Meiryo"
    fontSize: "1.125rem"
    fontWeight: 600
    letterSpacing: "-0.01em"
  lead:
    fontFamily: "Geist Variable, Noto Sans JP Variable, Hiragino Sans, Yu Gothic UI, Meiryo"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.75
  body:
    fontFamily: "Geist Variable, Noto Sans JP Variable, Hiragino Sans, Yu Gothic UI, Meiryo"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.8
  label:
    fontFamily: "Geist Variable, Noto Sans JP Variable, Hiragino Sans, Yu Gothic UI, Meiryo"
    fontSize: "0.875rem"
    fontWeight: 500
  mono:
    fontFamily: "Geist Mono Variable, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.75
  mono-sm:
    fontFamily: "Geist Mono Variable, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
rounded:
  sm: "0.4rem"
  md: "0.5rem"
  lg: "0.75rem"
  full: "50%"
spacing:
  gap: "0.75rem"
  panel-x: "1.5rem"
  panel-y: "1.75rem"
  block: "3rem"
  hero-gap: "3.5rem"
  section: "7rem"
  coda: "8rem"
components:
  button-primary:
    backgroundColor: "{colors.sl-color-white}"
    textColor: "{colors.sl-color-black}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 1.1rem"
    height: "2.5rem"
  button-primary-hover:
    backgroundColor: "{colors.sl-color-gray-1}"
  button-secondary:
    backgroundColor: "{colors.sl-color-black}"
    textColor: "{colors.sl-color-white}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 1.1rem"
    height: "2.5rem"
  terminal-body:
    backgroundColor: "{colors.sb-surface}"
    textColor: "{colors.sl-color-gray-1}"
    typography: "{typography.mono}"
    rounded: "{rounded.lg}"
    padding: "1.75rem 2rem 2rem"
  terminal-tell:
    textColor: "{colors.sb-tell}"
  panel-group:
    backgroundColor: "{colors.sl-color-black}"
    rounded: "{rounded.lg}"
    padding: "1.75rem 1.5rem"
  command-block:
    backgroundColor: "{colors.sb-surface}"
    textColor: "{colors.sl-color-gray-1}"
    typography: "{typography.mono-sm}"
    rounded: "{rounded.md}"
    padding: "0.7rem 0.9rem"
  step-number:
    textColor: "{colors.sl-color-gray-2}"
    typography: "{typography.mono-sm}"
    rounded: "{rounded.sm}"
    size: "1.75rem"
  coda:
    backgroundColor: "{colors.sb-surface}"
    rounded: "{rounded.lg}"
    padding: "4rem 1.5rem"
---

# Design System: Souieba

## Overview

**Creative North Star: "端末の最後の一行"**

Souieba の見た目は、開発者向けサービスの定番（Vercel・Linear）にそのまま並ぶことを目指す。皮肉も独自の比喩も持ち込まない。ほぼ黒（ライトでは白）の無地の地に、zinc 系のグレーの文字と 1px の細い罫線だけで面を区切り、主役は製品そのもの、つまり端末の中の会話に置く。その会話の最後に、友人の近況が「あ、そういえば」と青い一行で届く。この一行のために、ページの他の部分はすべて無彩色で静かにしてある。

密度は中くらい。見出しは中央揃えで大きく、文字詰めは強め（字間をマイナスに）。本文と説明は小さめのグレーで、読ませる量を絞る。中身のまとまりは、角丸 12px の外枠を一つ持ち、その内側を 1px の罫線で仕切るパネルで見せる。影も、グラデーションも、背景の模様も使わない。

ダークが既定（`:root`）で、ライトは `:root[data-theme="light"]` で同じ役割の値を反転させる。どちらの面でも、役割の名前（`--sl-color-*`, `--sb-*`）は同じで、値だけが入れ替わる。以前の「駅の伝言板」「手紙」の世界は、ユーザーが「AI っぽい」として退けた。

**Key Characteristics:**
- 無彩色の地と文字、zinc 系グレーの段階で階層を作る
- 1px の罫線（`--sb-border`）で区切り、影は使わない
- 色は青ひとつ。リンク、フォーカス、そして端末の Tell の一行だけ
- Geist / Geist Mono、日本語は Noto Sans JP。見出しは 600 で字間を詰める
- 端末ウィンドウと実際のコマンドを、図版の代わりに主役にする

## Colors

無彩色の zinc スケールに、控えめな青を一つだけ足した二面（ダーク既定・ライト）の配色。frontmatter の `light-` 接頭辞はライトテーマでの同じ変数の値を表す。

### Primary
- **控えめな青**（`sl-color-accent` / ライトは `light-sl-color-accent`）: リンク、`:focus-visible` の 2px アウトライン、`accent-color`・`caret-color`、選択範囲（30% に薄めて）に使う。面を塗るためには使わない。
- **Tell の青**（`sb-tell` / `light-sb-tell`）: 端末の最後の一行、友人の近況の文だけに使う専用の色。ダークではアクセントより明るく、ライトでは少し深くして、等幅の小さな文字でも地に対して読めるようにしてある。
- **淡い青と濃い青**（`sl-color-accent-low`, `sl-color-accent-high`）: Starlight の部品（ガイドページの注記、現在地の表示など）が使う段階。独自部品からは直接使わない。

### Neutral
- **地**（`sl-color-black`）: ページの地と、パネルの既定の面。ダークでほぼ黒、ライトで純白。
- **一段上の面**（`sb-surface`）: 端末ウィンドウ、コマンドの枠、結びの箱、表の右列。地との差はわずかで、罫線と組み合わせて初めて面として見える。
- **罫線**（`sb-border`）: すべての 1px の枠と仕切り。Starlight の灰色段階とは別に、より地に近い値で持つ。
- **文字（最も強い）**（`sl-color-white`）: 見出し、主ボタンの面、端末の利用者の発言。
- **本文グレー**（`sl-color-gray-1`, `sl-color-gray-2`）: 端末の出力やコマンド、リストの項目。
- **説明グレー**（`sl-color-gray-3`）: tagline、lead、カードの説明文、キャプション、端末のプロンプト記号。
- **控えめな印**（`sl-color-gray-4`, `sl-color-gray-5`）: `$` の記号、リストの短い横線、端末のウィンドウの丸、スクロールバー。
- **Starlight の面**（`sl-color-gray-6`, `light-sl-color-gray-7`）: ヘッダーやサイドバーなど Starlight が塗る面。

### Named Rules
**The One Blue Rule.** 色相を持つのは青だけで、使い道はリンク、フォーカス、選択、そして Tell の一行に限る。ヘッダーのロゴ、GitHub アイコン、テーマ切り替えは `!important` で無彩色に戻してある。ボタンもバッジも青く塗らない。

**The Tell Owns Its Color Rule.** `sb-tell` は Tell の文のためだけにある。他の強調に流用すると、ページが見せたい一行が埋もれる。

## Typography

**Display Font:** Geist Variable（日本語は Noto Sans JP Variable、続いて Hiragino Sans, Yu Gothic UI, Meiryo）
**Body Font:** 同じ（`--sl-font`）
**Label/Mono Font:** Geist Mono Variable（ui-monospace, SFMono-Regular, Menlo）

**Character:** 開発者向けの定番どおり、癖のない幾何学的なサンセリフと、それに揃えた等幅。日本語は Noto Sans JP に任せ、和欧で字面の重さがずれないようにしている。

### Hierarchy
- **Display**（600, `clamp(2.25rem, 1.3rem + 4.2vw, 4.25rem)`, 1.12, 字間 -0.035em）: トップのヒーロー見出しだけ。最大幅 14em、中央揃え。
- **Headline**（600, `clamp(1.6rem, 1.1rem + 1.8vw, 2.5rem)`, 1.25, 字間 -0.02em）: トップの節見出し（中央揃え）。結びの見出しは同じ性格で一段小さい `clamp(1.5rem, 1.1rem + 1.6vw, 2.25rem)`, 1.3。ガイドページの h1〜h3 も 600 と -0.02em を受け継ぐ。
- **Title**（600, 1.125rem, 字間 -0.01em）: パネルの中の小見出し（コマンドの各段）。表の列見出しは 1rem。
- **Lead**（400, 1.125rem, 1.75, `sl-color-gray-3`）: 見出しの下に一文だけ添える説明。最大幅 34rem、中央揃え。ヒーローの tagline も同じ幅と行間で、画面幅に応じて 1rem〜1.25rem。
- **Body**（400, 0.875rem, 1.7〜1.8）: パネル内の説明文とリスト。ガイドページの本文は Starlight の 1rem のまま。
- **Label**（500, 0.875rem）: ボタンの文字。
- **Mono**（400, 0.875rem, 1.75）: 端末の本文。コマンドの枠、端末のタイトル、手順番号、ツール出力は 0.8125rem。

### Named Rules
**The Tight Heading Rule.** 見出しはすべて 600 で、字間はマイナス（表示用 -0.035em、節 -0.02em、小見出し -0.01em）。700 以上の太字は使わない。

**The Phrase Break Rule.** 日本語の見出しと本文は `word-break: auto-phrase` で文節の切れ目で折り、見出しは `text-wrap: balance`、本文は `text-wrap: pretty`。改行で語が割れないことを、字詰めと同じくらい大事にする。

## Layout

Starlight の splash テンプレート（コンテンツ幅 67.5rem）の上に、中央揃えの一列で積む。ヒーローは上下 `clamp(3rem, 2rem + 6vw, 6.5rem)` の余白、見出し群と端末の間は 3.5rem。節見出しの前は 7rem、lead から部品までは 3rem、結びの前は 8rem。ボタンの並びや操作の間隔は 0.75rem。

パネルの内側は横 1.5rem・縦 1.75rem。端末の本文は狭い画面で 1.5rem、50rem 以上で横 2rem に広げる。

レスポンシブの切り替え点は 50rem の一つだけ。それより狭いと、コマンドの3段も表の2列も縦に積み、仕切りの罫線は上辺に移る。広いと横に並べ、仕切りは左辺の罫線になる。

### Named Rules
**The Plain Ground Rule.** 背景は無地。グリッド線、点の模様、グラデーション、光のにじみは置かない（グリッド線は生成 UI の定番の印として検出され、退けた）。パネルの内側の仕切り線は区切りであって背景の模様ではない。

## Elevation & Depth

影を一切使わない平らな系。奥行きは、地（`sl-color-black`）と一段上の面（`sb-surface`）のわずかな明度差と、1px の罫線（`sb-border`）だけで表す。ボタンの hover も影や浮き上がりではなく、面の色（主ボタン）か罫線の色（副ボタン）が変わるだけ。

### Named Rules
**The Line Not Shadow Rule.** 面を区切るのは 1px の罫線。`box-shadow` やドロップシャドウで浮かせない。

## Shapes

角丸は 6〜12px の範囲で、大きさで役割が決まる。ページの中のまとまり（端末ウィンドウ、パネル、結びの箱）は 12px（`rounded.lg`）、手で触る小さめの部品（ボタン、コマンドの枠）は 8px（`rounded.md`）、手順番号の小さな箱は約 6px（`rounded.sm`）。円は端末ウィンドウの3つの丸だけ。

罫線は常に 1px、色は `sb-border`。リストの行頭は記号ではなく、0.4rem × 1px の短い横線（`sl-color-gray-4`）。

マーク（`src/assets/mark.svg`、`public/favicon.svg` と共通）は、角丸 7/32 の黒い四角に 14% の白い縁、白い 2px の線で描いた吹き出しと、その中の青い一本線。テーマに関係なく黒い四角のまま使う。

### Named Rules
**The Shared Border Rule.** 並ぶ項目は、別々のカードにせず、一つの 12px の外枠（`overflow: hidden`）の中を 1px の罫線で仕切る。カードを間隔を空けて並べない。

## Components

部品は少なく、どれも罫線と無彩色でできている。触れるものだけが少し丸く、少し明るい。

### Buttons
- **Shape:** やや丸い角（0.5rem）、高さ 2.5rem、横の余白 1.1rem、文字 0.875rem / 500。
- **Primary:** 文字色の面（`sl-color-white`）に地の色の文字（`sl-color-black`）。ダークでは白いボタン、ライトでは黒いボタンになる。
- **Secondary:** 地の色の面に 1px の `sb-border` の枠、文字は `sl-color-white`。
- **Hover / Focus:** 主ボタンは面が `sl-color-gray-1` に、副ボタンは枠が `sl-color-gray-4` に変わる（0.15s ease-out）。フォーカスはサイト共通の 2px の青いアウトライン（offset 2px）。
- **並べ方:** 主ボタン一つと副ボタン一つを 0.75rem 空けて中央に並べる。ヒーローと結びで同じ部品を使う。

### Cards / Containers
- **Corner Style:** 12px（`rounded.lg`）。
- **Background:** 既定は地の色。比べる2列では、2列目だけ `sb-surface` にして差をつける。
- **Shadow Strategy:** なし（Elevation & Depth を参照）。
- **Border:** 外枠 1px の `sb-border`、内側の仕切りも同じ 1px。
- **Internal Padding:** 横 1.5rem・縦 1.75rem。

### Navigation
Starlight のヘッダーとサイドバーをそのまま使う。サイト名は 600 / -0.02em、ロゴとアイコンは無彩色（`sl-color-white`、hover で `sl-color-gray-2`）。

### Terminal Window（Signature）
この系の主役。タイトルバー（高さ 2.5rem、中央に等幅 0.8125rem の `sl-color-gray-3` のタイトル、左に `sl-color-gray-5` の丸3つ）と本文を、同じ `sb-surface` の面と `sb-border` の枠でつなぎ、外側だけ 12px の角丸にする。本文は Geist Mono 0.875rem / 1.75、行間 0.9rem。利用者の発言は `sl-color-white`、ツールの出力は `sl-color-gray-3` の 0.8125rem、インラインのコードは地の色の小さな枠。最後の行が Tell で、1rem の `sb-tell`。文節ごとに `inline-block` で包み、狭い画面でも文節の切れ目で折る。動きが許される環境では、この一行だけが 0.6s 待ってから 0.9s（`cubic-bezier(0.16, 1, 0.3, 1)`）で 0.35rem 下から現れる。不透明度は 0.35 から始め、最初から読める。下に「会話は例です」のキャプション（0.8125rem、`sl-color-gray-3`、中央）を必ず添える。

### Command Steps（Signature）
番号・小見出し・説明・コマンドを縦に並べた段を、Shared Border の外枠の中に3つ並べる。番号は 1.75rem の正方形の枠（約 6px の角丸、等幅 0.8125rem、`sl-color-gray-2`）。コマンドの枠は `sb-surface` の面に 8px の角丸、等幅 0.8125rem、行頭の `$` は `sl-color-gray-4`。折り返した続きは `$` のあとの位置まで下げる。コマンドの枠は段の下端に揃える。

### Coda
ページの結び。`sb-surface` の面、1px の枠、12px の角丸、内側 4rem 1.5rem の箱に、中央揃えの見出し・一文・ボタンの並びを置く。

## Do's and Don'ts

### Do:
- **Do** 色を足したくなったら、まず `sl-color-gray-1`〜`sl-color-gray-4` の段階で階層を作る。青はリンク、フォーカス、Tell の一行だけに使う。
- **Do** 面の区切りには 1px の `sb-border` を使い、一段上げたいときは `sb-surface` に替える。
- **Do** 並ぶ項目は一つの 12px の外枠に入れ、内側を罫線で仕切る。50rem 未満では縦に積み、仕切りを上辺に移す。
- **Do** 見出しは 600 で字間をマイナスにし、日本語は `word-break: auto-phrase` と `text-wrap: balance` で文節で折る。
- **Do** 製品を見せるときは、架空の画像ではなく端末ウィンドウと実際のコマンドで見せ、例であることをキャプションで明記する。
- **Do** 新しい色を足すときは、ダークの `:root` とライトの `:root[data-theme="light"]` の両方に同じ名前で値を置く。

### Don't:
- **Don't** 背景にグリッド線、点の模様、グラデーション、光のにじみを置かない。
- **Don't** `box-shadow` やドロップシャドウで面を浮かせない。hover でも浮かせない。
- **Don't** 青以外の色相を足さない。ボタン、番号、見出しを青く塗らない。
- **Don't** `sb-tell` を Tell の一行以外に使わない。
- **Don't** 見出しを 700 以上の太字にしない。
- **Don't** 手紙・駅の伝言板などの比喩や、独自の世界観の飾りを持ち込まない（ユーザーが「AI っぽい」として退けた）。
- **Don't** 角丸を 12px より大きくしない。
