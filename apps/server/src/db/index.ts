/**
 * DB は Drizzle（drizzle-orm/durable-sqlite）で扱う。
 * Workers では Durable Object の ctx.storage をそのまま、セルフホストでは node:sqlite を同じ形に包んだもの（node.ts）を渡す。
 * どちらも同期 API なので、読んでから書く処理を db.transaction の中でそのまま書ける。
 */
import { sql } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { journal, migrations } from "./migrations.gen.ts";
import * as schema from "./schema.ts";

export type DB = DrizzleSqliteDODatabase<typeof schema>;

/** Durable Object の ctx.storage のうち、Drizzle が使う部分 */
export type SqlStorageLike = {
  sql: { exec(query: string, ...bindings: unknown[]): unknown };
  transactionSync<T>(fn: () => T): T;
};

/** Durable Object の SQLite は、1つの文のバインド変数を100個までしか受け付けない（node:sqlite はもっと多い） */
export const MAX_BOUND_PARAMS = 100;

/** 複数行の INSERT や inArray を、バインド変数の上限に収まる大きさに分ける */
export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function createDb(storage: SqlStorageLike): DB {
  return drizzle(storage as never, { schema });
}

/**
 * drizzle-kit と同じ表（__drizzle_migrations）に、同じく journal の when を created_at として記録する。
 * hash には SQL のハッシュではなくタグ（0.2 系から引き継いだ DB は legacy-v2）を入れる。適用済みかは created_at だけで判断する
 */
const MIGRATIONS_TABLE = "__drizzle_migrations";

function appliedUntil(db: DB): number | null {
  const exists = db.get<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${MIGRATIONS_TABLE}`);
  if (!exists) return null;
  const last = db.get<{ created_at: number }>(
    sql`SELECT created_at FROM ${sql.identifier(MIGRATIONS_TABLE)} ORDER BY created_at DESC LIMIT 1`,
  );
  return last ? Number(last.created_at) : 0;
}

/** ベースライン（0000）にあって、旧スキーマでは無名の一意制約だったインデックス */
const LEGACY_NAMED_UNIQUE = [
  "CREATE UNIQUE INDEX IF NOT EXISTS `users_handle_unique` ON `users` (`handle`)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `credentials_token_hash_unique` ON `credentials` (`token_hash`)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `invites_code_hash_unique` ON `invites` (`code_hash`)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `posts_author_period` ON `posts` (`author_agent_id`,`period_start`)",
];

/**
 * 0.2 系の手書きのマイグレーションで作った DB を引き継ぐ。
 * 2番目まで適用済み（PRAGMA user_version = 2）なら、ベースライン（0000）と同じ形なので、適用済みとして記録する。
 * 違いは、一意制約に無名のインデックスも残ることと、主キーの列に NOT NULL が付いていないことだけ（test/db.test.ts）。
 */
function adoptLegacy(db: DB, legacyVersion: number): void {
  if (legacyVersion === 0) {
    throw new Error("この DB は Souieba のものではないか、スキーマのバージョンが記録されていません。SOUIEBA_DATA_DIR を確かめてください");
  }
  if (legacyVersion !== 2) {
    throw new Error(`この DB（スキーマ v${legacyVersion}）は古すぎます。先に 0.2 系のサーバで起動してスキーマ v2 に移行してください`);
  }
  const baseline = journal.entries[0]!;
  db.transaction(() => {
    // 同時に起動した別のプロセス（サーバと souieba-admin）が先に引き継いでいれば何もしない
    if (appliedUntil(db) !== null) return;
    // 旧スキーマの一意制約は無名なので、ベースラインと同じ名前のインデックスも作る（後のマイグレーションが名前で DROP INDEX できるように）
    for (const stmt of LEGACY_NAMED_UNIQUE) db.run(sql.raw(stmt));
    createMigrationsTable(db);
    db.run(sql`INSERT INTO ${sql.identifier(MIGRATIONS_TABLE)} (hash, created_at) VALUES ('legacy-v2', ${baseline.when})`);
  });
}

function createMigrationsTable(db: DB): void {
  db.run(sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(MIGRATIONS_TABLE)} (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)`);
}

function statements(text: string): string[] {
  return text
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 未適用のマイグレーションを順に適用する（drizzle-orm の migrator と同じ記録の仕方を、同期で行う）。
 * セルフホストではサーバと souieba-admin が同時に移行することがあるので、適用済みかはトランザクションの中で確かめ直す。
 * legacyVersion は、0.2 系の DB の PRAGMA user_version（node:sqlite だけ。Durable Object には旧 DB がない）。
 */
export function migrate(db: DB, opts: { legacyVersion?: () => number } = {}): void {
  if (appliedUntil(db) === null) {
    if (isEmptyDb(db)) createMigrationsTable(db);
    else adoptLegacy(db, opts.legacyVersion?.() ?? 0);
  }
  for (const entry of journal.entries) {
    if (entry.when <= (appliedUntil(db) ?? 0)) continue;
    const text = migrations[`m${String(entry.idx).padStart(4, "0")}`];
    if (!text) throw new Error(`マイグレーション ${entry.tag} がありません`);
    db.transaction(() => {
      if (entry.when <= (appliedUntil(db) ?? 0)) return;
      for (const stmt of statements(text)) db.run(sql.raw(stmt));
      db.run(sql`INSERT INTO ${sql.identifier(MIGRATIONS_TABLE)} (hash, created_at) VALUES (${entry.tag}, ${entry.when})`);
    });
  }
}

/** まだテーブルが1つもない（新しく作った）DB か */
export function isEmptyDb(db: DB): boolean {
  return !db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'`);
}

/** 未適用のマイグレーションの数（起動時にバックアップを取るかの判断に使う） */
export function pendingMigrations(db: DB): number {
  const applied = appliedUntil(db) ?? -1;
  return journal.entries.filter((e) => e.when > applied).length;
}

export { schema };
