import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getNativeBinding } from "../state/native-binding";
import {
  CURRENT_STATE_DB_USER_VERSION,
  SQLITE_AUTO_VACUUM_INCREMENTAL,
  SQLITE_AUTO_VACUUM_NONE,
  STATE_DB_JOURNAL_SIZE_LIMIT_BYTES,
  STATE_DB_WAL_AUTOCHECKPOINT_PAGES,
  StateDb,
} from "../state/state-db";
import { ThreadSearchStore } from "../thread-search/thread-search-store";

let stateDb: StateDb;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-state-db-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("StateDb", () => {
  it("creates additive runtime cache tables", () => {
    const tables = stateDb.raw
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name IN (?, ?, ?, ?, ?, ?, ?, ?)
         ORDER BY name`,
      )
      .all(
        "acp_installed_agents",
        "acp_registry_cache",
        "acp_sessions",
        "federation_enrollment_tokens",
        "federation_peers",
        "federation_session_audit",
        "pr_lookup_cache",
        "pr_status_cache",
      ) as Array<{ name: string }>;

    expect(tables.map((table) => table.name)).toEqual([
      "acp_installed_agents",
      "acp_registry_cache",
      "acp_sessions",
      "federation_enrollment_tokens",
      "federation_peers",
      "federation_session_audit",
      "pr_lookup_cache",
      "pr_status_cache",
    ]);
    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      CURRENT_STATE_DB_USER_VERSION,
    );
  });

  it("repairs revocation state after a later verified federation enrollment", () => {
    const dbPath = path.join(tempDir, "state.db");
    const insertPeer = stateDb.raw.prepare(
      `INSERT INTO federation_peers(
         peer_id, label, role, status, created_at, updated_at, last_seen_at,
         revoked_at, payload
       ) VALUES (?, ?, 'client', ?, 1000, 3000, 3000, 2000, '{}')`,
    );
    insertPeer.run("reenrolled_peer", "Re-enrolled", "connected");
    insertPeer.run("still_revoked_peer", "Still revoked", "revoked");
    insertPeer.run("unproven_peer", "Unproven", "connected");

    const insertEnrollment = stateDb.raw.prepare(
      `INSERT INTO federation_enrollment_tokens(
         enrollment_id, token_hmac, status, generated_at, expires_at, used_at,
         peer_id, payload
       ) VALUES (?, ?, 'used', 1000, 4000, ?, ?, '{}')`,
    );
    insertEnrollment.run(
      "federation-enrollment:reenrolled",
      "reenrolled-token-hmac",
      3_000,
      "reenrolled_peer",
    );
    insertEnrollment.run(
      "federation-enrollment:still-revoked",
      "still-revoked-token-hmac",
      3_000,
      "still_revoked_peer",
    );
    insertEnrollment.run(
      "federation-enrollment:unproven",
      "unproven-token-hmac",
      1_500,
      "unproven_peer",
    );

    stateDb.raw.pragma("user_version = 41");
    stateDb.close();
    stateDb = StateDb.open(dbPath);

    const peers = stateDb.raw
      .prepare(
        `SELECT peer_id, status, revoked_at
         FROM federation_peers
         ORDER BY peer_id`,
      )
      .all() as Array<{
        peer_id: string;
        status: string;
        revoked_at: number | null;
      }>;
    expect(peers).toEqual([
      {
        peer_id: "reenrolled_peer",
        status: "connected",
        revoked_at: null,
      },
      {
        peer_id: "still_revoked_peer",
        status: "revoked",
        revoked_at: 2_000,
      },
      {
        peer_id: "unproven_peer",
        status: "connected",
        revoked_at: 2_000,
      },
    ]);
    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      CURRENT_STATE_DB_USER_VERSION,
    );
  });

  it("restores raw v48 ACP keys to rollback-compatible storage", () => {
    const dbPath = path.join(tempDir, "state.db");
    stateDb.raw.prepare(
      `INSERT INTO threads(thread_id, payload)
       VALUES (?, ?)`,
    ).run(
      "acp:grok:thread-1",
      JSON.stringify({
        backend: "acp:grok",
        threadId: "thread-1",
        executionMode: "default",
      }),
    );
    stateDb.raw.prepare(
      `INSERT INTO backends(scope, payload)
       VALUES (?, ?)`,
    ).run(
      "all",
      JSON.stringify({
        knownThreadKeys: ["acp:grok:thread-1", "codex:thread-2"],
      }),
    );
    stateDb.raw.prepare(
      `INSERT INTO thread_search_documents(
         identity_key, backend, thread_id, title, linked_directories_json,
         display_json, indexed_at
       ) VALUES (?, ?, ?, ?, '[]', '{}', 1)`,
    ).run(
      "acp:grok:thread-1",
      "acp:grok",
      "thread-1",
      "Legacy search row",
    );
    stateDb.raw.prepare(
      `INSERT INTO thread_search_fts(identity_key, title)
       VALUES (?, ?)`,
    ).run("acp:grok:thread-1", "Raw v48 search row");
    stateDb.raw.prepare(
      `INSERT INTO star_map_arrangement(entry_key, payload)
       VALUES (?, ?)`,
    ).run(
      "pwr_local acp:grok:thread-1",
      JSON.stringify({
        instanceId: "pwr_local",
        threadKey: "acp:grok:thread-1",
        dx: 10,
        dy: 20,
        updatedAt: 1,
        by: "pwr_local",
      }),
    );

    stateDb.raw.pragma("user_version = 48");
    stateDb.close();
    stateDb = StateDb.open(dbPath);

    expect(
      stateDb.raw.prepare("SELECT thread_id FROM threads").pluck().all(),
    ).toEqual(["acp%3Agrok:thread-1"]);
    expect(JSON.parse(
      stateDb.raw.prepare("SELECT payload FROM backends WHERE scope = 'all'")
        .pluck()
        .get() as string,
    )).toMatchObject({
      knownThreadKeys: ["acp%3Agrok:thread-1", "codex:thread-2"],
    });
    expect(
      stateDb.raw.prepare(
        "SELECT identity_key FROM thread_search_documents",
      )
        .pluck()
        .all(),
    ).toEqual(["acp%3Agrok:thread-1"]);
    expect(
      stateDb.raw.prepare("SELECT identity_key FROM thread_search_fts")
        .pluck()
        .all(),
    ).toEqual(["acp%3Agrok:thread-1"]);
    expect(
      stateDb.raw.prepare(
        "SELECT entry_key, payload FROM star_map_arrangement",
      ).get(),
    ).toMatchObject({
      entry_key: "pwr_local acp%3Agrok:thread-1",
      payload: JSON.stringify({
        instanceId: "pwr_local",
        threadKey: "acp%3Agrok:thread-1",
        dx: 10,
        dy: 20,
        updatedAt: 1,
        by: "pwr_local",
      }),
    });
  });

  it("creates provider-aware pull request cache columns", () => {
    const prStatusColumns = stateDb.raw
      .prepare("PRAGMA table_info(pr_status_cache)")
      .all() as Array<{ name: string }>;
    const prLookupColumns = stateDb.raw
      .prepare("PRAGMA table_info(pr_lookup_cache)")
      .all() as Array<{ name: string }>;

    expect(prStatusColumns.map((column) => column.name)).toContain("provider");
    expect(prLookupColumns.map((column) => column.name)).toContain("provider");
  });

  it("creates durable scheduled thread action storage", () => {
    const table = stateDb.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("scheduled_thread_actions") as { name: string } | undefined;
    expect(table?.name).toBe("scheduled_thread_actions");

    const columns = stateDb.raw
      .prepare("PRAGMA table_info(scheduled_thread_actions)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "action_id",
        "backend",
        "thread_id",
        "kind",
        "origin",
        "status",
        "scheduled_for",
        "queue_entry_id",
        "turn_id",
        "error_message",
        "payload_ref",
        "claim_owner",
        "claim_expires_at",
      ]),
    );
    expect(columns.map((column) => column.name)).not.toContain("payload");
  });

  it("adds scheduled actions to federation-era version 38 databases", () => {
    const dbPath = path.join(tempDir, "state.db");
    stateDb.raw.exec(`
      DROP TABLE scheduled_thread_actions;
      PRAGMA user_version = 38;
    `);
    stateDb.close();

    stateDb = StateDb.open(dbPath);

    const table = stateDb.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("scheduled_thread_actions") as { name: string } | undefined;
    expect(table?.name).toBe("scheduled_thread_actions");
    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      CURRENT_STATE_DB_USER_VERSION,
    );
  });

  it("invalidates working-state counts computed before squash-merge support", () => {
    const dbPath = path.join(tempDir, "state.db");
    stateDb.raw.prepare(
      `INSERT INTO thread_git_working_state(worktree_path, fetched_at, payload)
       VALUES (?, ?, ?)`,
    ).run(
      "/repo/stale-worktree",
      Date.now(),
      JSON.stringify({
        dirtyFiles: 0,
        dirtyAdditions: 0,
        dirtyDeletions: 0,
        untrackedFiles: 0,
        unpushedCommits: 3,
      }),
    );
    stateDb.raw.pragma("user_version = 40");
    stateDb.close();

    stateDb = StateDb.open(dbPath);

    const cachedRows = stateDb.raw
      .prepare("SELECT worktree_path FROM thread_git_working_state")
      .all();
    expect(cachedRows).toEqual([]);
    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      CURRENT_STATE_DB_USER_VERSION,
    );
  });

  it("creates durable pull request status watch storage", () => {
    const table = stateDb.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("pr_status_watches") as { name: string } | undefined;
    expect(table?.name).toBe("pr_status_watches");

    const columns = stateDb.raw
      .prepare("PRAGMA table_info(pr_status_watches)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "watch_id",
        "backend",
        "thread_id",
        "pr_key",
        "head_sha",
        "status",
        "lease_owner",
        "lease_expires_at",
      ]),
    );
  });

  it("creates durable PR auto-dispatch ownership storage", () => {
    const table = stateDb.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("pr_auto_dispatch_candidates") as { name: string } | undefined;
    expect(table?.name).toBe("pr_auto_dispatch_candidates");

    const fingerprintIndex = stateDb.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get("idx_pr_auto_dispatch_pr_fingerprint") as
        | { name: string }
        | undefined;
    expect(fingerprintIndex?.name).toBe(
      "idx_pr_auto_dispatch_pr_fingerprint",
    );

    const budgetTable = stateDb.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("pr_auto_dispatch_budget") as { name: string } | undefined;
    const reservationTable = stateDb.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("pr_auto_dispatch_budget_reservations") as
        | { name: string }
        | undefined;
    expect(budgetTable?.name).toBe("pr_auto_dispatch_budget");
    expect(reservationTable?.name).toBe(
      "pr_auto_dispatch_budget_reservations",
    );
  });

  it("deduplicates legacy PR claims before creating the global fingerprint index", () => {
    const dbPath = path.join(tempDir, "state.db");
    stateDb.close();
    const raw = openRawDb(dbPath);
    raw.exec(`
      DROP INDEX idx_pr_auto_dispatch_pr_fingerprint;
      INSERT INTO pr_auto_dispatch_claims(
        backend, thread_id, pr_key, fingerprint, status,
        scheduled_at, created_at, updated_at, payload
      ) VALUES
        ('codex', 'thread-1', 'github.com/pwrdrvr/pwragent#1128', 'same-event', 'cancelled', 1, 1, 1, '{}'),
        ('codex', 'thread-2', 'github.com/pwrdrvr/pwragent#1128', 'same-event', 'cancelled', 2, 2, 2, '{}');
      PRAGMA user_version = 35;
    `);
    raw.close();

    stateDb = StateDb.open(dbPath);

    const claims = stateDb.raw
      .prepare(
        `SELECT backend, thread_id
         FROM pr_auto_dispatch_claims
         WHERE pr_key = ? AND fingerprint = ?`,
      )
      .all("github.com/pwrdrvr/pwragent#1128", "same-event");
    expect(claims).toHaveLength(1);
    const fingerprintIndex = stateDb.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get("idx_pr_auto_dispatch_pr_fingerprint") as
        | { name: string }
        | undefined;
    expect(fingerprintIndex?.name).toBe(
      "idx_pr_auto_dispatch_pr_fingerprint",
    );
  });

  it("creates thread usage pricing ledger tables", () => {
    const tables = stateDb.raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?, ?) ORDER BY name`,
      )
      .all(
        "pricing_catalog_versions",
        "pricing_rates",
        "thread_pricing_summaries",
        "thread_usage_turns",
        "thread_usage_lines",
      ) as Array<{ name: string }>;

    expect(tables.map((table) => table.name)).toEqual([
      "pricing_catalog_versions",
      "pricing_rates",
      "thread_pricing_summaries",
      "thread_usage_lines",
      "thread_usage_turns",
    ]);
    const usageLineColumns = stateDb.raw
      .prepare("PRAGMA table_info(thread_usage_lines)")
      .all() as Array<{ name: string }>;
    expect(usageLineColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "cache_write_input_cost_micros",
        "cache_write_input_tokens",
        "cumulative_cache_write_input_tokens",
        "pricing_basis",
      ]),
    );
  });

  it("creates thread tool accounting tables", () => {
    const tables = stateDb.raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?) ORDER BY name`,
      )
      .all(
        "thread_tool_invocation_alerts",
        "thread_tool_invocations",
        "thread_tool_analysis",
      ) as Array<{ name: string }>;

    expect(tables.map((table) => table.name)).toEqual([
      "thread_tool_analysis",
      "thread_tool_invocation_alerts",
      "thread_tool_invocations",
    ]);
    expect(indexNames("thread_tool_invocations")).toEqual(
      expect.arrayContaining([
        "idx_thread_tool_invocations_read_thread",
        "idx_thread_tool_invocations_polling",
        "idx_thread_tool_invocations_turn",
      ]),
    );
  });

  it("creates the thread message origin table", () => {
    const table = stateDb.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("thread_message_origins") as { name: string } | undefined;

    expect(table?.name).toBe("thread_message_origins");
    expect(indexNames("thread_message_origins")).toContain(
      "idx_thread_message_origins_thread",
    );
  });

  it("creates the observed messaging surface catalog", () => {
    const table = stateDb.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("messaging_observed_surfaces") as { name: string } | undefined;

    expect(table?.name).toBe("messaging_observed_surfaces");
    expect(indexNames("messaging_observed_surfaces")).toEqual(
      expect.arrayContaining([
        "idx_messaging_observed_surfaces_recent",
        "idx_messaging_observed_surfaces_platform_recent",
      ]),
    );
  });

  it("backfills observed surfaces from recent messaging activity", () => {
    stateDb.raw.prepare(
      `INSERT INTO messaging_activity_log(
         platform, kind, conversation_id, conversation_title,
         summary, created_at, payload
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "slack",
      "inbound-routed",
      "C13056",
      "p-search-signals-project",
      "Inbound from Harold",
      2000,
      JSON.stringify({
        conversationKind: "channel",
        conversationWorkspaceId: "T1",
      }),
    );
    stateDb.raw.prepare(
      `INSERT INTO messaging_activity_log(
         platform, kind, conversation_id, conversation_title,
         summary, created_at, payload
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "discord",
      "inbound-rejected",
      "unapproved-channel",
      "Unapproved",
      "Rejected inbound",
      3000,
      JSON.stringify({
        conversationKind: "channel",
        rejectionReason: "unauthorized-conversation",
      }),
    );
    stateDb.raw.exec("DROP TABLE messaging_observed_surfaces");
    stateDb.raw.pragma("user_version = 33");
    stateDb.close();
    stateDb = StateDb.open(path.join(tempDir, "state.db"));

    const row = stateDb.raw
      .prepare(
        "SELECT first_seen_at, last_seen_at, payload FROM messaging_observed_surfaces",
      )
      .get() as {
        first_seen_at: number;
        last_seen_at: number;
        payload: string;
      };
    expect(row.first_seen_at).toBe(2000);
    expect(row.last_seen_at).toBe(2000);
    expect(JSON.parse(row.payload)).toMatchObject({
      channel: {
        channel: "slack",
        conversation: {
          id: "C13056",
          kind: "channel",
          title: "p-search-signals-project",
          workspaceId: "T1",
        },
      },
    });
    expect(
      stateDb.raw
        .prepare("SELECT COUNT(*) AS count FROM messaging_observed_surfaces")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("carries observed context-replay columns on both the turn and the line", () => {
    // The tally's source of truth is thread_usage_turns. The line columns are a
    // DEPRECATED dual-write (issue #947) kept so older locally-run builds — which
    // read the tally off the usage line — keep working against a shared profile
    // DB. Every build must find the columns it expects on a fresh DB.
    const observedColumns = [
      "observed_cold_replay_count",
      "observed_cold_replay_uncached_tokens",
      "observed_hot_replay_cached_tokens",
      "observed_hot_replay_count",
    ];
    const turnColumns = (
      stateDb.raw
        .prepare("PRAGMA table_info(thread_usage_turns)")
        .all() as Array<{ name: string }>
    ).map((column) => column.name);
    const lineColumns = (
      stateDb.raw
        .prepare("PRAGMA table_info(thread_usage_lines)")
        .all() as Array<{ name: string }>
    ).map((column) => column.name);

    for (const column of observedColumns) {
      expect(turnColumns).toContain(column);
      expect(lineColumns).toContain(column);
    }
  });

  it("sets explicit WAL checkpoint and journal size bounds", () => {
    expect(stateDb.raw.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(stateDb.raw.pragma("wal_autocheckpoint", { simple: true })).toBe(
      STATE_DB_WAL_AUTOCHECKPOINT_PAGES,
    );
    expect(stateDb.raw.pragma("journal_size_limit", { simple: true })).toBe(
      STATE_DB_JOURNAL_SIZE_LIMIT_BYTES,
    );
  });

  // `auto_vacuum` is only honoured on a database with no header yet, and
  // `journal_mode = WAL` writes that header. These read the pragma back
  // instead of asserting the call was made, because the call WAS being made
  // before the fix and SQLite ignored it in silence.
  it("enables incremental auto-vacuum on a new database", () => {
    expect(stateDb.raw.pragma("auto_vacuum", { simple: true })).toBe(
      SQLITE_AUTO_VACUUM_INCREMENTAL,
    );
    // The pragma the ordering fight was with, still in force.
    expect(stateDb.raw.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("keeps incremental auto-vacuum across a close and reopen", () => {
    const dbPath = path.join(tempDir, "reopened.db");
    const first = StateDb.open(dbPath);
    first.close();
    const second = StateDb.open(dbPath);
    try {
      expect(second.raw.pragma("auto_vacuum", { simple: true })).toBe(
        SQLITE_AUTO_VACUUM_INCREMENTAL,
      );
    } finally {
      second.close();
    }
  });

  it("returns freed pages to the filesystem on incremental_vacuum", () => {
    const pageSize = stateDb.raw.pragma("page_size", {
      simple: true,
    }) as number;
    const pageCount = () =>
      stateDb.raw.pragma("page_count", { simple: true }) as number;

    const insert = stateDb.raw.prepare(
      "INSERT INTO meta(key, value) VALUES (?, ?)",
    );
    stateDb.raw.transaction(() => {
      for (let index = 0; index < 4000; index += 1) {
        insert.run(`bulk:${index}`, "x".repeat(400));
      }
    })();
    const grown = pageCount();
    stateDb.raw.prepare("DELETE FROM meta WHERE key LIKE 'bulk:%'").run();

    expect(
      stateDb.raw.pragma("freelist_count", { simple: true }),
    ).toBeGreaterThan(0);
    stateDb.raw.pragma("incremental_vacuum");

    // The assertion the old code could never have passed: the file itself is
    // smaller, not merely the freelist marked reusable.
    expect(stateDb.raw.pragma("freelist_count", { simple: true })).toBe(0);
    expect(pageCount() * pageSize).toBeLessThan(grown * pageSize);
  });

  describe("ensureIncrementalAutoVacuum", () => {
    // A database created the way every pre-fix profile was: WAL first, so the
    // `auto_vacuum` assignment lands on a file that already has a header.
    const openLegacyDatabase = (dbPath: string) => {
      const nativeBinding = getNativeBinding();
      const legacy = new Database(
        dbPath,
        nativeBinding ? { nativeBinding } : {},
      );
      legacy.pragma("journal_mode = WAL");
      legacy.pragma("auto_vacuum = INCREMENTAL");
      legacy.exec("CREATE TABLE bulk(id INTEGER PRIMARY KEY, blob TEXT)");
      const insert = legacy.prepare("INSERT INTO bulk(blob) VALUES (?)");
      legacy.transaction(() => {
        for (let index = 0; index < 20000; index += 1) {
          insert.run("x".repeat(400));
        }
      })();
      legacy.prepare("DELETE FROM bulk WHERE id % 10 != 0").run();
      return legacy;
    };

    it("reproduces the pre-fix state it has to repair", () => {
      const dbPath = path.join(tempDir, "legacy.db");
      const legacy = openLegacyDatabase(dbPath);
      try {
        expect(legacy.pragma("auto_vacuum", { simple: true })).toBe(
          SQLITE_AUTO_VACUUM_NONE,
        );
        const before = legacy.pragma("page_count", { simple: true }) as number;
        legacy.pragma("incremental_vacuum");
        // Free pages, and a vacuum that cannot touch them.
        expect(
          legacy.pragma("freelist_count", { simple: true }),
        ).toBeGreaterThan(0);
        expect(legacy.pragma("page_count", { simple: true })).toBe(before);
      } finally {
        legacy.close();
      }
    });

    it("converts a pre-fix database and shrinks the file", () => {
      const dbPath = path.join(tempDir, "convert.db");
      openLegacyDatabase(dbPath).close();

      const legacyDb = StateDb.open(dbPath);
      try {
        expect(legacyDb.raw.pragma("auto_vacuum", { simple: true })).toBe(
          SQLITE_AUTO_VACUUM_NONE,
        );

        const conversion = legacyDb.ensureIncrementalAutoVacuum();
        expect(conversion.status).toBe("converted");
        if (conversion.status !== "converted") throw new Error("unreachable");
        expect(conversion.bytesAfter).toBeLessThan(conversion.bytesBefore);

        expect(legacyDb.raw.pragma("auto_vacuum", { simple: true })).toBe(
          SQLITE_AUTO_VACUUM_INCREMENTAL,
        );
        // VACUUM rewrites the whole file; WAL has to survive that.
        expect(legacyDb.raw.pragma("journal_mode", { simple: true })).toBe(
          "wal",
        );
        expect(legacyDb.raw.pragma("integrity_check", { simple: true })).toBe(
          "ok",
        );
      } finally {
        legacyDb.close();
      }

      const reopened = StateDb.open(dbPath);
      try {
        expect(reopened.raw.pragma("auto_vacuum", { simple: true })).toBe(
          SQLITE_AUTO_VACUUM_INCREMENTAL,
        );
      } finally {
        reopened.close();
      }
    });

    it("reports failure when the rewrite leaves the mode unchanged", () => {
      const dbPath = path.join(tempDir, "stubborn.db");
      openLegacyDatabase(dbPath).close();

      const legacyDb = StateDb.open(dbPath);
      // Stand in for any VACUUM that returns cleanly without converting: the
      // method must not call that a success, or it would report a conversion
      // and then repeat the full rewrite on every launch forever.
      const realExec = legacyDb.raw.exec.bind(legacyDb.raw);
      legacyDb.raw.exec = ((sql: string) =>
        sql.trim().toUpperCase() === "VACUUM"
          ? legacyDb.raw
          : realExec(sql)) as typeof legacyDb.raw.exec;

      try {
        const conversion = legacyDb.ensureIncrementalAutoVacuum();
        expect(conversion.status).toBe("failed");
        if (conversion.status !== "failed") throw new Error("unreachable");
        expect(conversion.error.message).toContain("still not INCREMENTAL");
      } finally {
        legacyDb.raw.exec = realExec;
        legacyDb.close();
      }
    });

    it("is a no-op on an already-converted database", () => {
      // The guard that keeps this a once-per-profile cost rather than a
      // full rewrite on every launch.
      expect(stateDb.ensureIncrementalAutoVacuum()).toEqual({
        status: "already-incremental",
      });
    });

    it("runs from startGc", () => {
      const dbPath = path.join(tempDir, "gc.db");
      openLegacyDatabase(dbPath).close();

      const legacyDb = StateDb.open(dbPath);
      try {
        expect(legacyDb.startGc().status).toBe("converted");
        expect(legacyDb.raw.pragma("auto_vacuum", { simple: true })).toBe(
          SQLITE_AUTO_VACUUM_INCREMENTAL,
        );
        // Second launch pays nothing.
        expect(legacyDb.startGc().status).toBe("already-incremental");
      } finally {
        legacyDb.close();
      }
    });
  });

  it("does not orphan a GC interval when startGc is called twice", () => {
    // Without the `stopGc` at the top of `startGc`, the second call
    // overwrites `gcTimer` and the first interval becomes unreachable —
    // `stopGc` can no longer clear it, so it keeps sweeping a database that
    // `close` has already shut, throwing from a timer with nothing to catch it.
    const timers: Array<ReturnType<typeof setInterval>> = [];
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const cleared = new Set<ReturnType<typeof setInterval>>();

    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const timer = realSetInterval(...args);
      timers.push(timer);
      return timer;
    }) as typeof setInterval;
    globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
      cleared.add(timer);
      return realClearInterval(timer);
    }) as typeof clearInterval;

    try {
      stateDb.startGc();
      stateDb.startGc();
      stateDb.stopGc();
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      for (const timer of timers) realClearInterval(timer);
    }

    expect(timers).toHaveLength(2);
    expect(timers.filter((timer) => cleared.has(timer))).toHaveLength(2);
  });

  it("keeps AUTOINCREMENT limited to existing bounded UI history tables", () => {
    const rows = stateDb.raw
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND upper(sql) LIKE '%AUTOINCREMENT%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    expect(rows.map((row) => row.name)).toEqual([
      "composer_draft_journal",
      "messaging_activity_log",
    ]);
  });

  it("indexes thread usage pricing reads and rollups without full line-table scans", () => {
    expect(indexNames("thread_usage_lines")).toEqual(
      expect.arrayContaining([
        "idx_thread_usage_lines_read_parent",
        "idx_thread_usage_lines_read_thread",
        "idx_thread_usage_lines_summary_parent",
        "idx_thread_usage_lines_summary_thread",
      ]),
    );

    const readPlan = queryPlanDetails(
      `SELECT *
       FROM (
         SELECT *
         FROM thread_usage_lines
         WHERE backend = ?
           AND status != 'superseded'
           AND thread_id = ?
         UNION ALL
         SELECT *
         FROM thread_usage_lines
         WHERE backend = ?
           AND status != 'superseded'
           AND parent_thread_id = ?
           AND thread_id != ?
       )
       ORDER BY created_at DESC, usage_line_id DESC`,
      ["codex", "thread-1", "codex", "thread-1", "thread-1"],
    );
    expect(readPlan).toContain("idx_thread_usage_lines_read_thread");
    expect(readPlan).toContain("idx_thread_usage_lines_read_parent");
    expect(readPlan).not.toMatch(/\bSCAN thread_usage_lines\b/);

    const summaryPlan = queryPlanDetails(
      `SELECT
         COUNT(*) AS usage_line_count,
         COALESCE(SUM(total_cost_micros), 0) AS total_cost_micros
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
      [
        "openai",
        "codex",
        "USD",
        "thread-1",
        "openai",
        "codex",
        "USD",
        "thread-1",
        "thread-1",
      ],
    );
    expect(summaryPlan).toContain("idx_thread_usage_lines_summary_thread");
    expect(summaryPlan).toContain("idx_thread_usage_lines_summary_parent");
    expect(summaryPlan).not.toMatch(/\bSCAN thread_usage_lines\b/);
  });

  it("migrates legacy thread usage pricing rows into provider-scoped usage turns", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "legacy-thread-usage-pricing-state.db");
    const raw = openRawDb(dbPath);
    raw.exec(`
      PRAGMA user_version = 17;
      CREATE TABLE thread_usage_lines (
        usage_line_id              TEXT PRIMARY KEY,
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
        updated_at                 INTEGER NOT NULL
      );
      CREATE TABLE thread_pricing_summaries (
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
        PRIMARY KEY (backend, thread_id, currency)
      );
      INSERT INTO thread_usage_lines (
        usage_line_id,
        backend,
        thread_id,
        parent_thread_id,
        turn_id,
        source,
        source_item_id,
        scope,
        status,
        created_at,
        completed_at,
        model,
        reasoning_effort,
        service_tier,
        fast_mode,
        settings_source,
        settings_confidence,
        input_tokens,
        cached_input_tokens,
        uncached_input_tokens,
        output_tokens,
        reasoning_output_tokens,
        total_tokens,
        price_status,
        price_unavailable_reason,
        currency,
        pricing_catalog_id,
        pricing_catalog_version,
        pricing_rate_id,
        uncached_input_cost_micros,
        cached_input_cost_micros,
        output_cost_micros,
        total_cost_micros,
        updated_at
      ) VALUES (
        'line-1',
        'codex',
        'thread-1',
        NULL,
        'turn-1',
        'hydration',
        'item-1',
        'turn',
        'finalized',
        1000,
        1100,
        'gpt-5.5',
        'high',
        'standard',
        0,
        'turn-context',
        'exact',
        1000,
        200,
        800,
        300,
        100,
        1300,
        'priced',
        NULL,
        'USD',
        'openai-api',
        '2026-06-16',
        'openai:2026-06-16:gpt-5.5:standard',
        900,
        100,
        4000,
        5000,
        1200
      );
      INSERT INTO thread_pricing_summaries VALUES (
        'codex',
        'thread-1',
        'USD',
        1,
        1,
        0,
        1000,
        200,
        800,
        300,
        100,
        1300,
        5000,
        1200
      );
    `);
    raw.close();

    stateDb = StateDb.open(dbPath);

    expect(columnNames("thread_usage_lines")).toContain("provider");
    expect(columnNames("thread_usage_lines")).toContain("usage_turn_id");
    expect(columnNames("thread_pricing_summaries")).toContain("provider");
    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      CURRENT_STATE_DB_USER_VERSION,
    );

    const line = stateDb.raw
      .prepare(
        `SELECT provider, usage_turn_id
         FROM thread_usage_lines
         WHERE usage_line_id = 'line-1'`,
      )
      .get() as { provider: string; usage_turn_id: string };
    const turn = stateDb.raw
      .prepare(
        `SELECT provider, backend, thread_id, turn_id
         FROM thread_usage_turns
         WHERE usage_turn_id = ?`,
      )
      .get(line.usage_turn_id) as {
        provider: string;
        backend: string;
        thread_id: string;
        turn_id: string | null;
      };
    const summary = stateDb.raw
      .prepare(
        `SELECT provider, backend, thread_id, currency, total_cost_micros
         FROM thread_pricing_summaries`,
      )
      .get() as {
        provider: string;
        backend: string;
        thread_id: string;
        currency: string;
        total_cost_micros: number;
      };

    expect(line).toEqual({
      provider: "openai",
      usage_turn_id: "openai:codex:thread-1:turn-1",
    });
    expect(turn).toEqual({
      backend: "codex",
      provider: "openai",
      thread_id: "thread-1",
      turn_id: "turn-1",
    });
    expect(summary).toEqual({
      backend: "codex",
      currency: "USD",
      provider: "openai",
      thread_id: "thread-1",
      total_cost_micros: 5000,
    });
  });

  it("repairs live usage line timestamps that were overwritten by streaming updates", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "live-usage-created-at-repair-state.db");
    stateDb = StateDb.open(dbPath);
    stateDb.raw
      .prepare(
        `INSERT INTO thread_usage_lines (
          usage_line_id,
          usage_turn_id,
          provider,
          backend,
          thread_id,
          turn_id,
          source,
          source_item_id,
          scope,
          status,
          created_at,
          model,
          input_tokens,
          cached_input_tokens,
          uncached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          total_tokens,
          price_status,
          currency,
          uncached_input_cost_micros,
          cached_input_cost_micros,
          output_cost_micros,
          total_cost_micros,
          updated_at
        ) VALUES (
          'live-line-1',
          'openai:codex:thread-1:turn-1',
          'openai',
          'codex',
          'thread-1',
          'turn-1',
          'live',
          'thread-token-usage',
          'turn',
          'pending',
          2000,
          'gpt-5.5',
          1000,
          200,
          800,
          300,
          100,
          1300,
          'priced',
          'USD',
          900,
          100,
          4000,
          5000,
          2000
        )`,
      )
      .run();
    stateDb.raw
      .prepare(
        `INSERT INTO thread_usage_turns (
          usage_turn_id,
          provider,
          backend,
          thread_id,
          turn_id,
          model,
          settings_source,
          settings_confidence,
          observed_at,
          updated_at
        ) VALUES (
          'openai:codex:thread-1:turn-1',
          'openai',
          'codex',
          'thread-1',
          'turn-1',
          'gpt-5.5',
          'thread-overlay',
          'fallback',
          1000,
          2000
        )`,
      )
      .run();
    stateDb.raw.pragma("user_version = 19");
    stateDb.close();

    stateDb = StateDb.open(dbPath);

    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      CURRENT_STATE_DB_USER_VERSION,
    );
    expect(
      (
        stateDb.raw
          .prepare(
            "SELECT created_at FROM thread_usage_lines WHERE usage_line_id = 'live-line-1'",
          )
          .get() as { created_at: number }
      ).created_at,
    ).toBe(1000);
  });

  it("repairs OpenAI usage pricing after embedded catalog date changes", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "usage-pricing-repair-state.db");
    stateDb = StateDb.open(dbPath);
    stateDb.raw
      .prepare(
        `INSERT INTO thread_usage_lines (
          usage_line_id,
          usage_turn_id,
          provider,
          backend,
          thread_id,
          turn_id,
          source,
          source_item_id,
          scope,
          status,
          created_at,
          completed_at,
          model,
          service_tier,
          fast_mode,
          input_tokens,
          cached_input_tokens,
          uncached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          total_tokens,
          price_status,
          price_unavailable_reason,
          currency,
          uncached_input_cost_micros,
          cached_input_cost_micros,
          output_cost_micros,
          total_cost_micros,
          updated_at
        ) VALUES (
          'live-line-june-15',
          'openai:codex:thread-1:turn-1',
          'openai',
          'codex',
          'thread-1',
          'turn-1',
          'live',
          'thread-token-usage',
          'turn',
          'pending',
          ?,
          ?,
          'gpt-5.5',
          NULL,
          0,
          80351,
          38272,
          42079,
          58,
          0,
          80409,
          'unpriced',
          'missing-rate',
          'USD',
          0,
          0,
          0,
          0,
          ?
        )`,
      )
      .run(
        Date.UTC(2026, 5, 15, 18, 40, 23),
        Date.UTC(2026, 5, 15, 18, 40, 23),
        Date.UTC(2026, 5, 15, 18, 40, 23),
      );
    stateDb.raw
      .prepare(
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
          'openai',
          'codex',
          'thread-1',
          'USD',
          1,
          0,
          1,
          80351,
          38272,
          42079,
          58,
          0,
          80409,
          0,
          ?
        )`,
      )
      .run(Date.UTC(2026, 5, 15, 18, 40, 23));
    stateDb.raw.pragma("user_version = 21");
    stateDb.close();

    stateDb = StateDb.open(dbPath);

    const line = stateDb.raw
      .prepare(
        `SELECT price_status, price_unavailable_reason, pricing_rate_id, total_cost_micros
         FROM thread_usage_lines
         WHERE usage_line_id = 'live-line-june-15'`,
      )
      .get() as {
        price_status: string;
        price_unavailable_reason: string | null;
        pricing_rate_id: string | null;
        total_cost_micros: number;
      };
    const summary = stateDb.raw
      .prepare(
        `SELECT priced_usage_line_count, unpriced_usage_line_count, total_cost_micros
         FROM thread_pricing_summaries
         WHERE provider = 'openai'
           AND backend = 'codex'
           AND thread_id = 'thread-1'
           AND currency = 'USD'`,
      )
      .get() as {
        priced_usage_line_count: number;
        total_cost_micros: number;
        unpriced_usage_line_count: number;
      };

    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      CURRENT_STATE_DB_USER_VERSION,
    );
    expect(line).toEqual({
      price_status: "priced",
      price_unavailable_reason: null,
      pricing_rate_id: "openai:2026-06-16:gpt-5.5:standard",
      total_cost_micros: 231_271,
    });
    expect(summary).toEqual({
      priced_usage_line_count: 1,
      total_cost_micros: 231_271,
      unpriced_usage_line_count: 0,
    });
  });

  it("repairs a late Codex turn snapshot from its fresh cumulative opening balance", () => {
    const dbPath = path.join(tempDir, "codex-turn-usage-repair-state.db");
    stateDb.close();
    stateDb = StateDb.open(dbPath);
    const insert = stateDb.raw.prepare(
      `INSERT INTO thread_usage_lines (
         usage_line_id, provider, backend, thread_id, turn_id, source,
         source_item_id, scope, status, created_at, completed_at, model,
         reasoning_effort, service_tier, fast_mode, turn_usage_attributed,
         settings_source, settings_confidence, input_tokens, cached_input_tokens,
         uncached_input_tokens, output_tokens, reasoning_output_tokens,
         total_tokens, cumulative_input_tokens, cumulative_cached_input_tokens,
         cumulative_uncached_input_tokens, cumulative_output_tokens,
         cumulative_reasoning_output_tokens, cumulative_total_tokens,
         price_status, currency, pricing_catalog_id, pricing_catalog_version,
         pricing_rate_id, uncached_input_cost_micros,
         cached_input_cost_micros, output_cost_micros, total_cost_micros,
         updated_at
       ) VALUES (
         @usageLineId, 'openai', 'codex', 'thread-1', @turnId, 'live',
         'thread-token-usage', 'turn', 'pending', @createdAt, @completedAt,
         'gpt-5.6-sol', 'high', 'standard', 0, 1, 'thread-overlay',
         'fallback', @inputTokens, @cachedInputTokens, @uncachedInputTokens,
         @outputTokens, @reasoningOutputTokens, @totalTokens,
         @cumulativeInputTokens, @cumulativeCachedInputTokens,
         @cumulativeUncachedInputTokens, @cumulativeOutputTokens,
         @cumulativeReasoningOutputTokens, @cumulativeTotalTokens, 'priced',
         'USD', 'openai-api', '2026-07-09',
         'openai:2026-07-09:gpt-5.6-sol:standard',
         @uncachedInputCostMicros, @cachedInputCostMicros,
         @outputCostMicros, @totalCostMicros, @updatedAt
       )`,
    );
    const turn2StartedAt = Date.UTC(2026, 7, 8, 18, 18, 22);
    insert.run({
      cachedInputCostMicros: 84_864,
      cachedInputTokens: 169_728,
      completedAt: Date.UTC(2026, 6, 27, 2, 53, 2),
      createdAt: Date.UTC(2026, 6, 27, 2, 48, 53),
      cumulativeCachedInputTokens: 47_800_576,
      cumulativeInputTokens: 49_575_456,
      cumulativeOutputTokens: 118_122,
      cumulativeReasoningOutputTokens: 46_342,
      cumulativeTotalTokens: 49_693_578,
      cumulativeUncachedInputTokens: 1_774_880,
      inputTokens: 171_318,
      outputCostMicros: 3_000,
      outputTokens: 100,
      reasoningOutputTokens: 0,
      totalCostMicros: 95_814,
      totalTokens: 171_418,
      turnId: "turn-1",
      uncachedInputCostMicros: 7_950,
      uncachedInputTokens: 1_590,
      updatedAt: turn2StartedAt - 19_000,
      usageLineId: "line-turn-1",
    });
    insert.run({
      cachedInputCostMicros: 113_920,
      cachedInputTokens: 227_840,
      completedAt: Date.UTC(2026, 7, 8, 18, 24, 28),
      createdAt: turn2StartedAt,
      cumulativeCachedInputTokens: 57_795_328,
      cumulativeInputTokens: 59_830_359,
      cumulativeOutputTokens: 128_478,
      cumulativeReasoningOutputTokens: 49_365,
      cumulativeTotalTokens: 59_958_837,
      cumulativeUncachedInputTokens: 2_035_031,
      inputTokens: 228_834,
      outputCostMicros: 4_230,
      outputTokens: 141,
      reasoningOutputTokens: 0,
      totalCostMicros: 123_120,
      totalTokens: 228_975,
      turnId: "turn-2",
      uncachedInputCostMicros: 4_970,
      uncachedInputTokens: 994,
      updatedAt: Date.UTC(2026, 7, 8, 20, 52, 27),
      usageLineId: "line-turn-2",
    });

    stateDb.raw.pragma("user_version = 51");
    stateDb.close();
    stateDb = StateDb.open(dbPath);

    expect(
      stateDb.raw
        .prepare(
          `SELECT
             input_tokens,
             cached_input_tokens,
             uncached_input_tokens,
             output_tokens,
             reasoning_output_tokens,
             total_tokens,
             total_cost_micros
           FROM thread_usage_lines
           WHERE usage_line_id = 'line-turn-2'`,
        )
        .get(),
    ).toEqual({
      cached_input_tokens: 9_994_752,
      input_tokens: 10_254_903,
      output_tokens: 10_356,
      reasoning_output_tokens: 3_023,
      total_cost_micros: 6_699_501,
      total_tokens: 10_265_259,
      uncached_input_tokens: 260_151,
    });
    expect(
      stateDb.raw
        .prepare(
          `SELECT input_tokens, total_cost_micros
           FROM thread_pricing_summaries
           WHERE backend = 'codex' AND thread_id = 'thread-1'`,
        )
        .get(),
    ).toEqual({
      input_tokens: 10_426_221,
      total_cost_micros: 6_795_315,
    });
  });

  it("migrates legacy Grok pricing without billing fork baselines", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "grok-pricing-provider-repair-state.db");
    stateDb = StateDb.open(dbPath);
    stateDb.raw
      .prepare(
        `INSERT INTO thread_usage_lines (
          usage_line_id,
          usage_turn_id,
          provider,
          backend,
          thread_id,
          turn_id,
          source,
          source_item_id,
          scope,
          status,
          created_at,
          completed_at,
          model,
          service_tier,
          fast_mode,
          input_tokens,
          cached_input_tokens,
          uncached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          total_tokens,
          price_status,
          price_unavailable_reason,
          currency,
          uncached_input_cost_micros,
          cached_input_cost_micros,
          output_cost_micros,
          total_cost_micros,
          updated_at
        ) VALUES (
          'live-line-grok-4-5',
          'openai:acp-grok:thread-1:turn-1',
          'openai',
          'acp:grok',
          'thread-1',
          'turn-1',
          'live',
          'thread-token-usage',
          'turn',
          'pending',
          ?,
          ?,
          'grok-4.5-build',
          NULL,
          0,
          21208,
          11136,
          10072,
          45,
          28,
          21253,
          'unpriced',
          'missing-rate',
          'USD',
          0,
          0,
          0,
          0,
          ?
        )`,
      )
      .run(
        Date.UTC(2026, 6, 26),
        Date.UTC(2026, 6, 26),
        Date.UTC(2026, 6, 26),
      );
    stateDb.raw
      .prepare(
        `INSERT INTO thread_usage_lines (
          usage_line_id,
          provider,
          backend,
          thread_id,
          parent_thread_id,
          source,
          scope,
          status,
          created_at,
          model,
          input_tokens,
          cached_input_tokens,
          uncached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          total_tokens,
          price_status,
          currency,
          uncached_input_cost_micros,
          cached_input_cost_micros,
          output_cost_micros,
          total_cost_micros,
          updated_at
        ) VALUES (
          'fork-baseline-grok-4-5',
          'openai',
          'acp:grok',
          'thread-fork',
          'thread-parent',
          'hydration',
          'fork-baseline',
          'finalized',
          ?,
          'grok-4.5-build',
          21208,
          11136,
          10072,
          45,
          28,
          21253,
          'priced',
          'USD',
          0,
          0,
          0,
          0,
          ?
        )`,
      )
      .run(Date.UTC(2026, 6, 26), Date.UTC(2026, 6, 26));
    stateDb.raw.pragma("user_version = 28");
    stateDb.close();

    stateDb = StateDb.open(dbPath);

    const line = stateDb.raw
      .prepare(
        `SELECT
           provider,
           price_status,
           price_unavailable_reason,
           pricing_catalog_id,
           pricing_catalog_version,
           pricing_rate_id,
           total_cost_micros
         FROM thread_usage_lines
         WHERE usage_line_id = 'live-line-grok-4-5'`,
      )
      .get();
    const forkBaseline = stateDb.raw
      .prepare(
        `SELECT
           provider,
           price_status,
           pricing_catalog_id,
           pricing_catalog_version,
           pricing_rate_id,
           uncached_input_cost_micros,
           cached_input_cost_micros,
           output_cost_micros,
           total_cost_micros
         FROM thread_usage_lines
         WHERE usage_line_id = 'fork-baseline-grok-4-5'`,
      )
      .get();
    const summary = stateDb.raw
      .prepare(
        `SELECT provider, priced_usage_line_count, total_cost_micros
         FROM thread_pricing_summaries
         WHERE backend = 'acp:grok'
           AND thread_id = 'thread-1'
           AND currency = 'USD'`,
      )
      .get();
    const forkSummary = stateDb.raw
      .prepare(
        `SELECT provider, priced_usage_line_count, total_cost_micros
         FROM thread_pricing_summaries
         WHERE backend = 'acp:grok'
           AND thread_id = 'thread-parent'
           AND currency = 'USD'`,
      )
      .get();

    expect(line).toEqual({
      provider: "xai",
      price_status: "priced",
      price_unavailable_reason: null,
      pricing_catalog_id: "xai-api",
      pricing_catalog_version: "2026-07-17",
      pricing_rate_id: "xai:2026-07-17:grok-4.5:standard",
      total_cost_micros: 23_755,
    });
    expect(forkBaseline).toEqual({
      provider: "openai",
      price_status: "priced",
      pricing_catalog_id: null,
      pricing_catalog_version: null,
      pricing_rate_id: null,
      uncached_input_cost_micros: 0,
      cached_input_cost_micros: 0,
      output_cost_micros: 0,
      total_cost_micros: 0,
    });
    expect(forkSummary).toEqual({
      provider: "openai",
      priced_usage_line_count: 1,
      total_cost_micros: 0,
    });
    expect(summary).toEqual({
      provider: "xai",
      priced_usage_line_count: 1,
      total_cost_micros: 23_755,
    });
  });

  it("reprices Astra aggregate rows whose turn context window caps every request under 272K", () => {
    stateDb.close();

    const dbPath = path.join(
      tempDir,
      "astra-context-window-pricing-repair-state.db",
    );
    stateDb = StateDb.open(dbPath);
    const createdAt = Date.UTC(2026, 8, 5, 20, 40);
    stateDb.raw
      .prepare(
        `INSERT INTO thread_usage_turns (
          usage_turn_id,
          provider,
          backend,
          thread_id,
          turn_id,
          model,
          observed_at,
          model_context_window,
          updated_at
        ) VALUES (
          'openai:codex:thread-astra:turn-astra',
          'openai',
          'codex',
          'thread-astra',
          'turn-astra',
          'gpt-6-astra',
          ?,
          258400,
          ?
        )`,
      )
      .run(createdAt, createdAt);
    stateDb.raw
      .prepare(
        `INSERT INTO thread_usage_lines (
          usage_line_id,
          usage_turn_id,
          provider,
          backend,
          thread_id,
          turn_id,
          source,
          scope,
          status,
          created_at,
          model,
          fast_mode,
          input_tokens,
          cached_input_tokens,
          uncached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          total_tokens,
          price_status,
          price_unavailable_reason,
          currency,
          uncached_input_cost_micros,
          cached_input_cost_micros,
          output_cost_micros,
          total_cost_micros,
          updated_at
        ) VALUES (
          'codex:thread-astra:turn-astra:live-token-usage',
          'openai:codex:thread-astra:turn-astra',
          'openai',
          'codex',
          'thread-astra',
          'turn-astra',
          'live',
          'turn',
          'pending',
          ?,
          'gpt-6-astra',
          0,
          1648011,
          1527808,
          120203,
          9663,
          1131,
          1658805,
          'unpriced',
          'insufficient-token-breakdown',
          'USD',
          0,
          0,
          0,
          0,
          ?
        )`,
      )
      .run(createdAt, createdAt);
    stateDb.raw.pragma("user_version = 58");
    stateDb.close();

    stateDb = StateDb.open(dbPath);

    const line = stateDb.raw
      .prepare(
        `SELECT price_status, price_unavailable_reason, pricing_rate_id, total_cost_micros
         FROM thread_usage_lines
         WHERE usage_line_id = 'codex:thread-astra:turn-astra:live-token-usage'`,
      )
      .get() as {
        price_status: string;
        price_unavailable_reason: string | null;
        pricing_rate_id: string | null;
        total_cost_micros: number;
      };
    const summary = stateDb.raw
      .prepare(
        `SELECT priced_usage_line_count, unpriced_usage_line_count, total_cost_micros
         FROM thread_pricing_summaries
         WHERE provider = 'openai'
           AND backend = 'codex'
           AND thread_id = 'thread-astra'
           AND currency = 'USD'`,
      )
      .get() as {
        priced_usage_line_count: number;
        total_cost_micros: number;
        unpriced_usage_line_count: number;
      };

    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      CURRENT_STATE_DB_USER_VERSION,
    );
    expect(line).toEqual({
      price_status: "priced",
      price_unavailable_reason: null,
      pricing_rate_id: "openai:2026-09-04:gpt-6-astra:standard:input-lte-272k",
      total_cost_micros: 3_269_538,
    });
    expect(summary).toEqual({
      priced_usage_line_count: 1,
      total_cost_micros: 3_269_538,
      unpriced_usage_line_count: 0,
    });
  });

  it("reprices existing GPT-5.6 usage rows after the July 30 price reduction", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "gpt-5-6-pricing-repair-state.db");
    stateDb = StateDb.open(dbPath);
    stateDb.raw
      .prepare(
        `INSERT INTO thread_usage_lines (
          usage_line_id,
          provider,
          backend,
          thread_id,
          source,
          scope,
          status,
          created_at,
          model,
          input_tokens,
          cached_input_tokens,
          uncached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          total_tokens,
          price_status,
          price_unavailable_reason,
          currency,
          pricing_catalog_id,
          pricing_catalog_version,
          pricing_rate_id,
          uncached_input_cost_micros,
          cached_input_cost_micros,
          output_cost_micros,
          total_cost_micros,
          updated_at
        ) VALUES (
          'live-line-gpt-5-6-terra',
          'openai',
          'codex',
          'thread-gpt-5-6',
          'live',
          'turn',
          'pending',
          ?,
          'gpt-5.6-terra',
          26291,
          0,
          26291,
          15,
          0,
          26306,
          'priced',
          NULL,
          'USD',
          'openai-api',
          '2026-07-09',
          'openai:2026-07-09:gpt-5.6-terra:standard',
          65728,
          0,
          225,
          65953,
          ?
        )`,
      )
      .run(
        Date.UTC(2026, 6, 30, 22, 50, 30),
        Date.UTC(2026, 6, 30, 22, 50, 30),
      );
    stateDb.raw.pragma("user_version = 31");
    stateDb.close();

    stateDb = StateDb.open(dbPath);

    const line = stateDb.raw
      .prepare(
        `SELECT price_status, price_unavailable_reason, pricing_rate_id, total_cost_micros
         FROM thread_usage_lines
         WHERE usage_line_id = 'live-line-gpt-5-6-terra'`,
      )
      .get() as {
        price_status: string;
        price_unavailable_reason: string | null;
        pricing_rate_id: string | null;
        total_cost_micros: number;
      };
    const summary = stateDb.raw
      .prepare(
        `SELECT priced_usage_line_count, unpriced_usage_line_count, total_cost_micros
         FROM thread_pricing_summaries
         WHERE provider = 'openai'
           AND backend = 'codex'
           AND thread_id = 'thread-gpt-5-6'
           AND currency = 'USD'`,
      )
      .get() as {
        priced_usage_line_count: number;
        total_cost_micros: number;
        unpriced_usage_line_count: number;
      };

    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      CURRENT_STATE_DB_USER_VERSION,
    );
    expect(line).toEqual({
      price_status: "priced",
      price_unavailable_reason: null,
      pricing_rate_id: "openai:2026-07-30:gpt-5.6-terra:standard",
      total_cost_micros: 52_762,
    });
    expect(summary).toEqual({
      priced_usage_line_count: 1,
      total_cost_micros: 52_762,
      unpriced_usage_line_count: 0,
    });
  });

  it("rebuilds pricing summaries for parented usage lines only on the parent thread", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "parented-usage-pricing-repair-state.db");
    stateDb = StateDb.open(dbPath);
    stateDb.raw
      .prepare(
        `INSERT INTO thread_usage_lines (
          usage_line_id,
          usage_turn_id,
          provider,
          backend,
          thread_id,
          parent_thread_id,
          turn_id,
          source,
          source_item_id,
          scope,
          status,
          created_at,
          completed_at,
          model,
          service_tier,
          fast_mode,
          input_tokens,
          cached_input_tokens,
          uncached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          total_tokens,
          price_status,
          price_unavailable_reason,
          currency,
          uncached_input_cost_micros,
          cached_input_cost_micros,
          output_cost_micros,
          total_cost_micros,
          updated_at
        ) VALUES (
          'monitor-line-june-15',
          'openai:codex:monitor-thread-1:turn-1',
          'openai',
          'codex',
          'monitor-thread-1',
          'parent-thread-1',
          'turn-1',
          'monitor',
          'thread-token-usage',
          'monitor',
          'pending',
          ?,
          ?,
          'gpt-5.5',
          NULL,
          0,
          80351,
          38272,
          42079,
          58,
          0,
          80409,
          'unpriced',
          'missing-rate',
          'USD',
          0,
          0,
          0,
          0,
          ?
        )`,
      )
      .run(
        Date.UTC(2026, 5, 15, 18, 40, 23),
        Date.UTC(2026, 5, 15, 18, 40, 23),
        Date.UTC(2026, 5, 15, 18, 40, 23),
      );
    stateDb.raw.pragma("user_version = 21");
    stateDb.close();

    stateDb = StateDb.open(dbPath);

    const summaries = stateDb.raw
      .prepare(
        `SELECT thread_id, priced_usage_line_count, total_cost_micros
         FROM thread_pricing_summaries
         WHERE provider = 'openai'
           AND backend = 'codex'
           AND currency = 'USD'
         ORDER BY thread_id`,
      )
      .all() as Array<{
        priced_usage_line_count: number;
        thread_id: string;
        total_cost_micros: number;
      }>;

    expect(summaries).toEqual([
      {
        priced_usage_line_count: 1,
        thread_id: "parent-thread-1",
        total_cost_micros: 231_271,
      },
    ]);
  });

  it("repairs databases that used version 13 for the old PR cache migration", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "legacy-pr-cache-state.db");
    const raw = openRawDb(dbPath);
    raw.exec(`
      PRAGMA user_version = 13;
      CREATE TABLE pr_status_cache (
        pr_key     TEXT PRIMARY KEY,
        org        TEXT NOT NULL,
        repo       TEXT NOT NULL,
        number     INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        payload    TEXT NOT NULL
      );
    `);
    raw.close();

    stateDb = StateDb.open(dbPath);

    expect(existingTables()).toEqual([
      "federation_enrollment_tokens",
      "federation_peers",
      "federation_session_audit",
      "pr_lookup_cache",
      "pr_status_cache",
      "thread_search_documents",
      "thread_search_fts",
    ]);
    expect(columnNames("pr_status_cache")).toContain("provider");
    expect(columnNames("pr_lookup_cache")).toContain("provider");
    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      CURRENT_STATE_DB_USER_VERSION,
    );
  });

  it("repairs version 13 databases that only have thread search", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "legacy-thread-search-state.db");
    const raw = openRawDb(dbPath);
    raw.exec(`
      PRAGMA user_version = 13;
      CREATE TABLE thread_search_documents (
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
      CREATE INDEX idx_thread_search_documents_backend_updated
        ON thread_search_documents(backend, updated_at DESC);
      CREATE INDEX idx_thread_search_documents_project_updated
        ON thread_search_documents(project_key, updated_at DESC);
      CREATE INDEX idx_thread_search_documents_archived
        ON thread_search_documents(archived_at);
      CREATE VIRTUAL TABLE thread_search_fts USING fts5(
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
        tokenize = "unicode61 remove_diacritics 2 tokenchars '-_./:'"
      );
    `);
    raw.close();

    stateDb = StateDb.open(dbPath);

    expect(existingTables()).toEqual([
      "federation_enrollment_tokens",
      "federation_peers",
      "federation_session_audit",
      "pr_lookup_cache",
      "pr_status_cache",
      "thread_search_documents",
      "thread_search_fts",
    ]);
    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      CURRENT_STATE_DB_USER_VERSION,
    );
  });

  it("migrates thread search FTS rows to include thread ids", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "legacy-thread-search-fts-state.db");
    createLegacyThreadSearchFtsDb(dbPath, 22);

    stateDb = StateDb.open(dbPath);

    expect(columnNames("thread_search_fts")).toContain("thread_id");
    expect(
      new ThreadSearchStore(stateDb)
        .search({ query: "7f2f4bd1-8e7b-4d3b-92e5", limit: 10 })
        .map((result) => result.threadId),
    ).toEqual(["7f2f4bd1-8e7b-4d3b-92e5-0e9ef15c9c84"]);
    expect(
      new ThreadSearchStore(stateDb)
        .search({ query: "e31f5e66", limit: 10 })
        .map((result) => result.threadId),
    ).toEqual(["session_e31f5e66-7410-4235-aa19-3bbb63ee8c3d"]);
  });

  it("repairs stale thread search FTS tables even at current user_version", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "current-version-stale-thread-search-fts.db");
    createLegacyThreadSearchFtsDb(dbPath, CURRENT_STATE_DB_USER_VERSION);

    stateDb = StateDb.open(dbPath);

    expect(columnNames("thread_search_fts")).toContain("thread_id");
    expect(
      new ThreadSearchStore(stateDb)
        .search({ query: "7f2f4bd1-8e7b-4d3b-92e5", limit: 10 })
        .map((result) => result.threadId),
    ).toEqual(["7f2f4bd1-8e7b-4d3b-92e5-0e9ef15c9c84"]);
  });

  it("repairs stale thread search FTS tables without downgrading newer versions", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "newer-version-thread-search-fts.db");
    const newerVersion = CURRENT_STATE_DB_USER_VERSION + 1;
    createLegacyThreadSearchFtsDb(dbPath, newerVersion);

    stateDb = StateDb.open(dbPath);

    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      newerVersion,
    );
    expect(columnNames("thread_search_fts")).toContain("thread_id");
  });
});

function createLegacyThreadSearchFtsDb(
  dbPath: string,
  userVersion: number,
): void {
  const raw = openRawDb(dbPath);
  raw.exec(`
      PRAGMA user_version = 22;
      CREATE TABLE thread_search_documents (
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
      CREATE VIRTUAL TABLE thread_search_fts USING fts5(
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
        tokenize = "unicode61 remove_diacritics 2 tokenchars '-_./:'"
      );
      INSERT INTO thread_search_documents (
        identity_key, backend, thread_id, title, title_source, summary,
        project_key, created_at, updated_at, archived_at, git_branch,
        git_origin_url, model, linked_directories_json, display_json, indexed_at
      ) VALUES (
        'codex:7f2f4bd1-8e7b-4d3b-92e5-0e9ef15c9c84',
        'codex',
        '7f2f4bd1-8e7b-4d3b-92e5-0e9ef15c9c84',
        'Release notes',
        'derived',
        'Prepared release copy',
        'PwrAgent',
        1000,
        1000,
        NULL,
        'feat/release',
        NULL,
        'gpt-5.5',
        '[{"id":"dir-1","label":"PwrAgent","path":"/repo/PwrAgent","kind":"local"}]',
        '{}',
        1000
      ), (
        'codex:session_e31f5e66-7410-4235-aa19-3bbb63ee8c3d',
        'codex',
        'session_e31f5e66-7410-4235-aa19-3bbb63ee8c3d',
        'Kimi session',
        'derived',
        'Prepared release copy',
        'PwrAgent',
        1000,
        1000,
        NULL,
        'feat/release',
        NULL,
        'gpt-5.5',
        '[{"id":"dir-1","label":"PwrAgent","path":"/repo/PwrAgent","kind":"local"}]',
        '{}',
        1000
      );
    `);
  raw.pragma(`user_version = ${userVersion}`);
  raw.close();
}

function openRawDb(dbPath: string): BetterSqlite3.Database {
  const nativeBinding = getNativeBinding();
  return new Database(dbPath, nativeBinding ? { nativeBinding } : {});
}

function existingTables(): string[] {
  const rows = stateDb.raw
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name IN (?, ?, ?, ?, ?, ?, ?)
       ORDER BY name`,
    )
    .all(
      "federation_enrollment_tokens",
      "federation_peers",
      "federation_session_audit",
      "pr_lookup_cache",
      "pr_status_cache",
      "thread_search_documents",
      "thread_search_fts",
    ) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function columnNames(
  tableName:
    | "pr_lookup_cache"
    | "pr_status_cache"
    | "thread_pricing_summaries"
    | "thread_search_fts"
    | "thread_usage_lines",
): string[] {
  const rows = readTableInfo(tableName);
  return rows.map((row) => row.name);
}

function indexNames(
  tableName:
    | "messaging_observed_surfaces"
    | "thread_message_origins"
    | "thread_tool_invocations"
    | "thread_usage_lines",
): string[] {
  return (
    stateDb.raw.prepare(`PRAGMA index_list(${tableName})`).all() as Array<{
      name: string;
    }>
  )
    .map((row) => row.name)
    .sort();
}

function queryPlanDetails(sql: string, params: unknown[]): string {
  return (
    stateDb.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
      detail: string;
    }>
  )
    .map((row) => row.detail)
    .join("\n");
}

function readTableInfo(
  tableName:
    | "pr_lookup_cache"
    | "pr_status_cache"
    | "thread_pricing_summaries"
    | "thread_search_fts"
    | "thread_usage_lines",
): Array<{ name: string }> {
  switch (tableName) {
    case "pr_lookup_cache":
      return stateDb.raw.prepare("PRAGMA table_info(pr_lookup_cache)").all() as Array<{
        name: string;
      }>;
    case "pr_status_cache":
      return stateDb.raw.prepare("PRAGMA table_info(pr_status_cache)").all() as Array<{
        name: string;
      }>;
    case "thread_pricing_summaries":
      return stateDb.raw
        .prepare("PRAGMA table_info(thread_pricing_summaries)")
        .all() as Array<{ name: string }>;
    case "thread_search_fts":
      return stateDb.raw
        .prepare("PRAGMA table_info(thread_search_fts)")
        .all() as Array<{ name: string }>;
    case "thread_usage_lines":
      return stateDb.raw
        .prepare("PRAGMA table_info(thread_usage_lines)")
        .all() as Array<{ name: string }>;
  }
}
