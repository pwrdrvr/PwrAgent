import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";

const execFileAsync = promisify(execFile);
const GIT_REMOTE_TIMEOUT_MS = 2_000;
/** Remotes change infrequently; re-probing on every PR refresh is wasted work. */
const REMOTE_CACHE_TTL_MS = 5 * 60_000;

/**
 * Resolving a working directory to its GitHub `owner/repo`.
 *
 * The `gh` CLI can infer the repo from the cwd's remotes, while the in-process
 * GraphQL client needs an explicit owner/repo for `repository(owner:, name:)`.
 * PwrAgent still reads the configured remotes before invoking `gh` so a local
 * or non-GitHub checkout cannot accidentally start a GitHub lookup.
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
 *   github-work:owner/repo.git
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

  // scp-like syntax (`[user@]host:owner/repo.git`) is not a URL, so handle it
  // first. The user is optional, especially when `host` is an SSH config alias.
  const scpLike = url.includes("://")
    ? undefined
    : url.match(/^(?:[^@/:]+@)?([^/:]+):(.+\/.+)$/);
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

export type GitRemote = {
  name: string;
  url: string;
};

type ParsedGitRemote = GitRemote & {
  repo: GitHubRepoRef | undefined;
};

type RemoteCacheEntry = {
  value: ParsedGitRemote[];
  fetchedAt: number;
};

const remoteCache = new Map<string, RemoteCacheEntry>();

export function clearGitHubRemoteCache(): void {
  remoteCache.clear();
}

export type ResolveGitHubRepoOptions = {
  /** Override the git runner — tests inject canned configured remotes. */
  readRemotes?: (cwd: string) => Promise<GitRemote[]>;
  /** Override OpenSSH hostname expansion — tests inject SSH alias results. */
  resolveSshHostname?: (host: string) => Promise<string | undefined>;
  now?: () => number;
};

/**
 * Resolve a working directory to its `origin` repo, cached.
 *
 * Returns `undefined` for a non-git directory, a missing `origin`, or a remote
 * that isn't parseable. Callers that require GitHub must still check `host`.
 * Negative results are cached too, so a local checkout doesn't re-shell on
 * every sweep.
 */
export async function resolveGitHubRepoForDirectory(
  cwd: string,
  options: ResolveGitHubRepoOptions = {},
): Promise<GitHubRepoRef | undefined> {
  const remotes = await readParsedGitRemotes(cwd, options);
  return remotes.find((remote) => remote.name === "origin")?.repo;
}

/**
 * Return whether the checkout has any configured GitHub remote.
 *
 * PR discovery uses this as an eligibility gate before invoking `gh`. Looking
 * at every fetch URL (rather than only `origin`) preserves repositories whose
 * GitHub remote is named `upstream` or another custom name. SSH host aliases
 * are expanded through the local OpenSSH configuration without connecting. A
 * non-git path, a local repository with no remotes, and a repository whose
 * remotes all point elsewhere are authoritative negative answers until the
 * short cache expires.
 */
export async function hasGitHubRemoteForDirectory(
  cwd: string,
  options: ResolveGitHubRepoOptions = {},
): Promise<boolean> {
  return (await resolveGitHubReposForDirectory(cwd, options)).length > 0;
}

/**
 * Resolve every distinct GitHub repository in the checkout's configured
 * remotes. Branch PR lookup queries all of them because a fork checkout may
 * have `origin` pointing at the fork while the PR belongs to `upstream`.
 */
export async function resolveGitHubReposForDirectory(
  cwd: string,
  options: ResolveGitHubRepoOptions = {},
): Promise<GitHubRepoRef[]> {
  const remotes = await readParsedGitRemotes(cwd, options);
  const repos = new Map<string, GitHubRepoRef>();
  for (const remote of remotes) {
    if (remote.repo?.host !== "github.com") {
      continue;
    }
    const key = `${remote.repo.owner.toLowerCase()}/${remote.repo.repo.toLowerCase()}`;
    if (!repos.has(key)) {
      repos.set(key, remote.repo);
    }
  }
  return [...repos.values()];
}

async function readParsedGitRemotes(
  cwd: string,
  options: ResolveGitHubRepoOptions,
): Promise<ParsedGitRemote[]> {
  const now = options.now ?? (() => Date.now());
  const cached = remoteCache.get(cwd);
  if (cached && now() - cached.fetchedAt < REMOTE_CACHE_TTL_MS) {
    return cached.value;
  }

  const readRemotes = options.readRemotes ?? defaultReadRemotes;
  const resolveSshHostname =
    options.resolveSshHostname ?? defaultResolveSshHostname;
  let value: ParsedGitRemote[];
  try {
    value = await Promise.all(
      (await readRemotes(cwd)).map(async (remote) => {
        const repo = parseGitHubRemote(remote.url);
        const sshHost = readSshHost(remote.url);
        const resolvedHost = sshHost
          ? await resolveSshHostname(sshHost)
          : undefined;
        return {
          ...remote,
          repo: repo && resolvedHost
            ? { ...repo, host: resolvedHost.toLowerCase() }
            : repo,
        };
      }),
    );
  } catch {
    value = [];
  }

  remoteCache.set(cwd, { value, fetchedAt: now() });
  return value;
}

async function defaultReadRemotes(cwd: string): Promise<GitRemote[]> {
  const childEnv = buildPwrAgentChildProcessEnv(process.env);
  const { stdout } = await execFileAsync("git", ["remote"], {
    cwd,
    env: childEnv,
    maxBuffer: 64 * 1024,
    timeout: GIT_REMOTE_TIMEOUT_MS,
  });
  const names = uniqueNonEmptyLines(stdout);
  const entries = await Promise.all(
    names.map(async (name): Promise<GitRemote[]> => {
      try {
        const result = await execFileAsync(
          "git",
          ["remote", "get-url", "--all", name],
          {
            cwd,
            env: childEnv,
            maxBuffer: 64 * 1024,
            timeout: GIT_REMOTE_TIMEOUT_MS,
          },
        );
        return uniqueNonEmptyLines(result.stdout).map((url) => ({ name, url }));
      } catch {
        return [];
      }
    }),
  );
  return entries.flat();
}

function uniqueNonEmptyLines(value: string): string[] {
  return [
    ...new Set(
      value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    ),
  ];
}

function readSshHost(remoteUrl: string): string | undefined {
  const url = remoteUrl.trim();
  if (!url) {
    return undefined;
  }
  if (!url.includes("://")) {
    return url.match(/^(?:[^@/:]+@)?([^/:]+):(.+\/.+)$/)?.[1];
  }
  try {
    const parsed = new URL(url);
    return ["ssh:", "git+ssh:", "ssh+git:"].includes(parsed.protocol)
      ? parsed.hostname || undefined
      : undefined;
  } catch {
    return undefined;
  }
}

async function defaultResolveSshHostname(
  host: string,
): Promise<string | undefined> {
  try {
    // `ssh -G` evaluates and prints the effective OpenSSH configuration, then
    // exits without connecting. Disabling hostname canonicalization prevents a
    // DNS lookup while still expanding `Host alias` / `HostName github.com`.
    const { stdout } = await execFileAsync(
      "ssh",
      ["-G", "-o", "CanonicalizeHostname=no", host],
      {
        env: buildPwrAgentChildProcessEnv(process.env),
        maxBuffer: 256 * 1024,
        timeout: GIT_REMOTE_TIMEOUT_MS,
      },
    );
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^hostname\s+(.+)$/i);
      if (match?.[1]) {
        return match[1].trim() || undefined;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
