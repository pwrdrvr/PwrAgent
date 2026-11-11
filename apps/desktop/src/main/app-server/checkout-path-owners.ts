import path from "node:path";
import type { AppServerThreadSummary, ThreadOverlayState } from "@pwragent/shared";

/** The parts of a housekeeping candidate that say which checkouts it uses. */
export type CheckoutOwnerCandidate = {
  thread: Pick<AppServerThreadSummary, "id" | "source" | "archivedAt" | "linkedDirectories">;
  overlay?: Pick<ThreadOverlayState, "archiveTombstonedAt" | "extraLinkedDirectories">;
};

/**
 * Which non-archived threads list each checkout, for one pass over one
 * candidate list. Asking whether another thread shares a checkout used to
 * rescan every candidate's directories for every candidate, normalizing both
 * sides each time: quadratic in the thread count. Here each listed directory
 * is normalized once, the first time any candidate needs the answer.
 *
 * Build one per candidate list and drop it with the list. Revalidation before
 * a removal lists the owners again and builds its own.
 */
export class CheckoutPathOwners {
  /** Normalized path, then backend, then thread ids listing it. */
  private owners?: Map<string, Map<string, Set<string>>>;

  constructor(private readonly candidates: readonly CheckoutOwnerCandidate[]) {}

  /** Whether a non-archived thread other than `candidate` lists `worktreePath`. */
  sharedWithAnotherThread(candidate: Pick<CheckoutOwnerCandidate, "thread">, worktreePath: string): boolean {
    const byBackend = this.index().get(path.resolve(worktreePath));
    if (!byBackend) return false;
    const { source, id } = candidate.thread;
    for (const [backend, ids] of byBackend) {
      if (backend !== source || ids.size > 1 || !ids.has(id)) return true;
    }
    return false;
  }

  private index(): Map<string, Map<string, Set<string>>> {
    if (this.owners) return this.owners;
    const owners = new Map<string, Map<string, Set<string>>>();
    for (const { thread, overlay } of this.candidates) {
      if (thread.archivedAt !== undefined || overlay?.archiveTombstonedAt !== undefined) continue;
      for (const directory of [...thread.linkedDirectories, ...overlay?.extraLinkedDirectories ?? []]) {
        const key = path.resolve(directory.worktreePath ?? directory.path);
        const byBackend = owners.get(key) ?? new Map<string, Set<string>>();
        owners.set(key, byBackend);
        const ids = byBackend.get(thread.source) ?? new Set<string>();
        byBackend.set(thread.source, ids);
        ids.add(thread.id);
      }
    }
    return this.owners = owners;
  }
}

/** Yields to the event loop after every `every` calls. A pass that keeps
 * most candidates on thread state alone awaits nothing else, and promise
 * continuations alone never let timers, I/O or IPC run. Concurrent workers
 * share the pacer: while a yield is pending, every caller waits for it, so
 * one worker yielding does not leave the others running in microtasks. */
export function eventLoopPacer(every = 64): () => Promise<void> {
  let calls = 0;
  let pending: Promise<void> | undefined;
  return async () => {
    // Every call counts toward the next yield, including one that waits.
    calls += 1;
    if (pending) return await pending;
    if (calls % every !== 0) return;
    pending = new Promise<void>((resolve) => setImmediate(() => { pending = undefined; resolve(); }));
    await pending;
  };
}
