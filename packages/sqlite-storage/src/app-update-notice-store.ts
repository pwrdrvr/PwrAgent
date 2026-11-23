import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import { buildThreadIdentityKey, encodeLegacyThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import type { StateDb } from "./state-db";

type AgentIdentity = { backend: AppServerBackendKind; threadId: string };
type NoticeIdentity = { destination: string; version: string; phase: "available" | "ready" };

const RESTART_RECEIPT_KEY = "messaging-app-update-restart";
export type AppUpdateRestartReceipt = AgentIdentity & {
  runtimeId: string;
  version: string;
  bindingId: string;
  destination: string;
  connectionId: string;
};

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
    return Boolean(this.stateDb.raw.prepare(
      "SELECT 1 FROM app_update_notice_deliveries WHERE destination = ? AND version = ? AND phase = ?",
    ).get(notice.destination, notice.version, notice.phase));
  }

  recordDelivery(notice: NoticeIdentity, identity: AgentIdentity, bindingId: string): void {
    this.stateDb.raw.prepare(`INSERT OR IGNORE INTO app_update_notice_deliveries
      (destination, version, phase, thread_key, binding_id) VALUES (?, ?, ?, ?, ?)`)
      .run(notice.destination, notice.version, notice.phase, storageKey(identity), bindingId);
  }

  readRestartReceipt(): AppUpdateRestartReceipt | undefined {
    const row = this.stateDb.getMeta(RESTART_RECEIPT_KEY);
    return row ? JSON.parse(row) as AppUpdateRestartReceipt : undefined;
  }

  saveRestartReceipt(receipt: AppUpdateRestartReceipt): boolean {
    if (this.stateDb.getMeta(RESTART_RECEIPT_KEY) !== undefined) return false;
    return this.stateDb.raw.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
      .run(RESTART_RECEIPT_KEY, JSON.stringify(receipt)).changes === 1;
  }

  clearRestartReceipt(receipt: AppUpdateRestartReceipt): void {
    this.stateDb.raw.prepare("DELETE FROM meta WHERE key = ? AND value = ?")
      .run(RESTART_RECEIPT_KEY, JSON.stringify(receipt));
  }
}
