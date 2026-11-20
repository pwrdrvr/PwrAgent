import { act, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type {
  ArchiveThreadCleanupResult,
  RemoveLockedThreadWorktreeRequest,
  RemoveLockedThreadWorktreeResponse,
  RemoveLockedThreadWorktreesRequest,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import type { ArchiveThreadNotice } from "../archive-cleanup-notice";
import { collectLockedArchiveWorktrees, formatLockedWorktreeNotice } from "../locked-worktree-notice";
import { useLockedArchiveWorktreeNotice } from "../useLockedArchiveWorktreeNotice";

/*
 * Archive Thread never blocks on someone else's Git lock (D3): the thread is
 * archived and the notice names each kept worktree with Git's reason. Only
 * the operator's Unlock and Remove sends an approval, and that approval is
 * each lock reason exactly as the notice showed it (D4). Each owning
 * instance gets one request carrying exactly its own worktrees.
 */

/** Answers each worktree of a batch with `answer`, recording every batch. */
function batchApi(answer: (request: RemoveLockedThreadWorktreeRequest) => RemoveLockedThreadWorktreeResponse) {
  const batches: RemoveLockedThreadWorktreesRequest[] = [];
  const removeLockedThreadWorktrees = vi.fn(async (request: RemoveLockedThreadWorktreesRequest) => {
    batches.push(request);
    return { results: request.worktrees.map(answer) };
  });
  return { batches, removeLockedThreadWorktrees };
}

const lockedCleanup = fc.uniqueArray(
  fc.record({
    worktreePath: fc.stringMatching(/^\/contrived\/worktrees\/[a-z0-9]{1,8}$/),
    lockReason: fc.oneof(fc.constant(""), fc.string({ maxLength: 24 })),
  }),
  { minLength: 1, maxLength: 4, selector: (item) => item.worktreePath },
).map((items) => items.map(({ worktreePath, lockReason }): ArchiveThreadCleanupResult => ({
  worktreePath, removedWorktree: false, deletedBranch: false, worktreeState: "present", skippedReason: "Locked worktree",
  kept: { reason: "worktree-locked", worktreePath, lockReason },
})));

describe("locked worktree archive notice", () => {
  it("lists every kept worktree with its reason, and offers unlocking wherever the thread lives", () => {
    fc.assert(fc.property(lockedCleanup, fc.boolean(), (cleanup, remote) => {
      const items = collectLockedArchiveWorktrees(cleanup, {
        backend: "codex", threadId: "thread", threadTitle: "Fix flaky test",
        ...(remote ? { federationTarget: { scope: "remote", instanceId: "peer" } as const } : {}),
      });
      const notice = formatLockedWorktreeNotice(items, { onUnlockAndRemove: () => {}, onKeep: () => {} });
      expect(notice?.autoDismiss).toBe(false);
      for (const item of cleanup) {
        expect(notice?.facts?.some((fact) => fact.value.includes(item.worktreePath!)
          && fact.value.includes(item.kept!.lockReason))).toBe(true);
      }
      expect(notice?.actions?.map((action) => action.label)).toEqual(["Unlock and Remove", "Keep"]);
    }));
  });

  it("sends exactly the lock reasons it showed, and only when the operator chooses Unlock and Remove", async () => {
    await fc.assert(fc.asyncProperty(lockedCleanup, fc.boolean(), async (cleanup, choose) => {
      const { batches, removeLockedThreadWorktrees } = batchApi((request) => ({ status: "removed", worktreePath: request.worktreePath }));
      let notice: ArchiveThreadNotice | undefined;
      const { result, unmount } = renderHook(() => useLockedArchiveWorktreeNotice({
        desktopApi: { removeLockedThreadWorktrees }, setNotice: (next) => { notice = next; },
      }));
      act(() => { result.current.present(cleanup, {}, { backend: "codex", threadId: "thread", threadTitle: "Fix flaky test" }); });
      const shown = notice?.facts?.map((fact) => fact.value) ?? [];
      const action = notice?.actions?.find((candidate) => candidate.label === (choose ? "Unlock and Remove" : "Keep"));
      await act(async () => { action?.onClick(); });
      const requests = batches.flatMap((batch) => batch.worktrees);
      if (!choose) {
        expect(removeLockedThreadWorktrees).not.toHaveBeenCalled();
        expect(notice).toBeUndefined();
      } else {
        expect(requests.map(({ worktreePath, approvedLockReason }) => ({ worktreePath, approvedLockReason })))
          .toEqual(cleanup.map((item) => ({ worktreePath: item.worktreePath, approvedLockReason: item.kept!.lockReason })));
        for (const request of requests) expect(shown.some((value) => value.includes(request.worktreePath))).toBe(true);
        expect(batches).toHaveLength(1);
        expect(notice?.tone).toBe("success");
      }
      unmount();
    }), { numRuns: 40 });
  });

  it("sends each owning instance one request with exactly its own worktrees and their shown reasons", async () => {
    const ownerArb = fc.constantFrom<FederationTarget | undefined>(undefined,
      { scope: "remote", instanceId: "peer-a" }, { scope: "remote", instanceId: "peer-b" });
    const archivesArb = fc.array(fc.tuple(ownerArb, lockedCleanup), { minLength: 1, maxLength: 3 });
    await fc.assert(fc.asyncProperty(archivesArb, async (archives) => {
      const { batches, removeLockedThreadWorktrees } = batchApi((request) => ({ status: "removed", worktreePath: request.worktreePath }));
      let notice: ArchiveThreadNotice | undefined;
      const { result, unmount } = renderHook(() => useLockedArchiveWorktreeNotice({
        desktopApi: { removeLockedThreadWorktrees }, setNotice: (next) => { notice = next; },
      }));
      act(() => {
        archives.forEach(([federationTarget, cleanup], index) => result.current.present(cleanup, {},
          { backend: "codex", threadId: `thread-${index}`, ...(federationTarget ? { federationTarget } : {}) }));
      });
      await act(async () => { notice?.actions?.find((action) => action.label === "Unlock and Remove")?.onClick(); });
      const ownerKey = (target?: FederationTarget) => target?.scope === "remote" ? target.instanceId : "";
      // The last report of a worktree on an owner is the one the notice shows.
      const expected = new Map<string, Map<string, { threadId: string; approvedLockReason: string }>>();
      archives.forEach(([federationTarget, cleanup], index) => {
        const owner = expected.get(ownerKey(federationTarget)) ?? new Map();
        for (const item of cleanup) owner.set(item.worktreePath!, { threadId: `thread-${index}`, approvedLockReason: item.kept!.lockReason });
        expected.set(ownerKey(federationTarget), owner);
      });
      expect(batches.map((batch) => ownerKey(batch.federationTarget)).sort()).toEqual([...expected.keys()].sort());
      for (const batch of batches) {
        const owner = expected.get(ownerKey(batch.federationTarget))!;
        expect(new Map(batch.worktrees.map((item) => [item.worktreePath,
          { threadId: item.threadId, approvedLockReason: item.approvedLockReason }]))).toEqual(owner);
        expect(batch.worktrees).toHaveLength(owner.size);
      }
      unmount();
    }), { numRuns: 40 });
  });

  it("keeps the worktree and names the update when an older owner cannot unlock", async () => {
    const [cleanup] = fc.sample(lockedCleanup, { numRuns: 1, seed: 2 });
    let notice: ArchiveThreadNotice | undefined;
    const removeLockedThreadWorktrees = vi.fn(async () => {
      throw new Error("Update PwrAgent on the owning instance to unlock and remove this worktree.");
    });
    const { result } = renderHook(() => useLockedArchiveWorktreeNotice({
      desktopApi: { removeLockedThreadWorktrees }, setNotice: (next) => { notice = next; },
    }));
    act(() => {
      result.current.present(cleanup!, {}, { backend: "codex", threadId: "thread",
        federationTarget: { scope: "remote", instanceId: "older-peer" } });
    });
    await act(async () => { notice?.actions?.[0]?.onClick(); });
    expect(notice?.tone).toBe("error");
    expect(notice?.facts?.every((fact) => fact.value.includes("Update PwrAgent on the owning instance"))).toBe(true);
  });

  it("keeps collected locked worktrees when a later thread's cleanup fails for another reason", () => {
    const [locked] = fc.sample(lockedCleanup, { numRuns: 1, seed: 1 });
    let notice: ArchiveThreadNotice | undefined;
    const { result } = renderHook(() => useLockedArchiveWorktreeNotice({ setNotice: (next) => { notice = next; } }));
    act(() => { result.current.present(locked!, {}, { backend: "codex", threadId: "a" }); });
    act(() => {
      result.current.present([{ worktreePath: "/contrived/worktrees/other", removedWorktree: false, deletedBranch: false,
        error: "Snapshot failed" }], {}, { backend: "codex", threadId: "b" });
    });
    expect(notice?.actions?.map((action) => action.label)).toEqual(["Unlock and Remove", "Keep"]);
    for (const item of locked!) expect(notice?.facts?.some((fact) => fact.value.includes(item.worktreePath!))).toBe(true);
    expect(notice?.facts?.some((fact) => fact.value.includes("Snapshot failed"))).toBe(true);
  });

  it("asks again with the new reason when the lock changed before removal", async () => {
    const cleanup: ArchiveThreadCleanupResult[] = [{
      worktreePath: "/contrived/worktrees/orbit", removedWorktree: false, deletedBranch: false,
      kept: { reason: "worktree-locked", worktreePath: "/contrived/worktrees/orbit", lockReason: "release prep, do not remove" },
    }];
    const { batches, removeLockedThreadWorktrees } = batchApi((request) => ({
      status: "kept", worktreePath: request.worktreePath, reason: "Locked worktree",
      kept: { reason: "worktree-locked", worktreePath: request.worktreePath, lockReason: "hotfix in progress" },
    }));
    let notice: ArchiveThreadNotice | undefined;
    const { result } = renderHook(() => useLockedArchiveWorktreeNotice({
      desktopApi: { removeLockedThreadWorktrees }, setNotice: (next) => { notice = next; },
    }));
    act(() => { result.current.present(cleanup, {}, { backend: "codex", threadId: "thread" }); });
    await act(async () => { notice?.actions?.[0]?.onClick(); });
    expect(notice?.message).toContain("The lock changed");
    expect(notice?.facts?.[0]?.value).toContain("hotfix in progress");
    await act(async () => { notice?.actions?.[0]?.onClick(); });
    expect(batches.at(-1)?.worktrees).toEqual([expect.objectContaining({ approvedLockReason: "hotfix in progress" })]);
  });
});
