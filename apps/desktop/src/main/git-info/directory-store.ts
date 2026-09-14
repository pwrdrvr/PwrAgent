import path from "node:path";
import { createGitDirectoryObserver, type GitDirectoryObservation } from "./private/directory-observation";
import {
  runGit, buildFallbackLinkedDirectory, pathExists, parseGitWorktrees,
  loadThreadDirectoryEnrichment, type ThreadDirectoryEnrichment,
} from "./private/directory-probe";
import {
  directoryEnrichmentDiagnostics, type DirectoryEnrichmentCaller, type DirectoryEnrichmentContext,
} from "../diagnostics/directory-enrichment-diagnostics";
import { GitReadCache, type GitReadRequest } from "./read-cache";

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
    return reads.read(key, () => refresh(key, caller), {
      ...request, caller,
    }, (reason) => directoryEnrichmentDiagnostics.record(
      { directory: key, enricherId, caller, reason }, { requests: 1 },
    ));
  };
}

// All production Codex clients share the same cache and in-flight work.
export const enrichThreadDirectory = createThreadDirectoryEnricher();
