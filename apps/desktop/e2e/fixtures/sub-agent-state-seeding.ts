// Direct sqlite seeder for a thread's sub-agents, in the same class as
// `readme-state-seeding.ts`.
//
// Sub-agents are not replay-fixture data. Every producer (task monitors, code
// review, Codex's own spawnAgent, the title helper) persists a
// `ThreadSubAgentSummary` through `overlayStore.upsertThreadSubAgent`, which
// lands in the `threads` table's `payload` JSON — so driving a fixture would
// mean replaying whichever protocol traffic happens to create one, and would
// pin the test to that producer rather than to the surface. Writing the
// overlay row states the end state directly.
//
// Call AFTER launch (the schema is created on first boot) and reload the
// window afterwards: the renderer does not re-poll on a direct sqlite
// mutation. Same shape as the README capture spec's seeders.
import Database from "better-sqlite3";
import type { ThreadSubAgentSummary } from "@pwragent/shared";

type ThreadOverlayPayload = {
  backend: string;
  threadId: string;
  executionMode: string;
  extraLinkedDirectories: string[];
  subAgents?: ThreadSubAgentSummary[];
};

/**
 * Merges `subAgents` into the overlay row for `threadId`, preserving whatever
 * the app has already written there.
 *
 * The row is located by the `threadId` inside its payload rather than by a
 * recomputed key: `putThread` runs the key through
 * `encodeThreadIdentityKeyForStorage`, and duplicating that transform here
 * would be a second source of truth that silently drifts. Falls back to
 * inserting `<backend>:<threadId>` when the thread has no overlay row yet,
 * which is the same key `buildThreadIdentityKey` produces.
 */
export function seedThreadSubAgents(params: {
  backend?: string;
  stateDbPath: string;
  subAgents: ThreadSubAgentSummary[];
  threadId: string;
}): void {
  const backend = params.backend ?? "codex";
  const db = new Database(params.stateDbPath);
  try {
    const rows = db
      .prepare("SELECT thread_id, payload FROM threads")
      .all() as Array<{ thread_id: string; payload: string }>;

    const existing = rows.find((row) => {
      try {
        return (JSON.parse(row.payload) as ThreadOverlayPayload).threadId
          === params.threadId;
      } catch {
        return false;
      }
    });

    // upsertThreadSubAgent stores newest-first; match it so the seeded order
    // is the order the renderer receives.
    const subAgents = [...params.subAgents].sort(
      (left, right) => right.createdAt - left.createdAt,
    );

    if (existing) {
      const payload = JSON.parse(existing.payload) as ThreadOverlayPayload;
      db.prepare("UPDATE threads SET payload = ? WHERE thread_id = ?").run(
        JSON.stringify({ ...payload, subAgents }),
        existing.thread_id,
      );
      return;
    }

    const payload: ThreadOverlayPayload = {
      backend,
      threadId: params.threadId,
      executionMode: "default",
      extraLinkedDirectories: [],
      subAgents,
    };
    db.prepare(
      `INSERT OR REPLACE INTO threads(thread_id, directory_path, last_seen_at, dismissed_at, snoozed_until, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      // Matches `buildLegacyEncodedThreadIdentityKey`, which is what
      // `encodeThreadIdentityKeyForStorage` resolves a well-formed key to.
      `${encodeURIComponent(backend)}:${params.threadId}`,
      null,
      null,
      null,
      null,
      JSON.stringify(payload),
    );
  } finally {
    db.close();
  }
}

/**
 * One sub-agent per branch the strip can render: a live run (blinking accent
 * dot, ticking duration, Stop), one waiting on input (warning dot, no clock,
 * no action), and two failures (error dot, danger-toned "Failed", Dismiss —
 * two so the bulk-dismiss control renders, which only appears past one).
 *
 * Timestamps are fixed rather than derived from `Date.now()` so the audited
 * duration text is stable across runs.
 */
export function buildAuditSubAgents(): ThreadSubAgentSummary[] {
  const base = 1_800_000_000_000;
  return [
    {
      monitorId: "audit-running",
      task: "Run and monitor the approved headed smoke verification to terminal state",
      status: "running",
      createdAt: base,
      updatedAt: base,
      backend: "codex",
      monitorThreadId: "audit-monitor-thread",
      monitorTurnId: "audit-monitor-turn",
    },
    {
      monitorId: "audit-blocked",
      task: "Waiting on approval to force-push the runner branch",
      status: "blocked",
      createdAt: base - 1_000,
      updatedAt: base - 1_000,
      backend: "codex",
      monitorThreadId: "audit-blocked-thread",
      monitorTurnId: "audit-blocked-turn",
    },
    {
      monitorId: "audit-failed-1",
      task: "Build and verify the unregistered runner candidate",
      status: "failed",
      createdAt: base - 2_000,
      updatedAt: base - 2_000,
      backend: "codex",
      monitorThreadId: "audit-failed-thread-1",
      monitorTurnId: "audit-failed-turn-1",
    },
    {
      monitorId: "audit-failed-2",
      task: "Import and qualify a digest-pinned seed without using softwareupdate",
      status: "failed",
      createdAt: base - 3_000,
      updatedAt: base - 3_000,
      backend: "codex",
      monitorThreadId: "audit-failed-thread-2",
      monitorTurnId: "audit-failed-turn-2",
    },
  ];
}
