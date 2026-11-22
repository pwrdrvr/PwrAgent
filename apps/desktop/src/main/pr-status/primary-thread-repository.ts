import { isWorkspaceHandoffDirectory } from "@pwragent/shared/navigation-state";
import { type AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { type NavigationSnapshot } from "@pwragent/shared/contracts/navigation";
import { parseForgeRemote, readObservedGitOrigin, resolveGitHubRepoForDirectory } from "./git-remote";
import { buildPrRepositoryKey } from "./pr-auto-dispatch";
import type { PrMetadataDemand } from "./pr-metadata-process";

type ThreadWorkspace = Pick<NavigationSnapshot["threads"][number], "gitOriginUrl" | "linkedDirectories">;

function primaryCheckout(thread: ThreadWorkspace) {
  const handoff = thread.linkedDirectories.findLast(isWorkspaceHandoffDirectory);
  const directory = handoff ?? thread.linkedDirectories[0];
  return {
    path: directory && resolvePullRequestDirectoryPath(directory),
    origin: handoff ? undefined : thread.gitOriginUrl,
  };
}

export function primaryCheckoutKey(thread: ThreadWorkspace): string {
  const checkout = primaryCheckout(thread);
  return JSON.stringify([checkout.path, checkout.origin]);
}

/** Evidence for status polling. Checkout-dependent actions resolve the workspace themselves. */
export function readStoredPrimaryThreadRepository(thread: ThreadWorkspace): {
  key?: string;
  canProbe: boolean;
} {
  const { path, origin } = primaryCheckout(thread);
  const observation = path ? readObservedGitOrigin(path) : undefined;
  const repo = observation?.conclusive ? observation.repo : origin ? parseForgeRemote(origin) : undefined;
  return {
    key: repo && buildPrRepositoryKey(repo.host, repo.owner, repo.repo),
    canProbe: Boolean(path && !observation?.conclusive && (observation?.retryAt ?? 0) <= Date.now()),
  };
}

export async function resolvePrimaryThreadRepoKey(
  thread: ThreadWorkspace,
  resolutionByPath = new Map<string, Promise<string | undefined>>(),
  demand?: PrMetadataDemand,
  fresh = false,
): Promise<string | undefined> {
  demand?.signal?.throwIfAborted();
  // The owning checkout's current origin wins over session-start metadata:
  // a remote can change after a rename, fork, or workspace move. Resolve on
  // the owner so another machine's path never supplies repository identity.
  const { path: primaryPath, origin: originUrl } = primaryCheckout(thread);
  if (primaryPath) {
    let resolution = resolutionByPath.get(primaryPath);
    if (!resolution) {
      resolution = (demand || fresh
        ? resolveGitHubRepoForDirectory(primaryPath, { demand, ...(fresh ? { fresh } : {}) })
        : resolveGitHubRepoForDirectory(primaryPath))
        .then((resolved) => resolved
          ? buildPrRepositoryKey(resolved.host, resolved.owner, resolved.repo)
          : undefined);
      resolutionByPath.set(primaryPath, resolution);
    }
    const repositoryKey = await resolution;
    if (repositoryKey) return repositoryKey;
    if (readObservedGitOrigin(primaryPath)?.conclusive) return undefined;
  }

  // A missing checkout can still use the provider's snapshot, except after
  // a workspace handoff: that snapshot may describe a different project.
  const origin = originUrl ? parseForgeRemote(originUrl) : undefined;
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
