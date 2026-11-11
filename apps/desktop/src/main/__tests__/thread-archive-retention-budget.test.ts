import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildThreadIdentityKey,
  DEFAULT_THREAD_ARCHIVE_POLICY,
  type AppServerThreadSummary,
  type ThreadOverlayState,
} from "@pwragent/shared";
import { sweepThreadArchiveRetention } from "../app-server/thread-archive-retention";

/**
 * Operation budget for the hourly archive retention sweep. Finding each
 * family by scanning the whole thread list per member, and re-reading every
 * archive state after each deleted family, made a sweep that deletes many
 * families quadratic in the thread count. Both are now linear.
 *
 * Family lookups read each thread's `codexNativeSubAgent`, so a getter
 * counts them. Re-reads are counted as the archive states returned to the
 * sweep.
 */

const DAY = 86_400_000;
afterEach(() => { vi.useRealTimers(); });

async function sweep(families: number): Promise<{ deleted: number; parentReads: number; rows: number }> {
  let parentReads = 0;
  let threads: AppServerThreadSummary[] = [];
  let states: ThreadOverlayState[] = [];
  for (let index = 0; index < families; index++) {
    for (const [id, parent] of [[`root${index}`, undefined], [`child${index}`, `root${index}`]] as const) {
      const thread = { id, title: id, titleSource: "explicit", source: "codex", threadStatus: "notLoaded",
        archivedAt: 5 * DAY, updatedAt: DAY, linkedDirectories: [] } as AppServerThreadSummary;
      Object.defineProperty(thread, "codexNativeSubAgent", {
        get: () => { parentReads += 1; return parent ? { parentThreadId: parent } : undefined; },
      });
      threads.push(thread);
      states.push({ backend: "codex", threadId: id, executionMode: "default", extraLinkedDirectories: [],
        archiveRetentionStartedAt: 10 * DAY,
        worktreeSnapshots: [{ id, backend: "codex", threadId: id, worktreePath: `/w/${id}`, repositoryPath: "/repo",
          snapshotRef: `refs/snapshots/${id}`, snapshotCommit: "abc", createdAt: DAY, state: "archived", ignoredFilesExcluded: true }],
      });
    }
  }
  let rows = 0;
  const deleted = await sweepThreadArchiveRetention({
    getPolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, retentionDays: 30 }),
    listThreads: async () => threads,
    listStates: async () => { rows += states.length; return states; },
    listStatesFor: async (victims, refs) => {
      const keys = new Set(victims.map((state) => buildThreadIdentityKey(state.backend, state.threadId)));
      const found = states.filter((state) => keys.has(buildThreadIdentityKey(state.backend, state.threadId))
        || (state.worktreeSnapshots ?? []).some((snapshot) => refs.includes(snapshot.snapshotRef)));
      rows += found.length;
      return found;
    },
    observeArchives: async () => {},
    confirmAbsent: async () => true,
    deleteFamily: async (family) => {
      const ids = new Set(family.map(({ thread }) => thread.id));
      threads = threads.filter((thread) => !ids.has(thread.id));
    },
    deleteSnapshot: async () => {},
    forgetStates: async (victims) => {
      const ids = new Set(victims.map((state) => state.threadId));
      states = states.filter((state) => !ids.has(state.threadId));
    },
    isBusy: () => false,
    onError: (error) => { throw error; },
  });
  return { deleted, parentReads, rows };
}

describe("archive retention sweep budget", () => {
  it("does work proportional to the thread count as the deleted families double", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100 * DAY);
    const small = await sweep(60);
    const large = await sweep(120);
    expect(small.deleted).toBe(60);
    expect(large.deleted).toBe(120);
    // A scan of the list per family member made these about four times.
    expect(large.parentReads).toBeLessThanOrEqual(2 * small.parentReads + 16);
    expect(large.rows).toBeLessThanOrEqual(2 * small.rows + 16);
    // Each thread's parent read a few times; each state read a few times.
    expect(large.parentReads).toBeLessThanOrEqual(4 * 240);
    expect(large.rows).toBeLessThanOrEqual(4 * 240);
  });
});
