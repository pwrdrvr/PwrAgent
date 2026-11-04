import { realpath } from "node:fs/promises";
import path from "node:path";

export type ArchiveWorkspaceMutation = { key: string; paths: readonly string[] };

/** Removal needs checkout ownership to stay stable, not every thread on the
 * instance to stay idle. Keep the global generation for inventory reuse, but
 * fence removal only for identities/paths which can intersect its checkout. */
export class ArchiveWorkspaceAdmission {
  private readonly threads = new Map<string, readonly string[]>();
  private readonly classifiedPaths = new Map<string, boolean>();
  private readonly unclassifiedPaths = new Set<string>();
  private readonly changes: Array<{ key?: string; paths: readonly string[] }> = [];
  readonly directoryFilter: ReturnType<typeof archiveCleanupWorkspaceFilter>;

  constructor(readonly ownerKey: string, scopePath: string) {
    this.directoryFilter = archiveCleanupWorkspaceFilter(scopePath);
  }

  observeThread(key: string, paths: readonly string[]): void {
    this.threads.set(key, [...new Set([...this.threads.get(key) ?? [], ...paths])]);
    this.observePaths(paths);
  }

  changed(key?: string, paths: readonly string[] = []): void {
    this.changes.push({ key, paths });
    this.observePaths(paths);
  }

  private observePaths(paths: readonly string[]): void {
    for (const value of paths) {
      if (!this.classifiedPaths.has(value)) this.unclassifiedPaths.add(value);
    }
  }

  async prepare(mutations: readonly ArchiveWorkspaceMutation[]): Promise<void> {
    for (const mutation of mutations) this.observePaths(mutation.paths);
    // The Set iterator also visits paths appended while an earlier path is
    // resolving. Classified activity has no filesystem work on later events.
    for (const value of this.unclassifiedPaths) {
      try {
        this.classifiedPaths.set(value, await this.directoryFilter(value));
      } catch {
        // An uncertain alias blocks removal without breaking the unrelated
        // lifecycle notification which supplied the observation.
        this.classifiedPaths.set(value, true);
      }
      this.unclassifiedPaths.delete(value);
    }
  }

  private disjoint(key: string | undefined, extraPaths: readonly string[]): boolean {
    if (!key || key === this.ownerKey) return false;
    const paths = this.threads.get(key) ?? extraPaths;
    // Empty/relative/unknown workspaces cannot establish disjoint ownership.
    return paths.length > 0
      && [...paths, ...extraPaths].every((value) => this.classifiedPaths.get(value) === false);
  }

  assertCurrent(mutations: readonly ArchiveWorkspaceMutation[]): void {
    if (this.changes.some((change) => !this.disjoint(change.key, change.paths))) {
      throw new Error("Thread workspace state changed during removal admission; the worktree was kept. Retry archive after it settles.");
    }
    if (mutations.some((mutation) => mutation.key !== this.ownerKey && !this.disjoint(mutation.key, mutation.paths))) {
      throw new Error("Another thread lifecycle mutation is still in flight and may use this worktree; the worktree was kept. Retry archive after it settles.");
    }
  }
}

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
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
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
