import { isWorkspaceHandoffDirectory } from "@pwragent/shared/navigation-state";
import { type AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { type NavigationSnapshot } from "@pwragent/shared/contracts/navigation";
import { parseForgeRemote, resolveGitHubRepoForDirectory } from "./git-remote";
import { buildPrRepositoryKey } from "./pr-auto-dispatch";
import type { PrMetadataDemand } from "./pr-metadata-process";

export async function resolvePrimaryThreadRepoKey(
  thread: Pick<
    NavigationSnapshot["threads"][number],
    "gitOriginUrl" | "linkedDirectories"
  >,
  resolutionByPath = new Map<string, Promise<string | undefined>>(),
  demand?: PrMetadataDemand,
): Promise<string | undefined> {
  demand?.signal?.throwIfAborted();
  // The owning checkout's current origin wins over session-start metadata:
  // a remote can change after a rename, fork, or workspace move. Resolve on
  // the owner so another machine's path never supplies repository identity.
  const movedWorkspace = thread.linkedDirectories.findLast(
    isWorkspaceHandoffDirectory,
  );
  const primaryDirectory = movedWorkspace ?? thread.linkedDirectories[0];
  const primaryPath = primaryDirectory
    ? resolvePullRequestDirectoryPath(primaryDirectory)
    : undefined;
  if (primaryPath) {
    let resolution = resolutionByPath.get(primaryPath);
    if (!resolution) {
      resolution = (demand ? resolveGitHubRepoForDirectory(primaryPath, { demand }) : resolveGitHubRepoForDirectory(primaryPath))
        .then((resolved) => resolved
          ? buildPrRepositoryKey(resolved.host, resolved.owner, resolved.repo)
          : undefined);
      resolutionByPath.set(primaryPath, resolution);
    }
    const repositoryKey = await resolution;
    if (repositoryKey) return repositoryKey;
  }

  // A missing checkout can still use the provider's snapshot, except after
  // a workspace handoff: that snapshot may describe a different project.
  const origin = !movedWorkspace && thread.gitOriginUrl
    ? parseForgeRemote(thread.gitOriginUrl)
    : undefined;
  return origin ? buildPrRepositoryKey(origin.host, origin.owner, origin.repo) : undefined;
}

export function resolvePullRequestDirectoryPath(
  directory: AppServerThreadSummary["linkedDirectories"][number],
): string | undefined {
  const candidate =
    directory.kind === "worktree"
      ? directory.worktreePath ?? directory.path
      : directory.path;
  return candidate?.trim() || undefined;
}
