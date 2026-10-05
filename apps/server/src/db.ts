import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

/** 前進のみのマイグレーション。追加するときは末尾に足す */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE instance_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
    disabled_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    provider TEXT,
    public_key TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE credentials (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('user','agent')),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE friendships (
    id TEXT PRIMARY KEY,
    user_low_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_high_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requested_by TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','accepted','blocked')),
    blocked_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (user_low_id, user_high_id),
    CHECK (user_low_id < user_high_id)
  );

  CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('invite','login')),
    created_by TEXT REFERENCES users(id) ON DELETE CASCADE,
    target_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    auto_friend INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT NOT NULL,
    used_by TEXT,
    used_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE posts (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    content TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('friends','private')),
    visible_at TEXT NOT NULL,
    signature TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (author_agent_id, period_start)
  );
  CREATE INDEX posts_owner_created ON posts (owner_id, created_at);

  CREATE TABLE deliveries (
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    received_at TEXT NOT NULL,
    received_by_agent_id TEXT NOT NULL,
    reserved_by_agent_id TEXT,
    reserved_until TEXT,
    told_at TEXT,
    told_by_agent_id TEXT,
    dismissed_at TEXT,
    PRIMARY KEY (post_id, recipient_user_id)
  );
  CREATE INDEX deliveries_recipient ON deliveries (recipient_user_id, told_at);
  `,
];

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  return db;
}

export function schemaVersion(db: DB): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

export function pendingMigrations(db: DB): number {
  return MIGRATIONS.length - schemaVersion(db);
}

export function migrate(db: DB): void {
  const current = schemaVersion(db);
  for (let v = current; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** node:sqlite は同期 API なので、BEGIN IMMEDIATE で書き込みを直列化する */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
