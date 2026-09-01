// Direct sqlite seeder for a thread's pin rank, in the same class as
// `sub-agent-state-seeding.ts`.
//
// A thread's pin is not replay-fixture data. `pinnedRank` is desktop-local
// state that `setThreadPin` writes into the `threads` table's `payload` JSON,
// and `buildNavigationState` reads back onto the thread summary — the agent's
// `thread/list` never carries it, so no fixture can produce a pinned row. The
// only UI path is the row's context menu, which opens a native menu Playwright
// cannot drive. Writing the overlay row states the end state directly.
//
// The Directories a11y block needs pinned rows for a reason that is easy to
// miss: the "Directory threads" divider only renders when a directory has BOTH
// a pinned and an unpinned lane. With no pin the lane is undivided, the
// divider's `role="listitem"` wrapper and its 24px hit target never mount, and
// the audit would pass without ever looking at them.
//
// Call AFTER launch (the schema is created on first boot) and reload the
// window afterwards: the renderer does not re-poll on a direct sqlite
// mutation. Same shape as the README capture spec's seeders.
import Database from "better-sqlite3";

type ThreadOverlayPayload = {
  backend: string;
  threadId: string;
  executionMode: string;
  extraLinkedDirectories: string[];
  pinnedRank?: string;
};

export type SeededThreadPin = {
  threadId: string;
  pinnedRank: string;
};

/**
 * Merges `pinnedRank` into the overlay row for each pin, preserving whatever
 * the app has already written there.
 *
 * Rows are located by the `threadId` inside their payload rather than by a
 * recomputed key: `putThread` runs the key through
 * `encodeThreadIdentityKeyForStorage`, and duplicating that transform here
 * would be a second source of truth that silently drifts. Falls back to
 * inserting `<backend>:<threadId>` when the thread has no overlay row yet,
 * which is the same key `buildThreadIdentityKey` produces.
 */
export function seedThreadPinnedRanks(params: {
  backend?: string;
  pins: readonly SeededThreadPin[];
  stateDbPath: string;
}): void {
  const backend = params.backend ?? "codex";
  const db = new Database(params.stateDbPath);
  try {
    const rows = db
      .prepare("SELECT thread_id, payload FROM threads")
      .all() as Array<{ thread_id: string; payload: string }>;

    for (const pin of params.pins) {
      const existing = rows.find((row) => {
        try {
          return (JSON.parse(row.payload) as ThreadOverlayPayload).threadId
            === pin.threadId;
        } catch {
          return false;
        }
      });

      if (existing) {
        const payload = JSON.parse(existing.payload) as ThreadOverlayPayload;
        db.prepare("UPDATE threads SET payload = ? WHERE thread_id = ?").run(
          JSON.stringify({ ...payload, pinnedRank: pin.pinnedRank }),
          existing.thread_id,
        );
        continue;
      }

      const payload: ThreadOverlayPayload = {
        backend,
        threadId: pin.threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
        pinnedRank: pin.pinnedRank,
      };
      db.prepare(
        `INSERT OR REPLACE INTO threads(thread_id, directory_path, last_seen_at, dismissed_at, snoozed_until, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        // Matches `buildLegacyEncodedThreadIdentityKey`, which is what
        // `encodeThreadIdentityKeyForStorage` resolves a well-formed key to.
        `${encodeURIComponent(backend)}:${pin.threadId}`,
        null,
        null,
        null,
        null,
        JSON.stringify(payload),
      );
    }
  } finally {
    db.close();
  }
}

/**
 * The two pins the Directories audit needs, against
 * `e2e/fixtures/a11y-directories/replay.fixture.json`.
 *
 * Two rather than one so the pinned lane itself is reorderable — that is what
 * mounts `.directory-row__pin-drop-boundary` between the lanes, the roleless
 * wrapper sitting directly inside the list whose children the audit checks.
 * Ranks are `PIN_RANK_STEP` multiples, the spacing `setThreadPin` produces.
 */
export function buildAuditDirectoryPins(): SeededThreadPin[] {
  return [
    { threadId: "thread-directories-01", pinnedRank: "1024" },
    { threadId: "thread-directories-02", pinnedRank: "2048" },
  ];
}
