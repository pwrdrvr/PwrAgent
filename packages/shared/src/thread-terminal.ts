import type { AppServerThreadSummary } from "./contracts/normalized-app-server";

/**
 * The working directory a thread's integrated terminal should open in.
 *
 * One resolver for every surface that spawns a thread shell: the renderer's
 * local terminal panel and the federation owner answering a remote `pty.open`
 * both route through this, so a remote viewer's shell lands in exactly the
 * directory the owner's own panel would use. Worktree checkouts win over the
 * repository checkout, mirroring how thread-scoped commands prefer
 * `worktreePath`.
 */
export function resolveThreadTerminalCwd(
  thread: Pick<AppServerThreadSummary, "linkedDirectories" | "projectKey">,
): string | undefined {
  const directory =
    thread.linkedDirectories.find((candidate) => candidate.kind === "worktree") ??
    thread.linkedDirectories.find((candidate) => candidate.kind === "local") ??
    thread.linkedDirectories[0];

  return directory?.worktreePath ?? directory?.path ?? thread.projectKey;
}
