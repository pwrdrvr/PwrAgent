import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_THREAD_ARCHIVE_POLICY,
  type AppServerThreadSummary,
  type ThreadOverlayState,
  type WorktreeSnapshotSummary,
} from "@pwragent/shared";
import { sweepThreadArchiveRetention } from "../app-server/thread-archive-retention";

const day = 86_400_000;
afterEach(() => { vi.useRealTimers(); });

function harness() {
  vi.useFakeTimers();
  vi.setSystemTime(100 * day);
  const snapshot: WorktreeSnapshotSummary = {
    id: "snapshot", backend: "codex", threadId: "root", worktreePath: "/repo/worktree", repositoryPath: "/repo",
    snapshotRef: "refs/codex/snapshots/test", snapshotCommit: "abc", createdAt: day, state: "archived", ignoredFilesExcluded: true,
  };
  let threads: AppServerThreadSummary[] = [{
    id: "root", title: "Archived", titleSource: "explicit", source: "codex", threadStatus: "notLoaded",
    archivedAt: 69 * day, updatedAt: 60 * day, linkedDirectories: [],
  }];
  let states: ThreadOverlayState[] = [{
    backend: "codex", threadId: "root", executionMode: "default", extraLinkedDirectories: [],
    archiveRetentionStartedAt: 69 * day, worktreeSnapshots: [snapshot],
  }];
  const deps = {
    getPolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, retentionDays: 30 }),
    listThreads: vi.fn(async () => threads),
    listStates: vi.fn(async () => states),
    observeArchives: vi.fn(async (archived: AppServerThreadSummary[], now: number) => {
      for (const thread of archived) {
        let state = states.find((state) => state.threadId === thread.id);
        if (!state) { state = { backend: thread.source, threadId: thread.id, executionMode: "default", extraLinkedDirectories: [] }; states.push(state); }
        state.archiveRetentionStartedAt ??= now;
      }
    }),
    confirmAbsent: vi.fn(async (_state: ThreadOverlayState) => true),
    deleteFamily: vi.fn(async (family: Array<{ thread: AppServerThreadSummary }>) => {
      const ids = family.map(({ thread }) => thread.id);
      threads = threads.filter((thread) => !ids.includes(thread.id));
    }),
    deleteSnapshot: vi.fn(async (_snapshot: WorktreeSnapshotSummary) => {}),
    forgetStates: vi.fn(async (victims: ThreadOverlayState[]) => {
      const ids = victims.map((state) => state.threadId);
      states = states.filter((state) => !ids.includes(state.threadId));
    }),
    isBusy: vi.fn(() => false),
    onError: vi.fn(),
  };
  return { deps, snapshot, threads, states, getStates: () => states };
}

describe("archived thread retention", () => {
  it("deletes the provider conversation before discarding its snapshot and overlay", async () => {
    const { deps, snapshot } = harness();
    await sweepThreadArchiveRetention(deps);
    expect(deps.deleteFamily).toHaveBeenCalledTimes(1);
    expect(deps.deleteSnapshot).toHaveBeenCalledWith(snapshot);
    expect(deps.deleteFamily.mock.invocationCallOrder[0]).toBeLessThan(deps.deleteSnapshot.mock.invocationCallOrder[0]!);
    expect(deps.deleteSnapshot.mock.invocationCallOrder[0]).toBeLessThan(deps.forgetStates.mock.invocationCallOrder[0]!);
  });

  it("keeps snapshots when provider deletion fails", async () => {
    const { deps } = harness();
    deps.deleteFamily.mockRejectedValue(new Error("provider unavailable"));
    await sweepThreadArchiveRetention(deps);
    expect(deps.deleteSnapshot).not.toHaveBeenCalled();
    expect(deps.forgetStates).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith(expect.any(Error), "root");
  });

  it("retries failed snapshot cleanup after the provider thread is already gone", async () => {
    const { deps, getStates } = harness();
    deps.deleteSnapshot.mockRejectedValueOnce(new Error("repository unavailable"));
    await sweepThreadArchiveRetention(deps);
    expect(getStates()).toHaveLength(1);
    await sweepThreadArchiveRetention(deps);
    expect(deps.deleteFamily).toHaveBeenCalledTimes(1);
    expect(deps.deleteSnapshot).toHaveBeenCalledTimes(2);
    expect(getStates()).toHaveLength(0);
  });

  it("preserves a recovery ref shared with a retained active thread", async () => {
    const { deps, threads, states, snapshot } = harness();
    threads.push({ ...threads[0]!, id: "active", archivedAt: undefined });
    states.push({ ...states[0]!, threadId: "active", archiveRetentionStartedAt: undefined, worktreeSnapshots: [{ ...snapshot, threadId: "active" }] });
    await sweepThreadArchiveRetention(deps);
    expect(deps.deleteFamily).toHaveBeenCalledTimes(1);
    expect(deps.deleteSnapshot).not.toHaveBeenCalled();
    expect(deps.forgetStates.mock.calls[0]![0].map((state) => state.threadId)).toEqual(["root"]);
  });

  it.each(["active", "pinned", "Agent"])("protects a parent with a %s native descendant", async (protection) => {
    const { deps, threads, states } = harness();
    threads.push({ ...threads[0]!, id: "child", codexNativeSubAgent: { parentThreadId: "root" } as never,
      archivedAt: protection === "active" ? undefined : 69 * day, isPinned: protection === "pinned" });
    states.push({ ...states[0]!, threadId: "child", agent: protection === "Agent" ? {} as never : undefined });
    await sweepThreadArchiveRetention(deps);
    expect(deps.deleteFamily).not.toHaveBeenCalled();
    expect(deps.deleteSnapshot).not.toHaveBeenCalled();
  });

  it("starts a full retention period when an older archive is first discovered", async () => {
    const { deps, states } = harness();
    states[0]!.archiveRetentionStartedAt = undefined;
    await sweepThreadArchiveRetention(deps);
    expect(states[0]!.archiveRetentionStartedAt).toBe(Date.now());
    expect(deps.deleteFamily).not.toHaveBeenCalled();
  });

  it("cleans an expired missing thread even when its deletion notification was missed", async () => {
    const { deps, threads } = harness();
    threads.splice(0);
    await sweepThreadArchiveRetention(deps);
    expect(deps.deleteFamily).not.toHaveBeenCalled();
    expect(deps.deleteSnapshot).toHaveBeenCalledTimes(1);
    expect(deps.forgetStates).toHaveBeenCalledTimes(1);
  });

  it("retains a missing thread snapshot unless the provider confirms absence", async () => {
    const { deps, threads } = harness();
    threads.splice(0);
    deps.confirmAbsent.mockResolvedValue(false);
    await sweepThreadArchiveRetention(deps);
    expect(deps.deleteSnapshot).not.toHaveBeenCalled();
    deps.confirmAbsent.mockRejectedValue(new Error("offline"));
    await sweepThreadArchiveRetention(deps);
    expect(deps.deleteSnapshot).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalled();
  });

  it("makes no destructive changes when retention is disabled or discovery fails", async () => {
    const { deps } = harness();
    deps.getPolicy = () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY });
    await sweepThreadArchiveRetention(deps);
    expect(deps.deleteFamily).not.toHaveBeenCalled();
    expect(deps.deleteSnapshot).not.toHaveBeenCalled();
    deps.listThreads.mockRejectedValue(new Error("incomplete inventory"));
    await expect(sweepThreadArchiveRetention(deps)).rejects.toThrow("incomplete inventory");
    expect(deps.forgetStates).not.toHaveBeenCalled();
  });
});
