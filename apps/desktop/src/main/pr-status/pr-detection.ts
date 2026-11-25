import type { LinkedDirectorySummary } from "@pwragent/shared/contracts/normalized-app-server";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { prGitSubprocessCaller } from "../diagnostics/git-subprocess-diagnostics";
import {
  createScheduledPrefetchRemoteReader, observeForgeRepositoriesForDirectory, sampleForgeRepositoriesForDirectory, type GitHubRepoRef,
} from "./git-remote";
import type { GithubPrFetcher } from "./github-pr-fetcher";
import { runPrMetadataGit, SharedPrMetadataRead, type PrMetadataDemand } from "./pr-metadata-process";
import { prMatchesSourceRepository } from "./pr-source-repository";
import { hasForgeRepositoryName } from "./forge-repository-names";
import { observeProvenRemoteHeads, readGitRemoteHead, readProvenRemoteHeads, sharesRemoteHeadAbbreviations } from "./pr-remote-heads";
import { observeScheduledPrPrefetchMetadata, type ScheduledPrPrefetchMetadataScope } from "./pr-prefetch-metadata";

const GIT_BRANCH_LOOKUP_TIMEOUT_MS = 2_000;
const FALLBACK_DEFAULT_BRANCHES = [
  "main",
  "master",
  "develop",
  "trunk",
] as const;

type DefaultBranchInfo = {
  defaultsByRemote: Map<string, string>;
  names: Set<string>;
  remotes: Set<string>;
};

type TrackedRemoteBranch = {
  name: string;
  remote: string;
};

type StoredDiscoveryContext = { repos: GitHubRepoRef[]; defaults: DefaultBranchInfo };
// Navigation/federation can canonicalize many threads sharing one checkout.
// Cache eviction and expiry apply only to completed observations.
const storedDiscoveryContexts = new Map<string, { expiresAt: number; context: StoredDiscoveryContext }>();
const storedDiscoveryReads = new Map<string, SharedPrMetadataRead<StoredDiscoveryContext>>();
const STORED_DISCOVERY_CONTEXT_TTL_MS = 60_000;
const MAX_STORED_DISCOVERY_CONTEXTS = 256;

export type PrAttachmentDemand = PrMetadataDemand & {
  storedAttachmentObservation?: ReturnType<typeof createStoredAttachmentObservation>;
};

/** Share fresh remote and default refs only inside the current checkout observation. */
export function createStoredAttachmentObservation(
  representativeFor: (cwd: string) => Promise<{ root: string; gitDir: string; remoteCandidates: string[] } | undefined>,
  freshFallback = false,
) {
  const reads = new Map<string, ReturnType<typeof sampleSharedStoredDiscoveryContext>>();
  const proofs = new Set<() => Promise<boolean | undefined>>();
  const exactReads = new Map<string, Promise<StoredDiscoveryContext>>();
  function exact(cwd: string, demand?: PrMetadataDemand): Promise<StoredDiscoveryContext> {
    if (!freshFallback) return readStoredDiscoveryContext(cwd, demand);
    let read = exactReads.get(cwd);
    if (!read) {
      read = sampleStoredDiscoveryContext(cwd, demand, true);
      exactReads.set(cwd, read);
    }
    return read;
  }
  return {
    async unchanged(): Promise<boolean> {
      return (await Promise.all([...proofs].map((check) => check()))).every((match) => match === true);
    },
    async read(cwd: string, demand?: PrMetadataDemand): Promise<StoredDiscoveryContext> {
      const representative = await representativeFor(cwd);
      if (!representative) return await exact(cwd, demand);
      demand?.signal?.throwIfAborted();
      let read = reads.get(representative.root);
      if (!read) {
        read = sampleSharedStoredDiscoveryContext(representative.root, representative.remoteCandidates, demand);
        reads.set(representative.root, read);
      }
      const sample = await read;
      if (!sample) return await exact(cwd, demand);
      const { repos, remoteNames, proof } = sample;
      const verifiedHeads = await sharesRemoteHeadAbbreviations(representative.gitDir, proof.heads, demand) ? proof.heads : null;
      if (verifiedHeads) proofs.add(proof.unchanged);
      const defaults = await prGitSubprocessCaller.run("pr-stored-attachment-validation", () =>
        readDefaultBranchInfo(cwd, demand, remoteNames, verifiedHeads));
      return { repos, defaults };
    },
  };
}

/**
 * Detect PRs for a single thread by walking the resolved directory paths that
 * have a configured GitHub remote and querying each branch in-process.
 * Aggregates results, dedupes by URL (in case multiple linked dirs point
 * at the same repo).
 *
 * All lifecycle states are intentional: this is the on-focus / on-selection
 * authoritative fetch, so we want to surface merged/closed PRs too.
 * That state then sticks in the persistence overlay and the IPC layer
 * short-circuits future refreshes once any PR reaches a terminal state.
 */
export async function detectPullRequestsForThread(params: {
  fetcher: Pick<GithubPrFetcher, "fetchAllPullRequestsForBranch">
    & Partial<Pick<GithubPrFetcher, "fetchPullRequestsForCommit">>;
  branch: string;
  directoryPaths: string[];
  allowPrimedBranchLookup?: boolean;
  onProviderFailure?: () => void;
}): Promise<PrSummary[]> {
  const branch = params.branch.trim();
  if (!branch || params.directoryPaths.length === 0) {
    return [];
  }

  const dirs = uniqueNonEmpty(params.directoryPaths);
  if (dirs.length === 0) {
    return [];
  }

  const results = await prGitSubprocessCaller.run("pr-live-branch-lookup", () => Promise.all(
    dirs.map(async (cwd) => {
      const { repos, refreshedRemoteNames } = await observeForgeRepositoriesForDirectory(cwd);
      if (repos.length === 0) {
        return [];
      }
      const plan = await resolvePrLookupPlan({ branch, cwd, remoteNames: refreshedRemoteNames });
      let branchLookupFailed = false;
      const onBranchLookupFailure = params.onProviderFailure
        ? () => {
            branchLookupFailed = true;
            params.onProviderFailure?.();
          }
        : undefined;
      const prsByBranch = await Promise.all(
        plan.branches.map((lookupBranch) =>
          params.fetcher
            .fetchAllPullRequestsForBranch({
              cwd,
              branch: lookupBranch,
              ...(onBranchLookupFailure ? { onProviderFailure: onBranchLookupFailure } : {}),
              ...(params.allowPrimedBranchLookup === undefined
                ? {}
                : { allowPrimed: params.allowPrimedBranchLookup }),
            }),
        ),
      );
      let found = prsByBranch.flat().filter((pr) => prMatchesSourceRepository(pr, repos));
      // A branch with no remote upstream may have been pushed under another
      // name, and that remote branch may be gone after a merge. Its PR is
      // then found only by the tip commit. Accept only a PR whose head IS the
      // tip: a PR that merely contains the commit can be someone else's work.
      // A failed name lookup is already incomplete; a second request cannot
      // make it authoritative.
      const tipCommit = found.length === 0
        && !branchLookupFailed
        && plan.commitFallback
        && params.fetcher.fetchPullRequestsForCommit
        ? await readUnmergedBranchTip({ cwd, ...plan.commitFallback })
        : undefined;
      if (tipCommit && params.fetcher.fetchPullRequestsForCommit) {
        found = (await params.fetcher.fetchPullRequestsForCommit({
          cwd,
          sha: tipCommit,
          ...(params.onProviderFailure ? { onProviderFailure: params.onProviderFailure } : {}),
        })).filter((pr) =>
          pr.headSha?.trim().toLowerCase() === tipCommit
          && prMatchesSourceRepository(pr, repos));
      }
      return found.map((pr) => ({
        ...pr,
        linkedDirectoryPaths: uniqueNonEmpty([
          ...(pr.linkedDirectoryPaths ?? []),
          cwd,
        ]),
      }));
    }),
  ));

  const seenByUrl = new Map<string, PrSummary>();
  for (const prs of results) {
    for (const pr of prs) {
      const existing = seenByUrl.get(pr.url);
      seenByUrl.set(pr.url, existing
        ? {
            ...pr,
            linkedDirectoryPaths: uniqueNonEmpty([
              ...(existing.linkedDirectoryPaths ?? []),
              ...(pr.linkedDirectoryPaths ?? []),
            ]),
          }
        : pr);
    }
  }
  return [...seenByUrl.values()];
}

export async function resolvePrLookupBranches(params: {
  branch: string;
  cwd: string;
}): Promise<string[]> {
  return (await resolvePrLookupPlan(params)).branches;
}

type ScheduledCheckoutMetadata = {
  repos: GitHubRepoRef[];
  remoteNames: string[];
  defaults?: DefaultBranchInfo;
  verifiedHeads?: ReadonlyMap<string, string>;
  nativeHeadReads?: true;
  refreshRemoteNames?: boolean;
  unchanged: () => Promise<boolean>;
  publish?: () => Promise<void>;
};
type ScheduledPrefetchCheckout = ScheduledPrPrefetchMetadataScope & {
  verified?: ScheduledCheckoutMetadata;
};

/** Resolve the GitHub repositories eligible for scheduled branch prefetch. */
export function resolveScheduledPrPrefetchRepos(cwd: string, branch: string, checkout?: ScheduledPrefetchCheckout): Promise<GitHubRepoRef[]> {
  return prGitSubprocessCaller.run("pr-scheduled-prefetch", async () => {
    let sampled;
    if (checkout) {
      const cached = checkout.verified;
      let metadata = cached && await cached.unchanged() ? cached : undefined;
      if (!metadata) {
        checkout.verified = undefined;
        const observed = await observeScheduledPrPrefetchMetadata(cwd, checkout);
        if (observed?.proof) {
          const { heads, unchanged } = observed.proof;
          const remoteNames = observed.refreshedRemoteNames;
          const defaults = heads?.size === remoteNames.length ? await readDefaultBranchInfo(cwd, undefined, remoteNames, heads) : undefined;
          metadata = {
            repos: observed.repos, remoteNames, unchanged, publish: observed.publish,
            nativeHeadReads: observed.nativeHeadReads, refreshRemoteNames: observed.refreshRemoteNames,
            defaults, verifiedHeads: defaults ? undefined : heads,
          };
        } else {
          sampled = observed;
        }
      }
      if (metadata) {
        const remoteNames = metadata.refreshRemoteNames ? await refreshScheduledRemoteNames(cwd, metadata.remoteNames) : metadata.remoteNames;
        if (remoteNames) {
          const plan = await resolvePrLookupPlan({
            cwd, branch, remoteNames, defaultBranchInfo: metadata.defaults,
            nativeHeadReads: metadata.nativeHeadReads, verifiedHeads: metadata.verifiedHeads,
          });
          if (await metadata.unchanged()) {
            checkout.verified = metadata;
            await metadata.publish?.();
            return plan.branches.includes(branch) ? metadata.repos : [];
          }
        }
        checkout.verified = undefined;
      }
    }

    const scheduledSample = sampled ?? await checkout?.repositories.read();
    const { repos, refreshedRemoteNames } = scheduledSample ?? await observeForgeRepositoriesForDirectory(cwd, "github");
    if (repos.length === 0) return [];
    let remoteNames = checkout ? refreshedRemoteNames : undefined;
    if (scheduledSample?.refreshRemoteNames) {
      remoteNames = await refreshScheduledRemoteNames(cwd, refreshedRemoteNames);
      if (!remoteNames) return [];
    }
    const plan = await resolvePrLookupPlan({
      cwd, branch, remoteNames,
      nativeHeadReads: sampled?.nativeHeadReads,
    });
    await scheduledSample?.publish?.();
    return plan.branches.includes(branch) ? repos : [];
  });
}

async function refreshScheduledRemoteNames(cwd: string, sampledNames?: string[]): Promise<string[] | undefined> {
  const stdout = await readGitLine(cwd, ["remote"]);
  if (stdout === undefined) return undefined;
  const names = uniqueNonEmpty(stdout.split(/\r?\n/));
  // A changed list also invalidates the repository identity for this branch.
  if (sampledNames && (names.length !== sampledNames.length || names.some((name) => !sampledNames.includes(name)))) return undefined;
  return names;
}

/** Each discovery batch owns its observations, keyed by the exact cwd passed to Git. */
export function createScheduledPrPrefetchRepoResolver() {
  const batch = new Map<string, ScheduledPrefetchCheckout>();
  return (cwd: string, branch: string, branchCount = Number.POSITIVE_INFINITY): Promise<GitHubRepoRef[]> => {
    const checkout = batch.get(cwd) ?? { repositories: createScheduledPrefetchRemoteReader(cwd), branchCount };
    batch.set(cwd, checkout);
    return resolveScheduledPrPrefetchRepos(cwd, branch, checkout);
  };
}

type PrLookupPlan = {
  branches: string[];
  /**
   * Present for a branch with no remote upstream: when its name finds no PR,
   * look up the tip commit. The tip is read only then, so callers that need
   * only the branch names pay nothing for it.
   */
  commitFallback?: { localBranch: string; defaults: DefaultBranchInfo };
};

async function resolvePrLookupPlan(params: {
  branch: string;
  cwd: string;
  remoteNames?: string[];
  defaultBranchInfo?: DefaultBranchInfo;
  nativeHeadReads?: true;
  verifiedHeads?: ReadonlyMap<string, string>;
}): Promise<PrLookupPlan> {
  const defaultBranchInfo = params.defaultBranchInfo ?? await readDefaultBranchInfo(
    params.cwd, undefined, params.remoteNames, params.nativeHeadReads ? null : params.verifiedHeads,
  );
  // A timed-out/failed git probe must not turn a default branch into an
  // eligible head-name lookup against every contributor's fork.
  if (defaultBranchInfo.remotes.size === 0) return { branches: [] };
  if (defaultBranchInfo.names.size === 0
    && FALLBACK_DEFAULT_BRANCHES.some((branch) => branch === params.branch)) return { branches: [] };

  if (params.branch !== "HEAD") {
    const trackedRemoteBranch = await readTrackedRemoteBranch({
      cwd: params.cwd,
      localBranch: params.branch,
      remotes: defaultBranchInfo.remotes,
    });
    if (defaultBranchInfo.names.has(params.branch)) {
      return { branches: [] };
    }
    // A local feature branch may track the remote default branch for pulls.
    // Only substitute a tracked branch after verifying that remote's default.
    const trackedRemoteDefault = trackedRemoteBranch
      ? defaultBranchInfo.defaultsByRemote.get(trackedRemoteBranch.remote)
      : undefined;
    const branches = [
      trackedRemoteBranch
      && trackedRemoteDefault
      && trackedRemoteBranch.name !== trackedRemoteDefault
        ? trackedRemoteBranch.name
        : params.branch,
    ];
    if (trackedRemoteBranch) return { branches };
    return {
      branches,
      commitFallback: { localBranch: params.branch, defaults: defaultBranchInfo },
    };
  }

  return { branches: [] };
}

/**
 * The branch tip, when it has commits that no default branch contains. A tip
 * that a default branch already holds would find the PR that landed it there,
 * which belongs to another thread (`resolvePrLookupBranches` refuses default
 * branches for the same reason). With no known default ref there is nothing
 * to check against, so no tip is offered.
 */
async function readUnmergedBranchTip(params: {
  cwd: string;
  localBranch: string;
  defaults: DefaultBranchInfo;
}): Promise<string | undefined> {
  const tip = (await readGitLine(params.cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${params.localBranch}^{commit}`,
  ]))?.toLowerCase();
  if (!tip || !/^[0-9a-f]{40}$/.test(tip)) return undefined;
  const defaultRefs = [
    ...[...params.defaults.defaultsByRemote].map(([remote, name]) => `refs/remotes/${remote}/${name}`),
    ...[...params.defaults.names].map((name) => `refs/heads/${name}`),
  ];
  if (defaultRefs.length === 0) return undefined;
  const unmerged = await readGitLine(params.cwd, [
    "rev-list",
    "--ignore-missing",
    "--count",
    tip,
    "--not",
    ...defaultRefs,
  ]);
  return Number(unmerged) > 0 ? tip : undefined;
}

/**
 * Repair legacy automatic attachments before cache hits or history merging can
 * attach them to another thread. Explicit references remain valid independently
 * of the checkout's branch or remotes; legacy references without discovery
 * paths also have no automatic association to invalidate.
 * Missing checkouts are inconclusive: preserve their history.
 *
 * This runs before any lookup, so after a restart nothing has yet said what a
 * renamed repository's remote is called now. A PR whose source no remote
 * names asks the forge once per remote through `resolveRepositoryNames`. When
 * the forge cannot answer, a rename is as likely as a stranger's fork, so the
 * PR is kept until it can.
 */
export async function filterStoredDiscoveredPullRequests(
  prs: PrSummary[],
  options: { resolveRepositoryNames?: (repos: GitHubRepoRef[]) => Promise<void>; demand?: PrAttachmentDemand } = {},
): Promise<PrSummary[]> {
  options.demand?.signal?.throwIfAborted();
  const directories = uniqueNonEmpty(prs.flatMap((pr) => pr.explicitlyAttached ? [] : pr.linkedDirectoryPaths ?? []));
  if (directories.length === 0) return prs;
  const observation = options.demand?.storedAttachmentObservation;
  const contexts = new Map(await Promise.all(directories.map(async (cwd) => [
    cwd, await (observation ? observation.read(cwd, options.demand) : readStoredDiscoveryContext(cwd, options.demand)),
  ] as const)));
  // The repositories that decide each automatic PR, one list per linked
  // checkout; null where the checkout cannot say (missing, failed probe).
  const repairContexts = (pr: PrSummary): Array<GitHubRepoRef[] | null> =>
    uniqueNonEmpty(pr.linkedDirectoryPaths ?? []).map((cwd) => {
      const context = contexts.get(cwd)!;
      if (context.repos.length === 0 || context.defaults.remotes.size === 0) return null;
      return context.defaults.names.has(pr.headRefName ?? "") ? [] : context.repos;
    });
  const unnamed = new Map(prs
    .filter((pr) => !pr.explicitlyAttached && isGitHubSource(pr))
    .flatMap((pr) => repairContexts(pr)
      .filter((repos): repos is GitHubRepoRef[] => Boolean(repos?.length) && !prMatchesSourceRepository(pr, repos!)))
    .flatMap(unnamedGitHubRepositories)
    .map((repo) => [`${repo.owner}/${repo.repo}`.toLowerCase(), repo] as const));
  const resolveRepositoryNames = options.resolveRepositoryNames;
  options.demand?.signal?.throwIfAborted();
  if (resolveRepositoryNames && unnamed.size > 0) {
    await resolveRepositoryNames([...unnamed.values()]).catch(() => undefined);
  }
  return prs.filter((pr) => {
    if (pr.explicitlyAttached) return true;
    const decisions = repairContexts(pr);
    return decisions.length === 0 || decisions.some((repos) => {
      if (repos === null) return true;
      if (repos.length === 0) return false;
      return prMatchesSourceRepository(pr, repos)
        || (Boolean(resolveRepositoryNames)
          && isGitHubSource(pr)
          && unnamedGitHubRepositories(repos).length > 0);
    });
  });
}

function isGitHubSource(pr: PrSummary): boolean {
  return (pr.sourceRepository?.provider ?? pr.provider ?? "github.com").toLowerCase() === "github.com";
}

function unnamedGitHubRepositories(repos: GitHubRepoRef[]): GitHubRepoRef[] {
  return repos.filter((repo) => repo.host === "github.com" && !hasForgeRepositoryName(repo));
}

async function sampleSharedStoredDiscoveryContext(cwd: string, remoteCandidates: string[], demand?: PrMetadataDemand) {
  return await prGitSubprocessCaller.run("pr-stored-attachment-validation", async () => {
    // Candidate names come from the roster's config read. Check their loose
    // refs before sampling remotes, then require Git to confirm the names.
    if (!remoteCandidates.length) return undefined;
    const proof = await observeProvenRemoteHeads(cwd, remoteCandidates, demand, remoteCandidates.length);
    if (!proof) return undefined;
    const { repos, refreshedRemoteNames: remoteNames } = await sampleForgeRepositoriesForDirectory(cwd, demand);
    if (!repos.length || !remoteNames?.length || !remoteNames.every((name) => proof.heads.has(name))) return undefined;
    return { repos, remoteNames, proof };
  });
}

async function sampleStoredDiscoveryContext(cwd: string, demand?: PrMetadataDemand, fresh = false): Promise<StoredDiscoveryContext> {
  return await prGitSubprocessCaller.run("pr-stored-attachment-validation", async () => {
    const { repos, refreshedRemoteNames } = await (fresh
      ? sampleForgeRepositoriesForDirectory(cwd, demand)
      : observeForgeRepositoriesForDirectory(cwd, undefined, { demand }));
    const defaults = repos.length > 0
      ? await readDefaultBranchInfo(cwd, demand, refreshedRemoteNames)
      : { defaultsByRemote: new Map<string, string>(), names: new Set<string>(), remotes: new Set<string>() };
    demand?.signal?.throwIfAborted();
    return { repos, defaults };
  });
}

function readStoredDiscoveryContext(cwd: string, demand?: PrMetadataDemand): Promise<StoredDiscoveryContext> {
  const existing = storedDiscoveryReads.get(cwd);
  if (existing && !existing.signal.aborted) return existing.read(demand);
  const cached = storedDiscoveryContexts.get(cwd);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.context);
  storedDiscoveryContexts.delete(cwd);
  const pending = new SharedPrMetadataRead(async (sharedDemand) => {
    try {
      // Failed metadata stays inconclusive and is retried by the next read.
      const context = await sampleStoredDiscoveryContext(cwd, sharedDemand);
      if (context.repos.length > 0 && context.defaults.remotes.size > 0) {
        if (storedDiscoveryContexts.size >= MAX_STORED_DISCOVERY_CONTEXTS) {
          storedDiscoveryContexts.delete(storedDiscoveryContexts.keys().next().value!);
        }
        storedDiscoveryContexts.set(cwd, { expiresAt: Date.now() + STORED_DISCOVERY_CONTEXT_TTL_MS, context });
      }
      return context;
    } finally {
      if (storedDiscoveryReads.get(cwd) === pending) storedDiscoveryReads.delete(cwd);
    }
  });
  storedDiscoveryReads.set(cwd, pending);
  return pending.read(demand);
}

async function readTrackedRemoteBranch(params: {
  cwd: string;
  localBranch: string;
  remotes: Set<string>;
}): Promise<TrackedRemoteBranch | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await runPrMetadataGit(
      params.cwd,
      [
        "for-each-ref",
        "--format=%(refname)%09%(upstream:remotename)%09%(upstream:remoteref)",
        `refs/heads/${params.localBranch}`,
      ],
      {
        purpose: "pr-discovery",
        env: buildPwrAgentChildProcessEnv(process.env),
        maxBuffer: 64 * 1024,
        timeout: GIT_BRANCH_LOOKUP_TIMEOUT_MS,
      },
    ));
  } catch {
    return undefined;
  }

  const expectedRef = `refs/heads/${params.localBranch}`;
  const remoteRefPrefix = "refs/heads/";
  for (const line of stdout.split(/\r?\n/)) {
    const [refName = "", remote = "", remoteRef = ""] = line.split("\t");
    if (
      refName !== expectedRef
      || !params.remotes.has(remote)
      || !remoteRef.startsWith(remoteRefPrefix)
    ) {
      continue;
    }
    const name = remoteRef.slice(remoteRefPrefix.length).trim();
    return name ? { name, remote } : undefined;
  }
  return undefined;
}

async function readDefaultBranchInfo(
  cwd: string, demand?: PrMetadataDemand, remoteNames?: string[], verifiedHeads?: ReadonlyMap<string, string> | null,
): Promise<DefaultBranchInfo> {
  try {
    const { defaultsByRemote, remotes, confirmed } = await readRemoteDefaultBranches(cwd, demand, remoteNames, verifiedHeads);
    const names = new Set(defaultsByRemote.values());

    if (names.size === 0) {
      const refs = await readGitLine(cwd, [
        "for-each-ref",
        "--format=%(refname)",
        ...FALLBACK_DEFAULT_BRANCHES.map((branch) => `refs/heads/${branch}`),
      ], demand);
      // A successful empty ref read still confirms that Git can read the
      // checkout. After only failures, revalidate the previously sampled names.
      if (remoteNames && !confirmed && refs === undefined) {
        return await readDefaultBranchInfo(cwd, demand, undefined, verifiedHeads === null ? null : undefined);
      }
      const localRefs = new Set(refs?.split(/\r?\n/));
      const fallbackDefaultBranch = FALLBACK_DEFAULT_BRANCHES.find((branch) => localRefs.has(`refs/heads/${branch}`));
      if (fallbackDefaultBranch) {
        names.add(fallbackDefaultBranch);
      }
    }

    return { defaultsByRemote, names, remotes };
  } catch {
    demand?.signal?.throwIfAborted();
    return {
      defaultsByRemote: new Map(),
      names: new Set(),
      remotes: new Set(),
    };
  }
}

async function readRemoteDefaultBranches(
  cwd: string, demand?: PrMetadataDemand, remoteNames?: string[], verifiedHeads?: ReadonlyMap<string, string> | null,
): Promise<{
  defaultsByRemote: Map<string, string>;
  remotes: Set<string>;
  confirmed: boolean;
}> {
  if (!remoteNames) {
    const { stdout } = await runPrMetadataGit(cwd, ["remote"], {
      purpose: "pr-discovery",
      env: buildPwrAgentChildProcessEnv(process.env),
      maxBuffer: 64 * 1024,
      timeout: GIT_BRANCH_LOOKUP_TIMEOUT_MS,
    }, demand);
    remoteNames = uniqueNonEmpty(stdout.split(/\r?\n/));
  }
  // A null proof means this branch already tried the filesystem shortcut.
  const heads = verifiedHeads === null ? undefined : verifiedHeads ?? await readProvenRemoteHeads(cwd, remoteNames, demand);
  let confirmed = heads !== undefined;
  const defaults = await Promise.all(
    remoteNames.map(async (remote) => {
      const remoteHead = heads?.get(remote) ?? await readGitRemoteHead(cwd, remote, demand);
      if (remoteHead !== undefined) confirmed = true;
      const prefix = `${remote}/`;
      return remoteHead?.startsWith(prefix)
        ? ([remote, remoteHead.slice(prefix.length)] as const)
        : undefined;
    }),
  );
  return {
    defaultsByRemote: new Map(
      defaults.filter(
        (entry): entry is readonly [string, string] => Boolean(entry?.[1]),
      ),
    ),
    remotes: new Set(remoteNames),
    confirmed,
  };
}

async function readGitLine(
  cwd: string,
  args: string[],
  demand?: PrMetadataDemand,
): Promise<string | undefined> {
  try {
    const { stdout } = await runPrMetadataGit(cwd, args, {
      purpose: "pr-discovery",
      env: buildPwrAgentChildProcessEnv(process.env),
      maxBuffer: 64 * 1024,
      timeout: GIT_BRANCH_LOOKUP_TIMEOUT_MS,
    }, demand);
    return stdout.trim();
  } catch {
    demand?.signal?.throwIfAborted();
    return undefined;
  }
}

/**
 * Pick the cwd to ask `gh` about for each linked directory. Worktree
 * paths are preferred (those are where the branch actually exists
 * checked out); fall back to local paths when no worktree path is
 * recorded. Exposed for the renderer to call before forwarding paths
 * to the IPC layer.
 */
export function resolveFetchableDirectoryPaths(
  linkedDirectories: LinkedDirectorySummary[],
): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const directory of linkedDirectories) {
    const candidate =
      directory.kind === "worktree"
        ? directory.worktreePath ?? directory.path
        : directory.path;
    if (!candidate) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    dirs.push(candidate);
  }
  return dirs;
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
