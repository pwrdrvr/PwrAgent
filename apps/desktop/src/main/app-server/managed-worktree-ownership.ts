import { realpath } from "node:fs/promises";
import path from "node:path";
import { WORKTREE_FOLDER_CODEX_SUBFOLDER } from "@pwragent/shared/worktree-paths";

/** Called only for a checkout associated with a known thread. Resolve both
 * sides so an alias inside the root cannot claim an outside checkout. A
 * worktree folder holds Codex threads' worktrees in its `codex` subfolder;
 * those stay Codex's, as they did under `$CODEX_HOME/worktrees`. */
export async function isInManagedWorktreeRoot(checkout: string, roots: readonly string[]): Promise<boolean> {
  let target: string;
  try { target = await realpath(checkout); } catch { return false; }
  for (const root of roots) {
    try {
      const relative = path.relative(await realpath(root), target);
      if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        && relative.split(path.sep)[0] !== WORKTREE_FOLDER_CODEX_SUBFOLDER) return true;
    } catch { /* An unavailable root grants no ownership. */ }
  }
  return false;
}
