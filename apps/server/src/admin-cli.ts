/**
 * 管理用 CLI。2通りの使い方がある。
 *   サーバ上で DB を直接開く:  docker compose exec server souieba-admin create-user --handle alice --name Alice --admin
 *   admin API を HTTP で呼ぶ:  SOUIEBA_ADMIN_TOKEN=... souieba-admin --url https://souieba.example.com list-users
 * HTTP で呼ぶのは、Workers のようにサーバ上でコマンドを実行できない環境のため。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { VERSION } from "./app.ts";
import { migrateWithBackup, openDb } from "./db/node.ts";
import { ApiError } from "./errors.ts";
import * as accounts from "./services/accounts.ts";
import * as groups from "./services/groups.ts";

const USAGE = `使い方: souieba-admin [--url <サーバURL>] <command> [options]

  create-user --handle <h> --name <表示名> [--admin]   ユーザーを作成し、ログインコードを表示
  login-code  --handle <h>                            ログインコードを再発行（古い User トークンは失効）
  invite                                              アカウント作成用の招待コードを発行（どのグループにも入らない）
  list-groups                                         グループ一覧（名前・人数。投稿本文はサーバでは読めません）
  disable-user --handle <h>                           ユーザーを無効化
  list-users                                          ユーザー一覧
  admin-token --handle <h>                            admin 専用トークンを発行（admin API 用。admin のユーザーだけ。古いものは失効）
  backup      [path]                                  DB のバックアップ（SQLite のオンラインバックアップ。--url なしのときだけ）
  bootstrap   --handle <h> --name <表示名>             最初の admin を作る（--url のときだけ。admin が1人もいないあいだだけ）

--url なし: 環境変数 SOUIEBA_DATA_DIR（既定 /data）の souieba.db を直接操作します。
--url あり: admin API を呼びます。トークンは環境変数で渡します（~/.souieba には保存しません）。
  SOUIEBA_ADMIN_TOKEN       admin 専用トークン（bootstrap 以外）
  SOUIEBA_BOOTSTRAP_TOKEN   サーバに設定したブートストラップ用の秘密（bootstrap のとき）
  CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET   Cloudflare Access の service token（かけている場合）`;

type UserView = { id: string; handle: string; displayName: string; role: string; disabledAt?: string | null };
type GroupView = { id: string; name: string; memberCount: number; createdAt: string };
type Login = { loginCode: string; expiresAt: string };

/** DB を直接開く場合と admin API を呼ぶ場合で、同じ操作をそろえる */
type Backend = {
  createUser(handle: string, displayName: string, admin: boolean): Promise<{ user: UserView } & Login>;
  loginCode(handle: string): Promise<Login>;
  invite(): Promise<{ code: string; expiresAt: string }>;
  listGroups(): Promise<GroupView[]>;
  disableUser(handle: string): Promise<void>;
  listUsers(): Promise<UserView[]>;
  adminToken(handle: string): Promise<string>;
  bootstrap(handle: string, displayName: string): Promise<{ user: UserView; adminToken: string } & Login>;
  backup(path?: string): Promise<string>;
};

async function localBackend(): Promise<Backend> {
  const dataDir = process.env.SOUIEBA_DATA_DIR ?? "/data";
  mkdirSync(dataDir, { recursive: true });
  const { db, storage } = openDb(join(dataDir, "souieba.db"));
  // サーバより先に新しい版の souieba-admin を実行した場合も、サーバの起動時と同じくバックアップしてから移行する
  const backup = await migrateWithBackup(db, storage, join(dataDir, "backups"), VERSION);
  if (backup) console.error(`DB を移行しました（移行前のバックアップ: ${backup}）`);
  const now = new Date();
  const userByHandle = (handle: string) => {
    const u = accounts.getUserByHandle(db, handle);
    if (!u) throw new Error(`ユーザー ${handle} が見つかりません`);
    return u;
  };
  const view = (u: accounts.UserRow): UserView => ({ ...accounts.publicUser(u), disabledAt: u.disabledAt });
  return {
    async createUser(handle, displayName, admin) {
      return db.transaction(() => {
        const u = accounts.createUser(db, { handle, displayName, role: admin ? "admin" : "member" }, now);
        const { code, expiresAt } = accounts.issueLoginCode(db, u.id, now);
        return { user: view(u), loginCode: code, expiresAt };
      });
    },
    async loginCode(handle) {
      const { code, expiresAt } = accounts.issueLoginCode(db, userByHandle(handle).id, now);
      return { loginCode: code, expiresAt };
    },
    async invite() {
      return accounts.createAccountInvite(db, now);
    },
    async listGroups() {
      return groups.listAllGroups(db);
    },
    async disableUser(handle) {
      accounts.disableUser(db, userByHandle(handle).id, now);
    },
    async listUsers() {
      return accounts.listUsers(db).map(view);
    },
    async adminToken(handle) {
      return accounts.issueAdminToken(db, userByHandle(handle).id, now);
    },
    async bootstrap() {
      throw new Error("bootstrap は --url と使います。サーバ上では create-user --admin と admin-token を使ってください");
    },
    async backup(path) {
      const dest = path ?? join(dataDir, "backups", `manual-${now.toISOString().replace(/[:.]/g, "-")}.db`);
      mkdirSync(join(dest, ".."), { recursive: true });
      await storage.backupTo(dest);
      return dest;
    },
  };
}

function httpBackend(baseUrl: string): Backend {
  const base = baseUrl.replace(/\/+$/, "");
  const accessHeaders: Record<string, string> =
    process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
      ? { "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET }
      : {};

  async function call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const token = process.env.SOUIEBA_ADMIN_TOKEN;
    if (auth && !token) throw new Error("環境変数 SOUIEBA_ADMIN_TOKEN に admin 専用トークンを設定してください");
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...accessHeaders,
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as Record<string, any>) : {};
    if (!res.ok) throw new Error(`${method} ${path}: ${data.error?.message ?? `HTTP ${res.status}`}`);
    return data as T;
  }
  const enc = encodeURIComponent;

  return {
    createUser: (handle, displayName, admin) => call("POST", "/v1/admin/users", { handle, displayName, admin }),
    loginCode: (handle) => call("POST", `/v1/admin/users/${enc(handle)}/login-code`),
    invite: () => call("POST", "/v1/admin/invites"),
    listGroups: async () => (await call<{ groups: GroupView[] }>("GET", "/v1/admin/groups")).groups,
    disableUser: async (handle) => void (await call("POST", `/v1/admin/users/${enc(handle)}/disable`)),
    listUsers: async () => (await call<{ users: UserView[] }>("GET", "/v1/admin/users")).users,
    adminToken: async (handle) => (await call<{ adminToken: string }>("POST", `/v1/admin/users/${enc(handle)}/admin-token`)).adminToken,
    async bootstrap(handle, displayName) {
      const token = process.env.SOUIEBA_BOOTSTRAP_TOKEN;
      if (!token) throw new Error("環境変数 SOUIEBA_BOOTSTRAP_TOKEN に、サーバに設定した値を入れてください");
      return call("POST", "/v1/admin/bootstrap", { token, handle, displayName }, false);
    },
    async backup() {
      throw new Error("backup はサーバ上（--url なし）でだけ使えます。Workers では Durable Object の PITR を使ってください");
    },
  };
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      handle: { type: "string" },
      name: { type: "string" },
      admin: { type: "boolean", default: false },
    },
  });
  const [command, ...args] = positionals;
  if (!command) {
    console.log(USAGE);
    return;
  }
  const url = values.url ?? process.env.SOUIEBA_ADMIN_URL;
  const backend = url ? httpBackend(url) : await localBackend();
  const handle = () => {
    if (!values.handle) throw new Error("--handle が必要です");
    return values.handle;
  };
  const name = () => {
    if (!values.name) throw new Error("--name が必要です");
    return values.name;
  };

  switch (command) {
    case "create-user": {
      const r = await backend.createUser(handle(), name(), values.admin);
      console.log(`ユーザー @${r.user.handle}（${r.user.role}）を作成しました。`);
      console.log(`ログインコード: ${r.loginCode}（${r.expiresAt} まで有効）`);
      console.log(`利用者の PC で: souieba login <サーバURL> --code ${r.loginCode}`);
      break;
    }
    case "login-code": {
      const r = await backend.loginCode(handle());
      console.log(`ログインコード: ${r.loginCode}（${r.expiresAt} まで有効）`);
      break;
    }
    case "invite": {
      const { code, expiresAt } = await backend.invite();
      console.log(`招待コード: ${code}（${expiresAt} まで有効、1回限り）`);
      console.log(`利用者の PC で: souieba login <サーバURL> --code ${code} --handle <handle> --name <表示名>`);
      console.log("参加した人は souieba groups create <名前> でグループを作れます。");
      break;
    }
    case "list-groups": {
      const rows = await backend.listGroups();
      if (rows.length === 0) console.log("（グループはありません）");
      for (const g of rows) console.log(`${g.id}\t${g.name}\t${g.memberCount}人\t${g.createdAt}`);
      break;
    }
    case "disable-user": {
      await backend.disableUser(handle());
      console.log("無効化しました");
      break;
    }
    case "list-users": {
      for (const u of await backend.listUsers()) {
        console.log(`${u.id}\t@${u.handle}\t${u.displayName}\t${u.role}${u.disabledAt ? "\t(disabled)" : ""}`);
      }
      break;
    }
    case "admin-token": {
      const token = await backend.adminToken(handle());
      console.log(`admin 専用トークン: ${token}`);
      console.log(`@${handle()} の古い admin 専用トークンは失効しました（自分のものなら SOUIEBA_ADMIN_TOKEN を差し替えてください）。`);
      console.log(
        "このトークンは admin API にだけ使えます。パスワードマネージャーなどに保管し、エージェントが読める場所には置かないでください。",
      );
      break;
    }
    case "bootstrap": {
      const r = await backend.bootstrap(handle(), name());
      console.log(`最初の admin @${r.user.handle} を作成しました。`);
      console.log(`admin 専用トークン: ${r.adminToken}`);
      console.log(`  → 以降は SOUIEBA_ADMIN_TOKEN に設定して souieba-admin --url ${url} <command> で管理します`);
      console.log(`ログインコード: ${r.loginCode}（${r.expiresAt} まで有効）`);
      console.log(`  → 利用者として使うときは、自分の PC で: souieba login ${url} --code ${r.loginCode}`);
      break;
    }
    case "backup": {
      console.log(`バックアップしました: ${await backend.backup(args[0])}`);
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof ApiError || err instanceof Error ? err.message : err);
  process.exit(1);
});
