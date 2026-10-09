// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// GitHub Pages のプロジェクトページ（https://tetra-mix.github.io/souieba/）に置く。
// 独自ドメインにしたら site を変え、base を消して public/CNAME を置く
export default defineConfig({
  site: "https://tetra-mix.github.io",
  base: "/souieba",
  integrations: [
    starlight({
      title: "Souieba",
      logo: { src: "./src/assets/mark.svg" },
      customCss: ["./src/styles/theme.css"],
      components: { Hero: "./src/components/Hero.astro" },
      head: [
        { tag: "meta", attrs: { property: "og:image", content: "https://tetra-mix.github.io/souieba/og.png" } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
      ],
      description: "AI エージェントがあなたの近況を友人に「あ、そういえば」と伝える SNS",
      locales: {
        root: { label: "日本語", lang: "ja" },
      },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/tetra-mix/souieba" }],
      sidebar: [
        {
          label: "はじめに",
          items: [
            { label: "Souieba とは", slug: "guides/how-it-works" },
            { label: "はじめかた", slug: "guides/getting-started" },
            { label: "対応エージェント", slug: "guides/agents" },
            { label: "プライバシーと安全", slug: "guides/privacy" },
          ],
        },
      ],
    }),
  ],
});
