import { GitReadCache } from "../git-info/read-cache";
import type { ForgeCiClient } from "./forge-ci-client";
import { repositoryKey } from "./forge-repository-names";
import type { GitHubRepoRef } from "./git-remote";

const GITHUB_PARENT_TTL_MS = 5 * 60_000;
const GITHUB_PARENT_RETRY_MS = 60_000;

export type GitHubRepositoryParentLookup = (fork: GitHubRepoRef) => Promise<GitHubRepoRef | undefined>;

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
  return async (fork) => {
    if (fork.host !== "github.com" || !/^[\w-]+$/.test(fork.owner)
      || !/^[\w.-]+$/.test(fork.repo) || fork.repo === "." || fork.repo === "..") return undefined;
    return (await cache.read(repositoryKey(fork), async () => {
      try {
        const payload = await request(
          { ...fork, provider: "github" },
          { path: `repos/${encodeURIComponent(fork.owner)}/${encodeURIComponent(fork.repo)}` },
          AbortSignal.timeout(5_000),
        ) as { fork?: boolean; parent?: { full_name?: unknown } } | null;
        if (payload?.fork === false) return null;
        const name = payload?.parent?.full_name;
        const match = typeof name === "string" ? /^([^/]+)\/([^/]+)$/.exec(name) : null;
        return match ? { host: fork.host, owner: match[1]!, repo: match[2]! } : undefined;
      } catch {
        return undefined;
      }
    })) ?? undefined;
  };
}
