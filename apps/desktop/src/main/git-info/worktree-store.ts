import path from "node:path";
import { stat } from "node:fs/promises";
import type { LinkedDirectorySummary } from "@pwragent/shared/contracts/normalized-app-server";
import { readNavigationCheckout } from "./directory-store";
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

/** Read separate Git metadata only for a project row with a .git pointer. */
export async function readSeparateGitProjectCheckout(checkoutPath: string) {
  const dotGit = await stat(path.join(checkoutPath, ".git")).catch(() => undefined);
  if (!dotGit?.isFile()) return undefined;
  const separate = (await readNavigationCheckout(checkoutPath, true))?.separateGit;
  return separate && path.relative(separate.checkoutRoot, checkoutPath) === "" ? separate : undefined;
}
