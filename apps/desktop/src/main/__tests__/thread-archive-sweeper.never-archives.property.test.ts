import { DEFAULT_THREAD_ARCHIVE_POLICY } from "@pwragent/shared";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  ThreadArchiveSweeper,
  type ThreadArchiveCandidate,
} from "../app-server/thread-archive-sweeper";

// Archiving takes a thread out of the operator's lists, so only the operator
// does it: one thread, a selection, or Thread maintenance. The rule here is
// that the hourly sweep never archives a thread, for any set of threads and
// any archive settings an old or hand-edited config.toml can hold.
//
// The harness offers every hook the sweep has ever been given for archiving
// (`archive`, `canArchive`, `getPolicy`, …), with every admission check
// answering yes. A sweep that archives anything calls `archive`.

const thread = fc.record({
  ageDays: fc.integer({ min: 0, max: 400 }),
  pinned: fc.boolean(),
  status: fc.constantFrom("idle", "notLoaded", "active"),
  project: fc.constantFrom("~/src/harbor-web", "~/src/tty", undefined),
  parent: fc.option(fc.integer({ min: 0, max: 30 }), { nil: undefined }),
});

// Includes the retired `enabled` switch, on and off, as an older
// config.toml or a hand edit can still hold it.
const legacyPolicy = fc.record({
  enabled: fc.option(fc.boolean(), { nil: undefined }),
  mode: fc.constantFrom("count", "age"),
  keepPerProject: fc.integer({ min: 1, max: 5 }),
  inactivityDays: fc.integer({ min: 1, max: 60 }),
  retentionDays: fc.constantFrom(0, 30),
});

type Row = { ageDays: number; pinned: boolean; status: string; project?: string; parent?: number };

function candidates(rows: Row[], now: number): ThreadArchiveCandidate[] {
  return rows.map((row, index) => ({
    thread: {
      id: `t${index}`, title: `Thread ${index}`, titleSource: "explicit", source: "codex",
      threadStatus: row.status as "idle" | "notLoaded" | "active",
      updatedAt: now - row.ageDays * 86_400_000 - 1,
      isPinned: row.pinned,
      projectKey: row.project,
      linkedDirectories: row.project ? [{ path: row.project, kind: "directory" } as never] : [],
    },
    overlay: row.parent !== undefined && row.parent !== index && row.parent < rows.length
      ? { parentThreadId: `t${row.parent}` } as never
      : undefined,
  }));
}

describe("ThreadArchiveSweeper never archives a thread", () => {
  it("leaves every thread active across hourly and manual sweeps", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(thread, { minLength: 1, maxLength: 30 }),
      legacyPolicy,
      fc.boolean(),
      async (rows, policy, manual) => {
        const now = Date.now();
        const list = candidates(rows, now);
        const archive = vi.fn(async () => true);
        const hibernate = vi.fn(async () => true as const);
        const deps = {
          getPolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, ...policy }),
          resolveProject: async (item: ThreadArchiveCandidate) => item.thread.projectKey,
          listCandidates: async () => list,
          refreshCandidate: async (item: ThreadArchiveCandidate) => item,
          isBusy: () => false,
          canArchive: async () => true,
          archive,
          workspaceIsSafe: async () => true,
          workspaceArchiveBlocker: async () => undefined,
          cleanupRetention: async () => 0,
          cleanupWorktrees: async () => {},
          hibernation: {
            getPolicy: () => ({ enabled: true, idleDays: 1, maxSnapshotMb: 100,
              removeRebuildableOutput: true, restoreOn: "send" as const }),
            keepReason: () => ({ target: "/tmp/pwragent-never-archives/checkout" }),
            inspectWorkspace: async () => undefined,
            hibernate,
          },
          onError: () => {},
        };
        const sweeper = new ThreadArchiveSweeper(deps as ConstructorParameters<typeof ThreadArchiveSweeper>[0]);
        await sweeper.sweep({ manual });
        const status = sweeper.getStatus() as { archived?: number; threads?: { archived: number } };
        await sweeper.stop();
        expect(archive).not.toHaveBeenCalled();
        expect(status.archived ?? 0).toBe(0);
        expect(status.threads?.archived ?? 0).toBe(0);
      },
    ), { numRuns: 200 });
  });

  it("fixes the regression: 21 idle threads in one project, defaults from before 1.3.14", async () => {
    const now = Date.now();
    const list = candidates(Array.from({ length: 21 }, () => ({
      ageDays: 8,
      pinned: false, status: "notLoaded", project: "~/src/harbor-web", parent: undefined,
    })), now);
    const archive = vi.fn(async () => true);
    const sweeper = new ThreadArchiveSweeper({
      getPolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, enabled: true }),
      listCandidates: async () => list,
      refreshCandidate: async (item: ThreadArchiveCandidate) => item,
      isBusy: () => false,
      canArchive: async () => true,
      archive,
      workspaceIsSafe: async () => true,
      onError: () => {},
    } as never);
    await sweeper.sweep();
    await sweeper.stop();
    expect(archive).not.toHaveBeenCalled();
  });
});
