import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_REMOTE_TIMEOUT_MS = 2_000;
/** Remotes effectively never change for a checkout; re-probing is wasted work. */
const REMOTE_CACHE_TTL_MS = 5 * 60_000;

/**
 * Resolving a working directory to its GitHub `owner/repo`.
 *
 * The `gh` CLI never needs this — it infers the repo from the cwd's remote
 * itself. The in-process GraphQL client does need it, because
 * `repository(owner:, name:)` is how you address a repo in the API. This is the
 * one capability the subprocess path got for free that the batched path has to
 * do explicitly.
 */

export type GitHubRepoRef = {
  /** Remote host, lowercased. Only `github.com` works against api.github.com. */
  host: string;
  owner: string;
  repo: string;
};

/**
 * Parse a git remote URL into its host/owner/repo.
 *
 * Handles the shapes git actually produces:
 *   git@github.com:owner/repo.git
 *   ssh://git@github.com/owner/repo.git
 *   https://github.com/owner/repo(.git)
 *   git://github.com/owner/repo.git
 *   https://user:token@github.com/owner/repo.git
 */
export function parseGitHubRemote(remoteUrl: string): GitHubRepoRef | undefined {
  const url = remoteUrl.trim();
  if (!url) {
    return undefined;
  }

  // scp-like syntax (`git@host:owner/repo.git`) is not a URL, so handle it first.
  const scpLike = url.match(/^[^@/]+@([^:]+):(.+)$/);
  const parsed = scpLike
    ? { host: scpLike[1]!, path: scpLike[2]! }
    : parseStandardUrl(url);
  if (!parsed) {
    return undefined;
  }

  const segments = parsed.path
    .replace(/^\/+/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  // Exactly owner/repo — anything deeper is not a repo root.
  if (segments.length !== 2) {
    return undefined;
  }

  const [owner, repo] = segments;
  if (!owner || !repo) {
    return undefined;
  }
  return { host: parsed.host.toLowerCase(), owner, repo };
}

function parseStandardUrl(url: string): { host: string; path: string } | undefined {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) {
      return undefined;
    }
    return { host: parsed.hostname, path: parsed.pathname };
  } catch {
    return undefined;
  }
}

type RemoteCacheEntry = {
  value: GitHubRepoRef | undefined;
  fetchedAt: number;
};

const remoteCache = new Map<string, RemoteCacheEntry>();

export function clearGitHubRemoteCache(): void {
  remoteCache.clear();
}

export type ResolveGitHubRepoOptions = {
  /** Override the git runner — tests inject canned remote URLs. */
  readRemoteUrl?: (cwd: string) => Promise<string | undefined>;
  now?: () => number;
};

/**
 * Resolve a working directory to its `origin` GitHub repo, cached.
 *
 * Returns `undefined` for a non-git directory, a missing `origin`, or a remote
 * that isn't parseable — every caller treats that as "fall back to the `gh`
 * subprocess path", so a failure here is a slow path, never a wrong answer.
 * Negative results are cached too, so a non-GitHub checkout doesn't re-shell
 * on every sweep.
 */
export async function resolveGitHubRepoForDirectory(
  cwd: string,
  options: ResolveGitHubRepoOptions = {},
): Promise<GitHubRepoRef | undefined> {
  const now = options.now ?? (() => Date.now());
  const cached = remoteCache.get(cwd);
  if (cached && now() - cached.fetchedAt < REMOTE_CACHE_TTL_MS) {
    return cached.value;
  }

  const readRemoteUrl = options.readRemoteUrl ?? defaultReadRemoteUrl;
  let value: GitHubRepoRef | undefined;
  try {
    const remoteUrl = await readRemoteUrl(cwd);
    value = remoteUrl ? parseGitHubRemote(remoteUrl) : undefined;
  } catch {
    value = undefined;
  }

  remoteCache.set(cwd, { value, fetchedAt: now() });
  return value;
}

async function defaultReadRemoteUrl(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["remote", "get-url", "origin"],
      { cwd, maxBuffer: 64 * 1024, timeout: GIT_REMOTE_TIMEOUT_MS },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
