import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THREAD_ARCHIVE_POLICY } from "@pwragent/shared";
import type { ThreadArchiveCandidate } from "../app-server/thread-archive-sweeper";
import { ThreadMaintenanceService, type ThreadMaintenanceDeps } from "../app-server/thread-maintenance-service";

/**
 * Operation budget for Thread Maintenance's hibernate step. For each
 * checkout it measures, the step finds the threads using that checkout or a
 * directory inside it. Filtering every candidate's directories per checkout
 * made the step O(checkouts × candidates × directories). Reading each
 * candidate's directories once per scan makes it linear.
 *
 * `candidateCheckoutDirectories` normalizes each directory it reads, so the
 * count of `path.normalize` calls during the step counts directory reads.
 *
 * The step then lists each kept checkout's threads. Comparing every recorded
 * directory per kept checkout was quadratic too; the count of
 * `String.prototype.startsWith` calls during the step counts those
 * comparisons.
 */

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Threads each in their own checkout, plus a notes folder each. */
function candidates(count: number): ThreadArchiveCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    thread: {
      id: `t${index}`, title: `Thread ${index}`, titleSource: "explicit", source: "codex", threadStatus: "notLoaded",
      updatedAt: NOW - 30 * DAY,
      linkedDirectories: [{ id: `d${index}`, label: "repo", kind: "worktree", path: "/projects/app",
        worktreePath: `/worktrees/k${index}/app` }],
    } as ThreadArchiveCandidate["thread"],
    overlay: { backend: "codex", threadId: `t${index}`, extraLinkedDirectories: [
      { id: `n${index}`, label: "notes", kind: "local", path: `/notes/${index}` },
    ] } as ThreadArchiveCandidate["overlay"],
  }));
}

async function hibernateStep(list: ThreadArchiveCandidate[]): Promise<{ normalized: number; compared: number; kept: number }> {
  const deps: ThreadMaintenanceDeps = {
    getPolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "count", keepPerProject: 1 }),
    snapshotLimitBytes: 100,
    listCandidates: async () => list,
    resolveProject: async () => "/projects/app",
    refreshCandidate: async (item: ThreadArchiveCandidate) => item,
    isBusy: () => false,
    auditArchivedCheckouts: async () => ({ candidates: [], kept: {}, emptyFolders: 0 }),
    archiveFamily: async () => true,
    removeArchivedCheckouts: async () => ({ removed: [], kept: [], failed: [], emptyFoldersRemoved: 0, emptyFoldersFailed: [] }),
    isManagedCheckoutPath: () => true,
    trashItem: async () => {},
    now: () => NOW,
    newId: () => "scan",
    hibernation: {
      getPolicy: () => ({ enabled: true, idleDays: 7, maxSnapshotMb: 100, removeRebuildableOutput: true, restoreOn: "send" }),
      // Every thread has a checkout, measured for space, then kept: Git is
      // not the subject.
      keepReason: (candidate) => ({ target: candidate.thread.linkedDirectories[0]!.worktreePath!, keep: "Busy" }),
      inspect: async () => ({ files: 0, bytes: 0 }),
      hibernate: async () => true,
    },
  };
  const service = new ThreadMaintenanceService(deps);
  let normalized = 0;
  const normalize = path.normalize;
  vi.spyOn(path, "normalize").mockImplementation((value: string) => { normalized += 1; return normalize(value); });
  let compared = 0;
  const startsWith = String.prototype.startsWith;
  vi.spyOn(String.prototype, "startsWith").mockImplementation(function (this: string, ...args: Parameters<typeof startsWith>) {
    compared += 1;
    return startsWith.apply(this, args);
  });
  const scan = await service.scan({ steps: ["hibernate"] });
  vi.restoreAllMocks();
  // Each kept checkout lists its own thread.
  expect(scan.hibernate!.coverage?.keptCheckouts?.every((row) => row.threads?.length === 1)).toBe(true);
  return { normalized, compared, kept: scan.hibernate!.kept["Busy"] ?? 0 };
}

describe("Thread Maintenance hibernate step budget", () => {
  it("reads each thread's directories a bounded number of times as the thread count doubles", async () => {
    const small = await hibernateStep(candidates(60));
    const large = await hibernateStep(candidates(120));
    // Every checkout was measured and kept.
    expect(small.kept).toBe(60);
    expect(large.kept).toBe(120);
    // Doubling the threads at most doubles the directory reads, plus a
    // constant. A filter per checkout made it about four times.
    expect(large.normalized).toBeLessThanOrEqual(2 * small.normalized + 16);
    // Two directories per thread, read once per scan.
    expect(large.normalized).toBeLessThanOrEqual(4 * 120);
    // Listing each kept checkout's threads compares a bounded number of
    // directories per checkout. Walking every recorded directory per
    // checkout made it about four times.
    expect(large.compared).toBeLessThanOrEqual(2 * small.compared + 16);
  });
});
