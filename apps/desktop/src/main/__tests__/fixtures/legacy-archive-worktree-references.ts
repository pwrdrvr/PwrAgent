// Oracle for archive-worktree-references.property.test.ts: the
// implementation as of dd2300c (#3344), kept verbatim except for
// imports. It rebuilt its indexes on every mutation, which is obviously
// correct and quadratic. Do not use it in production code.
import path from "node:path";
import { realpath } from "node:fs/promises";
import { buildThreadIdentityKey } from "@pwragent/shared";
import type { ArchiveCleanupIntent } from "../../state/archive-cleanup-checkpoint";

export type DeferredArchiveWorktree = NonNullable<ArchiveCleanupIntent["deferredWorktrees"]>[number];

type PendingWorktree = DeferredArchiveWorktree & { phase: "waiting" | "ready" | "checking" | "retry" };

function referencePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Resolve aliases, including a missing checkout under an existing symlinked
 * root. Each observation owns its cache; directory mutations renew evidence. */
function canonicalWorktreePaths(): (value: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  const resolve = (value: string): Promise<string> => {
    if (!value || !path.isAbsolute(value)) return Promise.reject(new Error("Unknown worktree path."));
    const absolute = path.resolve(value);
    let pending = cache.get(absolute);
    if (!pending) {
      pending = (async () => {
        try { return await realpath(absolute); } catch (error) {
          if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          const parent = path.dirname(absolute);
          if (parent === absolute) throw error;
          return path.join(await resolve(parent), path.basename(absolute));
        }
      })().then((result) => process.platform === "win32" ? result.toLowerCase() : result);
      cache.set(absolute, pending);
    }
    return pending;
  };
  return resolve;
}

/** Pending ownership is per canonical checkout, rather than per notification.
 * The reverse index makes unrelated activity a no-op. A ready entry is merely
 * a scheduling hint; the physical queue still obtains fresh removal admission. */
export class LegacyArchiveWorktreeReferences {
  private readonly owners = new Map<string, { intent: ArchiveCleanupIntent; worktrees: Map<string, PendingWorktree> }>();
  private readonly watchers = new Map<string, Set<string>>();
  private readonly observations = new Map<string, number>();

  hasReference(key: string): boolean { return this.watchers.has(key); }

  async retain(intent: ArchiveCleanupIntent, worktree: DeferredArchiveWorktree): Promise<void> {
    for (const blocker of worktree.blockers) if (this.observations.has(blocker)) this.beginObservation(blocker);
    const resolved = await canonicalWorktreePaths()(worktree.worktreePath).catch(() => referencePath(worktree.worktreePath));
    // Removal can leave the supplied symlink dangling. Updates to its pending
    // row must retain the identity observed while the checkout still existed.
    const canonical = this.retainedKeys(worktree.worktreePath).values().next().value ?? resolved;
    const key = buildThreadIdentityKey(intent.backend, intent.threadId);
    const owner = this.owners.get(key) ?? { intent, worktrees: new Map<string, PendingWorktree>() };
    const previous = owner.worktrees.get(canonical);
    owner.worktrees.set(canonical, { ...previous, ...worktree, snapshot: worktree.snapshot ?? previous?.snapshot,
      blockers: [...new Set(worktree.blockers)], phase: worktree.blockers.length ? "waiting" : "retry" });
    this.owners.set(key, owner);
    this.reindex();
  }

  async fulfilled(worktreePath: string): Promise<void> {
    const canonical = await canonicalWorktreePaths()(worktreePath);
    const fulfilled = this.retainedKeys(worktreePath);
    fulfilled.add(canonical);
    for (const [key, owner] of this.owners) {
      for (const checkout of fulfilled) owner.worktrees.delete(checkout);
      if (!owner.worktrees.size) this.owners.delete(key);
    }
    this.reindex();
  }

  forgetOwner(key: string): void { this.owners.delete(key); this.reindex(); }

  intents(): ArchiveCleanupIntent[] {
    return [...this.owners.values()].map(({ intent, worktrees }) => ({ ...intent, deferredWorktrees: [...worktrees.values()].map((row) => this.record(row)) }));
  }

  recoveryIntents(): ArchiveCleanupIntent[] { return this.selectOwners([...this.owners.keys()], false); }
  readyIntents(key?: string): ArchiveCleanupIntent[] { return this.selectOwners(key ? [key] : [...this.owners.keys()], true); }
  scheduled(intent: ArchiveCleanupIntent): void {
    const owner = this.owners.get(buildThreadIdentityKey(intent.backend, intent.threadId));
    const selected = new Set([...owner?.worktrees ?? []].filter(([, current]) =>
      intent.deferredWorktrees?.some((row) => row.worktreePath === current.worktreePath)).map(([checkout]) => checkout));
    for (const current of this.owners.values()) for (const [checkout, row] of current.worktrees) {
      if (selected.has(checkout)) row.phase = "checking";
    }
  }
  pending(intent: ArchiveCleanupIntent): DeferredArchiveWorktree[] {
    const owner = this.owners.get(buildThreadIdentityKey(intent.backend, intent.threadId));
    return (intent.deferredWorktrees ?? []).filter((row) => [...owner?.worktrees.values() ?? []]
      .some((current) => current.worktreePath === row.worktreePath));
  }

  /** Invalidate before the first read. A late completion cannot release a
   * reference which a newer directory mutation has changed again. */
  beginObservation(key: string): number {
    const generation = (this.observations.get(key) ?? 0) + 1;
    this.observations.set(key, generation);
    return generation;
  }

  async observe(key: string, generation: number, paths: readonly string[]): Promise<ArchiveCleanupIntent[]> {
    const affected = [...this.watchers.get(key) ?? []];
    if (!affected.length) return [];
    const canonical = canonicalWorktreePaths();
    // An absent/relative path or failed read must never release ownership.
    const observed = await Promise.all(paths.map(canonical));
    if (this.observations.get(key) !== generation) return [];
    for (const ownerKey of affected) {
      const owner = this.owners.get(ownerKey);
      if (!owner) continue;
      for (const [checkout, worktree] of owner.worktrees) {
        if (observed.some((value) => value === checkout || value.startsWith(checkout + path.sep))) continue;
        const owned = worktree.blockers.includes(key);
        worktree.blockers = worktree.blockers.filter((blocker) => blocker !== key);
        if (owned && !worktree.blockers.length) worktree.phase = "ready";
      }
    }
    this.reindex();
    return this.selectOwners(affected, true);
  }

  private selectOwners(keys: string[], readyOnly: boolean): ArchiveCleanupIntent[] {
    const selected = new Set<string>();
    const requests: ArchiveCleanupIntent[] = [];
    for (const key of keys) {
      const owner = this.owners.get(key);
      if (!owner) continue;
      const worktrees: DeferredArchiveWorktree[] = [];
      for (const [checkout, worktree] of owner.worktrees) {
        if (selected.has(checkout) || (readyOnly && (worktree.phase !== "ready" || worktree.blockers.length))) continue;
        selected.add(checkout);
        worktrees.push(this.record(worktree));
      }
      if (worktrees.length) requests.push({ ...owner.intent, deferredWorktrees: worktrees });
    }
    return requests;
  }

  private record(worktree: PendingWorktree): DeferredArchiveWorktree {
    const { phase: _phase, ...record } = worktree;
    return record;
  }

  private retainedKeys(worktreePath: string): Set<string> {
    const supplied = referencePath(worktreePath);
    const keys = new Set<string>();
    for (const owner of this.owners.values()) for (const [checkout, row] of owner.worktrees) {
      if (referencePath(row.worktreePath) === supplied) keys.add(checkout);
    }
    return keys;
  }

  private reindex(): void {
    this.watchers.clear();
    for (const [ownerKey, owner] of this.owners) for (const worktree of owner.worktrees.values()) {
      // Failed attempts without a known blocker wait for startup or an
      // explicit retry, never a timer or their own archive completion.
      for (const key of worktree.blockers) {
        const watched = this.watchers.get(key) ?? new Set<string>();
        watched.add(ownerKey);
        this.watchers.set(key, watched);
      }
    }
  }
}
