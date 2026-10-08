import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync, backup } from "node:sqlite";
import { type DB, type SqlStorageLike, createDb, isEmptyDb, migrate, pendingMigrations } from "./index.ts";

type Value = string | number | bigint | null | Uint8Array;

/** Durable Object の SqlStorageCursor のうち、Drizzle が使う部分 */
class Cursor {
  private index = 0;
  private objects: Record<string, Value>[] | null = null;

  constructor(
    private readonly columns: string[],
    private readonly rows: Value[][],
  ) {}

  toArray(): Record<string, Value>[] {
    this.objects ??= this.rows.map((r) => Object.fromEntries(this.columns.map((c, i) => [c, r[i]!])));
    return this.objects;
  }

  raw() {
    return { toArray: () => this.rows };
  }

  next(): { done: boolean; value?: Record<string, Value> } {
    const row = this.toArray()[this.index++];
    return row ? { done: false, value: row } : { done: true };
  }

  one(): Record<string, Value> {
    if (this.rows.length !== 1) throw new Error(`1行を期待しましたが ${this.rows.length} 行でした`);
    return this.toArray()[0]!;
  }
}

/**
 * node:sqlite を Durable Object の ctx.storage と同じ形に見せる。
 * セルフホストと Workers で、同じ Drizzle のドライバ（durable-sqlite）を使うため。
 */
/** 準備した文を覚えておく数。inArray や複数行の INSERT は件数ごとに別の文になるので、上限を設ける */
const STATEMENT_CACHE_SIZE = 500;

export class NodeSqlStorage implements SqlStorageLike {
  private depth = 0;
  private readonly cache = new Map<string, StatementSync>();

  constructor(readonly raw: DatabaseSync) {}

  readonly sql = {
    // Durable Object と同じく、exec の時点で文を実行する（書き込みは結果を読まれないことがあるため）
    exec: (query: string, ...bindings: unknown[]): Cursor => {
      let stmt = this.cache.get(query);
      if (!stmt) {
        stmt = this.raw.prepare(query);
        // 同じ名前の列（JOIN した id など）を取り違えないよう、配列で受け取る
        stmt.setReturnArrays(true);
        if (this.cache.size >= STATEMENT_CACHE_SIZE) this.cache.clear();
        this.cache.set(query, stmt);
      }
      const columns = stmt.columns().map((c) => c.name);
      if (columns.length === 0) {
        stmt.run(...(bindings as Value[]));
        return new Cursor([], []);
      }
      return new Cursor(columns, stmt.all(...(bindings as Value[])) as unknown as Value[][]);
    },
  };

  /** BEGIN IMMEDIATE で書き込みを直列化する。入れ子はセーブポイントにする */
  transactionSync<T>(fn: () => T): T {
    const outer = this.depth === 0;
    const sp = `sp${this.depth}`;
    this.raw.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const result = fn();
      this.raw.exec(outer ? "COMMIT" : `RELEASE ${sp}`);
      return result;
    } catch (err) {
      // COMMIT 自体が失敗した場合も含めて巻き戻す。トランザクションが開いたまま残らないようにする
      if (this.raw.isTransaction) this.raw.exec(outer ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    } finally {
      this.depth--;
    }
  }

  /** 0.2 系の DB のスキーマのバージョン */
  legacyVersion(): number {
    return (this.raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  }

  backupTo(path: string): Promise<number> {
    return backup(this.raw, path);
  }
}

/**
 * 未適用のマイグレーションがあれば適用する。既存の DB なら、その前に必ずバックアップを取る。
 * サーバの起動時と souieba-admin（DB を直接開く場合）の両方で使う。取ったバックアップのパスを返す
 */
export async function migrateWithBackup(db: DB, storage: NodeSqlStorage, backupDir: string, label: string): Promise<string | null> {
  if (pendingMigrations(db) === 0) return null;
  let backup: string | null = null;
  if (!isEmptyDb(db)) {
    mkdirSync(backupDir, { recursive: true });
    backup = join(backupDir, `pre-${label}-${Date.now()}.db`);
    await storage.backupTo(backup);
  }
  migrate(db, { legacyVersion: () => storage.legacyVersion() });
  return backup;
}

export function openDb(path: string): { db: DB; storage: NodeSqlStorage } {
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const storage = new NodeSqlStorage(raw);
  return { db: createDb(storage), storage };
}
