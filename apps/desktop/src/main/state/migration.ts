import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import Database from "better-sqlite3";
import { migrateMessagingStoreData } from "../messaging/core/messaging-migrations.js";
import { resolveActiveProfilePath, resolvePwragntRoot } from "../profile";
import { getNativeBinding } from "./native-binding.js";
import { StateDb } from "./state-db.js";

export type MigrationOutcome =
  | { status: "already-migrated" }
  | { status: "fresh-install"; dbPath: string }
  | { status: "migrated"; dbPath: string; counts: Record<string, number> }
  | { status: "no-sources" };

type LegacyPaths = {
  messagingState?: string;
  overlayState?: string;
  settingsSecrets?: string;
  desktopConfig?: string;
  grokAppServerConfig?: string;
};

export function findLegacyPaths(options?: {
  homeDir?: string;
  xdgConfigHome?: string;
  xdgStateHome?: string;
}): LegacyPaths {
  const homeDir = options?.homeDir ?? os.homedir();
  const xdgConfigHome =
    options?.xdgConfigHome?.trim() ||
    process.env.XDG_CONFIG_HOME?.trim() ||
    path.join(homeDir, ".config");
  const xdgStateHome =
    options?.xdgStateHome?.trim() ||
    process.env.XDG_STATE_HOME?.trim() ||
    path.join(homeDir, ".local", "state");

  const paths: LegacyPaths = {};

  const msgPath = path.join(xdgStateHome, "pwragnt", "messaging-state.json");
  if (fs.existsSync(msgPath)) paths.messagingState = msgPath;

  const overlayPath = path.join(xdgStateHome, "pwragnt", "overlay-state.json");
  if (fs.existsSync(overlayPath)) paths.overlayState = overlayPath;

  const secretsPath = path.join(
    xdgStateHome,
    "pwragnt",
    "settings-secrets.json",
  );
  if (fs.existsSync(secretsPath)) paths.settingsSecrets = secretsPath;

  const configPath = path.join(xdgConfigHome, "pwragnt", "config.toml");
  if (fs.existsSync(configPath)) paths.desktopConfig = configPath;

  const grokPath = path.join(xdgConfigHome, "grok-app-server", "config.toml");
  if (fs.existsSync(grokPath)) paths.grokAppServerConfig = grokPath;

  return paths;
}

export function migrateIfNeeded(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cliProfile?: string;
  xdgConfigHome?: string;
  xdgStateHome?: string;
}): MigrationOutcome {
  const dbPath = resolveActiveProfilePath("state/state.db", options);
  const nativeBinding = getNativeBinding();

  if (fs.existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true, ...(nativeBinding ? { nativeBinding } : {}) });
    try {
      const row = db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      if (row && Number(row.value) >= 1) {
        return { status: "already-migrated" };
      }
    } finally {
      db.close();
    }
  }

  const legacy = findLegacyPaths(options);
  const hasAnySources =
    legacy.messagingState ||
    legacy.overlayState ||
    legacy.settingsSecrets ||
    legacy.desktopConfig ||
    legacy.grokAppServerConfig;

  if (!hasAnySources) {
    const stateDb = StateDb.open(dbPath, {
      profileName: options?.cliProfile ?? "default",
    });
    stateDb.close();
    return { status: "fresh-install", dbPath };
  }

  const messagingData = legacy.messagingState
    ? readAndParseJson(legacy.messagingState)
    : null;
  const overlayData = legacy.overlayState
    ? readAndParseJson(legacy.overlayState)
    : null;
  const secretsData = legacy.settingsSecrets
    ? readAndParseJson(legacy.settingsSecrets)
    : null;

  const tmpDbPath = `${dbPath}.tmp`;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);

  const tmpDb = new Database(tmpDbPath, nativeBinding ? { nativeBinding } : {});
  try {
    tmpDb.pragma("journal_mode = WAL");
    tmpDb.pragma("synchronous = NORMAL");
    tmpDb.pragma("auto_vacuum = INCREMENTAL");

    const stateDb = StateDb.open(tmpDbPath, {
      profileName: options?.cliProfile ?? "default",
    });

    const counts: Record<string, number> = {};
    const timestamp = new Date().toISOString();

    stateDb.setMeta("migrated_from", timestamp);

    if (messagingData) {
      const migrated = migrateMessagingStoreData(messagingData);
      counts.bindings = migrateBindings(stateDb.raw, migrated.bindings);
      counts.pending_intents = migratePendingIntents(
        stateDb.raw,
        migrated.pendingIntents,
      );
      counts.browse_sessions = migrateBrowseSessions(
        stateDb.raw,
        migrated.browseSessions,
      );
      counts.callback_handles = migrateCallbackHandles(
        stateDb.raw,
        migrated.callbackHandles,
      );
      counts.deliveries = migrateDeliveries(stateDb.raw, migrated.deliveries);
    }

    if (overlayData) {
      const overlay = overlayData as Record<string, unknown>;
      counts.backends = migrateBackends(
        stateDb.raw,
        (overlay.backends as Record<string, unknown>) ?? {},
      );
      counts.launchpad_defaults = migrateLaunchpadDefaults(
        stateDb.raw,
        (overlay.launchpadDefaults as Record<string, unknown>) ?? {},
      );
      counts.directory_launchpads = migrateDirectoryLaunchpads(
        stateDb.raw,
        (overlay.directoryLaunchpads as Record<string, unknown>) ?? {},
      );
      counts.threads = migrateThreads(
        stateDb.raw,
        (overlay.threads as Record<string, unknown>) ?? {},
      );
    }

    if (secretsData && typeof secretsData === "object") {
      counts.secrets = migrateSecrets(stateDb.raw, secretsData);
    }

    stateDb.close();
  } catch (error) {
    tmpDb.close();
    if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
    const walPath = `${tmpDbPath}-wal`;
    const shmPath = `${tmpDbPath}-shm`;
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
    throw error;
  }

  tmpDb.close();
  cleanupSidecars(tmpDbPath);
  fs.renameSync(tmpDbPath, dbPath);

  copyConfig(legacy.desktopConfig, options);
  copyGrokConfig(legacy.grokAppServerConfig, options);

  // Legacy files are intentionally left in place. The old app code may still
  // be running against them on other branches. Cleanup happens post-merge
  // once all inflight branches are rebased to the new system.

  const counts = verifyCounts(dbPath);
  return { status: "migrated", dbPath, counts };
}

function readAndParseJson(filePath: string): unknown {
  const contents = fs.readFileSync(filePath, "utf8");
  return JSON.parse(contents);
}

function migrateBindings(
  db: BetterSqlite3.Database,
  bindings: Record<string, unknown>,
): number {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO bindings(binding_id, channel_kind, channel_id, thread_id, status, created_at, updated_at, revoked_at, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let count = 0;
  const insert = db.transaction(() => {
    for (const [id, raw] of Object.entries(bindings)) {
      const binding = raw as Record<string, unknown>;
      const channel = binding.channel as Record<string, unknown> | undefined;
      stmt.run(
        id,
        (channel?.channel as string) ?? "",
        channelId(channel),
        (binding.threadId as string) ?? "",
        binding.revokedAt ? "revoked" : "active",
        binding.createdAt ?? Date.now(),
        binding.updatedAt ?? Date.now(),
        binding.revokedAt ?? null,
        JSON.stringify(binding),
      );
      count++;
    }
  });
  insert();
  return count;
}

function migratePendingIntents(
  db: BetterSqlite3.Database,
  intents: Record<string, unknown>,
): number {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO pending_intents(intent_id, binding_id, created_at, expires_at, payload)
     VALUES (?, ?, ?, ?, ?)`,
  );
  let count = 0;
  const insert = db.transaction(() => {
    for (const [id, raw] of Object.entries(intents)) {
      const intent = raw as Record<string, unknown>;
      stmt.run(
        id,
        (intent.bindingId as string) ?? "",
        intent.createdAt ?? Date.now(),
        intent.expiresAt ?? Date.now(),
        JSON.stringify(intent),
      );
      count++;
    }
  });
  insert();
  return count;
}

function migrateBrowseSessions(
  db: BetterSqlite3.Database,
  sessions: Record<string, unknown>,
): number {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO browse_sessions(session_id, binding_id, created_at, expires_at, payload)
     VALUES (?, ?, ?, ?, ?)`,
  );
  let count = 0;
  const insert = db.transaction(() => {
    for (const [id, raw] of Object.entries(sessions)) {
      const session = raw as Record<string, unknown>;
      stmt.run(
        id,
        (session.bindingId as string) ?? null,
        session.createdAt ?? Date.now(),
        session.expiresAt ?? Date.now(),
        JSON.stringify(session),
      );
      count++;
    }
  });
  insert();
  return count;
}

function migrateCallbackHandles(
  db: BetterSqlite3.Database,
  handles: Record<string, unknown>,
): number {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO callback_handles(handle_id, session_id, created_at, expires_at, payload)
     VALUES (?, ?, ?, ?, ?)`,
  );
  let count = 0;
  const insert = db.transaction(() => {
    for (const [id, raw] of Object.entries(handles)) {
      const handle = raw as Record<string, unknown>;
      stmt.run(
        id,
        (handle.browseSessionId as string) ?? null,
        handle.createdAt ?? Date.now(),
        handle.expiresAt ?? Date.now(),
        JSON.stringify(handle),
      );
      count++;
    }
  });
  insert();
  return count;
}

function migrateDeliveries(
  db: BetterSqlite3.Database,
  deliveries: Record<string, unknown>,
): number {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO deliveries(delivery_id, binding_id, created_at, payload)
     VALUES (?, ?, ?, ?)`,
  );
  let count = 0;
  const insert = db.transaction(() => {
    for (const [id, raw] of Object.entries(deliveries)) {
      const delivery = raw as Record<string, unknown>;
      stmt.run(
        id,
        (delivery.bindingId as string) ?? "",
        delivery.createdAt ?? Date.now(),
        JSON.stringify(delivery),
      );
      count++;
    }
  });
  insert();
  return count;
}

function migrateBackends(
  db: BetterSqlite3.Database,
  backends: unknown,
): number {
  if (!backends || typeof backends !== "object") return 0;
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO backends(scope, payload) VALUES (?, ?)",
  );
  let count = 0;
  const insert = db.transaction(() => {
    for (const [scope, value] of Object.entries(
      backends as Record<string, unknown>,
    )) {
      if (value && typeof value === "object") {
        stmt.run(scope, JSON.stringify(value));
        count++;
      }
    }
  });
  insert();
  return count;
}

function migrateLaunchpadDefaults(
  db: BetterSqlite3.Database,
  defaults: unknown,
): number {
  if (!defaults || typeof defaults !== "object") return 0;
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO launchpad_defaults(key, value) VALUES (?, ?)",
  );
  let count = 0;
  const insert = db.transaction(() => {
    for (const [key, value] of Object.entries(
      defaults as Record<string, unknown>,
    )) {
      if (value !== undefined) {
        stmt.run(key, JSON.stringify(value));
        count++;
      }
    }
  });
  insert();
  return count;
}

function migrateDirectoryLaunchpads(
  db: BetterSqlite3.Database,
  launchpads: unknown,
): number {
  if (!launchpads || typeof launchpads !== "object") return 0;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO directory_launchpads(directory_path, payload, created_at, updated_at, settings_touched_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  let count = 0;
  const now = Date.now();
  const insert = db.transaction(() => {
    for (const [dirPath, raw] of Object.entries(
      launchpads as Record<string, unknown>,
    )) {
      const lp = raw as Record<string, unknown>;
      stmt.run(
        dirPath,
        JSON.stringify(lp),
        (lp.createdAt as number) ?? now,
        (lp.updatedAt as number) ?? now,
        (lp.settingsTouchedAt as number) ?? null,
      );
      count++;
    }
  });
  insert();
  return count;
}

function migrateThreads(
  db: BetterSqlite3.Database,
  threads: unknown,
): number {
  if (!threads || typeof threads !== "object") return 0;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO threads(thread_id, directory_path, last_seen_at, dismissed_at, snoozed_until, payload)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let count = 0;
  const insert = db.transaction(() => {
    for (const [threadId, raw] of Object.entries(
      threads as Record<string, unknown>,
    )) {
      const thread = raw as Record<string, unknown>;
      stmt.run(
        threadId,
        (thread.directoryPath as string) ?? null,
        (thread.lastSeenAt as number) ?? null,
        (thread.dismissedAt as number) ?? null,
        (thread.snoozedUntil as number) ?? null,
        JSON.stringify(thread),
      );
      count++;
    }
  });
  insert();
  return count;
}

function migrateSecrets(
  db: BetterSqlite3.Database,
  secrets: unknown,
): number {
  if (!secrets || typeof secrets !== "object") return 0;
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO secrets(key, ciphertext, updated_at) VALUES (?, ?, ?)",
  );
  let count = 0;
  const now = Date.now();
  const insert = db.transaction(() => {
    for (const [key, raw] of Object.entries(
      secrets as Record<string, unknown>,
    )) {
      const record = raw as Record<string, unknown>;
      const ciphertext = record?.ciphertext as string | undefined;
      if (ciphertext) {
        stmt.run(key, Buffer.from(ciphertext, "base64"), now);
        count++;
      }
    }
  });
  insert();
  return count;
}

function channelId(channel: Record<string, unknown> | undefined): string {
  if (!channel) return "";
  const conv = channel.conversation as Record<string, unknown> | undefined;
  if (!conv) return "";
  return [conv.kind ?? "", conv.parentId ?? "", conv.id ?? ""].join(":");
}

function copyConfig(
  srcPath: string | undefined,
  options?: { env?: NodeJS.ProcessEnv; homeDir?: string; cliProfile?: string },
): void {
  if (!srcPath) return;
  const destPath = resolveActiveProfilePath("config.toml", options);
  if (fs.existsSync(destPath)) return;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
}

function copyGrokConfig(
  srcPath: string | undefined,
  options?: { env?: NodeJS.ProcessEnv; homeDir?: string },
): void {
  if (!srcPath) return;
  const root = resolvePwragntRoot(options);
  const destPath = path.join(root, "grok-app-server", "config.toml");
  if (fs.existsSync(destPath)) return;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
}

function backupFile(filePath: string | undefined, timestamp: number): void {
  if (!filePath || !fs.existsSync(filePath)) return;
  fs.renameSync(filePath, `${filePath}.bak.${timestamp}`);
}

function cleanupSidecars(tmpDbPath: string): void {
  const walPath = `${tmpDbPath}-wal`;
  const shmPath = `${tmpDbPath}-shm`;
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
  if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
}

function verifyCounts(dbPath: string): Record<string, number> {
  const nativeBinding = getNativeBinding();
  const db = new Database(dbPath, { readonly: true, ...(nativeBinding ? { nativeBinding } : {}) });
  try {
    const tables = [
      "bindings",
      "pending_intents",
      "browse_sessions",
      "callback_handles",
      "deliveries",
      "backends",
      "launchpad_defaults",
      "directory_launchpads",
      "threads",
      "secrets",
    ];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const row = db
        .prepare(`SELECT COUNT(*) as count FROM ${table}`)
        .get() as { count: number };
      counts[table] = row.count;
    }
    return counts;
  } finally {
    db.close();
  }
}
