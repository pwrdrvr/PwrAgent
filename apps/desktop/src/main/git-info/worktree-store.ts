import path from "node:path";
import type { LinkedDirectorySummary } from "@pwragent/shared/contracts/normalized-app-server";
import { resolveWorktreeRepositoryDirectory as probe } from "./private/directory-probe";
import { GitReadCache } from "./read-cache";

const cache = new GitReadCache<LinkedDirectorySummary | undefined>({
  ttlMs: 5_000,
  // Recheck positive project folds on each index pass so a moved primary
  // checkout does not keep hiding its worktree behind an obsolete path.
  ttlFor: (value, key) => value && key.startsWith("project-root:") ? 0 : 5_000,
});

export function resolveWorktreeRepositoryDirectory(cwd: string, options?: {
  fresh?: boolean;
  /** Project rows represent roots. Check only their own .git entry. */
  rootOnly?: boolean;
}): Promise<LinkedDirectorySummary | undefined> {
  const root = path.resolve(cwd);
  if (options?.fresh) return probe(root, options.rootOnly);
  const key = options?.rootOnly ? `project-root:${root}` : root;
  return cache.read(key, () => probe(root, options?.rootOnly));
}
