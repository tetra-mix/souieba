/**
 * サーバ上で実行する管理用 CLI。
 *   docker compose exec server souieba-admin create-user --handle alice --name Alice --admin
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { migrate, openDb } from "./db.ts";
import * as accounts from "./services/accounts.ts";
import { ApiError } from "./errors.ts";

const USAGE = `使い方: souieba-admin <command> [options]

  create-user --handle <h> --name <表示名> [--admin]   ユーザーを作成し、ログインコードを表示
  login-code  --handle <h>                            ログインコードを再発行（古い User トークンは失効）
  invite                                              アカウント作成用の招待コードを発行（どのグループにも入らない）
  list-groups                                         グループ一覧（名前・人数。投稿本文はサーバでは読めません）
  disable-user --handle <h>                           ユーザーを無効化
  list-users                                          ユーザー一覧
  backup      [path]                                  DB のバックアップ（VACUUM INTO）

環境変数 SOUIEBA_DATA_DIR（既定 /data）の souieba.db を操作します。`;

function main(argv: string[]) {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      handle: { type: "string" },
      name: { type: "string" },
      admin: { type: "boolean", default: false },
    },
  });
  const dataDir = process.env.SOUIEBA_DATA_DIR ?? "/data";
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(join(dataDir, "souieba.db"));
  migrate(db);
  const now = new Date();

  const userByHandle = () => {
    if (!values.handle) throw new Error("--handle が必要です");
    const u = accounts.getUserByHandle(db, values.handle);
    if (!u) throw new Error(`ユーザー ${values.handle} が見つかりません`);
    return u;
  };

  switch (command) {
    case "create-user": {
      if (!values.handle || !values.name) throw new Error("--handle と --name が必要です");
      const u = accounts.createUser(db, { handle: values.handle, displayName: values.name, role: values.admin ? "admin" : "member" }, now);
      const { code, expiresAt } = accounts.issueLoginCode(db, u.id, now);
      console.log(`ユーザー @${u.handle}（${u.role}）を作成しました。`);
      console.log(`ログインコード: ${code}（${expiresAt} まで有効）`);
      console.log(`利用者の PC で: souieba login <サーバURL> --code ${code}`);
      break;
    }
    case "login-code": {
      const u = userByHandle();
      const { code, expiresAt } = accounts.issueLoginCode(db, u.id, now);
      console.log(`ログインコード: ${code}（${expiresAt} まで有効）`);
      break;
    }
    case "invite": {
      const { code, expiresAt } = accounts.createAccountInvite(db, now);
      console.log(`招待コード: ${code}（${expiresAt} まで有効、1回限り）`);
      console.log(`利用者の PC で: souieba login <サーバURL> --code ${code} --handle <handle> --name <表示名>`);
      console.log("参加した人は souieba groups create <名前> でグループを作れます。");
      break;
    }
    case "list-groups": {
      const rows = db
        .prepare(
          `SELECT g.id, g.name, g.created_at, (SELECT count(*) FROM group_members m WHERE m.group_id = g.id AND m.left_at IS NULL) AS n
           FROM groups g ORDER BY g.created_at`,
        )
        .all() as { id: string; name: string; created_at: string; n: number }[];
      if (rows.length === 0) console.log("（グループはありません）");
      for (const g of rows) console.log(`${g.id}\t${g.name}\t${g.n}人\t${g.created_at}`);
      break;
    }
    case "disable-user": {
      accounts.disableUser(db, userByHandle().id, now);
      console.log("無効化しました");
      break;
    }
    case "list-users": {
      for (const u of accounts.listUsers(db)) {
        console.log(`${u.id}\t@${u.handle}\t${u.display_name}\t${u.role}${u.disabled_at ? "\t(disabled)" : ""}`);
      }
      break;
    }
    case "backup": {
      const path = positionals[0] ?? join(dataDir, "backups", `manual-${now.toISOString().replace(/[:.]/g, "-")}.db`);
      mkdirSync(join(path, ".."), { recursive: true });
      db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
      console.log(`バックアップしました: ${path}`);
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof ApiError || err instanceof Error ? err.message : err);
  process.exit(1);
}
