import { realpath } from "node:fs/promises";
import path from "node:path";

export type ArchiveWorkspaceMutation = { key: string; paths: readonly string[] };

type OwnershipState = {
  generation: number;
  phase: "unknown" | "refreshing" | "disjoint" | "blocked";
  changed: boolean;
  paths: Map<string, boolean | undefined>;
};

export type ArchiveWorkspaceObservation = {
  key: string;
  tokens: Array<{ admission: ArchiveWorkspaceAdmission; generation: number }>;
};

/** Own the mutation -> invalidation -> observation transition for every route.
 * Writers are registered before their first await. Admissions opened midway
 * through a writer inherit its fence, even if their inventory sees old paths. */
export class ArchiveWorkspaceOwnership {
  private readonly writers = new Map<string, Set<symbol>>();

  constructor(private readonly admissions: () => Iterable<ArchiveWorkspaceAdmission>) {}

  beginAdmission(admission: ArchiveWorkspaceAdmission): void {
    for (const key of this.writers.keys()) admission.invalidateOwnership(key);
  }

  invalidate(key: string): ArchiveWorkspaceObservation {
    return { key, tokens: [...new Set(this.admissions())].map((admission) => ({
      admission, generation: admission.invalidateOwnership(key),
    })) };
  }

  beginMutation(key: string): () => ArchiveWorkspaceObservation {
    const writer = Symbol(key);
    const writers = this.writers.get(key) ?? new Set<symbol>();
    writers.add(writer);
    this.writers.set(key, writers);
    this.invalidate(key);
    return () => {
      writers.delete(writer);
      if (writers.size === 0) this.writers.delete(key);
      // Revoke notification reads made while this writer was still running.
      return this.invalidate(key);
    };
  }

  async refresh(observation: ArchiveWorkspaceObservation, read: () => Promise<readonly string[]>): Promise<void> {
    if (!observation.tokens.length) return;
    try {
      const paths = await read();
      if (this.writers.has(observation.key)) return;
      await Promise.all(observation.tokens.map(async ({ admission, generation }) => {
        await admission.completeOwnership(observation.key, generation, paths);
      }));
    } catch {
      for (const { admission, generation } of observation.tokens) admission.failOwnership(observation.key, generation);
    }
  }
}

/** Each identity has one ownership state. Ordinary activity may reuse a
 * disjoint proof; ownership changes revoke it synchronously. Only the matching
 * observation generation may install fresh canonical evidence. */
export class ArchiveWorkspaceAdmission {
  private readonly threads = new Map<string, OwnershipState>();
  readonly directoryFilter: ReturnType<typeof archiveCleanupWorkspaceFilter>;

  constructor(readonly ownerKey: string, private readonly scopePath: string) {
    this.directoryFilter = archiveCleanupWorkspaceFilter(scopePath);
  }

  private thread(key: string): OwnershipState {
    let state = this.threads.get(key);
    if (!state) {
      state = { generation: 0, phase: "unknown", changed: false, paths: new Map() };
      this.threads.set(key, state);
    }
    return state;
  }

  observeThread(key: string, paths: readonly string[]): void {
    const state = this.thread(key);
    for (const value of paths) {
      if (!state.paths.has(value)) {
        state.paths.set(value, undefined);
        if (state.phase === "disjoint") state.phase = "unknown";
      }
    }
  }

  changed(key = "", paths: readonly string[] = []): void {
    this.thread(key).changed = true;
    this.observeThread(key, paths);
  }

  invalidateOwnership(key: string): number {
    const state = this.thread(key);
    state.generation += 1;
    state.changed = true;
    state.phase = "refreshing";
    return state.generation;
  }

  async completeOwnership(key: string, generation: number, paths: readonly string[]): Promise<void> {
    const state = this.thread(key);
    if (state.generation !== generation) return;
    this.observeThread(key, paths.length ? paths : [""]);
    // A directory mutation can also change a symlink. Canonical evidence from
    // the preceding inventory cannot certify the new ownership generation.
    const filter = archiveCleanupWorkspaceFilter(this.scopePath);
    const evidence = new Map<string, boolean>();
    for (const value of state.paths.keys()) {
      let related = true;
      try { related = await filter(value); } catch { /* Uncertain aliases protect the checkout. */ }
      if (state.generation !== generation) return;
      evidence.set(value, related);
    }
    state.paths = evidence;
    state.phase = this.provenDisjoint(key, state) ? "disjoint" : "blocked";
  }

  failOwnership(key: string, generation: number): void {
    const state = this.thread(key);
    if (state.generation === generation) state.phase = "blocked";
  }

  async prepare(mutations: readonly ArchiveWorkspaceMutation[]): Promise<void> {
    for (const mutation of mutations) this.observeThread(mutation.key, mutation.paths);
    for (const [key, state] of this.threads) {
      // Inventory and ordinary activity cannot complete an ownership refresh.
      if (state.phase === "refreshing" || state.phase === "blocked" || state.paths.size === 0) continue;
      const generation = state.generation;
      for (const [value, known] of state.paths) {
        if (known !== undefined) continue;
        let related = true;
        try { related = await this.directoryFilter(value); } catch { /* Fail closed. */ }
        if (state.generation !== generation) break;
        state.paths.set(value, related);
      }
      if (state.generation === generation) state.phase = this.provenDisjoint(key, state) ? "disjoint" : "blocked";
    }
  }

  private provenDisjoint(key: string, state: OwnershipState): boolean {
    return Boolean(key) && key !== this.ownerKey && state.paths.size > 0
      && [...state.paths.values()].every((related) => related === false);
  }

  assertCurrent(mutations: readonly ArchiveWorkspaceMutation[]): void {
    if ([...this.threads.values()].some((state) => state.changed && state.phase !== "disjoint")) {
      throw new Error("Thread workspace state changed during removal admission; the worktree was kept. Retry archive after it settles.");
    }
    if (mutations.some(({ key, paths }) => key !== this.ownerKey
      && (this.threads.get(key)?.phase !== "disjoint"
        || paths.some((value) => this.threads.get(key)?.paths.get(value) !== false)))) {
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
