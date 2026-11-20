import { useCallback, useRef } from "react";
import type { AppServerBackendKind, ArchiveThreadCleanupResult } from "@pwragent/shared/contracts/normalized-app-server";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import { formatArchiveCleanupNotice, type ArchiveThreadNotice } from "./archive-cleanup-notice";
import type { DesktopApi } from "./desktop-api";
import {
  collectLockedArchiveWorktrees,
  formatLockedWorktreeNotice,
  groupLockedWorktreesByOwner,
  lockedWorktreeRemovalOutcome,
  mergeLockedArchiveWorktrees,
  type LockedArchiveWorktree,
} from "./locked-worktree-notice";
import type { ThreadActionErrorContext } from "./thread-action-error-context";

/**
 * Archive Thread's cleanup notice, with the worktrees Git kept because
 * someone else locked them collected across one archive action (several
 * selected threads, sub-threads) into one notice with one Unlock and Remove.
 * Only the operator's click unlocks; the approval is each lock reason
 * exactly as the notice showed it.
 */
export function useLockedArchiveWorktreeNotice(params: {
  desktopApi?: Pick<DesktopApi, "removeLockedThreadWorktrees">;
  setNotice: (notice: ArchiveThreadNotice | undefined) => void;
}) {
  const { desktopApi, setNotice } = params;
  const lockedRef = useRef<LockedArchiveWorktree[]>([]);
  const showRef = useRef<(failed?: ArchiveThreadNotice) => void>(() => {});

  const keep = useCallback((): void => {
    lockedRef.current = [];
    setNotice(undefined);
  }, [setNotice]);

  const unlockAndRemove = useCallback(async (): Promise<void> => {
    const chosen = lockedRef.current;
    lockedRef.current = [];
    if (chosen.length === 0) return;
    setNotice({
      id: `locked-worktrees-removing\n${chosen.map((item) => item.kept.worktreePath).join("\n")}`,
      title: chosen.length === 1 ? "Removing the locked worktree" : "Removing the locked worktrees",
      message: "Unlocking, saving a checkpoint of the changes, and removing.",
      autoDismiss: false,
      status: { label: "In progress", state: "progress" },
    });
    // One call per owning instance; each owner checks and removes its own.
    const groups = groupLockedWorktreesByOwner(chosen);
    const answered = await Promise.all(groups.map(async (group) => {
      try {
        if (!desktopApi?.removeLockedThreadWorktrees) throw new Error("Update PwrAgent to remove a locked worktree.");
        const { results } = await desktopApi.removeLockedThreadWorktrees({
          ...(group.federationTarget ? { federationTarget: group.federationTarget } : {}),
          worktrees: group.items.map((item) => ({
            backend: item.backend,
            threadId: item.threadId,
            worktreePath: item.kept.worktreePath,
            approvedLockReason: item.kept.lockReason,
          })),
        });
        return group.items.map((item, index) => results[index]
          ?? { status: "failed" as const, worktreePath: item.kept.worktreePath, message: "The owner sent no result." });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return group.items.map((item) => ({ status: "failed" as const, worktreePath: item.kept.worktreePath, message }));
      }
    }));
    const outcome = lockedWorktreeRemovalOutcome(groups.flatMap((group) => group.items), answered.flat());
    lockedRef.current = mergeLockedArchiveWorktrees(lockedRef.current, outcome.relocked);
    if (lockedRef.current.length) showRef.current(outcome.notice);
    else setNotice(outcome.notice);
  }, [desktopApi, setNotice]);

  showRef.current = (failed?: ArchiveThreadNotice): void => {
    setNotice(formatLockedWorktreeNotice(lockedRef.current, {
      onUnlockAndRemove: () => { void unlockAndRemove(); },
      onKeep: keep,
    }, failed));
  };

  /** Report one archive's cleanup. Returns whether a notice was raised. */
  const present = useCallback((
    cleanup: ArchiveThreadCleanupResult[],
    context: ThreadActionErrorContext,
    owner: { backend: AppServerBackendKind; threadId: string; threadTitle?: string; federationTarget?: FederationTarget },
  ): boolean => {
    const failed = formatArchiveCleanupNotice(cleanup, context, { excludeLocked: true });
    const added = collectLockedArchiveWorktrees(cleanup, owner);
    if (added.length === 0) {
      // Keep worktrees collected earlier in this action, and their action.
      if (failed && lockedRef.current.length) showRef.current(failed);
      else if (failed) setNotice(failed);
      return Boolean(failed);
    }
    lockedRef.current = mergeLockedArchiveWorktrees(lockedRef.current, added);
    showRef.current(failed);
    return true;
  }, [setNotice]);

  /** A new archive action, or a dismissed notice, starts a fresh list. */
  const reset = useCallback((): void => {
    lockedRef.current = [];
  }, []);

  return { present, reset };
}
