import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createDb, migrate, pendingMigrations, schema } from "../src/db/index.ts";
import { NodeSqlStorage, openDb } from "../src/db/node.ts";
import { LEGACY_MIGRATIONS } from "./fixtures/legacy-schema.ts";

/** テーブルごとの列・外部キー・一意制約（インデックス名は比べない） */
function shape(raw: DatabaseSync) {
  const q = (s: string) => raw.prepare(s).all() as Record<string, unknown>[];
  const tables = q("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'")
    .map((r) => r.name as string)
    .sort();
  return Object.fromEntries(
    tables.map((t) => [
      t,
      {
        columns: q(`PRAGMA table_info(${t})`)
          // 旧スキーマの TEXT PRIMARY KEY には NOT NULL が付いていない（SQLite では主キーでも NULL を許す）。値は常に入れているので比べない
          .map((c) => ({ name: c.name, type: c.type, notnull: c.pk ? "pk" : c.notnull, dflt: c.dflt_value, pk: c.pk }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name))),
        fks: q(`PRAGMA foreign_key_list(${t})`)
          .map((f) => `${f.from}->${f.table}.${f.to} ${f.on_delete}`)
          .sort(),
        // 旧スキーマの一意制約は無名（sqlite_autoindex_*）で、引き継ぐときに同じ列の名前付きのものも作るので、列の組で比べる
        unique: [
          ...new Set(
            q(`PRAGMA index_list(${t})`)
              .filter((i) => i.unique && i.origin !== "pk")
              .map((i) => (q(`PRAGMA index_info(${i.name})`) as { name: string }[]).map((c) => c.name).join(",")),
          ),
        ].sort(),
        indexes: q(`PRAGMA index_list(${t})`)
          .filter((i) => !i.unique)
          .map((i) => (q(`PRAGMA index_info(${i.name})`) as { name: string }[]).map((c) => c.name).join(","))
          .sort(),
      },
    ]),
  );
}

function legacyDb(version: number) {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const m of LEGACY_MIGRATIONS.slice(0, version)) raw.exec(m);
  raw.exec(`PRAGMA user_version = ${version}`);
  const storage = new NodeSqlStorage(raw);
  return { raw, storage, db: createDb(storage) };
}

describe("マイグレーション", () => {
  it("新しい DB には全テーブルを作り、2回目は何もしない", () => {
    const { db } = openDb(":memory:");
    expect(pendingMigrations(db)).toBeGreaterThan(0);
    migrate(db);
    expect(pendingMigrations(db)).toBe(0);
    migrate(db);
    expect(db.select().from(schema.users).all()).toEqual([]);
  });

  it("0.2 系の手書きのマイグレーション（v2）で作った DB と、同じ形のスキーマになる", () => {
    const fresh = openDb(":memory:");
    migrate(fresh.db);
    const legacy = legacyDb(2);
    migrate(legacy.db, { legacyVersion: () => legacy.storage.legacyVersion() });
    expect(shape(legacy.raw)).toEqual(shape(fresh.storage.raw));
  });

  it("0.2 系の DB を、データを残したまま引き継ぐ", () => {
    const { raw, storage, db } = legacyDb(2);
    raw.exec(`
      INSERT INTO users (id, handle, display_name, role, created_at, identity_key) VALUES ('u1','alice','A','admin','t','k');
      INSERT INTO agents (id, owner_id, name, created_at) VALUES ('a1','u1','x','t');
    `);
    migrate(db, { legacyVersion: () => storage.legacyVersion() });
    expect(pendingMigrations(db)).toBe(0);
    expect(db.select({ handle: schema.users.handle }).from(schema.users).all()).toEqual([{ handle: "alice" }]);
    // 引き継いだ後も、外部キーの ON DELETE CASCADE が効く
    db.delete(schema.users).run();
    expect(db.select().from(schema.agents).all()).toEqual([]);
  });

  it("Friend の時代の DB（v1）は、先に 0.2 系で移行するよう求める", () => {
    const { storage, db } = legacyDb(1);
    expect(() => migrate(db, { legacyVersion: () => storage.legacyVersion() })).toThrow(/0\.2 系/);
  });

  it("引き継いだ DB にも、ベースラインと同じ名前の一意インデックスがある（後のマイグレーションが名前で扱えるように）", () => {
    const fresh = openDb(":memory:");
    migrate(fresh.db);
    const legacy = legacyDb(2);
    migrate(legacy.db, { legacyVersion: () => legacy.storage.legacyVersion() });
    const named = (raw: DatabaseSync) =>
      (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(
        (r) => r.name,
      );
    expect(named(legacy.raw)).toEqual(expect.arrayContaining(named(fresh.storage.raw)));
  });

  it("バージョンの記録がない DB（Souieba のものでない）は、そう伝えて止める", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec("CREATE TABLE users (id TEXT)");
    const storage = new NodeSqlStorage(raw);
    expect(() => migrate(createDb(storage), { legacyVersion: () => storage.legacyVersion() })).toThrow(/Souieba のものではない/);
  });
});

describe("node:sqlite のトランザクション", () => {
  it("COMMIT が失敗しても、トランザクションが開いたまま残らない", () => {
    const { db, storage } = openDb(":memory:");
    migrate(db);
    // 外部キーの検査を COMMIT まで遅らせ、COMMIT を失敗させる
    expect(() =>
      storage.transactionSync(() => {
        storage.raw.exec("PRAGMA defer_foreign_keys = ON");
        storage.raw.exec("INSERT INTO agents (id, owner_id, name, created_at) VALUES ('a1', 'missing', 'x', 't')");
      }),
    ).toThrow(/FOREIGN KEY/);
    expect(storage.raw.isTransaction).toBe(false);
    // その後のトランザクションも普通に使える
    expect(storage.transactionSync(() => 1)).toBe(1);
  });
});
