import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import {
  estimateOpenAiTokenUsageCost,
  resolveOpenAiPricingServiceTier,
  type ThreadUsageLineRecord,
} from "@pwragent/shared";
import { getNativeBinding } from "./native-binding.js";

export const CURRENT_STATE_DB_USER_VERSION = 25;
export const STATE_DB_WAL_AUTOCHECKPOINT_PAGES = 1000;
export const STATE_DB_JOURNAL_SIZE_LIMIT_BYTES = 16 * 1024 * 1024;

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

const SCHEMA_V2 = `
CREATE TABLE messaging_activity_log (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  platform                 TEXT NOT NULL,
  kind                     TEXT NOT NULL,
  thread_id                TEXT,
  binding_id               TEXT,
  conversation_id          TEXT,
  conversation_title       TEXT,
  actor_id                 TEXT,
  actor_display_name       TEXT,
  summary                  TEXT NOT NULL,
  created_at               INTEGER NOT NULL,
  payload                  TEXT NOT NULL
);
CREATE INDEX idx_messaging_activity_log_created
  ON messaging_activity_log(created_at DESC);
CREATE INDEX idx_messaging_activity_log_platform_created
  ON messaging_activity_log(platform, created_at DESC);
CREATE INDEX idx_messaging_activity_log_thread
  ON messaging_activity_log(thread_id);
`;

const SCHEMA_V3 = `
CREATE TABLE messaging_pairing_tokens (
  entry_id      TEXT PRIMARY KEY,
  token_hmac    TEXT NOT NULL UNIQUE,
  platform      TEXT NOT NULL,
  instance_id   TEXT NOT NULL,
  scope         TEXT NOT NULL,
  status        TEXT NOT NULL,
  generated_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  observed_at   INTEGER,
  payload       TEXT NOT NULL
);
CREATE INDEX idx_messaging_pairing_platform_expires
  ON messaging_pairing_tokens(platform, instance_id, expires_at);
CREATE INDEX idx_messaging_pairing_status
  ON messaging_pairing_tokens(status, expires_at);
`;

const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS monitor_subscriptions (
  subscription_id  TEXT PRIMARY KEY,
  channel_kind     TEXT NOT NULL,
  channel_id       TEXT NOT NULL,
  status           TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  revoked_at       INTEGER,
  payload          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_monitor_subscriptions_channel
  ON monitor_subscriptions(channel_kind, channel_id);

CREATE TABLE IF NOT EXISTS app_runtime_instances (
  instance_id                 TEXT PRIMARY KEY,
  profile_name                TEXT NOT NULL,
  process_id                  INTEGER NOT NULL,
  cwd_hint                    TEXT,
  cwd_hash                    TEXT,
  started_at                  INTEGER NOT NULL,
  heartbeat_at                INTEGER NOT NULL,
  exited_at                   INTEGER,
  desired_messaging_enabled   INTEGER NOT NULL,
  effective_messaging_enabled INTEGER NOT NULL,
  disabled_reason             TEXT
);
CREATE INDEX IF NOT EXISTS idx_app_runtime_instances_profile_heartbeat
  ON app_runtime_instances(profile_name, heartbeat_at DESC);

CREATE TABLE IF NOT EXISTS messaging_runtime_lease (
  lease_key         TEXT PRIMARY KEY,
  owner_instance_id TEXT NOT NULL,
  acquired_at       INTEGER NOT NULL,
  heartbeat_at      INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  released_at       INTEGER,
  status            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messaging_runtime_lease_status_expires
  ON messaging_runtime_lease(status, expires_at);
`;

const DIRECTORY_GIT_STATUS_SCHEMA = `
CREATE TABLE IF NOT EXISTS directory_git_status (
  directory_key        TEXT PRIMARY KEY,
  directory_path       TEXT,
  directory_updated_at INTEGER,
  fetched_at           INTEGER NOT NULL,
  payload              TEXT
);
CREATE INDEX IF NOT EXISTS idx_directory_git_status_fetched
  ON directory_git_status(fetched_at DESC);
`;

const DIRECTORY_OVERLAY_SCHEMA = `
CREATE TABLE IF NOT EXISTS directory_overlay (
  directory_key TEXT PRIMARY KEY,
  payload       TEXT NOT NULL
);
`;

// Per-worktree git working-state cache (the dirty/unpushed thread-row
// chips), keyed by a thread's working directory path. Sibling of
// `directory_git_status`, which caches per-repo branch/sync state.
const THREAD_GIT_WORKING_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS thread_git_working_state (
  worktree_path TEXT PRIMARY KEY,
  fetched_at    INTEGER NOT NULL,
  payload       TEXT
);
CREATE INDEX IF NOT EXISTS idx_thread_git_working_state_fetched
  ON thread_git_working_state(fetched_at DESC);
`;

const COMPOSER_DRAFT_RECOVERY_SCHEMA = `
CREATE TABLE IF NOT EXISTS composer_draft_latest (
  scope_key    TEXT PRIMARY KEY,
  scope_kind   TEXT NOT NULL,
  status       TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  payload      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_composer_draft_latest_updated
  ON composer_draft_latest(updated_at DESC);

CREATE TABLE IF NOT EXISTS composer_draft_journal (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_key    TEXT NOT NULL,
  scope_kind   TEXT NOT NULL,
  status       TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  char_count   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  payload      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_composer_draft_journal_scope_updated
  ON composer_draft_journal(scope_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_composer_draft_journal_updated
  ON composer_draft_journal(updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_composer_draft_journal_scope_hash_status
  ON composer_draft_journal(scope_key, content_hash, status);
`;

const MESSAGING_TOPIC_MANAGEMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS messaging_managed_topics (
  topic_record_id TEXT PRIMARY KEY,
  channel_kind    TEXT NOT NULL,
  supergroup_id   TEXT NOT NULL,
  topic_id        TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  payload         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messaging_managed_topics_conversation
  ON messaging_managed_topics(channel_kind, supergroup_id, topic_id);
CREATE INDEX IF NOT EXISTS idx_messaging_managed_topics_supergroup
  ON messaging_managed_topics(channel_kind, supergroup_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messaging_thread_topic_links (
  link_id         TEXT PRIMARY KEY,
  channel_kind    TEXT NOT NULL,
  supergroup_id   TEXT NOT NULL,
  backend         TEXT NOT NULL,
  thread_id       TEXT NOT NULL,
  topic_record_id TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  payload         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messaging_thread_topic_links_unique
  ON messaging_thread_topic_links(channel_kind, supergroup_id, backend, thread_id);

CREATE TABLE IF NOT EXISTS messaging_topic_cleanup_proposals (
  proposal_id   TEXT PRIMARY KEY,
  channel_kind  TEXT NOT NULL,
  supergroup_id TEXT NOT NULL,
  status        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  applied_at    INTEGER,
  expires_at    INTEGER,
  payload       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messaging_topic_cleanup_proposals_supergroup
  ON messaging_topic_cleanup_proposals(channel_kind, supergroup_id, updated_at DESC);
`;

const ACP_AGENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS acp_registry_cache (
  cache_key   TEXT PRIMARY KEY,
  fetched_at  INTEGER NOT NULL,
  payload     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acp_registry_cache_fetched
  ON acp_registry_cache(fetched_at DESC);

CREATE TABLE IF NOT EXISTS acp_installed_agents (
  backend_id           TEXT PRIMARY KEY,
  registry_id          TEXT NOT NULL,
  version              TEXT,
  install_status       TEXT NOT NULL,
  auth_status          TEXT NOT NULL,
  verification_status  TEXT NOT NULL,
  installed_at         INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  payload              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acp_installed_agents_registry
  ON acp_installed_agents(registry_id);
CREATE INDEX IF NOT EXISTS idx_acp_installed_agents_updated
  ON acp_installed_agents(updated_at DESC);
`;

const ACP_SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS acp_sessions (
  backend_id  TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  payload     TEXT NOT NULL,
  PRIMARY KEY (backend_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_acp_sessions_backend_updated
  ON acp_sessions(backend_id, updated_at DESC);
`;

const AUTOMATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS automations (
  automation_id  TEXT PRIMARY KEY,
  backend        TEXT NOT NULL,
  thread_id      TEXT NOT NULL,
  name           TEXT NOT NULL,
  status         TEXT NOT NULL,
  backlog_policy TEXT NOT NULL,
  next_run_at    INTEGER,
  last_run_at    INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER,
  payload        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automations_thread
  ON automations(backend, thread_id, status);
CREATE INDEX IF NOT EXISTS idx_automations_next_run
  ON automations(status, next_run_at);

CREATE TABLE IF NOT EXISTS automation_runs (
  run_id          TEXT PRIMARY KEY,
  automation_id  TEXT NOT NULL,
  backend         TEXT NOT NULL,
  thread_id       TEXT NOT NULL,
  status          TEXT NOT NULL,
  trigger         TEXT NOT NULL,
  scheduled_for   INTEGER,
  queued_at       INTEGER,
  started_at      INTEGER,
  completed_at    INTEGER,
  backend_turn_id TEXT,
  queue_entry_id  TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  payload         TEXT NOT NULL,
  FOREIGN KEY (automation_id) REFERENCES automations(automation_id)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_automation_updated
  ON automation_runs(automation_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_thread_updated
  ON automation_runs(backend, thread_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_status
  ON automation_runs(status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_one_pending_scheduled
  ON automation_runs(automation_id)
  WHERE trigger = 'scheduled' AND status IN ('pending', 'queued');

CREATE TABLE IF NOT EXISTS automation_run_artifacts (
  run_id         TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  backend       TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  status        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  payload       TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES automation_runs(run_id)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_automation_run_artifacts_automation_updated
  ON automation_run_artifacts(automation_id, updated_at DESC);
`;

const MESSAGING_ACTIVITY_SUMMARY_SCHEMA = `
CREATE TABLE IF NOT EXISTS messaging_activity_summary (
  platform         TEXT PRIMARY KEY,
  last_request_at  INTEGER,
  last_response_at INTEGER,
  updated_at       INTEGER NOT NULL
);
`;

const THREAD_SEARCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS thread_search_documents (
  identity_key            TEXT PRIMARY KEY,
  backend                 TEXT NOT NULL,
  thread_id               TEXT NOT NULL,
  title                   TEXT NOT NULL,
  title_source            TEXT,
  summary                 TEXT,
  project_key             TEXT,
  created_at              INTEGER,
  updated_at              INTEGER,
  archived_at             INTEGER,
  git_branch              TEXT,
  git_origin_url          TEXT,
  model                   TEXT,
  linked_directories_json TEXT NOT NULL,
  display_json            TEXT NOT NULL,
  indexed_at              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_search_documents_backend_updated
  ON thread_search_documents(backend, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_thread_search_documents_project_updated
  ON thread_search_documents(project_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_thread_search_documents_archived
  ON thread_search_documents(archived_at);

CREATE VIRTUAL TABLE IF NOT EXISTS thread_search_fts USING fts5(
  identity_key UNINDEXED,
  title,
  summary,
  project_key,
  directory_labels,
  directory_paths,
  git_branch,
  git_origin_url,
  model,
  backend,
  thread_id,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '-_./:'"
);
`;

const PR_STATUS_CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS pr_status_cache (
  pr_key     TEXT PRIMARY KEY,
  provider   TEXT NOT NULL DEFAULT 'github.com',
  org        TEXT NOT NULL,
  repo       TEXT NOT NULL,
  number     INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  payload    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pr_status_cache_fetched
  ON pr_status_cache(fetched_at DESC);
`;

const PR_LOOKUP_CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS pr_lookup_cache (
  lookup_key      TEXT PRIMARY KEY,
  provider        TEXT NOT NULL DEFAULT 'github.com',
  branch          TEXT NOT NULL,
  directory_paths TEXT NOT NULL,
  fetched_at      INTEGER NOT NULL,
  payload         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pr_lookup_cache_fetched
  ON pr_lookup_cache(fetched_at DESC);
`;

const THREAD_USAGE_PRICING_SCHEMA = `
CREATE TABLE IF NOT EXISTS pricing_catalog_versions (
  catalog_id      TEXT NOT NULL,
  catalog_version TEXT NOT NULL,
  provider        TEXT NOT NULL,
  currency        TEXT NOT NULL,
  effective_from  INTEGER NOT NULL,
  effective_to    INTEGER,
  source_label    TEXT,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (catalog_id, catalog_version)
);

CREATE TABLE IF NOT EXISTS pricing_rates (
  rate_id                         TEXT PRIMARY KEY,
  catalog_id                      TEXT NOT NULL,
  catalog_version                 TEXT NOT NULL,
  provider                        TEXT NOT NULL,
  currency                        TEXT NOT NULL,
  model                           TEXT NOT NULL,
  service_tier                    TEXT NOT NULL,
  input_micros_per_million        INTEGER NOT NULL,
  cached_input_micros_per_million INTEGER NOT NULL,
  output_micros_per_million       INTEGER NOT NULL,
  display_name                    TEXT NOT NULL,
  FOREIGN KEY (catalog_id, catalog_version)
    REFERENCES pricing_catalog_versions(catalog_id, catalog_version)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pricing_rates_lookup
  ON pricing_rates(provider, model, service_tier, currency);

CREATE TABLE IF NOT EXISTS thread_usage_turns (
  usage_turn_id       TEXT PRIMARY KEY,
  provider            TEXT NOT NULL,
  backend             TEXT NOT NULL,
  thread_id           TEXT NOT NULL,
  parent_thread_id    TEXT,
  turn_id             TEXT,
  model               TEXT,
  reasoning_effort    TEXT,
  service_tier        TEXT,
  fast_mode           INTEGER,
  settings_source     TEXT,
  settings_confidence TEXT,
  started_at          INTEGER,
  completed_at        INTEGER,
  observed_at         INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_usage_turns_thread
  ON thread_usage_turns(provider, backend, thread_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_thread_usage_turns_turn
  ON thread_usage_turns(provider, backend, thread_id, turn_id);

CREATE TABLE IF NOT EXISTS thread_usage_lines (
  usage_line_id              TEXT PRIMARY KEY,
  usage_turn_id              TEXT,
  provider                   TEXT NOT NULL DEFAULT 'openai',
  backend                    TEXT NOT NULL,
  thread_id                  TEXT NOT NULL,
  parent_thread_id           TEXT,
  turn_id                    TEXT,
  source                     TEXT NOT NULL,
  source_item_id             TEXT,
  scope                      TEXT NOT NULL,
  status                     TEXT NOT NULL,
  created_at                 INTEGER NOT NULL,
  completed_at               INTEGER,
  model                      TEXT,
  reasoning_effort           TEXT,
  service_tier               TEXT,
  fast_mode                  INTEGER,
  settings_source            TEXT,
  settings_confidence        TEXT,
  input_tokens               INTEGER NOT NULL,
  cached_input_tokens        INTEGER NOT NULL,
  uncached_input_tokens      INTEGER NOT NULL,
  output_tokens              INTEGER NOT NULL,
  reasoning_output_tokens    INTEGER NOT NULL,
  total_tokens               INTEGER NOT NULL,
  cumulative_input_tokens    INTEGER,
  cumulative_cached_input_tokens INTEGER,
  cumulative_uncached_input_tokens INTEGER,
  cumulative_output_tokens   INTEGER,
  cumulative_reasoning_output_tokens INTEGER,
  cumulative_total_tokens    INTEGER,
  price_status               TEXT NOT NULL,
  price_unavailable_reason   TEXT,
  currency                   TEXT NOT NULL,
  pricing_catalog_id         TEXT,
  pricing_catalog_version    TEXT,
  pricing_rate_id            TEXT,
  uncached_input_cost_micros INTEGER NOT NULL,
  cached_input_cost_micros   INTEGER NOT NULL,
  output_cost_micros         INTEGER NOT NULL,
  total_cost_micros          INTEGER NOT NULL,
  cumulative_total_cost_micros INTEGER,
  updated_at                 INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_usage_lines_thread
  ON thread_usage_lines(provider, backend, thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_thread_usage_lines_parent
  ON thread_usage_lines(provider, backend, parent_thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_thread_usage_lines_turn
  ON thread_usage_lines(provider, backend, thread_id, turn_id);
CREATE INDEX IF NOT EXISTS idx_thread_usage_lines_source
  ON thread_usage_lines(provider, backend, thread_id, source, source_item_id);
CREATE INDEX IF NOT EXISTS idx_thread_usage_lines_read_thread
  ON thread_usage_lines(backend, thread_id, created_at DESC, usage_line_id DESC)
  WHERE status != 'superseded';
CREATE INDEX IF NOT EXISTS idx_thread_usage_lines_read_parent
  ON thread_usage_lines(backend, parent_thread_id, created_at DESC, usage_line_id DESC)
  WHERE status != 'superseded';
CREATE INDEX IF NOT EXISTS idx_thread_usage_lines_summary_thread
  ON thread_usage_lines(provider, backend, currency, thread_id)
  WHERE status != 'superseded';
CREATE INDEX IF NOT EXISTS idx_thread_usage_lines_summary_parent
  ON thread_usage_lines(provider, backend, currency, parent_thread_id)
  WHERE status != 'superseded';

CREATE TABLE IF NOT EXISTS thread_pricing_summaries (
  provider                  TEXT NOT NULL DEFAULT 'openai',
  backend                   TEXT NOT NULL,
  thread_id                 TEXT NOT NULL,
  currency                  TEXT NOT NULL,
  usage_line_count          INTEGER NOT NULL,
  priced_usage_line_count   INTEGER NOT NULL,
  unpriced_usage_line_count INTEGER NOT NULL,
  input_tokens              INTEGER NOT NULL,
  cached_input_tokens       INTEGER NOT NULL,
  uncached_input_tokens     INTEGER NOT NULL,
  output_tokens             INTEGER NOT NULL,
  reasoning_output_tokens   INTEGER NOT NULL,
  total_tokens              INTEGER NOT NULL,
  total_cost_micros         INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  PRIMARY KEY (provider, backend, thread_id, currency)
);
`;

const DELIVERIES_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const REVOKED_BINDINGS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const APP_RUNTIME_INSTANCE_RETENTION_MS = 60 * 60 * 1000;
const COMPOSER_DRAFT_JOURNAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const COMPOSER_DRAFT_JOURNAL_CAP = 300;
/**
 * Per-platform cap for the messaging activity log. Older rows are
 * evicted FIFO so the table stays small even on busy platforms. Tuned
 * to ~hours of normal traffic; raise via a future setting if anyone
 * needs deeper history.
 */
const MESSAGING_ACTIVITY_LOG_PER_PLATFORM_CAP = 500;

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
    db.pragma(`wal_autocheckpoint = ${STATE_DB_WAL_AUTOCHECKPOINT_PAGES}`);
    db.pragma(`journal_size_limit = ${STATE_DB_JOURNAL_SIZE_LIMIT_BYTES}`);
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");

    // Migrations are wrapped in transactions so a partial failure
    // (mid-DDL crash, transient disk error) rolls back cleanly and the
    // next launch retries from the previous user_version. Without the
    // transaction the table could exist with the old user_version, and
    // the next launch would throw "table already exists" on retry.
    const userVersion = db.pragma("user_version", { simple: true }) as number;
    if (userVersion === 0) {
      db.pragma("auto_vacuum = INCREMENTAL");
      db.transaction(() => {
        db.exec(SCHEMA_V1);
        if (options?.profileName) {
          db.prepare("UPDATE meta SET value = ? WHERE key = 'profile_name'").run(
            options.profileName,
          );
        }
        db.pragma("user_version = 1");
      })();
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 2) {
      db.transaction(() => {
        db.exec(SCHEMA_V2);
        db.pragma("user_version = 2");
      })();
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 3) {
      db.transaction(() => {
        db.exec(SCHEMA_V3);
        db.pragma("user_version = 3");
      })();
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 4) {
      db.transaction(() => {
        db.exec(SCHEMA_V4);
        db.pragma("user_version = 4");
      })();
    }
    ensureCurrentSchema(db);
    if ((db.pragma("user_version", { simple: true }) as number) < 5) {
      db.transaction(() => {
        db.pragma("user_version = 5");
      })();
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 6) {
      db.transaction(() => {
        db.exec(COMPOSER_DRAFT_RECOVERY_SCHEMA);
        db.pragma("user_version = 6");
      })();
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 7) {
      db.transaction(() => {
        // Directory pin persistence — see plan
        // 2026-05-09-002-feat-directory-pinning-plan.md Unit B.
        // Additive table, no data migration; the same DDL also
        // lives in `ensureCurrentSchema` so re-instantiated dbs
        // converge.
        db.exec(DIRECTORY_OVERLAY_SCHEMA);
        db.pragma("user_version = 7");
      })();
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 8) {
      db.transaction(() => {
        db.exec(MESSAGING_TOPIC_MANAGEMENT_SCHEMA);
        db.pragma("user_version = 8");
      })();
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 9) {
      db.transaction(() => {
        db.exec(ACP_AGENT_SCHEMA);
        db.pragma("user_version = 9");
      })();
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 10) {
      db.transaction(() => {
        db.exec(ACP_SESSION_SCHEMA);
        db.pragma("user_version = 10");
      })();
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 11) {
      db.transaction(() => {
        db.exec(AUTOMATION_SCHEMA);
        db.pragma("user_version = 11");
      })();
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 12) {
      db.transaction(() => {
        db.exec(MESSAGING_ACTIVITY_SUMMARY_SCHEMA);
        db.pragma("user_version = 12");
      })();
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 13) {
      db.transaction(() => {
        db.exec(THREAD_SEARCH_SCHEMA);
        db.pragma("user_version = 13");
      })();
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 14) {
      db.transaction(() => {
        db.exec(PR_STATUS_CACHE_SCHEMA);
        db.exec(PR_LOOKUP_CACHE_SCHEMA);
        db.pragma("user_version = 14");
      })();
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 15) {
      db.transaction(() => {
        ensurePullRequestProviderColumns(db);
        db.pragma("user_version = 15");
      })();
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 16) {
      db.transaction(() => {
        db.exec(THREAD_GIT_WORKING_STATE_SCHEMA);
        db.pragma("user_version = 16");
      })();
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 17) {
      db.transaction(() => {
        db.exec(THREAD_USAGE_PRICING_SCHEMA);
        db.pragma("user_version = 17");
      })();
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 18) {
      db.transaction(() => {
        ensureThreadUsagePricingProviderScope(db);
        db.pragma("user_version = 18");
      })();
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 19) {
      db.transaction(() => {
        ensureThreadUsagePricingCumulativeColumns(db);
        db.pragma("user_version = 19");
      })();
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 20) {
      db.transaction(() => {
        repairThreadUsageLineCreatedAt(db);
        db.pragma("user_version = 20");
      })();
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 21) {
      db.transaction(() => {
        ensureThreadUsagePricingIndexes(db);
        db.pragma("user_version = 21");
      })();
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 22) {
      db.transaction(() => {
        repairOpenAiThreadUsagePricing(db);
        db.pragma("user_version = 22");
      })();
    }
    if ((db.pragma("user_version", { simple: true }) as number) < 25) {
      db.transaction(() => {
        ensureThreadSearchFtsThreadIdColumn(db);
        db.pragma(`user_version = ${CURRENT_STATE_DB_USER_VERSION}`);
      })();
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
        .prepare(
          "UPDATE messaging_pairing_tokens SET status = 'expired' WHERE status IN ('pending', 'observed') AND expires_at < ?",
        )
        .run(now);
      this.db
        .prepare(
          "UPDATE messaging_runtime_lease SET status = 'expired' WHERE status = 'active' AND expires_at < ?",
        )
        .run(now);
      this.db
        .prepare(
          "DELETE FROM app_runtime_instances WHERE heartbeat_at < ? AND exited_at IS NOT NULL",
        )
        .run(now - APP_RUNTIME_INSTANCE_RETENTION_MS);
      this.db
        .prepare("DELETE FROM deliveries WHERE created_at < ?")
        .run(now - DELIVERIES_RETENTION_MS);
      this.db
        .prepare(
          "DELETE FROM bindings WHERE revoked_at IS NOT NULL AND revoked_at < ?",
        )
        .run(now - REVOKED_BINDINGS_RETENTION_MS);
      // Per-platform FIFO eviction for the activity log: keep the
      // newest N per platform; delete the rest. A single windowed
      // DELETE handles every platform at once — the inner subquery
      // computes a per-platform rank by id-desc, and we delete rows
      // beyond the cap. Cleaner than the previous distinct-platforms
      // loop and runs in one statement.
      this.db
        .prepare(
          `DELETE FROM messaging_activity_log
           WHERE id IN (
             SELECT id FROM (
               SELECT
                 id,
                 ROW_NUMBER() OVER (
                   PARTITION BY platform
                   ORDER BY id DESC
                 ) AS rank
               FROM messaging_activity_log
             )
             WHERE rank > ?
           )`,
        )
        .run(MESSAGING_ACTIVITY_LOG_PER_PLATFORM_CAP);
      this.db
        .prepare("DELETE FROM composer_draft_journal WHERE updated_at < ?")
        .run(now - COMPOSER_DRAFT_JOURNAL_RETENTION_MS);
      this.db
        .prepare(
          `DELETE FROM composer_draft_journal
           WHERE id IN (
             SELECT id FROM composer_draft_journal
             ORDER BY updated_at DESC, id DESC
             LIMIT -1 OFFSET ?
           )`,
        )
        .run(COMPOSER_DRAFT_JOURNAL_CAP);
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

function ensureCurrentSchema(db: BetterSqlite3.Database): void {
  db.transaction(() => {
    db.exec(SCHEMA_V4);
    db.exec(DIRECTORY_GIT_STATUS_SCHEMA);
    db.exec(THREAD_GIT_WORKING_STATE_SCHEMA);
    db.exec(DIRECTORY_OVERLAY_SCHEMA);
    db.exec(COMPOSER_DRAFT_RECOVERY_SCHEMA);
    db.exec(MESSAGING_TOPIC_MANAGEMENT_SCHEMA);
    db.exec(ACP_AGENT_SCHEMA);
    db.exec(ACP_SESSION_SCHEMA);
    db.exec(AUTOMATION_SCHEMA);
    db.exec(MESSAGING_ACTIVITY_SUMMARY_SCHEMA);
    db.exec(THREAD_SEARCH_SCHEMA);
    db.exec(PR_STATUS_CACHE_SCHEMA);
    db.exec(PR_LOOKUP_CACHE_SCHEMA);
    ensureThreadSearchFtsThreadIdColumn(db);
    ensurePullRequestProviderColumns(db);
    ensureThreadUsagePricingProviderScope(db);
    ensureThreadUsagePricingCumulativeColumns(db);
    if ((db.pragma("user_version", { simple: true }) as number) < 4) {
      db.pragma("user_version = 4");
    }
  })();

  if (!tableColumnExists(db, "app_runtime_instances", "cwd_hash")) {
    db.exec("ALTER TABLE app_runtime_instances ADD COLUMN cwd_hash TEXT");
  }
  db.exec(`
CREATE INDEX IF NOT EXISTS idx_app_runtime_instances_profile_cwd_hash
  ON app_runtime_instances(profile_name, cwd_hash, heartbeat_at DESC);
`);
}

function ensureThreadUsagePricingProviderScope(db: BetterSqlite3.Database): void {
  const hasUsageLines = tableExists(db, "thread_usage_lines");
  const hasPricingSummaries = tableExists(db, "thread_pricing_summaries");
  if (!hasUsageLines || !hasPricingSummaries) {
    db.exec(THREAD_USAGE_PRICING_SCHEMA);
    return;
  }

  db.exec(`
CREATE TABLE IF NOT EXISTS pricing_catalog_versions (
  catalog_id      TEXT NOT NULL,
  catalog_version TEXT NOT NULL,
  provider        TEXT NOT NULL,
  currency        TEXT NOT NULL,
  effective_from  INTEGER NOT NULL,
  effective_to    INTEGER,
  source_label    TEXT,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (catalog_id, catalog_version)
);

CREATE TABLE IF NOT EXISTS pricing_rates (
  rate_id                         TEXT PRIMARY KEY,
  catalog_id                      TEXT NOT NULL,
  catalog_version                 TEXT NOT NULL,
  provider                        TEXT NOT NULL,
  currency                        TEXT NOT NULL,
  model                           TEXT NOT NULL,
  service_tier                    TEXT NOT NULL,
  input_micros_per_million        INTEGER NOT NULL,
  cached_input_micros_per_million INTEGER NOT NULL,
  output_micros_per_million       INTEGER NOT NULL,
  display_name                    TEXT NOT NULL,
  FOREIGN KEY (catalog_id, catalog_version)
    REFERENCES pricing_catalog_versions(catalog_id, catalog_version)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pricing_rates_lookup
  ON pricing_rates(provider, model, service_tier, currency);

CREATE TABLE IF NOT EXISTS thread_usage_turns (
  usage_turn_id       TEXT PRIMARY KEY,
  provider            TEXT NOT NULL,
  backend             TEXT NOT NULL,
  thread_id           TEXT NOT NULL,
  parent_thread_id    TEXT,
  turn_id             TEXT,
  model               TEXT,
  reasoning_effort    TEXT,
  service_tier        TEXT,
  fast_mode           INTEGER,
  settings_source     TEXT,
  settings_confidence TEXT,
  started_at          INTEGER,
  completed_at        INTEGER,
  observed_at         INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_usage_turns_thread
  ON thread_usage_turns(provider, backend, thread_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_thread_usage_turns_turn
  ON thread_usage_turns(provider, backend, thread_id, turn_id);
`);

  if (!tableColumnExists(db, "thread_usage_lines", "provider")) {
    db.exec(
      "ALTER TABLE thread_usage_lines ADD COLUMN provider TEXT NOT NULL DEFAULT 'openai'",
    );
  }
  if (!tableColumnExists(db, "thread_usage_lines", "usage_turn_id")) {
    db.exec("ALTER TABLE thread_usage_lines ADD COLUMN usage_turn_id TEXT");
  }
  db.exec(`
UPDATE thread_usage_lines
SET
  provider = COALESCE(NULLIF(provider, ''), 'openai'),
  usage_turn_id = COALESCE(
    NULLIF(usage_turn_id, ''),
    COALESCE(NULLIF(provider, ''), 'openai') || ':' || backend || ':' || thread_id || ':' || COALESCE(turn_id, usage_line_id)
  )
`);

  db.exec(`
INSERT INTO thread_usage_turns (
  usage_turn_id,
  provider,
  backend,
  thread_id,
  parent_thread_id,
  turn_id,
  model,
  reasoning_effort,
  service_tier,
  fast_mode,
  settings_source,
  settings_confidence,
  started_at,
  completed_at,
  observed_at,
  updated_at
)
SELECT
  usage_turn_id,
  provider,
  backend,
  thread_id,
  parent_thread_id,
  turn_id,
  model,
  reasoning_effort,
  service_tier,
  fast_mode,
  settings_source,
  settings_confidence,
  MIN(created_at),
  MAX(completed_at),
  MIN(created_at),
  MAX(updated_at)
FROM thread_usage_lines
WHERE usage_turn_id IS NOT NULL
GROUP BY usage_turn_id
ON CONFLICT(usage_turn_id) DO UPDATE SET
  provider = excluded.provider,
  backend = excluded.backend,
  thread_id = excluded.thread_id,
  parent_thread_id = excluded.parent_thread_id,
  turn_id = excluded.turn_id,
  model = excluded.model,
  reasoning_effort = excluded.reasoning_effort,
  service_tier = excluded.service_tier,
  fast_mode = excluded.fast_mode,
  settings_source = excluded.settings_source,
  settings_confidence = excluded.settings_confidence,
  started_at = excluded.started_at,
  completed_at = excluded.completed_at,
  observed_at = MIN(thread_usage_turns.observed_at, excluded.observed_at),
  updated_at = excluded.updated_at
`);

  if (!tableColumnExists(db, "thread_pricing_summaries", "provider")) {
    db.exec(
      "ALTER TABLE thread_pricing_summaries ADD COLUMN provider TEXT NOT NULL DEFAULT 'openai'",
    );
  }
  db.exec("DROP TABLE IF EXISTS thread_pricing_summaries_v2");
  db.exec(`
CREATE TABLE thread_pricing_summaries_v2 (
  provider                  TEXT NOT NULL DEFAULT 'openai',
  backend                   TEXT NOT NULL,
  thread_id                 TEXT NOT NULL,
  currency                  TEXT NOT NULL,
  usage_line_count          INTEGER NOT NULL,
  priced_usage_line_count   INTEGER NOT NULL,
  unpriced_usage_line_count INTEGER NOT NULL,
  input_tokens              INTEGER NOT NULL,
  cached_input_tokens       INTEGER NOT NULL,
  uncached_input_tokens     INTEGER NOT NULL,
  output_tokens             INTEGER NOT NULL,
  reasoning_output_tokens   INTEGER NOT NULL,
  total_tokens              INTEGER NOT NULL,
  total_cost_micros         INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  PRIMARY KEY (provider, backend, thread_id, currency)
)
`);
  db.exec(`
INSERT INTO thread_pricing_summaries_v2
SELECT
  COALESCE(NULLIF(provider, ''), 'openai'),
  backend,
  thread_id,
  currency,
  usage_line_count,
  priced_usage_line_count,
  unpriced_usage_line_count,
  input_tokens,
  cached_input_tokens,
  uncached_input_tokens,
  output_tokens,
  reasoning_output_tokens,
  total_tokens,
  total_cost_micros,
  updated_at
FROM thread_pricing_summaries
`);
  db.exec("DROP TABLE thread_pricing_summaries");
  db.exec("ALTER TABLE thread_pricing_summaries_v2 RENAME TO thread_pricing_summaries");
  db.exec(THREAD_USAGE_PRICING_SCHEMA);
}

function ensureThreadUsagePricingCumulativeColumns(db: BetterSqlite3.Database): void {
  if (!tableExists(db, "thread_usage_lines")) {
    db.exec(THREAD_USAGE_PRICING_SCHEMA);
    return;
  }

  const columns: Array<{ name: string; sql: string }> = [
    {
      name: "cumulative_input_tokens",
      sql: "ALTER TABLE thread_usage_lines ADD COLUMN cumulative_input_tokens INTEGER",
    },
    {
      name: "cumulative_cached_input_tokens",
      sql: "ALTER TABLE thread_usage_lines ADD COLUMN cumulative_cached_input_tokens INTEGER",
    },
    {
      name: "cumulative_uncached_input_tokens",
      sql: "ALTER TABLE thread_usage_lines ADD COLUMN cumulative_uncached_input_tokens INTEGER",
    },
    {
      name: "cumulative_output_tokens",
      sql: "ALTER TABLE thread_usage_lines ADD COLUMN cumulative_output_tokens INTEGER",
    },
    {
      name: "cumulative_reasoning_output_tokens",
      sql: "ALTER TABLE thread_usage_lines ADD COLUMN cumulative_reasoning_output_tokens INTEGER",
    },
    {
      name: "cumulative_total_tokens",
      sql: "ALTER TABLE thread_usage_lines ADD COLUMN cumulative_total_tokens INTEGER",
    },
    {
      name: "cumulative_total_cost_micros",
      sql: "ALTER TABLE thread_usage_lines ADD COLUMN cumulative_total_cost_micros INTEGER",
    },
  ];
  for (const column of columns) {
    if (!tableColumnExists(db, "thread_usage_lines", column.name)) {
      db.exec(column.sql);
    }
  }
}

function ensureThreadSearchFtsThreadIdColumn(db: BetterSqlite3.Database): void {
  if (!tableExists(db, "thread_search_documents")) {
    db.exec(THREAD_SEARCH_SCHEMA);
    return;
  }
  if (
    tableExists(db, "thread_search_fts") &&
    tableColumnExists(db, "thread_search_fts", "thread_id")
  ) {
    return;
  }

  db.exec("DROP TABLE IF EXISTS thread_search_fts");
  db.exec(THREAD_SEARCH_SCHEMA);

  const rows = db
    .prepare(
      `SELECT
         identity_key,
         backend,
         thread_id,
         title,
         summary,
         project_key,
         git_branch,
         git_origin_url,
         model,
         linked_directories_json
       FROM thread_search_documents`,
    )
    .all() as Array<{
    backend: string;
    git_branch: string | null;
    git_origin_url: string | null;
    identity_key: string;
    linked_directories_json: string;
    model: string | null;
    project_key: string | null;
    summary: string | null;
    thread_id: string;
    title: string;
  }>;
  const insert = db.prepare(
    `INSERT INTO thread_search_fts (
       identity_key, title, summary, project_key, directory_labels,
       directory_paths, git_branch, git_origin_url, model, backend, thread_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const row of rows) {
    const directories = parseThreadSearchLinkedDirectories(
      row.linked_directories_json,
    );
    insert.run(
      row.identity_key,
      row.title,
      row.summary ?? "",
      row.project_key ?? "",
      directories.map((directory) => directory.label).join(" "),
      directories
        .flatMap((directory) => [directory.path, directory.worktreePath].filter(Boolean))
        .join(" "),
      row.git_branch ?? "",
      row.git_origin_url ?? "",
      row.model ?? "",
      row.backend,
      row.thread_id,
    );
  }
}

function parseThreadSearchLinkedDirectories(value: string): Array<{
  label?: string;
  path?: string;
  worktreePath?: string;
}> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object",
      )
      .map((entry) => ({
        ...(typeof entry.label === "string" ? { label: entry.label } : {}),
        ...(typeof entry.path === "string" ? { path: entry.path } : {}),
        ...(typeof entry.worktreePath === "string"
          ? { worktreePath: entry.worktreePath }
          : {}),
      }));
  } catch {
    return [];
  }
}

function repairThreadUsageLineCreatedAt(db: BetterSqlite3.Database): void {
  if (
    !tableExists(db, "thread_usage_lines") ||
    !tableExists(db, "thread_usage_turns") ||
    !tableColumnExists(db, "thread_usage_lines", "usage_turn_id")
  ) {
    return;
  }

  db.exec(`
UPDATE thread_usage_lines
SET created_at = (
  SELECT MIN(thread_usage_lines.created_at, thread_usage_turns.observed_at)
  FROM thread_usage_turns
  WHERE thread_usage_turns.usage_turn_id = thread_usage_lines.usage_turn_id
)
WHERE source = 'live'
  AND usage_turn_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM thread_usage_turns
    WHERE thread_usage_turns.usage_turn_id = thread_usage_lines.usage_turn_id
      AND thread_usage_turns.observed_at < thread_usage_lines.created_at
  )
`);
}

function ensureThreadUsagePricingIndexes(db: BetterSqlite3.Database): void {
  if (!tableExists(db, "thread_usage_lines")) {
    db.exec(THREAD_USAGE_PRICING_SCHEMA);
    return;
  }

  db.exec(`
CREATE INDEX IF NOT EXISTS idx_thread_usage_lines_read_thread
  ON thread_usage_lines(backend, thread_id, created_at DESC, usage_line_id DESC)
  WHERE status != 'superseded';
CREATE INDEX IF NOT EXISTS idx_thread_usage_lines_read_parent
  ON thread_usage_lines(backend, parent_thread_id, created_at DESC, usage_line_id DESC)
  WHERE status != 'superseded';
CREATE INDEX IF NOT EXISTS idx_thread_usage_lines_summary_thread
  ON thread_usage_lines(provider, backend, currency, thread_id)
  WHERE status != 'superseded';
CREATE INDEX IF NOT EXISTS idx_thread_usage_lines_summary_parent
  ON thread_usage_lines(provider, backend, currency, parent_thread_id)
  WHERE status != 'superseded';
`);
}

function repairOpenAiThreadUsagePricing(db: BetterSqlite3.Database): void {
  if (
    !tableExists(db, "thread_usage_lines") ||
    !tableExists(db, "thread_pricing_summaries")
  ) {
    return;
  }

  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT
         usage_line_id,
         cached_input_tokens,
         created_at,
         currency,
         fast_mode,
         model,
         output_tokens,
         price_status,
         reasoning_output_tokens,
         service_tier,
         uncached_input_tokens
       FROM thread_usage_lines
       WHERE provider = 'openai'`,
    )
    .all() as Array<{
      cached_input_tokens: number;
      created_at: number;
      currency: string;
      fast_mode: number | null;
      model: string | null;
      output_tokens: number;
      price_status: string;
      reasoning_output_tokens: number;
      service_tier: string | null;
      uncached_input_tokens: number;
      usage_line_id: string;
    }>;
  const updateLine = db.prepare(
    `UPDATE thread_usage_lines
     SET
       price_status = @priceStatus,
       price_unavailable_reason = @priceUnavailableReason,
       currency = @currency,
       pricing_catalog_id = @pricingCatalogId,
       pricing_catalog_version = @pricingCatalogVersion,
       pricing_rate_id = @pricingRateId,
       uncached_input_cost_micros = @uncachedInputCostMicros,
       cached_input_cost_micros = @cachedInputCostMicros,
       output_cost_micros = @outputCostMicros,
       total_cost_micros = @totalCostMicros,
       updated_at = @updatedAt
     WHERE usage_line_id = @usageLineId`,
  );

  for (const row of rows) {
    const cost = estimateOpenAiTokenUsageCost({
      at: row.created_at,
      cachedInputTokens: row.cached_input_tokens,
      fastMode: row.fast_mode === null ? undefined : Boolean(row.fast_mode),
      model: row.model ?? undefined,
      outputTokens: row.output_tokens,
      reasoningOutputTokens: row.reasoning_output_tokens,
      serviceTier: row.service_tier ?? undefined,
      uncachedInputTokens: row.uncached_input_tokens,
    });
    if (!cost && row.price_status === "priced") {
      continue;
    }

    const pricingServiceTier = resolveOpenAiPricingServiceTier({
      fastMode: row.fast_mode === null ? undefined : Boolean(row.fast_mode),
      serviceTier: row.service_tier ?? undefined,
    });
    const priceUnavailableReason: ThreadUsageLineRecord["priceUnavailableReason"] | null =
      cost
        ? null
        : !row.model
          ? "missing-model"
          : pricingServiceTier === undefined
            ? "unsupported-service-tier"
            : "missing-rate";

    updateLine.run({
      cachedInputCostMicros: cost?.cachedInputCostMicros ?? 0,
      currency: cost?.currency ?? row.currency,
      outputCostMicros: cost?.outputCostMicros ?? 0,
      priceStatus: cost ? "priced" : "unpriced",
      priceUnavailableReason,
      pricingCatalogId: cost?.catalogId ?? null,
      pricingCatalogVersion: cost?.catalogVersion ?? null,
      pricingRateId: cost?.rateId ?? null,
      totalCostMicros: cost?.totalCostMicros ?? 0,
      uncachedInputCostMicros: cost?.uncachedInputCostMicros ?? 0,
      updatedAt: now,
      usageLineId: row.usage_line_id,
    });
  }

  rebuildThreadPricingSummaries(db, now);
}

function rebuildThreadPricingSummaries(db: BetterSqlite3.Database, updatedAt: number): void {
  db.exec("DELETE FROM thread_pricing_summaries");
  const rollups = db
    .prepare(
      `SELECT DISTINCT
         provider,
         backend,
         currency,
         COALESCE(NULLIF(parent_thread_id, ''), thread_id) AS thread_id
       FROM thread_usage_lines
       WHERE status != 'superseded'`,
    )
    .all() as Array<{
      backend: string;
      currency: string;
      provider: string;
      thread_id: string;
    }>;
  const readAggregate = db.prepare(
    `SELECT
       COUNT(*) AS usage_line_count,
       SUM(CASE WHEN price_status = 'priced' THEN 1 ELSE 0 END) AS priced_usage_line_count,
       SUM(CASE WHEN price_status != 'priced' THEN 1 ELSE 0 END) AS unpriced_usage_line_count,
       COALESCE(SUM(input_tokens), 0) AS input_tokens,
       COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
       COALESCE(SUM(uncached_input_tokens), 0) AS uncached_input_tokens,
       COALESCE(SUM(output_tokens), 0) AS output_tokens,
       COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
       COALESCE(SUM(total_tokens), 0) AS total_tokens,
       COALESCE(SUM(CASE WHEN price_status = 'priced' THEN total_cost_micros ELSE 0 END), 0)
         AS total_cost_micros
     FROM (
       SELECT *
       FROM thread_usage_lines
       WHERE provider = ?
         AND backend = ?
         AND currency = ?
         AND status != 'superseded'
         AND thread_id = ?
       UNION ALL
       SELECT *
       FROM thread_usage_lines
       WHERE provider = ?
         AND backend = ?
         AND currency = ?
         AND status != 'superseded'
         AND parent_thread_id = ?
         AND thread_id != ?
     )`,
  );
  const insertSummary = db.prepare(
    `INSERT INTO thread_pricing_summaries (
      provider,
      backend,
      thread_id,
      currency,
      usage_line_count,
      priced_usage_line_count,
      unpriced_usage_line_count,
      input_tokens,
      cached_input_tokens,
      uncached_input_tokens,
      output_tokens,
      reasoning_output_tokens,
      total_tokens,
      total_cost_micros,
      updated_at
    ) VALUES (
      @provider,
      @backend,
      @threadId,
      @currency,
      @usageLineCount,
      @pricedUsageLineCount,
      @unpricedUsageLineCount,
      @inputTokens,
      @cachedInputTokens,
      @uncachedInputTokens,
      @outputTokens,
      @reasoningOutputTokens,
      @totalTokens,
      @totalCostMicros,
      @updatedAt
    )`,
  );

  for (const rollup of rollups) {
    const aggregate = readAggregate.get(
      rollup.provider,
      rollup.backend,
      rollup.currency,
      rollup.thread_id,
      rollup.provider,
      rollup.backend,
      rollup.currency,
      rollup.thread_id,
      rollup.thread_id,
    ) as {
      cached_input_tokens: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      priced_usage_line_count: number | null;
      reasoning_output_tokens: number | null;
      total_cost_micros: number | null;
      total_tokens: number | null;
      uncached_input_tokens: number | null;
      unpriced_usage_line_count: number | null;
      usage_line_count: number;
    };

    if (aggregate.usage_line_count === 0) {
      continue;
    }

    insertSummary.run({
      backend: rollup.backend,
      cachedInputTokens: aggregate.cached_input_tokens ?? 0,
      currency: rollup.currency,
      inputTokens: aggregate.input_tokens ?? 0,
      outputTokens: aggregate.output_tokens ?? 0,
      pricedUsageLineCount: aggregate.priced_usage_line_count ?? 0,
      provider: rollup.provider,
      reasoningOutputTokens: aggregate.reasoning_output_tokens ?? 0,
      threadId: rollup.thread_id,
      totalCostMicros: aggregate.total_cost_micros ?? 0,
      totalTokens: aggregate.total_tokens ?? 0,
      uncachedInputTokens: aggregate.uncached_input_tokens ?? 0,
      unpricedUsageLineCount: aggregate.unpriced_usage_line_count ?? 0,
      updatedAt,
      usageLineCount: aggregate.usage_line_count,
    });
  }
}

function tableExists(
  db: BetterSqlite3.Database,
  tableName: string,
): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { 1: number } | undefined;
  return Boolean(row);
}

function ensurePullRequestProviderColumns(db: BetterSqlite3.Database): void {
  if (!tableColumnExists(db, "pr_status_cache", "provider")) {
    db.exec(
      "ALTER TABLE pr_status_cache ADD COLUMN provider TEXT NOT NULL DEFAULT 'github.com'",
    );
  }
  db.exec(`
UPDATE pr_status_cache
SET
  provider = COALESCE(NULLIF(provider, ''), 'github.com'),
  pr_key = COALESCE(NULLIF(provider, ''), 'github.com')
    || '/'
    || lower(org)
    || '/'
    || lower(repo)
    || '#'
    || number
`);

  if (!tableColumnExists(db, "pr_lookup_cache", "provider")) {
    db.exec(
      "ALTER TABLE pr_lookup_cache ADD COLUMN provider TEXT NOT NULL DEFAULT 'github.com'",
    );
  }
  db.exec(`
UPDATE pr_lookup_cache
SET provider = COALESCE(NULLIF(provider, ''), 'github.com')
`);
}

function tableColumnExists(
  db: BetterSqlite3.Database,
  tableName:
    | "app_runtime_instances"
    | "pr_lookup_cache"
    | "pr_status_cache"
    | "thread_pricing_summaries"
    | "thread_search_fts"
    | "thread_usage_lines",
  columnName: string,
): boolean {
  const rows = readTableInfo(db, tableName);
  return rows.some((row) => row.name === columnName);
}

function readTableInfo(
  db: BetterSqlite3.Database,
  tableName:
    | "app_runtime_instances"
    | "pr_lookup_cache"
    | "pr_status_cache"
    | "thread_pricing_summaries"
    | "thread_search_fts"
    | "thread_usage_lines",
): Array<{ name: string }> {
  switch (tableName) {
    case "app_runtime_instances":
      return db.prepare("PRAGMA table_info(app_runtime_instances)").all() as Array<{
        name: string;
      }>;
    case "pr_lookup_cache":
      return db.prepare("PRAGMA table_info(pr_lookup_cache)").all() as Array<{
        name: string;
      }>;
    case "pr_status_cache":
      return db.prepare("PRAGMA table_info(pr_status_cache)").all() as Array<{
        name: string;
      }>;
    case "thread_pricing_summaries":
      return db.prepare("PRAGMA table_info(thread_pricing_summaries)").all() as Array<{
        name: string;
      }>;
    case "thread_search_fts":
      return db.prepare("PRAGMA table_info(thread_search_fts)").all() as Array<{
        name: string;
      }>;
    case "thread_usage_lines":
      return db.prepare("PRAGMA table_info(thread_usage_lines)").all() as Array<{
        name: string;
      }>;
  }
}
