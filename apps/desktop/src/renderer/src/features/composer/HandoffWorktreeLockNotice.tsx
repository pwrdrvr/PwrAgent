import { useEffect, useRef, useState } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { WorktreeLockedKept } from "@pwragent/shared/contracts/normalized-app-server";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";

export type HandoffWorktreeLock = {
  /** Someone else's Git lock on the worktree this handoff would archive. */
  lock?: WorktreeLockedKept;
  unlock: boolean;
  setUnlock: (unlock: boolean) => void;
};

/**
 * When a handoff dialog that would archive the source worktree opens, reads
 * that worktree's Git lock: one file read on the owner. Only someone else's
 * lock is reported; PwrAgent's own drive lock is cleared without asking.
 * Unlocking is off each time the dialog opens, so the default keeps the
 * worktree and the handoff never fails over the lock.
 */
export function useHandoffWorktreeLock(params: {
  desktopApi?: Pick<DesktopApi, "readThreadWorktreeLock">;
  thread?: Pick<NavigationThreadSummary, "id" | "source" | "federation">;
  /** The worktree the handoff would archive; undefined when it archives none. */
  worktreePath?: string;
}): HandoffWorktreeLock {
  const { thread, worktreePath } = params;
  const [lock, setLock] = useState<WorktreeLockedKept>();
  const [unlock, setUnlock] = useState(false);
  // A refreshed thread summary or API object must not re-read the lock and
  // clear the operator's choice: the read is keyed by identity values only.
  const readRef = useRef(params.desktopApi?.readThreadWorktreeLock);
  readRef.current = params.desktopApi?.readThreadWorktreeLock;
  const targetRef = useRef(thread?.federation?.ref.target);
  targetRef.current = thread?.federation?.ref.target;
  const threadId = thread?.id;
  const backend = thread?.source;
  const target = thread?.federation?.ref.target;
  const targetKey = target?.scope === "remote" ? `remote:${target.instanceId}` : target?.scope ?? "";
  useEffect(() => {
    setLock(undefined);
    setUnlock(false);
    const read = readRef.current;
    if (!worktreePath || !threadId || !backend || !read) return;
    let current = true;
    void read({
      backend, threadId, worktreePath, federationTarget: targetRef.current ?? readRendererFederationTarget(),
    }).then((response) => {
      if (current) setLock(response.lock);
    }, () => {
      // Without a reading the owner still keeps a locked worktree: the
      // handoff completes and the worktree stays on disk.
    });
    return () => { current = false; };
  }, [backend, targetKey, threadId, worktreePath]);
  return { lock, unlock, setUnlock };
}

/** The approval a handoff sends: the lock text the operator saw, only when they chose to unlock. */
export function handoffLockApproval(state: HandoffWorktreeLock): { approvedLockReason?: string } {
  return state.lock && state.unlock ? { approvedLockReason: state.lock.lockReason } : {};
}

export function HandoffWorktreeLockNotice(props: { state: HandoffWorktreeLock; disabled?: boolean }) {
  const { lock, unlock, setUnlock } = props.state;
  if (!lock) return null;
  return (
    <div className="workspace-handoff-dialog__lock" role="group" aria-label="Git has this worktree locked">
      <p className="workspace-handoff-dialog__lock-title">Git has this worktree locked</p>
      {lock.lockReason
        ? <p className="workspace-handoff-dialog__lock-reason">{lock.lockReason}</p>
        : <p className="workspace-handoff-dialog__lock-reason is-empty">No reason given</p>}
      <p className="workspace-handoff-dialog__lock-path">{lock.worktreePath}</p>
      <label className="workspace-handoff-dialog__lock-check">
        <input
          checked={unlock}
          className="settings-thread-management__checkbox-input"
          disabled={props.disabled}
          type="checkbox"
          onChange={(event) => setUnlock(event.currentTarget.checked)}
        />
        <span aria-hidden="true" className={`settings-thread-management__checkbox${unlock ? " is-checked" : ""}`} />
        <span>Unlock it and archive the worktree</span>
      </label>
      <p className="workspace-handoff-dialog__note">
        {unlock
          ? "The lock is removed only if it still says this when you click Handoff."
          : "Unchecked, the handoff completes and the worktree stays on disk, still locked."}
      </p>
    </div>
  );
}
