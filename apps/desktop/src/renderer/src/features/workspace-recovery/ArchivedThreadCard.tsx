import { useId, useState } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { WorktreeSnapshotSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { ArchiveIcon } from "../../icons";
import { formatAge } from "../maintenance/thread-maintenance-selection";

export type ArchivedThreadCardProps = {
  thread: NavigationThreadSummary;
  /** The machine that owns the thread, when it is not this one. */
  ownerLabel?: string;
  /** Absent when this window cannot restore the thread (a peer owns it). */
  onRestore?: () => Promise<void>;
};

type CardState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "error"; message: string };

/** The worktrees a restore brings back, newest archive first. */
export function archivedWorktreeSnapshots(thread: Pick<NavigationThreadSummary, "worktreeSnapshots">): WorktreeSnapshotSummary[] {
  return (thread.worktreeSnapshots ?? [])
    .filter((snapshot) => snapshot.state === "archived" || snapshot.state === "hibernated")
    .sort((left, right) => (right.archivedAt ?? right.createdAt) - (left.archivedAt ?? left.createdAt));
}

/** When the thread was archived: its own stamp, else its newest worktree archive. */
function archivedAt(thread: NavigationThreadSummary, snapshots: readonly WorktreeSnapshotSummary[]): number | undefined {
  return thread.archivedAt ?? snapshots.find((snapshot) => snapshot.archivedAt !== undefined)?.archivedAt;
}

/**
 * Takes the composer's place while the open thread is archived. Archiving is
 * the operator's choice, so a message never undoes it: Restore thread is the
 * only way back, the same rule agents meet when they message an archived
 * thread. Same family as the hibernated-checkout card, which instead lets
 * the next message restore its checkout.
 */
export function ArchivedThreadCard(props: ArchivedThreadCardProps) {
  const headingId = useId();
  const [now] = useState(() => Date.now());
  const [state, setState] = useState<CardState>({ phase: "idle" });
  const snapshots = archivedWorktreeSnapshots(props.thread);
  const latest = snapshots[0];
  const at = archivedAt(props.thread, snapshots);
  const running = state.phase === "running";
  const owner = props.ownerLabel ? `On ${props.ownerLabel}` : undefined;

  const restore = async () => {
    if (!props.onRestore) return;
    setState({ phase: "running" });
    try {
      // Success leaves the card running: it goes away when the owner reports
      // the thread unarchived and the composer takes its place.
      await props.onRestore();
    } catch (error) {
      setState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const extra = snapshots.length > 1
    ? `+${snapshots.length - 1} more ${snapshots.length === 2 ? "worktree" : "worktrees"}`
    : undefined;
  const meta = latest ? [latest.sourceBranch, "recovery snapshot saved", extra].filter(Boolean).join(" · ") : undefined;

  return (
    <section
      aria-busy={running}
      aria-labelledby={headingId}
      className={`missing-worktree-card missing-worktree-card--archived${running ? " missing-worktree-card--busy" : ""}`}
    >
      <h2 id={headingId} className="missing-worktree-card__heading">
        <ArchiveIcon size={15} aria-hidden="true" />
        {running ? "Restoring thread" : "Thread archived"}
        <span className="missing-worktree-card__owner">
          {[owner, running || at === undefined ? undefined : formatAge(at, now)].filter(Boolean).join(" · ")}
        </span>
      </h2>
      {latest ? <p className="missing-worktree-card__path">{latest.worktreePath}</p> : null}
      {meta && !running ? <p className="missing-worktree-card__meta">{meta}</p> : null}
      <p className="missing-worktree-card__lede">
        {running
          ? latest
            ? "Returning it to your thread lists, and recreating its worktree from the recovery snapshot."
            : "Returning it to your thread lists."
          : !props.onRestore
            ? `Restore it on ${props.ownerLabel ?? "the machine that owns it"} to reply. This window can't restore another machine's thread.`
            : latest
              ? "Restore it to reply. It returns to your thread lists, and Git recreates its worktree from the recovery snapshot."
              : "Restore it to reply. It returns to your thread lists."}
      </p>
      {state.phase === "error" ? (
        <p className="missing-worktree-card__error" role="alert">{state.message}</p>
      ) : null}
      {props.onRestore && !running ? (
        <div className="missing-worktree-card__actions">
          <button className="button button--primary" type="button" onClick={() => void restore()}>
            {state.phase === "error" ? "Try again" : "Restore thread"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
