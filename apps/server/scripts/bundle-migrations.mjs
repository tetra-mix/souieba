// drizzle-kit が生成したマイグレーション（drizzle/）を、Node と Workers の両方で読み込める TS に埋め込む。
// .sql をそのまま import すると、Node（tsx・vitest・esbuild）と wrangler でそれぞれ設定が要るため。
//   pnpm --filter @souieba/server db:generate --name <名前>
import { readFileSync, writeFileSync } from "node:fs";

const dir = new URL("../drizzle/", import.meta.url);
const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", dir), "utf8"));
const migrations = {};
for (const e of journal.entries) {
  migrations[`m${String(e.idx).padStart(4, "0")}`] = readFileSync(new URL(`${e.tag}.sql`, dir), "utf8");
}
const out = `// 生成ファイル。直接編集しない（scripts/bundle-migrations.mjs）
export const journal = ${JSON.stringify(journal, null, 2)} as const;

export const migrations: Record<string, string> = ${JSON.stringify(migrations, null, 2)};
`;
writeFileSync(new URL("../src/db/migrations.gen.ts", import.meta.url), out);
console.log(`migrations.gen.ts: ${journal.entries.length} 件`);
