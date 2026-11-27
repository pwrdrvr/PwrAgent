import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CURRENT_STATE_DB_USER_VERSION as SHARED_STATE_DB_USER_VERSION, StateDb as SharedStateDb } from "@pwragent/sqlite-storage/state-db";
import { StateDb as DesktopStateDb } from "../storage/state-db";
import { StateDb, CURRENT_STATE_DB_USER_VERSION } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, openFreshStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const oraclePath = path.join(import.meta.dirname, "fixtures/shared-sqlite-schema-oracle.json");
const hosts = [DesktopStateDb, SharedStateDb, StateDb];

function schemaAtV80(db: StateDb): { sha256: string; objects: number; userVersion: number } {
  const rows = db.raw.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all() as Array<{ name: string; tbl_name: string; sql: string | null }>;
  // Keep the extraction oracle frozen at v80, excluding only the explicitly
  // additive owner-job, search-key, OpenAI Decisions registry, compaction
  // recovery and automatic wake guards, research, request-pricing, sub-agent dismissal,
  // operator-request scope, pricing summary, gate pricing, usage completion,
  // automation turn, and PR watch indexes, plus pricing summary deltas and scheduled
  // action projections, app update notices, targeted managed membership,
  // subthread lookup indexes, pin mount tokens, lifetime automation cost,
  // transcript accounting indexes, and pending ACP compaction storage.
  // Restore the v80 SQL for the indexes replaced by v83 and v84.
  const compared = rows.filter(row =>
    row.tbl_name !== "owner_jobs"
    && row.tbl_name !== "openai_decision_versions"
    && row.tbl_name !== "thread_compaction_recovery_guards"
    && row.tbl_name !== "thread_automatic_wake_guards"
    && row.tbl_name !== "thread_automatic_wake_admissions"
    && row.tbl_name !== "thread_automatic_wake_reviews"
    && row.tbl_name !== "thread_search_fts_rows"
    && row.tbl_name !== "research_runs"
    && row.tbl_name !== "research_events"
    && row.tbl_name !== "research_workers"
    && row.tbl_name !== "research_items"
    && row.tbl_name !== "research_deliveries"
    && row.tbl_name !== "thread_sub_agent_failure_dismissals"
    && row.name !== "app_update_notice_agents"
    && row.name !== "app_update_notice_deliveries"
    && row.name !== "app_update_notice_eligible_agents"
    && row.name !== "app_update_notice_remove_ineligible_agent"
    && row.name !== "idx_thread_usage_lines_identity"
    && row.name !== "idx_operator_open_questions_backend"
    && row.name !== "idx_operator_open_questions_thread"
    && row.name !== "idx_thread_todos_backend"
    && row.name !== "idx_thread_todos_thread_backend"
    && row.name !== "idx_thread_reviews_backend"
    && row.name !== "idx_thread_reviews_thread_backend"
    && row.name !== "idx_thread_pricing_summaries_thread"
    && row.name !== "idx_thread_usage_lines_assumed_thread"
    && row.name !== "idx_thread_usage_lines_assumed_parent"
    && row.name !== "idx_thread_usage_lines_gate_child_source"
    && row.name !== "idx_thread_usage_lines_gate_usage_turn"
    && row.name !== "idx_thread_usage_lines_completion_turn"
    && row.name !== "idx_thread_usage_lines_child_turn"
    && row.name !== "idx_thread_usage_lines_unpriced_thread"
    && row.name !== "idx_thread_usage_lines_unpriced_parent"
    && row.name !== "idx_thread_usage_lines_spend_thread"
    && row.name !== "idx_thread_usage_lines_spend_parent"
    && row.name !== "idx_thread_usage_turns_pending_acp_compaction"
    && row.name !== "idx_thread_usage_turns_acp_context"
    && row.name !== "idx_thread_usage_turns_navigation_context"
    && row.name !== "idx_automation_runs_backend_turn"
    && row.tbl_name !== "automation_pruned_run_costs"
    && row.name !== "idx_pr_status_watches_retry"
    && row.name !== "idx_pr_status_watches_history"
    && row.name !== "thread_pricing_summary_delta_insert"
    && row.name !== "thread_pricing_summary_delta_update"
    && row.name !== "thread_pricing_summary_delta_delete"
    && !row.name.startsWith("scheduled_action_projection_")
    && !row.name.startsWith("thread_managed_legacy_")
    && row.name !== "thread_sub_agents_padded_child"
    && row.name !== "idx_scheduled_thread_actions_projection_order"
    && row.name !== "idx_scheduled_thread_actions_terminal_updated"
    && row.name !== "idx_threads_subthread_noncanonical_id"
    && row.name !== "idx_threads_subthread_parent"
    && row.name !== "remote_thread_pin_mount_insert"
    && row.name !== "remote_thread_pin_mount_update"
  ).map(row => {
    switch (row.name) {
      case "remote_thread_pins":
        return { ...row, sql: row.sql?.replace(", mount_token BLOB NOT NULL DEFAULT X''", "") };
      case "thread_usage_lines":
        return { ...row, sql: row.sql?.replace(/^ {2}request_pricing +TEXT,\n/m, "") };
      case "thread_usage_turns":
        return { ...row, sql: row.sql?.replace(/^ {2}acp_compaction_before_tokens INTEGER,\n/m, "") };
      case "thread_pricing_summaries":
        return { ...row, sql: row.sql?.replace(", ledger_delta_ready INTEGER NOT NULL DEFAULT 0", "") };
      case "automations":
        return { ...row, sql: row.sql?.replace(", cost_since INTEGER, total_cost_micros INTEGER", "") };
      case "automation_runs":
        return { ...row, sql: row.sql?.replace(", accounted_cost_micros INTEGER", "") };
      case "idx_thread_usage_lines_turn":
        return {
          ...row,
          sql: row.sql?.replace(
            "ON thread_usage_lines(backend, thread_id, turn_id, provider)",
            "ON thread_usage_lines(provider, backend, thread_id, turn_id)",
          ),
        };
      case "idx_thread_usage_lines_source":
        return {
          ...row,
          sql: row.sql?.replace(
            "ON thread_usage_lines(backend, thread_id, source_item_id)\n"
              + "  WHERE status != 'superseded' AND source_item_id IS NOT NULL",
            "ON thread_usage_lines(provider, backend, thread_id, source, source_item_id)",
          ),
        };
      case "idx_thread_usage_turns_turn":
        return {
          ...row,
          sql: row.sql?.replace(
            "(backend, thread_id, turn_id)\n  WHERE turn_id IS NOT NULL",
            "(provider, backend, thread_id, turn_id)",
          ),
        };
      case "idx_thread_usage_lines_read_parent":
        return { ...row, sql: row.sql?.replace("parent_thread_id IS NOT NULL AND ", "") };
      case "thread_sub_agents_by_lens_v3":
        return {
          ...row,
          name: "thread_sub_agents_by_lens_v2",
          sql: row.sql
            ?.replace("thread_sub_agents_by_lens_v3", "thread_sub_agents_by_lens_v2")
            .replace("\n  WHEN substr(monitor_id, 1, 11) = 'acp-native:' THEN 'harness'", ""),
        };
      default:
        return row;
    }
  });
  return {
    sha256: createHash("sha256").update(JSON.stringify(compared)).digest("hex"),
    objects: compared.length,
    userVersion: 80,
  };
}

function schemaDefinition(db: StateDb): unknown {
  const objects = db.raw.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  return {
    // ALTER TABLE may append a missing column in a different physical order.
    // Column names, types, defaults and constraints must still agree, as must
    // every index, trigger and view. Fresh creation separately pins exact SQL.
    objects: objects.map(row => ({ ...row, sql: row.type === "table" ? null : row.sql })),
    tables: objects.filter(row => row.type === "table").map(row => ({
      name: row.name,
      columns: db.raw.prepare('SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY name').all(row.name),
    })),
    userVersion: db.raw.pragma("user_version", { simple: true }),
  };
}

afterEach(() => vi.unstubAllEnvs());

it("retains the exact pre-extraction SQLite schema beneath later migrations", () => {
  const db = openFreshStateDb(":memory:");
  try {
    const actual = schemaAtV80(db);
    expect(db.raw.pragma("user_version", { simple: true })).toBe(CURRENT_STATE_DB_USER_VERSION);
    if (process.env.UPDATE_SHARED_SQLITE_SCHEMA_ORACLE === "1") {
      writeFileSync(oraclePath, JSON.stringify(actual, null, 2) + "\n");
    }
    expect(actual).toEqual(JSON.parse(readFileSync(oraclePath, "utf8")));
  } finally { db.close(); }
});

it("binds desktop adapters and state compatibility exports to one portable implementation", () => {
  expect(DesktopStateDb).toBe(SharedStateDb);
  expect(StateDb).toBe(SharedStateDb);
  expect(CURRENT_STATE_DB_USER_VERSION).toBe(SHARED_STATE_DB_USER_VERSION);
});

// These are old profile shapes already supported by the versioned ladder.
// SQLite's schema, rather than a list of expected columns, is the oracle.
const upgrades = [
  { version: 70, sql: "ALTER TABLE thread_usage_lines DROP COLUMN account_key" },
  { version: 72, sql: "ALTER TABLE thread_todos DROP COLUMN items_json" },
  { version: 73, sql: "DROP TABLE durable_turn_requests" },
  { version: 74, sql: "DROP TABLE thread_reviews" },
  { version: 76, sql: "DROP TABLE thread_dependencies" },
  { version: 77, sql: "DROP INDEX idx_thread_todos_dependency; ALTER TABLE thread_todos DROP COLUMN dependency_id" },
  { version: 80, sql: "DROP TABLE durable_turn_requests; DROP TABLE thread_reviews; DROP TABLE owner_jobs" },
  { version: 82, sql: "ALTER TABLE thread_usage_lines DROP COLUMN request_pricing; DROP TABLE thread_automatic_wake_guards; DROP TABLE thread_automatic_wake_admissions; DROP TABLE thread_automatic_wake_reviews" },
  { version: CURRENT_STATE_DB_USER_VERSION, sql: "DROP INDEX idx_pr_status_watches_retry; DROP INDEX idx_pr_status_watches_history" },
  { version: CURRENT_STATE_DB_USER_VERSION, sql: "DROP INDEX idx_thread_usage_turns_pending_acp_compaction; DROP INDEX idx_thread_usage_turns_acp_context; ALTER TABLE thread_usage_turns DROP COLUMN acp_compaction_before_tokens" },
] as const;

it.each(upgrades)("upgrades v$version ($sql) and reopens without losing metadata or adding writes", async ({ version, sql }) => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const { dbPath, tempDir } = createTempStateDb("shared-sqlite-upgrade-");
  const metadata = [
    { id: "empty-thread", seenAt: 0, title: "", pinnedRank: "", parent: { backend: "codex", threadId: "" } },
    { id: "fixture-thread", seenAt: 2_147_483_648, title: "親スレッド's\0 title", pinnedRank: "a1",
      parent: { backend: "claude", threadId: "thread-😀" } },
  ].map(({ id, seenAt, ...payload }) => ({ id, seenAt, payload: JSON.stringify(payload), secret: Buffer.from(payload.title) }));
  let db: StateDb | undefined;
  try {
    db = StateDb.open(dbPath, { profileName: "fixture" });
    const initialSchema = schemaDefinition(db);
    const insert = db.raw.prepare("INSERT INTO threads(thread_id, last_seen_at, payload) VALUES (?, ?, ?)");
    for (const { id, seenAt, payload, secret } of metadata) {
      insert.run(id, seenAt, payload);
      db.setSecret(id, secret);
    }
    db.raw.exec(sql);
    db.raw.pragma(`user_version = ${version}`);
    db.close();
    db = undefined;
    // All three imports are the same class, as asserted above. Open each
    // migrated shape through every public binding and check steady-state writes.
    for (const [index, host] of hosts.entries()) {
      const reopened = await measureSqliteWrites(() => host.open(dbPath));
      db = reopened.result;
      if (index > 0) expect(reopened.writes.commits).toBe(0);
      const reads = await measureSqliteWrites(() => {
        expect(schemaDefinition(db!)).toEqual(initialSchema);
        expect(db!.getMeta("profile_name")).toBe("fixture");
        const read = db!.raw.prepare("SELECT payload, last_seen_at FROM threads WHERE thread_id = ?");
        for (const { id, seenAt, payload, secret } of metadata) {
          expect(db!.getSecret(id)).toEqual(secret);
          expect(read.get(id)).toEqual({ payload, last_seen_at: seenAt });
        }
      });
      expect(reads.writes.commits).toBe(0);
      db.close();
      db = undefined;
    }
  } finally {
    db?.close();
    removeTempStateDbDir(tempDir);
  }
});

it.each([
  { variant: "default", value: "" },
  { variant: "deferred", value: "owner's metadata" },
  { variant: "immediate", value: "候補😀" },
  { variant: "exclusive", value: "x".repeat(4096) },
] as const)("makes $variant commits visible to every binding and rolls back refusals", async ({ variant, value }) => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const { dbPath, tempDir } = createTempStateDb("shared-sqlite-transactions-");
  const connections: StateDb[] = [];
  try {
    for (const host of hosts) connections.push(host.open(dbPath));
    let previous: string | undefined;
    for (const [index, writer] of connections.entries()) {
      const next = index === 0 ? value : `${value}:${index}`;
      const refuse = writer.raw.transaction(() => {
        writer.setMeta("fixture-value", next);
        throw new Error("fixture rollback");
      });
      const rolledBack = await measureSqliteWrites(() =>
        expect(() => refuse[variant]()).toThrow("fixture rollback"));
      expect(rolledBack.writes.commits).toBe(0);
      for (const reader of connections) expect(reader.getMeta("fixture-value")).toBe(previous);

      const commit = writer.raw.transaction(() => writer.setMeta("fixture-value", next));
      const committed = await measureSqliteWrites(() => commit[variant]());
      expect(committed.writes.commits).toBe(1);
      for (const reader of connections) expect(reader.getMeta("fixture-value")).toBe(next);
      previous = next;
    }
  } finally {
    for (const db of connections) db.close();
    removeTempStateDbDir(tempDir);
  }
});
