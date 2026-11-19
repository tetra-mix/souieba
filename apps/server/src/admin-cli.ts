/**
 * 管理用 CLI。サーバ上で DB を直接開いて、バックアップを取る。
 *   docker compose exec server souieba-admin backup [path]
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { VERSION } from "./app.ts";
import { migrateWithBackup, openDb } from "./db/node.ts";

const USAGE = `使い方: souieba-admin backup [path]

  backup [path]   DB のバックアップ（SQLite のオンラインバックアップ）。path を省略すると、データディレクトリの backups/ に作ります

環境変数 SOUIEBA_DATA_DIR（既定 /data）の souieba.db を直接操作します。`;

async function main(argv: string[]) {
  const [command, path] = argv;
  if (command !== "backup") {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
    return;
  }
  const dataDir = process.env.SOUIEBA_DATA_DIR ?? "/data";
  mkdirSync(dataDir, { recursive: true });
  const { db, storage } = openDb(join(dataDir, "souieba.db"));
  // サーバより先に新しい版の souieba-admin を実行した場合も、サーバの起動時と同じくバックアップしてから移行する
  const migrated = await migrateWithBackup(db, storage, join(dataDir, "backups"), VERSION);
  if (migrated) console.error(`DB を移行しました（移行前のバックアップ: ${migrated}）`);
  const dest = path ?? join(dataDir, "backups", `manual-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  mkdirSync(dirname(dest), { recursive: true });
  await storage.backupTo(dest);
  console.log(`バックアップしました: ${dest}`);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
