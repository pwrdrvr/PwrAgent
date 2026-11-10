import type { BackgroundCleanupOutcome, BackgroundCleanupThread } from "../../lib/background-archive-cleanup-types";
import { useThreadLinks, type ResolvedThreadLink } from "../../lib/thread-links";
import { ThreadChip } from "../thread-detail/ThreadChip";

function CleanupThread({ thread }: { thread: BackgroundCleanupThread }) {
  const links = useThreadLinks();
  const resolved = thread.ref.backend ? links?.resolve(thread.ref) : undefined;
  const backend = thread.ref.backend ?? resolved?.backend;
  const resolvedTitle = resolved?.title?.trim();
  const title = (resolvedTitle && resolvedTitle !== thread.ref.threadId ? resolvedTitle : undefined) || thread.title || "Unknown thread";
  if (!backend) return <span className="chip background-cleanup__unknown">Unknown thread</span>;
  const link: ResolvedThreadLink = {
    ...thread.ref, backend, title,
    titleSource: title === "Unknown thread" ? "fallback" : "explicit",
  };
  return <ThreadChip link={link} fallbackLabel={title} onOpen={(target) => links?.show(target)} />;
}

/** The compact view and Copy are projections of the same retained outcomes. */
export function BackgroundArchiveCleanupDetails({ outcomes }: { outcomes: readonly BackgroundCleanupOutcome[] }) {
  return <div className="background-cleanup">
    {(["failed", "kept"] as const).map((kind) => {
      const group = outcomes.filter((outcome) => outcome.kind === kind);
      if (!group.length) return null;
      return <section key={kind} aria-label={kind === "failed" ? "Failed cleanup" : "Kept worktrees"}>
        <p className="background-cleanup__heading">{kind === "failed" ? "Failed" : "Kept"}</p>
        {group.map((outcome, index) => <div className="background-cleanup__outcome" data-kind={kind} key={index}>
          <p className="background-cleanup__reason">{outcome.blockerCount && /^Worktree is still used by /.test(outcome.reason)
            ? "Worktree is still used by active threads." : outcome.reason}</p>
          <p className="background-cleanup__path">{outcome.worktreePath ?? "Worktree path unavailable"}</p>
          <div className="background-cleanup__threads">
            <span>Thread</span><CleanupThread thread={outcome.source} />
          </div>
          {outcome.blockers.length ? <div className="background-cleanup__threads">
            <span>Used by</span>
            {outcome.blockers.slice(0, 3).map((thread, blockerIndex) => <CleanupThread thread={thread} key={blockerIndex} />)}
          </div> : null}
          {outcome.blockerCount > 3 ? <p className="background-cleanup__more">
            {outcome.blockerCount - 3} more blocking threads not shown. Copy includes {outcome.blockers.length} retained references.
          </p> : null}
          {outcome.textTruncated || outcome.blockerCount > outcome.blockers.length ? <p className="background-cleanup__more">
            Some outcome details were truncated at the storage limit; Copy states what was omitted.
          </p> : null}
        </div>)}
      </section>;
    })}
  </div>;
}
