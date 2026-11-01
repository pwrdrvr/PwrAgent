import type { GitHubRepoRef } from "./git-remote";

/**
 * What the forge last called each remote's repository.
 *
 * GitHub redirects a renamed repository's old owner/name and always answers
 * with the new one, PRs included. A checkout whose remote still spells the old
 * name then gets its own PRs back under a name no remote matches. The forge
 * says what the name is now on the same `repository(owner, name)` selection
 * every PR lookup already makes, so learning it costs no request.
 *
 * In memory only. A restart relearns each name on its first lookup, and every
 * later answer replaces the last one, so a name GitHub stops redirecting
 * corrects itself.
 */
const MAX_REMEMBERED_REPOSITORIES = 512;
const forgeNames = new Map<string, GitHubRepoRef>();

function repositoryKey(repo: GitHubRepoRef): string {
  return `${repo.host}/${repo.owner}/${repo.repo}`.toLowerCase();
}

/** Record the forge's `nameWithOwner` answer for a repository it was asked about. */
export function recordForgeRepositoryName(
  asked: GitHubRepoRef,
  nameWithOwner: string,
): void {
  const [owner, repo, ...rest] = nameWithOwner.trim().split("/");
  if (!owner || !repo || rest.length > 0) return;
  const key = repositoryKey(asked);
  forgeNames.delete(key);
  forgeNames.set(key, { host: asked.host.toLowerCase(), owner, repo });
  if (forgeNames.size > MAX_REMEMBERED_REPOSITORIES) {
    forgeNames.delete(forgeNames.keys().next().value!);
  }
}

/** Whether the forge has answered for this remote since launch. */
export function hasForgeRepositoryName(repo: GitHubRepoRef): boolean {
  return forgeNames.has(repositoryKey(repo));
}

/** The forge's current name for a remote, or the remote itself when unknown. */
export function forgeRepositoryName(repo: GitHubRepoRef): GitHubRepoRef {
  return forgeNames.get(repositoryKey(repo)) ?? repo;
}

/**
 * Each remote, followed by the forge's current name for it where that is a
 * different repository name. Case-only differences are already the same name.
 */
export function withForgeRepositoryNames(repos: GitHubRepoRef[]): GitHubRepoRef[] {
  const names = [...repos];
  for (const repo of repos) {
    const named = forgeRepositoryName(repo);
    if (repositoryKey(named) !== repositoryKey(repo)) names.push(named);
  }
  return names;
}

/** Forget every answer. Tests use this; the app never needs to. */
export function clearForgeRepositoryNames(): void {
  forgeNames.clear();
}
