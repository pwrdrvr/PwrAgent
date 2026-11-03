import { realpath } from "node:fs/promises";
import path from "node:path";

/** A scan-local filter for expensive Git enrichment, never for membership or
 * overlay reads. Resolve missing suffixes through their nearest existing
 * ancestor so a removed checkout under a symlinked root remains in scope. */
export function archiveCleanupWorkspaceFilter(scopePath: string): (cwd: string | undefined) => Promise<boolean> {
  const observations = new Map<string, Promise<string>>();
  const canonical = (value: string): Promise<string> => {
    const resolved = path.resolve(value);
    let observation = observations.get(resolved);
    if (!observation) {
      observation = (async () => {
        try {
          return await realpath(resolved);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          const parent = path.dirname(resolved);
          if (parent === resolved) throw error;
          return path.join(await canonical(parent), path.basename(resolved));
        }
      })();
      observations.set(resolved, observation);
    }
    return observation;
  };
  const within = (parent: string, child: string): boolean => {
    const relative = path.relative(parent, child);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
  };
  return async (cwd) => {
    // An absent or relative cwd cannot prove disjoint ownership. Keep the
    // ordinary strict enrichment behavior rather than guess its workspace.
    if (!cwd || !path.isAbsolute(cwd)) return true;
    const scope = await canonical(scopePath);
    const workspace = await canonical(cwd);
    return within(scope, workspace) || within(workspace, scope);
  };
}
