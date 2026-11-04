import path from "node:path";
import { realpath } from "node:fs/promises";
import { buildThreadIdentityKey } from "@pwragent/shared";
import type { ArchiveCleanupIntent } from "../state/archive-cleanup-checkpoint";

export type DeferredArchiveWorktree = NonNullable<ArchiveCleanupIntent["deferredWorktrees"]>[number];

/** Resolve aliases, including a missing checkout under an existing symlinked
 * root. Each observation owns its cache; directory mutations renew evidence. */
export function canonicalWorktreePaths(): (value: string) => Promise<string> {
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
export class ArchiveWorktreeReferences {
  private readonly owners = new Map<string, { intent: ArchiveCleanupIntent; worktrees: Map<string, DeferredArchiveWorktree> }>();
  private readonly watchers = new Map<string, Set<string>>();
  private readonly observations = new Map<string, number>();

  hasReference(key: string): boolean { return this.watchers.has(key); }

  async retain(intent: ArchiveCleanupIntent, worktree: DeferredArchiveWorktree): Promise<void> {
    const canonical = await canonicalWorktreePaths()(worktree.worktreePath).catch(() => path.resolve(worktree.worktreePath));
    const key = buildThreadIdentityKey(intent.backend, intent.threadId);
    const owner = this.owners.get(key) ?? { intent, worktrees: new Map<string, DeferredArchiveWorktree>() };
    owner.worktrees.set(canonical, { ...worktree, blockers: [...new Set(worktree.blockers)] });
    this.owners.set(key, owner);
    this.reindex();
  }

  async fulfilled(worktreePath: string): Promise<void> {
    const canonical = await canonicalWorktreePaths()(worktreePath);
    for (const [key, owner] of this.owners) {
      owner.worktrees.delete(canonical);
      if (!owner.worktrees.size) this.owners.delete(key);
    }
    this.reindex();
  }

  forgetOwner(key: string): void { this.owners.delete(key); this.reindex(); }

  intents(): ArchiveCleanupIntent[] {
    return [...this.owners.values()].map(({ intent, worktrees }) => ({ ...intent, deferredWorktrees: [...worktrees.values()] }));
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
    const ready: ArchiveCleanupIntent[] = [];
    for (const ownerKey of affected) {
      const owner = this.owners.get(ownerKey);
      if (!owner) continue;
      for (const [checkout, worktree] of owner.worktrees) {
        if (observed.some((value) => value === checkout || value.startsWith(checkout + path.sep))) continue;
        worktree.blockers = worktree.blockers.filter((blocker) => blocker !== key);
      }
      const available = [...owner.worktrees.values()].filter((worktree) => worktree.blockers.length === 0);
      if (available.length) ready.push({ ...owner.intent, deferredWorktrees: available });
    }
    this.reindex();
    return ready;
  }

  private reindex(): void {
    this.watchers.clear();
    for (const [ownerKey, owner] of this.owners) for (const worktree of owner.worktrees.values()) {
      // Failed attempts without a known blocker wait for their owner's next
      // ownership change or startup recovery, never a timer or ordinary turn.
      for (const key of worktree.blockers.length ? worktree.blockers : [ownerKey]) {
        const watched = this.watchers.get(key) ?? new Set<string>();
        watched.add(ownerKey);
        this.watchers.set(key, watched);
      }
    }
  }
}
