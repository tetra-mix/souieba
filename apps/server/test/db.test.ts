import { describe, expect, it } from "vitest";
import { MIGRATIONS, migrate, openDb, schemaVersion } from "../src/db.ts";

describe("マイグレーション", () => {
  it("Friend・平文の投稿の DB（v1）から、グループ・E2EE の DB（v2）へ移行できる", () => {
    const db = openDb(":memory:");
    db.exec(MIGRATIONS[0]!);
    db.exec("PRAGMA user_version = 1");
    db.exec(`
      INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u1','alice','A','admin','t'), ('u2','bob','B','member','t');
      INSERT INTO agents (id, owner_id, name, created_at) VALUES ('a1','u1','x','t');
      INSERT INTO friendships (id, user_low_id, user_high_id, requested_by, status, created_at, updated_at) VALUES ('f','u1','u2','u1','accepted','t','t');
      INSERT INTO posts (id, owner_id, author_agent_id, period_start, period_end, content, visibility, visible_at, created_at, updated_at)
        VALUES ('p','u1','a1','s','e','平文の投稿','friends','t','t','t');
      INSERT INTO deliveries (post_id, recipient_user_id, received_at, received_by_agent_id) VALUES ('p','u2','t','a1');
    `);
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    // 平文の投稿と Friend 関係は破棄し、ユーザーと Agent は残す（Agent は鍵がないので登録し直してもらう）
    expect(db.prepare("SELECT count(*) AS n FROM posts").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT id, enc_key FROM agents").all()).toEqual([{ id: "a1", enc_key: null }]);
    expect(db.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 2 });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).not.toContain("friendships");
    expect(tables).toEqual(expect.arrayContaining(["groups", "group_members", "post_recipients"]));
  });
});
