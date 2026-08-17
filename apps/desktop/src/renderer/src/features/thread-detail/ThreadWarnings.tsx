import {
  isBranchDrifted,
  type NavigationThreadSummary,
} from "@pwragent/shared";

/**
 * Thread-level warning banners, rendered at the top of the chat column.
 *
 * These deliberately do NOT live in `ThreadHeader`. The context rail is
 * absolutely positioned inside `.thread-view__layout`, which is the header's
 * NEXT sibling — so anything that changes the header's height moves the top
 * of the layout, and the rail's icon strip slides down with it. Both rows
 * here are independently conditional and one of them (branch drift) can
 * appear from a background poll, which made the rail jump while the operator
 * was reaching for it.
 *
 * Keeping them inside `.thread-view__primary` fixes that at the source: the
 * header's height is now fixed by `min-height` and its own single row, the
 * layout's top edge never moves, and the rail stays put. The warnings still
 * clear the rail because the layout already reserves its gutter.
 *
 * Do not move these back into `<header>`, and do not try to compensate with a
 * hard-coded rail offset — the header has two conditional rows plus a
 * wordmark that relocates here when the sidebar is hidden, so no constant is
 * correct. `thread-view.test.tsx` pins the placement.
 */
export function ThreadWarnings(props: { thread: NavigationThreadSummary }) {
  const unlinkedPath = unlinkedWorkspacePath(props.thread);
  const branchDrifted = isBranchDrifted(
    props.thread.gitBranch,
    props.thread.observedGitBranch,
  );

  if (!unlinkedPath && !branchDrifted) {
    return null;
  }

  return (
    <div className="thread-warnings">
      {unlinkedPath ? (
        // `role="status"` (polite), not `alert`: this reports an unresolved
        // link, not a failure, and it is derived state that re-announces on
        // every thread selection. Matches the branch-drift banner right
        // below, which shares this class and is the more urgent of the two.
        <p className="thread-warning" role="status">
          This thread's recorded working directory is not linked to a project:{" "}
          <code>{unlinkedPath}</code>
        </p>
      ) : null}
      {branchDrifted ? (
        <p className="thread-warning" role="status">
          Branch warning: this thread expects <code>{props.thread.gitBranch}</code>, but the
          worktree is on <code>{props.thread.observedGitBranch}</code>.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The thread records a working directory the backend reported, but nothing
 * resolved it to a linked project. Deliberately NOT an "it was deleted" test:
 * the renderer never stats a path, and an empty `linkedDirectories` has
 * several causes besides absence — a cwd that is not a git checkout, a git
 * probe that failed or timed out, or a backend that reports no cwd at all.
 * Absence is only one of them, so the copy this drives must stay limited to
 * what is actually known here. Do not reword it back into a claim about the
 * directory no longer existing without a real absence signal on the summary.
 */
function unlinkedWorkspacePath(thread: NavigationThreadSummary): string | undefined {
  const projectKey = thread.projectKey?.trim();
  if (!projectKey || thread.linkedDirectories.length > 0) {
    return undefined;
  }

  return projectKey;
}
