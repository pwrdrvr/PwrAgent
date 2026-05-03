import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { getNativeBinding } from "./native-binding.js";

const SCHEMA_V1 = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO meta(key, value) VALUES ('schema_version', '1');
INSERT INTO meta(key, value) VALUES ('migrated_from', '');
INSERT INTO meta(key, value) VALUES ('profile_name', '');

CREATE TABLE bindings (
  binding_id     TEXT PRIMARY KEY,
  channel_kind   TEXT NOT NULL,
  channel_id     TEXT NOT NULL,
  thread_id      TEXT NOT NULL,
  status         TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  revoked_at     INTEGER,
  payload        TEXT NOT NULL
);
CREATE INDEX idx_bindings_thread ON bindings(thread_id);
CREATE INDEX idx_bindings_channel ON bindings(channel_kind, channel_id);

CREATE TABLE pending_intents (
  intent_id   TEXT PRIMARY KEY,
  binding_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  payload     TEXT NOT NULL
);
CREATE INDEX idx_pending_intents_expires ON pending_intents(expires_at);
CREATE INDEX idx_pending_intents_binding ON pending_intents(binding_id);

CREATE TABLE browse_sessions (
  session_id  TEXT PRIMARY KEY,
  binding_id  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  payload     TEXT NOT NULL
);
CREATE INDEX idx_browse_sessions_expires ON browse_sessions(expires_at);

CREATE TABLE callback_handles (
  handle_id   TEXT PRIMARY KEY,
  session_id  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  payload     TEXT NOT NULL
);
CREATE INDEX idx_callback_handles_expires ON callback_handles(expires_at);
CREATE INDEX idx_callback_handles_session ON callback_handles(session_id);

CREATE TABLE deliveries (
  delivery_id   TEXT PRIMARY KEY,
  binding_id    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  payload       TEXT NOT NULL
);
CREATE INDEX idx_deliveries_binding_created ON deliveries(binding_id, created_at);

CREATE TABLE backends (
  scope       TEXT PRIMARY KEY,
  payload     TEXT NOT NULL
);

CREATE TABLE launchpad_defaults (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL
);

CREATE TABLE directory_launchpads (
  directory_path  TEXT PRIMARY KEY,
  payload         TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  settings_touched_at INTEGER
);

CREATE TABLE threads (
  thread_id        TEXT PRIMARY KEY,
  directory_path   TEXT,
  last_seen_at     INTEGER,
  dismissed_at     INTEGER,
  snoozed_until    INTEGER,
  payload          TEXT NOT NULL
);
CREATE INDEX idx_threads_directory ON threads(directory_path);
CREATE INDEX idx_threads_dismissed ON threads(dismissed_at);

CREATE TABLE secrets (
  key         TEXT PRIMARY KEY,
  ciphertext  BLOB NOT NULL,
  updated_at  INTEGER NOT NULL
);
`;

const DELIVERIES_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const REVOKED_BINDINGS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export class StateDb {
  private db: BetterSqlite3.Database;
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(db: BetterSqlite3.Database) {
    this.db = db;
  }

  static open(dbPath: string, options?: { profileName?: string }): StateDb {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const nativeBinding = getNativeBinding();
    const db = new Database(dbPath, nativeBinding ? { nativeBinding } : {});

    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");

    const userVersion = db.pragma("user_version", { simple: true }) as number;
    if (userVersion === 0) {
      db.pragma("auto_vacuum = INCREMENTAL");
      db.exec(SCHEMA_V1);
      if (options?.profileName) {
        db.prepare("UPDATE meta SET value = ? WHERE key = 'profile_name'").run(
          options.profileName,
        );
      }
      db.pragma("user_version = 1");
    }

    return new StateDb(db);
  }

  get raw(): BetterSqlite3.Database {
    return this.db;
  }

  close(): void {
    this.stopGc();
    this.db.close();
  }

  startGc(intervalMs = 60 * 60 * 1000): void {
    this.cleanupExpired();
    this.gcTimer = setInterval(() => this.cleanupExpired(), intervalMs);
    if (this.gcTimer.unref) this.gcTimer.unref();
  }

  stopGc(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  cleanupExpired(now = Date.now()): void {
    const cleanup = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM browse_sessions WHERE expires_at < ?")
        .run(now);
      this.db
        .prepare("DELETE FROM pending_intents WHERE expires_at < ?")
        .run(now);
      this.db
        .prepare("DELETE FROM callback_handles WHERE expires_at < ?")
        .run(now);
      this.db
        .prepare("DELETE FROM deliveries WHERE created_at < ?")
        .run(now - DELIVERIES_RETENTION_MS);
      this.db
        .prepare(
          "DELETE FROM bindings WHERE revoked_at IS NOT NULL AND revoked_at < ?",
        )
        .run(now - REVOKED_BINDINGS_RETENTION_MS);
    });
    cleanup();
    this.db.pragma("incremental_vacuum");
  }

  getMeta(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
      .run(key, value);
  }

  getSecret(key: string): Buffer | undefined {
    const row = this.db
      .prepare("SELECT ciphertext FROM secrets WHERE key = ?")
      .get(key) as { ciphertext: Buffer } | undefined;
    return row?.ciphertext;
  }

  setSecret(key: string, ciphertext: Buffer): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO secrets(key, ciphertext, updated_at) VALUES (?, ?, ?)",
      )
      .run(key, ciphertext, Date.now());
  }

  deleteSecret(key: string): void {
    this.db.prepare("DELETE FROM secrets WHERE key = ?").run(key);
  }
}
