import { useCallback, useRef } from "react";
import type { AppServerBackendKind, ArchiveThreadCleanupResult, FederationTarget } from "@pwragent/shared";
import { formatArchiveCleanupNotice, type ArchiveThreadNotice } from "./archive-cleanup-notice";
import type { DesktopApi } from "./desktop-api";
import {
  collectLockedArchiveWorktrees,
  formatLockedWorktreeNotice,
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
  desktopApi?: Pick<DesktopApi, "removeLockedThreadWorktree">;
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
    const chosen = lockedRef.current.filter((item) => item.unlockable);
    lockedRef.current = lockedRef.current.filter((item) => !item.unlockable);
    if (chosen.length === 0) return;
    setNotice({
      id: `locked-worktrees-removing\n${chosen.map((item) => item.kept.worktreePath).join("\n")}`,
      title: chosen.length === 1 ? "Removing the locked worktree" : "Removing the locked worktrees",
      message: "Unlocking, saving a checkpoint of the changes, and removing.",
      autoDismiss: false,
      status: { label: "In progress", state: "progress" },
    });
    const responses = [];
    for (const item of chosen) {
      try {
        if (!desktopApi?.removeLockedThreadWorktree) throw new Error("Update PwrAgent to remove a locked worktree.");
        responses.push(await desktopApi.removeLockedThreadWorktree({
          backend: item.backend,
          threadId: item.threadId,
          worktreePath: item.kept.worktreePath,
          approvedLockReason: item.kept.lockReason,
        }));
      } catch (error) {
        responses.push({ status: "failed" as const, worktreePath: item.kept.worktreePath,
          message: error instanceof Error ? error.message : String(error) });
      }
    }
    const outcome = lockedWorktreeRemovalOutcome(chosen, responses);
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
      if (failed) setNotice(failed);
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
