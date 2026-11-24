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
const navigationCheckouts = new GitReadCache<NavigationCheckout | undefined>({ ttlMs: 1_000 });

/**
 * Group raw provider folders for navigation using filesystem evidence alone.
 * Existing provider or overlay relationships and live branch facts are
 * supplied through their own reads. Ambiguous layouts retain the provider cwd
 * until a caller requests Git-verified enrichment.
 */
export function readNavigationCheckout(cwd: string, fresh = false): Promise<NavigationCheckout | undefined> {
  if (hasGitDiscoveryOverrides()) return Promise.resolve(undefined);
  const key = path.resolve(cwd);
  return fresh ? loadNavigationCheckout(key) : navigationCheckouts.read(key, () => loadNavigationCheckout(key));
}

export async function readNavigationCheckouts(
  directories: readonly string[],
  options: { fresh: boolean; verified: boolean; checkpoint: () => void },
): Promise<Array<NavigationCheckout | undefined>> {
  const { fresh, verified, checkpoint } = options;
  if (hasGitDiscoveryOverrides()) return directories.map(() => undefined);
  const common = verified ? undefined : createGitDirectoryCommonFileObservation();
  const observations = await collectConcurrent(directories, 16, async (cwd) => {
    checkpoint();
    const cached = fresh ? undefined : navigationCheckouts.readCompleted(cwd);
    return { cwd, cached: Boolean(cached), checkout: cached ? await cached : await loadNavigationCheckout(cwd, common?.readFor(cwd)) };
  });
  const changed = await common?.changedCheckouts(checkpoint);
  if (changed?.size) {
    await collectConcurrent(observations.filter(({ cwd }) => changed.has(cwd)), 16, async (entry) => {
      checkpoint();
      entry.checkout = await loadNavigationCheckout(entry.cwd);
    });
  }
  checkpoint();
  if (!fresh) {
    for (const { cwd, cached, checkout } of observations) {
      if (!cached) navigationCheckouts.prime(cwd, checkout);
    }
  }
  return observations.map(({ checkout }) => checkout);
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
