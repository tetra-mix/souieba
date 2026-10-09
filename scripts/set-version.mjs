// CLI（apps/cli/package.json）・サーバ（apps/server/src/app.ts の VERSION）・スキル（skills/souieba/SKILL.md）の
// バージョンを書き換える。MIN_CLIENT_VERSION は API に互換性のない変更をしたときに手で上げるので、ここでは触らない。
//   node scripts/set-version.mjs 0.5.1
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("使い方: node scripts/set-version.mjs <x.y.z>");
  process.exit(1);
}

const root = new URL("../", import.meta.url);
const edit = (p, re, to) => {
  const url = new URL(p, root);
  const before = readFileSync(url, "utf8");
  if (!re.test(before)) {
    console.error(`${p} にバージョンが見つかりません`);
    process.exit(1);
  }
  writeFileSync(url, before.replace(re, to));
};

edit("apps/cli/package.json", /^(\s*"version":\s*")[^"]+(")/m, `$1${version}$2`);
edit("apps/server/src/app.ts", /(export const VERSION = ")[^"]+(")/, `$1${version}$2`);
edit("skills/souieba/SKILL.md", /^(version:\s*)\S+(\s*)$/m, `$1${version}$2`);
console.log(`バージョンを ${version} にしました`);
