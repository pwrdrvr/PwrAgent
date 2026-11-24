import { FORGE_PRODUCTS, forgeKindForRemoteHost, type ForgeKind } from "@pwragent/shared/forge-product";
import { isWindowsFilesystemPath } from "@pwragent/shared/path-display";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";
import { parseGitRemoteConfiguration, type GitRemote, type GitRemoteConfiguration } from "./git-remote-config";
import { runPrMetadataGit, runPrMetadataProcess, SharedPrMetadataRead, type PrMetadataDemand } from "./pr-metadata-process";

const execFileAsync = promisify(execFile);
const GIT_REMOTE_TIMEOUT_MS = 2_000;
export const REMOTE_CONFIG_KEYS = "^remote\\.|^url\\..*\\.(push)?insteadof$|^branch\\..*\\.(remote|pushremote|merge)$";
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

export type { GitRemote } from "./git-remote-config";

type ParsedGitRemote = GitRemote & {
  repo: GitHubRepoRef | undefined;
};

type RemoteCacheEntry = {
  value: ParsedGitRemote[];
  names?: string[];
  unconfirmedEmpty?: true;
  readWithGitRemote?: true;
  sshResolutionFailed?: true;
  readFailed?: true;
  sampleOrder: number;
  fetchedAt: number;
};
type ParsedRemoteObservation = Omit<RemoteCacheEntry, "fetchedAt">;

const remoteCache = new Map<string, RemoteCacheEntry>();
const remoteLookups = new Map<string, SharedPrMetadataRead<RemoteCacheEntry>>();
let remoteCacheGeneration = 0;
let remoteSampleOrder = 0;

function nextRemoteSampleOrder(): number {
  return ++remoteSampleOrder;
}

type SshResolver = (host: string, demand?: PrMetadataDemand) => Promise<string | undefined>;
// Share only running OpenSSH evaluations. A completed evaluation belongs to
// its directory's existing TTL; a new probe must evaluate Include/Match again.
let sshLookups = new WeakMap<SshResolver, Map<string, SharedPrMetadataRead<string | undefined>>>();

export function clearGitHubRemoteCache(): void {
  remoteCacheGeneration++;
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
  /** Re-observe the remote before an action that needs the current checkout. */
  fresh?: boolean;
  /** Confirm an empty config in Git before using it as checkout authority. */
  confirmEmpty?: boolean;
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
  const observation = await readParsedGitRemotes(cwd, options);
  return observation.value.find((remote) => remote.name === "origin")?.repo;
}

/** Keep negative observations until the shared remote cache permits a retry. */
export function readObservedGitOrigin(cwd: string): {
  repo?: GitHubRepoRef;
  conclusive: boolean;
  retryAt: number;
} | undefined {
  const observation = remoteCache.get(cwd);
  if (!observation) return undefined;
  const origin = observation.value.find((remote) => remote.name === "origin");
  // A listed origin with a failed get-url read is inconclusive. A confirmed
  // remote list without origin establishes absence, even if the list is empty.
  const conclusive = Boolean(origin || (observation.names && !observation.names.includes("origin")));
  return { repo: origin?.repo, conclusive, retryAt: observation.fetchedAt + REMOTE_CACHE_TTL_MS };
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
  return (await observeForgeRepositoriesForDirectory(cwd, kind, options)).repos;
}

export async function observeForgeRepositoriesForDirectory(
  cwd: string,
  kind?: ForgeKind,
  options: ResolveGitHubRepoOptions = {},
): Promise<{ repos: GitHubRepoRef[]; refreshedRemoteNames?: string[] }> {
  const previous = remoteCache.get(cwd);
  const observation = await readParsedGitRemotes(cwd, options);
  // Default-branch reads can reuse names sampled by this lookup, while an
  // older identity cache hit must not extend their separate freshness window.
  return {
    repos: collectForgeRepositories(observation.value, kind),
    refreshedRemoteNames: observation === previous ? undefined : observation.names,
  };
}

/** Sample current Git config while reusing completed identity resolution for matching URLs. */
export function createScheduledPrefetchRemoteReader(cwd: string) {
  let previous: RemoteCacheEntry | undefined;
  const observationForReuse = () => {
    const live = remoteCache.get(cwd);
    if (!isCurrentRemoteObservation(previous)) return isCurrentRemoteObservation(live) ? live : undefined;
    if (!isCurrentRemoteObservation(live)) return previous;
    if (previous.readFailed !== live.readFailed) return previous.readFailed ? live : previous;
    // An older Git sample can finish later while waiting for SSH expansion.
    return live.sampleOrder >= previous.sampleOrder ? live : previous;
  };
  const read = async (
    configuration?: GitRemoteConfiguration,
    options: { useGitRemote?: boolean; configSampleOrder?: number; validateNegative?: () => Promise<boolean> } = {},
  ) => {
    const cacheGeneration = remoteCacheGeneration;
    const reused = observationForReuse();
    const observation = await loadParsedGitRemotes(cwd, {}, {}, {
      configuration, configSampleOrder: options.configSampleOrder, previous: reused, useGitRemote: options.useGitRemote,
    });
    const repos = collectForgeRepositories(observation.value, "github");
    // Matching names or URLs do not refresh the resolved identity's age.
    const fetchedAt = reused && observation.value === reused.value ? reused.fetchedAt : Date.now();
    const snapshot = { ...observation, fetchedAt };
    const complete = hasAllRemoteUrls(observation);
    const keepUsableIdentity = observation.readFailed && isCurrentRemoteObservation(reused)
      && collectForgeRepositories(reused.value, "github").length > 0;
    if (!keepUsableIdentity && (observation.readFailed || observation.unconfirmedEmpty || complete)
      && (repos.length > 0 || !options.validateNegative || await options.validateNegative())) {
      previous = snapshot;
    }
    // A native fallback has no config proof. If an owner read completed
    // during SSH expansion, use its later checkout sample for this branch too.
    const live = remoteCache.get(cwd);
    if (observation.readWithGitRemote && isCurrentRemoteObservation(live) && live.sampleOrder > snapshot.sampleOrder
      && !live.readFailed && !live.sshResolutionFailed && hasAllRemoteUrls(live)) {
      return { repos: collectForgeRepositories(live.value, "github"), refreshedRemoteNames: live.names };
    }
    const sshIdentityUnchanged = observation.value.some(({ url }) => readSshHost(url)) ? () => {
      if (!isCurrentRemoteObservation(snapshot)) return false;
      const current = observationForReuse();
      // Git config freshness covers URL changes. For the same URLs, the
      // owner can observe a different SSH hostname without touching Git files.
      return !current || current.value === snapshot.value || !sameRemoteUrls(current.value, snapshot.value)
        || current.value.every(({ repo }, index) => repo?.host === snapshot.value[index]?.repo?.host);
    } : undefined;
    // The live phase can reuse successful SSH or native URL discovery once
    // the caller accepts this sample. Leave current live reads alone.
    const publish = repos.length && complete && !observation.sshResolutionFailed
      && (sshIdentityUnchanged || observation.readWithGitRemote)
      ? () => {
        if (remoteCacheGeneration === cacheGeneration && isCurrentRemoteObservation(snapshot)
          && !isCurrentRemoteObservation(remoteCache.get(cwd)) && !remoteLookups.has(cwd)) remoteCache.set(cwd, snapshot);
      }
      : undefined;
    return { repos, refreshedRemoteNames: observation.names, sshIdentityUnchanged, publish };
  };
  return {
    read,
    nextSampleOrder: nextRemoteSampleOrder,
    hasGitHubIdentityFor: (configuration: GitRemoteConfiguration) => {
      const observation = observationForReuse();
      return Boolean(observation && sameRemoteUrls(configuration.remotes, observation.value)
        && collectForgeRepositories(observation.value, "github").length > 0);
    },
    usesGitRemote: () => observationForReuse()?.readWithGitRemote === true,
    shouldSkipLookup: () => {
      const observation = observationForReuse();
      // Unavailable checkouts retry on the same schedule as ordinary reads.
      // Their failure has no remote names and establishes no absence.
      return Boolean(observation && (observation.readFailed || observation.unconfirmedEmpty || hasAllRemoteUrls(observation))
        && collectForgeRepositories(observation.value, "github").length === 0);
    },
  };
}

export function isGitConfigNoMatch(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const result = error as { code?: number; stdout?: string; stderr?: string };
  return result.code === 1 && result.stdout === "" && result.stderr === "";
}

function isCurrentRemoteObservation(observation: RemoteCacheEntry | undefined): observation is RemoteCacheEntry {
  return Boolean(observation && Date.now() - observation.fetchedAt < REMOTE_CACHE_TTL_MS);
}

function hasAllRemoteUrls(observation: ParsedRemoteObservation): boolean {
  const namesWithUrls = new Set(observation.value.map(({ name }) => name));
  return observation.names?.every((name) => namesWithUrls.has(name)) ?? false;
}

function sameRemoteUrls(left: GitRemote[], right: GitRemote[]): boolean {
  return left.length === right.length && left.every(({ name, url }, index) =>
    name === right[index].name && url === right[index].url);
}

function collectForgeRepositories(remotes: ParsedGitRemote[], kind?: ForgeKind): GitHubRepoRef[] {
  const repos = new Map<string, GitHubRepoRef>();
  for (const { repo } of remotes) {
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
  return (await readParsedGitRemotes(cwd, {})).value.flatMap(({ repo }) => repo ? [repo] : []);
}

async function readParsedGitRemotes(
  cwd: string,
  options: ResolveGitHubRepoOptions,
): Promise<RemoteCacheEntry> {
  options.demand?.signal?.throwIfAborted();
  const now = options.now ?? (() => Date.now());
  const confirmEmpty = Boolean(options.confirmEmpty || options.fresh);
  const cached = remoteCache.get(cwd);
  if (!options.fresh && cached && now() - cached.fetchedAt < REMOTE_CACHE_TTL_MS
    && !(confirmEmpty && cached.unconfirmedEmpty)) {
    return cached;
  }

  const existing = remoteLookups.get(cwd);
  if (existing && !existing.signal.aborted) {
    const observation = await existing.read(options.demand);
    // A checkout-authority read can join a cheaper discovery already in
    // flight. Confirm an ambiguous result once the shared read settles.
    return confirmEmpty && observation.unconfirmedEmpty
      ? readParsedGitRemotes(cwd, options)
      : observation;
  }

  const pending = new SharedPrMetadataRead(async (demand) => {
    try {
      const loaded = await loadParsedGitRemotes(cwd, options, demand);
      demand.signal?.throwIfAborted();
      const observation = { ...loaded, fetchedAt: now() };
      if (remoteLookups.get(cwd) === pending) remoteCache.set(cwd, observation);
      return observation;
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
  prefetch?: { configuration?: GitRemoteConfiguration; configSampleOrder?: number; previous?: RemoteCacheEntry; useGitRemote?: boolean },
): Promise<ParsedRemoteObservation> {
  const resolveSshHostname =
    options.resolveSshHostname ?? defaultResolveSshHostname;
  // Also retain resolved values within this probe, including negative answers.
  const localSshLookups = new Map<string, Promise<string | undefined>>();
  try {
    demand.signal?.throwIfAborted();
    const raw: Awaited<ReturnType<typeof defaultReadRemotes>> = prefetch?.configuration ?? (options.readRemotes
      ? { remotes: await options.readRemotes(cwd) }
      : await defaultReadRemotes(cwd, demand, Boolean(options.confirmEmpty || options.fresh), prefetch));
    const sampleOrder = prefetch?.configSampleOrder ?? raw.sampleOrder ?? nextRemoteSampleOrder();
    const { names, remotes, unconfirmedEmpty, readWithGitRemote } = raw;
    const prior = prefetch?.previous;
    if (prior && (remotes === prior.value || (isCurrentRemoteObservation(prior) && sameRemoteUrls(remotes, prior.value)))) {
      return { names, value: prior.value, unconfirmedEmpty, readWithGitRemote,
        sshResolutionFailed: prior.sshResolutionFailed, sampleOrder: prior.sampleOrder };
    }
    let sshResolutionFailed: true | undefined;
    const value = await Promise.all(
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
        if (sshHost && !resolvedHost) sshResolutionFailed = true;
        return {
          ...remote,
          repo: repo && resolvedHost
            ? { ...repo, host: resolvedHost.toLowerCase() }
            : repo,
        };
      }),
    );
    return { names, value, unconfirmedEmpty, readWithGitRemote, sshResolutionFailed, sampleOrder };
  } catch {
    demand.signal?.throwIfAborted();
    // Preserve the bounded negative cache, including non-git directories.
    return { value: [], readFailed: true, sampleOrder: nextRemoteSampleOrder() };
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

async function defaultReadRemotes(
  cwd: string, demand: PrMetadataDemand, confirmEmpty: boolean,
  prefetch?: { previous?: RemoteCacheEntry; useGitRemote?: boolean },
): Promise<{ names?: string[]; remotes: GitRemote[]; unconfirmedEmpty?: true; readWithGitRemote?: true; sampleOrder?: number }> {
  const childEnv = buildPwrAgentChildProcessEnv(process.env);
  const gitOptions = {
    purpose: "pr-remotes" as const,
    env: childEnv,
    maxBuffer: 64 * 1024,
    timeout: GIT_REMOTE_TIMEOUT_MS,
  };
  // GIT_CONFIG affects the config subcommand, while remote reads the standard
  // hierarchy. Keep the original Git commands in this case and for unusual
  // configuration. `remote --verbose` prints only the first fetch URL.
  const previous = prefetch?.previous;
  if (!prefetch?.useGitRemote && !previous?.readWithGitRemote
    && !Object.keys(childEnv).some((key) => key.toUpperCase() === "GIT_CONFIG")) {
    try {
      const { stdout } = await runPrMetadataGit(cwd,
        ["config", "--null", "--show-scope", "--includes", "--get-regexp", REMOTE_CONFIG_KEYS], gitOptions, demand);
      const configuration = parseGitRemoteConfiguration(stdout);
      if (configuration?.names.length) return configuration;
      if (configuration && !confirmEmpty) return { remotes: [], unconfirmedEmpty: true };
    } catch (error) {
      demand.signal?.throwIfAborted();
      if (!confirmEmpty && isGitConfigNoMatch(error)) {
        return { remotes: [], unconfirmedEmpty: true };
      }
    }
  }

  // An empty config is enough to skip discovery. It takes Git's remote
  // command to distinguish a checkout without an origin from an unavailable one.
  const { stdout } = await runPrMetadataGit(cwd, ["remote"], gitOptions, demand);
  const names = uniqueNonEmptyLines(stdout);
  // Unusual config uses the ordinary remote-identity freshness window.
  // Each branch still gets a current list and native ref reads.
  if (isCurrentRemoteObservation(previous) && previous.readWithGitRemote && previous.names?.length === names.length
    && names.every((name, index) => name === previous.names?.[index]) && hasAllRemoteUrls(previous)) {
    return { names, remotes: previous.value, readWithGitRemote: true };
  }
  // A native URL read spans several commands. Order it from the remote list
  // so an overlapping owner sample can supersede this mixed observation.
  const sampleOrder = nextRemoteSampleOrder();
  const entries = await Promise.all(
    names.map(async (name): Promise<GitRemote[]> => {
      try {
        const result = await runPrMetadataGit(
          cwd,
          ["remote", "get-url", "--all", name],
          gitOptions, demand,
        );
        return uniqueNonEmptyLines(result.stdout).map((url) => ({ name, url }));
      } catch {
        return [];
      }
    }),
  );
  return { names, remotes: entries.flat(), readWithGitRemote: true, sampleOrder };
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
