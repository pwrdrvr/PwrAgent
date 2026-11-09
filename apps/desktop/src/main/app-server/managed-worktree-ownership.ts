import { realpath } from "node:fs/promises";
import path from "node:path";

/** Called only for a checkout associated with a known thread. Resolve both
 * sides so an alias inside the root cannot claim an outside checkout. */
export async function isInManagedWorktreeRoot(checkout: string, roots: readonly string[]): Promise<boolean> {
  let target: string;
  try { target = await realpath(checkout); } catch { return false; }
  for (const root of roots) {
    try {
      const relative = path.relative(await realpath(root), target);
      if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return true;
    } catch { /* An unavailable root grants no ownership. */ }
  }
  return false;
}
