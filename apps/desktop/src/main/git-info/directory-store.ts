import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { LinkedDirectorySummary } from "@pwragent/shared/contracts/normalized-app-server";
import {
  createGitDirectoryCommonFileObservation, createGitDirectoryObserver, type GitDirectoryObservation,
} from "./private/directory-observation";
import {
  runGit, buildCheckoutLinkedDirectory, buildFallbackLinkedDirectory, hasGitDiscoveryOverrides,
  pathExists, parseGitWorktrees, readLiveWorktreeCommonDirectory, resolveWorktreeRepositoryDirectory,
  loadThreadDirectoryEnrichment, type ThreadDirectoryEnrichment,
} from "./private/directory-probe";
import {
  directoryEnrichmentDiagnostics, type DirectoryEnrichmentCaller, type DirectoryEnrichmentContext,
} from "../diagnostics/directory-enrichment-diagnostics";
import { GitReadCache, type GitReadRequest } from "./read-cache";
import { gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";
import { collectConcurrent } from "../../shared/concurrent-work";

export type { ThreadDirectoryEnrichment } from "./private/directory-probe";

type CachedEnrichment = {
  observation: GitDirectoryObservation;
  value: ThreadDirectoryEnrichment;
};

/**
 * Directory facts survive query invalidation and elapsed time. Filesystem
 * identity is the invalidation authority; HEAD changes only refresh the branch.
 * All reads first pass through the timed read cache, including failed probes.
 * Identity checks happen only after admission, never on a warm read.
 */
export function createThreadDirectoryEnricher(options: { now?: () => number } = {}): (
  projectKey?: string,
  caller?: DirectoryEnrichmentCaller,
  request?: GitReadRequest,
) => Promise<ThreadDirectoryEnrichment> {
  const enricherId = directoryEnrichmentDiagnostics.createEnricherId();
  const cache = new Map<string, CachedEnrichment>();
  const reads = new GitReadCache<ThreadDirectoryEnrichment>({
    now: options.now, ttlMs: 1_000,
    ttlFor: (value, key) => cache.has(key) && value.observedGitBranch ? 1_000 : 5_000,
  });
  const observe = createGitDirectoryObserver();
  const repositoryWorktrees = new Map<string, { version: string; paths: string[]; roots: Set<string> }>();
  const pendingWorktrees = new Map<string, Promise<string[]>>();

  async function readWorktrees(
    key: string,
    repoRoot: string,
    before: GitDirectoryObservation | undefined,
    context: DirectoryEnrichmentContext,
  ): Promise<string[]> {
    // Git's inventory prints the admin directory for a separate git-dir.
    // Git has already confirmed the checkout root with --show-toplevel.
    if (before?.separateGitDirectory && before.checkoutRoot
      && path.relative(repoRoot, before.checkoutRoot) === "" && !hasGitDiscoveryOverrides()) return [repoRoot];
    if (!before?.commonDirectory || !before.commonVersion) {
      return parseGitWorktrees(await runGit(key, ["worktree", "list", "--porcelain"], context));
    }
    const common = before.commonDirectory;
    const cached = repositoryWorktrees.get(common);
    if (cached?.version === before.commonVersion) {
      const paths = cached.paths;
      // A newly added/moved checkout must refresh the inventory. Deleted
      // siblings do not affect this lookup; a moved primary must refresh too.
      if (cached.roots.has(path.resolve(repoRoot)) && paths[0] && await pathExists(paths[0])) {
        return cached.paths;
      }
    }
    const pendingKey = JSON.stringify([common, before.commonVersion]);
    const existing = pendingWorktrees.get(pendingKey);
    if (existing) return existing;
    const pending = runGit(key, ["worktree", "list", "--porcelain"], context).then((output) => {
      const paths = parseGitWorktrees(output);
      repositoryWorktrees.set(common, { version: before.commonVersion!, paths, roots: new Set(paths) });
      return paths;
    });
    pendingWorktrees.set(pendingKey, pending);
    try {
      return await pending;
    } finally {
      if (pendingWorktrees.get(pendingKey) === pending) pendingWorktrees.delete(pendingKey);
    }
  }

  async function refresh(key: string, caller: DirectoryEnrichmentCaller): Promise<ThreadDirectoryEnrichment> {
    let observationErrors = 0;
    const before = await observe(key).catch(() => {
      observationErrors += 1;
      return undefined;
    });
    gitSubprocessDiagnostics.observeRepository(key, before?.commonDirectory);
    const cached = cache.get(key);
    const sameRelationship = before
      && cached?.observation.relationship === before.relationship;
    const context: DirectoryEnrichmentContext = {
      directory: key,
      enricherId,
      caller,
      reason: !before ? "observation-unavailable"
        : sameRelationship && cached.observation.head === before.head ? "cache-hit"
        : !before.repository ? "unversioned"
        : !cached ? "cold"
        : sameRelationship ? "head-changed" : "relationship-changed",
    };
    directoryEnrichmentDiagnostics.record(context, { requests: 1, observationErrors });
    if (sameRelationship && cached.observation.head === before.head) {
      return cached.value;
    }
    cache.delete(key);
    let value: ThreadDirectoryEnrichment;
    if (before && !before.repository) {
      value = { linkedDirectories: [buildFallbackLinkedDirectory(key)] };
    } else if (sameRelationship) {
      const branch = await runGit(key, ["rev-parse", "--abbrev-ref", "HEAD"], context)
        .catch(() => undefined);
      value = { ...cached.value, observedGitBranch: branch || undefined };
    } else {
      value = await loadThreadDirectoryEnrichment(key, context, (repoRoot) => readWorktrees(key, repoRoot, before, context));
    }
    // Only confirmed facts enter the identity cache. Fallbacks stay in the
    // short negative cache so a recovered filesystem/executable gets retried.
    if (before && (!before.repository || value.observedGitBranch)) {
      const after = await observe(key).catch(() => {
        directoryEnrichmentDiagnostics.record(context, { observationErrors: 1 });
        return undefined;
      });
      if (after?.relationship === before.relationship && after.head === before.head) {
        cache.set(key, { observation: after, value });
        directoryEnrichmentDiagnostics.record(context, { cacheStored: 1 });
      } else {
        directoryEnrichmentDiagnostics.record(context, { observationChangedDuringProbe: 1 });
      }
    } else {
      directoryEnrichmentDiagnostics.record(context, { resultNotCached: 1 });
    }
    return value;
  }

  return async (projectKey, caller = "direct", request = {}) => {
    if (!projectKey?.trim()) {
      directoryEnrichmentDiagnostics.record(
        { directory: "", enricherId, caller, reason: "empty-path" }, { requests: 1 },
      );
      return { linkedDirectories: [] };
    }
    const key = path.resolve(projectKey.trim());
    // Membership actions must observe topology now, even inside the normal
    // display TTL. The listing already deduplicates paths within its scan.
    if (caller === "verified-directory-list") return refresh(key, caller);
    return reads.read(key, () => refresh(key, caller), {
      ...request, caller,
    }, (reason) => directoryEnrichmentDiagnostics.record(
      { directory: key, enricherId, caller, reason }, { requests: 1 },
    ));
  };
}

// All production Codex clients share the same cache and in-flight work.
export const enrichThreadDirectory = createThreadDirectoryEnricher();

const observeNavigationCheckout = createGitDirectoryObserver({ navigation: true });
type NavigationCheckout = {
  directories?: LinkedDirectorySummary[];
  provisional?: { root: string; directory: LinkedDirectorySummary };
  separateGit?: { commonDirectory: string; checkoutRoot: string; primary?: LinkedDirectorySummary };
};
const NAVIGATION_CHECKOUT_TTL_MS = 1_000;
const navigationCheckouts = new GitReadCache<NavigationCheckout | undefined>({ ttlMs: NAVIGATION_CHECKOUT_TTL_MS });
type NavigationCheckoutSample = { checkout: NavigationCheckout | undefined; observedAt: number };
type PendingNavigationCheckout = Promise<NavigationCheckoutSample | undefined>;
const pendingNavigationCheckouts = new Map<string, PendingNavigationCheckout>();

/**
 * Group raw provider folders for navigation using filesystem evidence alone.
 * Existing provider or overlay relationships and live branch facts are
 * supplied through their own reads. Ambiguous layouts retain the provider cwd
 * until a caller requests Git-verified enrichment.
 */
export function readNavigationCheckout(cwd: string, fresh = false): Promise<NavigationCheckout | undefined> {
  if (hasGitDiscoveryOverrides()) return Promise.resolve(undefined);
  const key = path.resolve(cwd);
  return fresh ? loadNavigationCheckout(key) : readPendingNavigationCheckout(key, pendingNavigationCheckouts.get(key));
}

async function readPendingNavigationCheckout(
  cwd: string, pending: PendingNavigationCheckout | undefined, requestedAt = performance.now(),
): Promise<NavigationCheckout | undefined> {
  while (pending) {
    const prepared = await pending;
    if (prepared && requestedAt < prepared.observedAt + NAVIGATION_CHECKOUT_TTL_MS) return prepared.checkout;
    // A cancelled batch publishes nothing. A waiter that arrived after an
    // observation expired also needs a replacement or a regular per-path read.
    pending = pendingNavigationCheckouts.get(cwd);
  }
  return await navigationCheckouts.read(cwd, () => loadNavigationCheckout(cwd));
}

export async function readNavigationCheckouts(
  directories: readonly string[],
  options: { fresh: boolean; verified: boolean; signal?: AbortSignal; checkpoint: () => void },
): Promise<Array<NavigationCheckout | undefined>> {
  const { fresh, verified, signal, checkpoint } = options;
  signal?.throwIfAborted();
  if (hasGitDiscoveryOverrides()) return directories.map(() => undefined);
  const check = () => {
    signal?.throwIfAborted();
    checkpoint();
  };
  if (fresh || verified) {
    const observations = await observeNavigationCheckouts(directories, verified, check);
    return observations.map(({ checkout }) => checkout);
  }

  check();
  const requestedAt = performance.now();
  const claims = new Map<string, PromiseWithResolvers<NavigationCheckoutSample | undefined>>();
  const abandon = () => {
    for (const [cwd, claim] of claims) {
      if (pendingNavigationCheckouts.get(cwd) === claim.promise) pendingNavigationCheckouts.delete(cwd);
      claim.resolve(undefined);
    }
    claims.clear();
  };
  const cancelled = signal && Promise.withResolvers<never>();
  // Use one abort listener for the batch even when several paths await other owners.
  void cancelled?.promise.catch(() => {});
  const onAbort = () => {
    abandon();
    cancelled?.reject(signal?.reason);
  };
  const wait = <T>(pending: Promise<T>): Promise<T> =>
    cancelled ? Promise.race([pending, cancelled.promise]) : pending;
  const readClaim = async (cwd: string, pending: PendingNavigationCheckout): Promise<NavigationCheckout | undefined> => {
    const prepared = await wait(pending);
    check();
    if (prepared && requestedAt < prepared.observedAt + NAVIGATION_CHECKOUT_TTL_MS) return prepared.checkout;
    // A surviving reader can acquire a fresh claim. Give its single-path
    // retry a separate signal so concurrent retries share no listener limit.
    const retryOptions = signal ? { ...options, signal: AbortSignal.any([signal]) } : options;
    return (await readNavigationCheckouts([cwd], retryOptions))[0];
  };

  // Reserve before yielding. A batch validates its own observations before
  // awaiting foreign claims, and still drains admitted I/O on cancellation.
  const readers = directories.map((cwd) => {
    const pending = pendingNavigationCheckouts.get(cwd);
    if (pending) return () => readClaim(cwd, pending);
    const existing = navigationCheckouts.readExisting(cwd);
    if (existing) return () => wait(existing);
    const claim = Promise.withResolvers<NavigationCheckoutSample | undefined>();
    claims.set(cwd, claim);
    pendingNavigationCheckouts.set(cwd, claim.promise);
    return () => readClaim(cwd, claim.promise);
  });

  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    try {
      if (claims.size) {
        const observations = await observeNavigationCheckouts([...claims.keys()], false, check);
        check();
        for (const { cwd, checkout, observedAt } of observations) {
          const claim = claims.get(cwd);
          if (!claim || pendingNavigationCheckouts.get(cwd) !== claim.promise) continue;
          navigationCheckouts.prime(cwd, checkout, observedAt);
          claim.resolve({ checkout, observedAt });
        }
      }
    } finally {
      abandon();
    }
    const results = await collectConcurrent(readers, 16, async (read) => {
      check();
      return await read();
    });
    check();
    return results;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function observeNavigationCheckouts(
  directories: readonly string[], verified: boolean, checkpoint: () => void,
): Promise<Array<NavigationCheckoutSample & { cwd: string }>> {
  const common = verified ? undefined : createGitDirectoryCommonFileObservation();
  const observations = await collectConcurrent(directories, 16, async (cwd) => {
    checkpoint();
    const checkout = await loadNavigationCheckout(cwd, common?.readFor(cwd));
    return { cwd, checkout, observedAt: performance.now() };
  });
  const changed = await common?.changedCheckouts(checkpoint);
  if (changed?.size) {
    await collectConcurrent(observations.filter(({ cwd }) => changed.has(cwd)), 16, async (entry) => {
      checkpoint();
      entry.checkout = await loadNavigationCheckout(entry.cwd);
      entry.observedAt = performance.now();
    });
  }
  checkpoint();
  return observations;
}

async function loadNavigationCheckout(
  key: string, readCommon?: Parameters<typeof observeNavigationCheckout>[3],
): Promise<NavigationCheckout | undefined> {
  try {
    if (!(await stat(key)).isDirectory()) return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { directories: [] } : undefined;
  }
  try {
    let boundary: string | undefined;
    const observed = await observeNavigationCheckout(key, (root) => { boundary = root; }, undefined, readCommon);
    const provisional = boundary ? { provisional: { root: boundary, directory: buildFallbackLinkedDirectory(key) } } : undefined;
    if (observed?.repository === false) return { directories: [buildFallbackLinkedDirectory(key)] };
    if (!observed?.checkoutRoot || !observed.gitDirectory) return provisional;
    const checkout = buildCheckoutLinkedDirectory(observed.checkoutRoot);
    const dotGit = path.join(observed.checkoutRoot, ".git");
    if (!observed.dotGitDirectory) {
      if (observed.separateGitDirectory) {
        const commonDirectory = await realpath(observed.gitDirectory);
        return { directories: [checkout], separateGit: { commonDirectory, checkoutRoot: checkout.path, primary: checkout } };
      }
      const common = observed.commonDirectory;
      if (observed.standardWorktreeLink && common) {
        if (path.basename(common) !== ".git") {
          return { ...provisional, separateGit: { commonDirectory: common, checkoutRoot: checkout.path } };
        }
        const primaryHead = path.join(common, "HEAD");
        const hasHead = readCommon ? Boolean(await readCommon(primaryHead)) : await pathExists(primaryHead);
        if (hasHead) {
          return { directories: [buildCheckoutLinkedDirectory(path.dirname(common), observed.checkoutRoot)] };
        }
        return { ...provisional, separateGit: { commonDirectory: common, checkoutRoot: checkout.path } };
      }
      const linked = await resolveWorktreeRepositoryDirectory(observed.checkoutRoot, true);
      if (linked) return { directories: [linked] };
      // A standalone administrative directory has no backlink to its
      // primary checkout. Return the linked side for an index-local join.
      const adminParent = path.dirname(await realpath(observed.gitDirectory));
      if (path.basename(adminParent) === "worktrees") {
        const commonDirectory = await readLiveWorktreeCommonDirectory(dotGit, observed.gitDirectory);
        if (commonDirectory && path.relative(commonDirectory, path.dirname(adminParent)) === "") {
          return { ...provisional, separateGit: { commonDirectory, checkoutRoot: checkout.path } };
        }
      }
      return provisional;
    }
    if (observed.commonDirectory === dotGit && await realpath(dotGit) === dotGit) {
      return { directories: [checkout] };
    }
    return provisional;
  } catch {
    // Filesystem observations can race checkout moves or permission changes.
  }
  return undefined;
}
