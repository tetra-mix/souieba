// CLI（apps/cli/package.json）・サーバ（apps/server/src/app.ts の VERSION）・スキル（skills/souieba/SKILL.md）の
// バージョンが揃っているかを確かめる。リリースのワークフローでは、タグ（v0.4.0 など）とも比べる。
//   node scripts/check-version.mjs [タグ]
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

const versions = {
  "apps/cli/package.json": JSON.parse(read("apps/cli/package.json")).version,
  "apps/server/src/app.ts": /export const VERSION = "([^"]+)"/.exec(read("apps/server/src/app.ts"))?.[1],
  "skills/souieba/SKILL.md": /^version:\s*(\S+)\s*$/m.exec(read("skills/souieba/SKILL.md"))?.[1],
};
const tag = process.argv[2];
if (tag) versions[`タグ ${tag}`] = tag.replace(/^v/, "");

const expected = versions["apps/cli/package.json"];
const wrong = Object.entries(versions).filter(([, v]) => v !== expected);
if (wrong.length > 0) {
  console.error(`バージョンが揃っていません（apps/cli/package.json は ${expected}）:`);
  for (const [where, v] of wrong) console.error(`  ${where}: ${v ?? "（見つかりません）"}`);
  process.exit(1);
}
console.log(`バージョン ${expected}（${Object.keys(versions).join("、")}）`);
