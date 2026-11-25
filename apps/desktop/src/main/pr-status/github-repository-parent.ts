import { GitReadCache } from "../git-info/read-cache";
import type { ForgeCiClient } from "./forge-ci-client";
import { recordForgeRepositoryName, repositoryKey } from "./forge-repository-names";
import type { GitHubRepoRef } from "./git-remote";

const GITHUB_PARENT_TTL_MS = 5 * 60_000;
const GITHUB_PARENT_RETRY_MS = 60_000;

const REPOSITORY_PARENT_QUERY = `query RepositoryParent($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name, followRenames: true) {
    nameWithOwner
    isFork
    parent { nameWithOwner }
  }
}`;

/** Read a cached relationship and start any due lookup without waiting for the forge. */
export type GitHubRepositoryParentLookup = (fork: GitHubRepoRef) => GitHubRepoRef | undefined;

export function createGitHubRepositoryParentLookup(
  request: ForgeCiClient["requestGithub"],
  now?: () => number,
): GitHubRepositoryParentLookup {
  // Share the answer across worktrees of the same fork. Null is a confirmed
  // non-fork; undefined is inconclusive and can retry sooner.
  const cache = new GitReadCache<GitHubRepoRef | null | undefined>({
    ttlMs: GITHUB_PARENT_TTL_MS,
    ttlFor: (value) => value === undefined ? GITHUB_PARENT_RETRY_MS : GITHUB_PARENT_TTL_MS,
    maxEntries: 512,
    now,
  });
  return (fork) => {
    if (fork.host !== "github.com") return undefined;
    return cache.readInBackground(repositoryKey(fork), async () => {
      try {
        const payload = await request(
          { ...fork, provider: "github" },
          {
            path: "graphql", graphql: true,
            body: { query: REPOSITORY_PARENT_QUERY, variables: { owner: fork.owner, name: fork.repo } },
          },
          AbortSignal.timeout(5_000),
        ) as { data?: { repository?: {
          nameWithOwner?: unknown;
          isFork?: boolean;
          parent?: { nameWithOwner?: unknown };
        } } } | null;
        const repository = payload?.data?.repository;
        if (typeof repository?.nameWithOwner === "string") recordForgeRepositoryName(fork, repository.nameWithOwner);
        if (repository?.isFork === false) return null;
        const name = repository?.parent?.nameWithOwner;
        const match = typeof name === "string" ? /^([^/]+)\/([^/]+)$/.exec(name) : null;
        return match ? { host: fork.host, owner: match[1]!, repo: match[2]! } : undefined;
      } catch {
        return undefined;
      }
    }) ?? undefined;
  };
}
