// Pins the a11y gate's directory-pin seeder against the real overlay schema.
//
// `e2e/fixtures/directory-pin-state-seeding.ts` writes the `threads` table by
// hand, so it encodes three assumptions the app could change underneath it:
// the storage key format, the overlay payload shape, and the fact that
// `pinnedRank` lives in that payload at all. If any drifts, the seeder writes a
// row nothing reads — the pinned lane never appears, the "Directory threads"
// divider never mounts, and the Directories a11y block keeps passing while
// auditing a list that is missing the control it was added for. That failure is
// silent by construction, which is exactly why it gets a test rather than a
// comment.
//
// It lives here rather than beside the fixture because `e2e/` is Playwright's;
// this needs vitest and a real sqlite file, and it costs no Electron launch.
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PIN_RANK_STEP, isPinnedThread } from "@pwragent/shared";
import { StateDb } from "../state/state-db";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import {
  buildAuditDirectoryPins,
  seedThreadPinnedRanks,
} from "../../../e2e/fixtures/directory-pin-state-seeding";

function freshStateDbPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "directory-pin-seed-"));
  const dbPath = path.join(dir, "state.db");
  // Create the schema the way the app does, then close over the same file.
  StateDb.open(dbPath, { profileName: "default" });
  return dbPath;
}

function openStore(dbPath: string): SqliteOverlayStore {
  return new SqliteOverlayStore(StateDb.open(dbPath, { profileName: "default" }));
}

describe("seedThreadPinnedRanks", () => {
  it("reaches the overlay store when the threads have no rows yet", async () => {
    // The a11y block seeds immediately after launch, before opening the
    // directories lens, so this is the path it actually takes.
    const dbPath = freshStateDbPath();

    seedThreadPinnedRanks({
      pins: buildAuditDirectoryPins(),
      stateDbPath: dbPath,
    });

    const store = openStore(dbPath);
    for (const pin of buildAuditDirectoryPins()) {
      const state = await store.getThreadOverlayState({
        backend: "codex",
        threadId: pin.threadId,
      });

      expect(state?.pinnedRank).toBe(pin.pinnedRank);
      // The renderer's own predicate, not a truthiness check — a rank the
      // app would not consider pinned leaves the lane undivided.
      expect(isPinnedThread({ id: pin.threadId, pinnedRank: state?.pinnedRank }))
        .toBe(true);
    }
  });

  it("preserves existing overlay state when a row already exists", async () => {
    const dbPath = freshStateDbPath();
    await openStore(dbPath).setThreadReaction({
      backend: "codex",
      threadId: "thread-directories-01",
      emoji: "🔥",
      present: true,
    });

    seedThreadPinnedRanks({
      pins: [{ threadId: "thread-directories-01", pinnedRank: "1024" }],
      stateDbPath: dbPath,
    });

    const state = await openStore(dbPath).getThreadOverlayState({
      backend: "codex",
      threadId: "thread-directories-01",
    });

    expect(state?.pinnedRank).toBe("1024");
    // Merging, not clobbering — the seeder must not wipe what the app wrote.
    expect(state?.reactions).toEqual(["🔥"]);
  });

  it("seeds the two pins the divider needs, on threads the fixture ships", () => {
    // One pin would still produce a pinned lane, but not a reorderable one,
    // so `.directory-row__pin-drop-boundary` would not mount between the
    // lanes and the audit would stop covering that roleless wrapper.
    const pins = buildAuditDirectoryPins();
    expect(pins).toHaveLength(2);

    const fixture = JSON.parse(
      readFileSync(
        path.resolve(
          import.meta.dirname,
          "../../../e2e/fixtures/a11y-directories/replay.fixture.json",
        ),
        "utf8",
      ),
    ) as {
      steps: Array<{
        method: string;
        result?: Array<{ id: string; linkedDirectories?: Array<{ path: string }> }>;
      }>;
    };
    const threads =
      fixture.steps.find((step) => step.method === "thread/list")?.result ?? [];
    const threadIds = new Set(threads.map((thread) => thread.id));

    // A pin on a thread the fixture does not list writes a row nothing joins
    // to, which is the silent-pass this whole file exists to prevent.
    for (const pin of pins) {
      expect(threadIds.has(pin.threadId)).toBe(true);
      expect(Number(pin.pinnedRank) % PIN_RANK_STEP).toBe(0);
    }

    // Count the audited directory's own lane, not every thread in the file —
    // the second directory's thread is in a different row and contributes
    // nothing to this cap.
    const auditedDirectoryThreads = threads.filter((thread) =>
      thread.linkedDirectories?.some(
        (directory) => directory.path === "/repo/PwrAgent",
      ),
    );
    for (const pin of pins) {
      expect(auditedDirectoryThreads.map((thread) => thread.id))
        .toContain(pin.threadId);
    }

    // The unpinned remainder has to clear the 10-row cap for "Show more" to
    // render, which is the audit's other in-list control.
    expect(auditedDirectoryThreads.length - pins.length).toBeGreaterThan(10);
  });
});
