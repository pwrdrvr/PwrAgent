import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import { buildThreadIdentityKey, encodeLegacyThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import type { StateDb } from "./state-db";
import type { AppUpdateRestartReceipt } from "@pwragent/owner-core/app-update-notice-storage";
import type BetterSqlite3 from "better-sqlite3";

type AgentIdentity = { backend: AppServerBackendKind; threadId: string };
type NoticeIdentity = { destination: string; version: string; phase: "available" | "ready" };

const RESTART_RECEIPT_KEY = "messaging-app-update-restart";
const RESTART_RECEIPT_KEY_PREFIX = `${RESTART_RECEIPT_KEY}:`;

export const APP_UPDATE_NOTICE_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_update_notice_agents (
  thread_key TEXT PRIMARY KEY REFERENCES threads(thread_id) ON DELETE CASCADE ON UPDATE CASCADE
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS app_update_notice_deliveries (
  destination TEXT NOT NULL,
  version TEXT NOT NULL,
  phase TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  ready_surface TEXT,
  PRIMARY KEY (destination, version, phase)
) WITHOUT ROWID;
CREATE VIEW IF NOT EXISTS app_update_notice_eligible_agents AS
  SELECT thread_id AS thread_key,
    json_extract(payload, '$.backend') AS backend,
    json_extract(payload, '$.threadId') AS threadId,
    json_extract(payload, '$.agent.name') AS name
  FROM threads
  WHERE json_type(payload, '$.agent') = 'object'
    AND json_type(payload, '$.archiveRetentionStartedAt') IS NULL
    AND json_type(payload, '$.archiveTombstonedAt') IS NULL;
CREATE TRIGGER IF NOT EXISTS app_update_notice_remove_ineligible_agent
AFTER UPDATE OF payload ON threads
WHEN EXISTS (SELECT 1 FROM app_update_notice_agents WHERE thread_key = NEW.thread_id)
BEGIN
  DELETE FROM app_update_notice_agents WHERE thread_key = NEW.thread_id
    AND NOT EXISTS (SELECT 1 FROM app_update_notice_eligible_agents WHERE thread_key = NEW.thread_id);
END;
`;

export function ensureAppUpdateNoticeSchema(db: BetterSqlite3.Database): void {
  const hasReadySurface = db.prepare(
    "SELECT 1 FROM pragma_table_info('app_update_notice_deliveries') WHERE name = 'ready_surface'",
  );
  const existingObjects = db.prepare(`SELECT COUNT(*) FROM sqlite_schema
    WHERE name IN ('app_update_notice_agents', 'app_update_notice_deliveries',
      'app_update_notice_eligible_agents', 'app_update_notice_remove_ineligible_agent')`).pluck().get();
  if (existingObjects === 4 && hasReadySurface.get()) return;

  db.transaction(() => {
    db.exec(APP_UPDATE_NOTICE_SCHEMA);
    // Another opener may have added the column while this connection waited.
    if (!hasReadySurface.get()) {
      db.exec("ALTER TABLE app_update_notice_deliveries ADD COLUMN ready_surface TEXT");
    }
  }).immediate();
}

type AgentRow = AgentIdentity & { name: string; enabled: number };

function storageKey(identity: AgentIdentity): string {
  const key = buildThreadIdentityKey(identity.backend, identity.threadId);
  return encodeLegacyThreadIdentityKey(key) ?? key;
}

export class AppUpdateNoticeStore {
  constructor(private readonly stateDb: StateDb) {}

  listAgents(): Array<AgentIdentity & { name: string; enabled: boolean }> {
    const rows = this.stateDb.raw.prepare(`SELECT backend, threadId, name,
      app_update_notice_agents.thread_key IS NOT NULL AS enabled
      FROM app_update_notice_eligible_agents LEFT JOIN app_update_notice_agents USING (thread_key)
      ORDER BY name COLLATE NOCASE, app_update_notice_eligible_agents.thread_key`).all() as AgentRow[];
    return rows.map((row) => ({ ...row, enabled: row.enabled === 1 }));
  }

  isEnabled(identity: AgentIdentity): boolean {
    return Boolean(this.stateDb.raw.prepare(
      "SELECT 1 FROM app_update_notice_agents WHERE thread_key = ?",
    ).get(storageKey(identity)));
  }

  setEnabled(identity: AgentIdentity, enabled: boolean): boolean {
    const key = storageKey(identity);
    if (enabled) {
      this.stateDb.raw.prepare(`INSERT OR IGNORE INTO app_update_notice_agents(thread_key)
        SELECT thread_key FROM app_update_notice_eligible_agents WHERE thread_key = ?`).run(key);
    } else {
      this.stateDb.raw.prepare("DELETE FROM app_update_notice_agents WHERE thread_key = ?").run(key);
    }
    return this.isEnabled(identity);
  }

  hasRecipients(): boolean {
    return Boolean(this.stateDb.raw.prepare("SELECT 1 FROM app_update_notice_agents LIMIT 1").get());
  }

  delivered(notice: NoticeIdentity): boolean {
    return this.readDelivery(notice) !== undefined;
  }

  readDelivery(notice: NoticeIdentity): { bindingId: string; readySurface: string | null } | undefined {
    return this.stateDb.raw.prepare(`SELECT binding_id AS bindingId, ready_surface AS readySurface
      FROM app_update_notice_deliveries WHERE destination = ? AND version = ? AND phase = ?`)
      .get(notice.destination, notice.version, notice.phase) as { bindingId: string; readySurface: string | null } | undefined;
  }

  recordDelivery(notice: NoticeIdentity, identity: AgentIdentity, bindingId: string, readySurface?: string): void {
    this.stateDb.raw.prepare(`INSERT INTO app_update_notice_deliveries
      (destination, version, phase, thread_key, binding_id, ready_surface) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(destination, version, phase) DO UPDATE SET ready_surface = excluded.ready_surface
      WHERE app_update_notice_deliveries.binding_id = excluded.binding_id AND excluded.ready_surface IS NOT NULL
        AND app_update_notice_deliveries.ready_surface IS NOT excluded.ready_surface`)
      .run(notice.destination, notice.version, notice.phase, storageKey(identity), bindingId, readySurface ?? null);
  }

  listRestartReceipts(): Array<{ key: string; receipt: AppUpdateRestartReceipt }> {
    const rows = this.stateDb.raw.prepare("SELECT key, value FROM meta WHERE key = ? OR key GLOB ? ORDER BY key")
      .all(RESTART_RECEIPT_KEY, `${RESTART_RECEIPT_KEY_PREFIX}*`) as Array<{ key: string; value: string }>;
    return rows.map(({ key, value }) => ({ key, receipt: JSON.parse(value) as AppUpdateRestartReceipt }));
  }

  saveRestartReceipt(receipt: AppUpdateRestartReceipt): boolean {
    const key = `${RESTART_RECEIPT_KEY_PREFIX}${receipt.runtimeId}:${receipt.version}`;
    if (this.stateDb.getMeta(key) !== undefined) return false;
    return this.stateDb.raw.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
      .run(key, JSON.stringify(receipt)).changes === 1;
  }

  clearRestartReceipt(receipt: AppUpdateRestartReceipt): void {
    this.removeRestartReceipt(`${RESTART_RECEIPT_KEY_PREFIX}${receipt.runtimeId}:${receipt.version}`, receipt);
  }

  observeRestartReceipt(key: string, receipt: AppUpdateRestartReceipt, version: string): AppUpdateRestartReceipt | undefined {
    if (receipt.observedVersion !== undefined) return receipt;
    const observed = { ...receipt, observedVersion: version };
    const result = this.stateDb.raw.prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?")
      .run(JSON.stringify(observed), key, JSON.stringify(receipt));
    return result.changes === 1 ? observed : undefined;
  }

  removeRestartReceipt(key: string, receipt: AppUpdateRestartReceipt): void {
    this.stateDb.raw.prepare("DELETE FROM meta WHERE key = ? AND value = ?").run(key, JSON.stringify(receipt));
  }
}
