import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp, VERSION } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { migrate, openDb, pendingMigrations, schemaVersion } from "./db.ts";
import { runRetention } from "./retention.ts";

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  mkdirSync(join(config.dataDir, "backups"), { recursive: true });
  const db = openDb(join(config.dataDir, "souieba.db"));
  if (pendingMigrations(db) > 0) {
    // 既存の DB をマイグレーションする前に、必ずバックアップを取る
    let backup: string | null = null;
    if (schemaVersion(db) > 0) {
      backup = join(config.dataDir, "backups", `pre-${VERSION}-${Date.now()}.db`);
      db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    }
    migrate(db);
    console.log(JSON.stringify({ level: "info", msg: "migrated", backup }));
  }

  const retention = () => {
    const r = runRetention(db, new Date(), config.postRetentionMs);
    console.log(JSON.stringify({ level: "info", msg: "retention", ...r }));
  };
  retention();
  setInterval(retention, 86_400_000).unref();

  if (config.publicUrl.startsWith("http:")) {
    console.warn(JSON.stringify({ level: "warn", msg: "http で動作しています。VPN が通信路を暗号化していることを確認してください" }));
  }

  const app = createApp({ db, config });
  serve({ fetch: app.fetch, hostname: config.bind, port: config.port }, (info) => {
    console.log(JSON.stringify({ level: "info", msg: "listening", address: info.address, port: info.port, version: VERSION }));
  });
}

main();
