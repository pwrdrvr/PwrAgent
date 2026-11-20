import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type {
  RemoveLockedThreadWorktreeRequest,
  RemoveLockedThreadWorktreeResponse,
  RemoveLockedThreadWorktreesRequest,
} from "@pwragent/shared/contracts/normalized-app-server";
import type {
  ThreadMaintenanceRun,
  ThreadMaintenanceRunItem,
} from "@pwragent/shared/thread-maintenance";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ThreadMaintenanceDialog } from "../ThreadMaintenanceDialog";
import { itemAfterUnlockAndRemove, offersUnlockAndRemove } from "../thread-maintenance-run-items";

/*
 * Rule (locked-worktree design D2/D4): a maintenance run row offers Unlock
 * and Remove only for an archived checkout that someone else's Git lock
 * kept: one the operator chose to remove, or one the archive step kept when
 * it archived its thread. Hibernation never unlocks, so its "Locked
 * worktree" rows never offer it. The approval sent is exactly the lock text
 * the row shows.
 */

afterEach(() => {
  cleanup();
});

const NOW = new Date(2026, 10, 20, 10, 42).getTime();

const lockedRemoval: ThreadMaintenanceRunItem = {
  itemId: "remove:0", step: "checkouts", action: "removeCheckout", object: "/w/mwokr2/orbit", path: "/w/mwokr2/orbit",
  backend: "codex", threadId: "t-orbit", status: "kept", reason: "Locked worktree",
  lockReason: "release prep, do not remove", startedAt: NOW, finishedAt: NOW + 500, finishedOrder: 2,
};
const lockedArchiveWorktree: ThreadMaintenanceRunItem = {
  itemId: "threads:0:locked:0", step: "threads", action: "removeCheckout", object: "/w/mwokr4/orbit", path: "/w/mwokr4/orbit",
  backend: "codex", threadId: "t-archived", status: "kept", reason: "Locked worktree",
  lockReason: "pairing session", startedAt: NOW, finishedAt: NOW + 600, finishedOrder: 3,
};
const lockedHibernation: ThreadMaintenanceRunItem = {
  itemId: "hibernate:0", step: "hibernate", action: "hibernate", object: "Fix flaky test", path: "/w/mwokr3/orbit",
  backend: "codex", threadId: "t-flaky", status: "kept", reason: "Locked worktree",
  lockReason: "release prep, do not remove", startedAt: NOW, finishedAt: NOW + 400, finishedOrder: 1,
};

function finishedRun(items: ThreadMaintenanceRunItem[]): ThreadMaintenanceRun {
  return { runId: "run-1", revision: 2, scanId: "scan-1", running: false, startedAt: NOW, finishedAt: NOW + 1000,
    steps: [], problems: [], items };
}

async function showFinished(items: ThreadMaintenanceRunItem[],
  removeLockedThreadWorktree: (request: RemoveLockedThreadWorktreeRequest) => Promise<RemoveLockedThreadWorktreeResponse>) {
  const listeners = new Set<(next: ThreadMaintenanceRun) => void>();
  const desktopApi = {
    getThreadMaintenanceRun: vi.fn(async () => ({ ...finishedRun(items), running: true, revision: 1 })),
    stopThreadMaintenance: vi.fn(async () => {}),
    removeLockedThreadWorktrees: vi.fn(async (request: RemoveLockedThreadWorktreesRequest) => ({
      results: await Promise.all(request.worktrees.map(removeLockedThreadWorktree)),
    })),
    onThreadMaintenanceRunChanged: vi.fn((listener: (next: ThreadMaintenanceRun) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }),
  } as unknown as DesktopApi;
  render(<ThreadMaintenanceDialog desktopApi={desktopApi} onClose={vi.fn()} onMinimize={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
  await within(dialog).findByText("/w/mwokr2/orbit");
  act(() => { for (const listener of listeners) listener(finishedRun(items)); });
  await within(dialog).findByText("Maintenance finished");
  return { dialog, desktopApi };
}

describe("Unlock and Remove in a maintenance run", () => {
  it("is offered on a kept checkout removal or archived worktree with a lock reason, never on a hibernation row", async () => {
    const { dialog } = await showFinished([lockedHibernation, lockedRemoval, lockedArchiveWorktree], async (request) => ({
      status: "removed", worktreePath: request.worktreePath,
    }));
    const kept = within(dialog).getByRole("region", { name: "Kept · 3" });
    const rows = within(kept).getAllByRole("listitem");
    const hibernation = rows.find((row) => row.textContent?.includes("Fix flaky test"))!;
    const removal = rows.find((row) => row.textContent?.includes("/w/mwokr2/orbit"))!;
    const archived = rows.find((row) => row.textContent?.includes("/w/mwokr4/orbit"))!;
    expect(removal).toHaveTextContent("Git has it locked: release prep, do not remove");
    expect(within(removal).getByRole("button", { name: "Unlock and remove /w/mwokr2/orbit" })).toBeEnabled();
    expect(archived).toHaveTextContent("Git has it locked: pairing session");
    expect(within(archived).getByRole("button", { name: "Unlock and remove /w/mwokr4/orbit" })).toBeEnabled();
    expect(within(hibernation).queryByRole("button", { name: /Unlock and remove/i })).toBeNull();
  });

  it("sends exactly the shown lock text and moves a removed row to Done", async () => {
    let answer: (response: RemoveLockedThreadWorktreeResponse) => void = () => {};
    const { dialog, desktopApi } = await showFinished([lockedRemoval],
      async () => await new Promise<RemoveLockedThreadWorktreeResponse>((resolve) => { answer = resolve; }));
    const button = within(dialog).getByRole("button", { name: "Unlock and remove /w/mwokr2/orbit" });
    fireEvent.click(button);
    expect(desktopApi.removeLockedThreadWorktrees).toHaveBeenCalledWith({ worktrees: [{
      backend: "codex", threadId: "t-orbit", worktreePath: "/w/mwokr2/orbit", approvedLockReason: "release prep, do not remove",
    }] });
    expect(button).toBeDisabled();
    await act(async () => { answer({ status: "removed", worktreePath: "/w/mwokr2/orbit" }); });
    await waitFor(() => expect(within(dialog).getByRole("region", { name: "Done · 1" })).toHaveTextContent("/w/mwokr2/orbit"));
    expect(within(dialog).queryByRole("button", { name: /Unlock and remove/i })).toBeNull();
  });

  it("shows a changed lock and asks again for its new text", async () => {
    const { dialog, desktopApi } = await showFinished([lockedRemoval], async () => ({
      status: "kept", worktreePath: "/w/mwokr2/orbit", reason: "Locked worktree",
      kept: { reason: "worktree-locked", worktreePath: "/w/mwokr2/orbit", lockReason: "hotfix in progress" },
    }));
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Unlock and remove /w/mwokr2/orbit" })); });
    await within(dialog).findByText("hotfix in progress");
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Unlock and remove /w/mwokr2/orbit" })); });
    expect(desktopApi.removeLockedThreadWorktrees).toHaveBeenLastCalledWith({ worktrees: [
      expect.objectContaining({ approvedLockReason: "hotfix in progress" })] });
  });
});

const itemArb: fc.Arbitrary<ThreadMaintenanceRunItem> = fc.record({
  itemId: fc.string({ minLength: 1 }),
  step: fc.constantFrom("threads", "hibernate", "checkouts", "expired"),
  action: fc.constantFrom("archive", "hibernate", "removeCheckout", "trashCheckout", "removeBuildOutput", "removeEmptyFolders"),
  object: fc.string(),
  path: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  backend: fc.option(fc.constantFrom("codex", "claude"), { nil: undefined }),
  threadId: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  status: fc.constantFrom("queued", "running", "done", "kept", "failed"),
  reason: fc.option(fc.string(), { nil: undefined }),
  lockReason: fc.option(fc.string(), { nil: undefined }),
}, { requiredKeys: ["itemId", "step", "action", "object", "status"] }) as fc.Arbitrary<ThreadMaintenanceRunItem>;

describe("which rows offer Unlock and Remove", () => {
  it("only a kept checkout removal or archived worktree that a lock holds and that names its thread and path", () => {
    fc.assert(fc.property(itemArb, (item) => {
      expect(offersUnlockAndRemove(item)).toBe((item.step === "checkouts" || item.step === "threads")
        && item.action === "removeCheckout"
        && item.status === "kept" && item.lockReason !== undefined
        && Boolean(item.backend) && Boolean(item.threadId) && Boolean(item.path));
      if (item.step === "hibernate" || item.action === "hibernate") expect(offersUnlockAndRemove(item)).toBe(false);
    }), { examples: [[lockedRemoval], [lockedArchiveWorktree], [lockedHibernation]] });
  });

  it("a row offers it again after an answer only when the lock is still there, with its new text", () => {
    const outcomeArb = fc.oneof(
      fc.constant<RemoveLockedThreadWorktreeResponse>({ status: "removed", worktreePath: "/w" }),
      fc.string().map((message): RemoveLockedThreadWorktreeResponse => ({ status: "failed", worktreePath: "/w", message })),
      fc.option(fc.string(), { nil: undefined }).map((lockReason): RemoveLockedThreadWorktreeResponse => ({
        status: "kept", worktreePath: "/w", reason: "Locked worktree",
        ...(lockReason !== undefined ? { kept: { reason: "worktree-locked" as const, worktreePath: "/w", lockReason } } : {}),
      })),
      fc.string().map((message) => ({ status: "error" as const, message })),
    );
    fc.assert(fc.property(outcomeArb, fc.nat(), (outcome, order) => {
      const after = itemAfterUnlockAndRemove(lockedRemoval, outcome, order, NOW);
      const lock = outcome.status === "kept" ? outcome.kept?.lockReason : undefined;
      expect(after.lockReason).toBe(lock);
      expect(offersUnlockAndRemove(after)).toBe(lock !== undefined);
      expect(after.finishedOrder).toBe(order);
      expect(after.status).toBe(outcome.status === "removed" ? "done" : outcome.status === "kept" ? "kept" : "failed");
    }));
  });
});
