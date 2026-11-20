import { FORGE_PRODUCTS, forgeKindForRemoteHost, type ForgeKind } from "@pwragent/shared/forge-product";
import { isWindowsFilesystemPath } from "@pwragent/shared/path-display";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";
import { runPrMetadataGit, runPrMetadataProcess, SharedPrMetadataRead, type PrMetadataDemand } from "./pr-metadata-process";

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
  const repo = parseForgeRemote(remoteUrl);
  return repo && !repo.owner.includes("/") ? repo : undefined;
}

export function parseForgeRemote(remoteUrl: string): GitHubRepoRef | undefined {
  const url = remoteUrl.trim();
  // A drive-qualified local remote must not be mistaken for an SCP host.
  if (!url || isWindowsFilesystemPath(url)) {
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
  // GitLab namespaces can contain arbitrarily nested subgroups.
  if (segments.length < 2) {
    return undefined;
  }

  const repo = segments.pop();
  const owner = segments.join("/");
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
const remoteLookups = new Map<string, SharedPrMetadataRead<ParsedGitRemote[]>>();
type SshResolver = (host: string, demand?: PrMetadataDemand) => Promise<string | undefined>;
// Share only running OpenSSH evaluations. A completed evaluation belongs to
// its directory's existing TTL; a new probe must evaluate Include/Match again.
let sshLookups = new WeakMap<SshResolver, Map<string, SharedPrMetadataRead<string | undefined>>>();

export function clearGitHubRemoteCache(): void {
  remoteCache.clear();
  // Existing callers may finish, but cannot publish into the new cache.
  remoteLookups.clear();
  sshLookups = new WeakMap();
}

export type ResolveGitHubRepoOptions = {
  /** Override the git runner — tests inject canned configured remotes. */
  readRemotes?: (cwd: string) => Promise<GitRemote[]>;
  /** Override OpenSSH hostname expansion — tests inject SSH alias results. */
  resolveSshHostname?: (host: string) => Promise<string | undefined>;
  now?: () => number;
  demand?: PrMetadataDemand;
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
  return resolveForgeReposForDirectory(cwd, "github", options);
}

/** One remote discovery path, with product host/path policy from the catalog. */
export async function resolveForgeReposForDirectory(
  cwd: string,
  kind?: ForgeKind,
  options: ResolveGitHubRepoOptions = {},
): Promise<GitHubRepoRef[]> {
  const repos = new Map<string, GitHubRepoRef>();
  for (const { repo } of await readParsedGitRemotes(cwd, options)) {
    if (!repo) continue;
    const matched = forgeKindForRemoteHost(repo.host);
    if (!matched || (kind !== undefined && matched !== kind)) continue;
    if (!FORGE_PRODUCTS[matched].nestedNamespaces && repo.owner.includes("/")) continue;
    const key = `${repo.host}/${repo.owner}/${repo.repo}`.toLowerCase();
    if (!repos.has(key)) repos.set(key, repo);
  }
  return [...repos.values()];
}

/** Unclassified hosts require explicit product evidence from the caller. */
export async function readForgeRepositoryRemotes(cwd: string): Promise<GitHubRepoRef[]> {
  return (await readParsedGitRemotes(cwd, {})).flatMap(({ repo }) => repo ? [repo] : []);
}

async function readParsedGitRemotes(
  cwd: string,
  options: ResolveGitHubRepoOptions,
): Promise<ParsedGitRemote[]> {
  options.demand?.signal?.throwIfAborted();
  const now = options.now ?? (() => Date.now());
  const cached = remoteCache.get(cwd);
  if (cached && now() - cached.fetchedAt < REMOTE_CACHE_TTL_MS) {
    return cached.value;
  }

  const existing = remoteLookups.get(cwd);
  if (existing && !existing.signal.aborted) {
    return existing.read(options.demand);
  }

  const pending = new SharedPrMetadataRead(async (demand) => {
    try {
      const value = await loadParsedGitRemotes(cwd, options, demand);
      demand.signal?.throwIfAborted();
      if (remoteLookups.get(cwd) === pending) remoteCache.set(cwd, { value, fetchedAt: now() });
      return value;
    } finally {
      if (remoteLookups.get(cwd) === pending) remoteLookups.delete(cwd);
    }
  });
  remoteLookups.set(cwd, pending);
  return pending.read(options.demand);
}

async function loadParsedGitRemotes(
  cwd: string,
  options: ResolveGitHubRepoOptions,
  demand: PrMetadataDemand,
): Promise<ParsedGitRemote[]> {
  const resolveSshHostname =
    options.resolveSshHostname ?? defaultResolveSshHostname;
  // Also retain resolved values within this probe, including negative answers.
  const localSshLookups = new Map<string, Promise<string | undefined>>();
  try {
    demand.signal?.throwIfAborted();
    const remotes = await (options.readRemotes ? options.readRemotes(cwd) : defaultReadRemotes(cwd, demand));
    return await Promise.all(
      remotes.map(async (remote) => {
        const repo = parseForgeRemote(remote.url);
        const sshHost = readSshHost(remote.url);
        let hostname: Promise<string | undefined> | undefined;
        if (sshHost) {
          hostname = localSshLookups.get(sshHost);
          if (!hostname) {
            hostname = resolveSshHostInFlight(sshHost, resolveSshHostname, demand);
            localSshLookups.set(sshHost, hostname);
          }
        }
        const resolvedHost = await hostname;
        return {
          ...remote,
          repo: repo && resolvedHost
            ? { ...repo, host: resolvedHost.toLowerCase() }
            : repo,
        };
      }),
    );
  } catch {
    demand.signal?.throwIfAborted();
    // Preserve the bounded negative cache, including non-git directories.
    return [];
  }
}

function resolveSshHostInFlight(host: string, resolve: SshResolver, demand: PrMetadataDemand): Promise<string | undefined> {
  demand.signal?.throwIfAborted();
  let lookups = sshLookups.get(resolve);
  if (!lookups) {
    lookups = new Map();
    sshLookups.set(resolve, lookups);
  }
  const existing = lookups.get(host);
  if (existing && !existing.signal.aborted) return existing.read(demand);
  const pending = new SharedPrMetadataRead(async (sharedDemand) => {
    try {
      sharedDemand.signal?.throwIfAborted();
      return await (resolve === defaultResolveSshHostname ? resolve(host, sharedDemand) : resolve(host));
    } finally {
      if (lookups.get(host) === pending) lookups.delete(host);
    }
  });
  lookups.set(host, pending);
  return pending.read(demand);
}

async function defaultReadRemotes(cwd: string, demand: PrMetadataDemand): Promise<GitRemote[]> {
  const childEnv = buildPwrAgentChildProcessEnv(process.env);
  const { stdout } = await runPrMetadataGit(cwd, ["remote"], {
    purpose: "pr-remotes",
    env: childEnv,
    maxBuffer: 64 * 1024,
    timeout: GIT_REMOTE_TIMEOUT_MS,
  }, demand);
  const names = uniqueNonEmptyLines(stdout);
  const entries = await Promise.all(
    names.map(async (name): Promise<GitRemote[]> => {
      try {
        const result = await runPrMetadataGit(
          cwd,
          ["remote", "get-url", "--all", name],
          {
            purpose: "pr-remotes",
            env: childEnv,
            maxBuffer: 64 * 1024,
            timeout: GIT_REMOTE_TIMEOUT_MS,
          }, demand,
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
  if (!url || isWindowsFilesystemPath(url)) {
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

function defaultResolveSshHostname(host: string, demand?: PrMetadataDemand): Promise<string | undefined> {
  return runPrMetadataProcess(() => readSshHostname(host), demand);
}

async function readSshHostname(host: string): Promise<string | undefined> {
  const finish = gitSubprocessDiagnostics.start("ssh-config", "pr-remotes", { sshHost: host });
  let failed = true;
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
    failed = false;
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^hostname\s+(.+)$/i);
      if (match?.[1]) {
        return match[1].trim() || undefined;
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    finish(failed);
  }
}

export async function resolveGitLabReposForDirectory(
  cwd: string,
  options: ResolveGitHubRepoOptions = {},
): Promise<GitHubRepoRef[]> {
  return resolveForgeReposForDirectory(cwd, "gitlab", options);
}
