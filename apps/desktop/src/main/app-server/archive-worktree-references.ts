import path from "node:path";
import { realpath } from "node:fs/promises";
import { buildThreadIdentityKey } from "@pwragent/shared";
import type { ArchiveCleanupIntent } from "../storage/desktop-runtime-storage";

export type DeferredArchiveWorktree = NonNullable<ArchiveCleanupIntent["deferredWorktrees"]>[number];

type PendingWorktree = DeferredArchiveWorktree & { phase: "waiting" | "ready" | "checking" | "retry" };

function referencePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

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

type Owner = { seq: number; intent: ArchiveCleanupIntent; worktrees: Map<string, PendingWorktree> };

/** Pending ownership is per canonical checkout, rather than per notification.
 * The reverse indexes make unrelated activity a no-op and keep every update
 * proportional to the rows it touches, so hundreds of waiting checkouts do not
 * turn each release or queue slot into a pass over all of them. A ready entry
 * is merely a scheduling hint; the physical queue still obtains fresh removal
 * admission. */
export class ArchiveWorktreeReferences {
  private readonly owners = new Map<string, Owner>();
  private seq = 0;
  /** Blocker identity -> owner -> rows that blocker holds. */
  private readonly watchers = new Map<string, Map<string, number>>();
  /** Canonical checkout -> owners with a row for it. */
  private readonly checkoutOwners = new Map<string, Set<string>>();
  /** Supplied (pre-resolution) path -> canonical checkout -> rows. */
  private readonly supplied = new Map<string, Map<string, number>>();
  /** Owner -> rows that are ready and have no blocker. */
  private readonly ready = new Map<string, number>();
  private readonly observations = new Map<string, number>();
  /** Counts every retained or changed row. Releases and fulfilment shrink the
   * backlog and do not count: recovery re-evaluates each recovered row afresh,
   * so a checkpoint only needs to follow what was added. */
  additions = 0;

  hasReference(key: string): boolean { return this.watchers.has(key); }
  get hasOwners(): boolean { return this.owners.size > 0; }
  hasPending(ownerKey: string, worktreePath: string): boolean {
    return [...this.owners.get(ownerKey)?.worktrees.values() ?? []].some((row) => row.worktreePath === worktreePath);
  }

  async retain(intent: ArchiveCleanupIntent, worktree: DeferredArchiveWorktree): Promise<void> {
    for (const blocker of worktree.blockers) if (this.observations.has(blocker)) this.beginObservation(blocker);
    const resolved = await canonicalWorktreePaths()(worktree.worktreePath).catch(() => referencePath(worktree.worktreePath));
    // Removal can leave the supplied symlink dangling. Updates to its pending
    // row must retain the identity observed while the checkout still existed.
    const canonical = this.retainedKeys(worktree.worktreePath).values().next().value ?? resolved;
    const key = buildThreadIdentityKey(intent.backend, intent.threadId);
    let owner = this.owners.get(key);
    if (!owner) {
      owner = { seq: ++this.seq, intent, worktrees: new Map() };
      this.owners.set(key, owner);
    }
    const previous = owner.worktrees.get(canonical);
    this.additions += 1;
    this.setRow(key, owner, canonical, { ...previous, ...worktree, snapshot: worktree.snapshot ?? previous?.snapshot,
      blockers: [...new Set(worktree.blockers)], phase: worktree.blockers.length ? "waiting" : "retry" });
  }

  async fulfilled(worktreePath: string): Promise<void> {
    const canonical = await canonicalWorktreePaths()(worktreePath);
    const fulfilled = this.retainedKeys(worktreePath);
    fulfilled.add(canonical);
    for (const checkout of fulfilled) {
      for (const key of [...this.checkoutOwners.get(checkout) ?? []]) this.deleteRow(key, checkout);
    }
  }

  forgetOwner(key: string): void {
    const owner = this.owners.get(key);
    if (!owner) return;
    for (const checkout of [...owner.worktrees.keys()]) this.deleteRow(key, checkout);
  }

  intents(): ArchiveCleanupIntent[] {
    return [...this.owners.values()].map(({ intent, worktrees }) => ({ ...intent, deferredWorktrees: [...worktrees.values()].map((row) => this.record(row)) }));
  }

  recoveryIntents(): ArchiveCleanupIntent[] { return this.selectOwners([...this.owners.keys()], false); }
  readyIntents(key?: string): ArchiveCleanupIntent[] {
    const keys = key ? [key] : [...this.ready.keys()].sort((left, right) => this.owners.get(left)!.seq - this.owners.get(right)!.seq);
    return this.selectOwners(keys, true);
  }
  scheduled(intent: ArchiveCleanupIntent): void {
    const owner = this.owners.get(buildThreadIdentityKey(intent.backend, intent.threadId));
    const paths = new Set(intent.deferredWorktrees?.map((row) => row.worktreePath) ?? []);
    const selected = [...owner?.worktrees ?? []].filter(([, current]) => paths.has(current.worktreePath)).map(([checkout]) => checkout);
    for (const checkout of selected) {
      // setRow reindexes the owner; iterate a copy of the live set.
      for (const key of [...this.checkoutOwners.get(checkout) ?? []]) {
        const current = this.owners.get(key)!;
        const row = current.worktrees.get(checkout)!;
        this.setRow(key, current, checkout, { ...row, phase: "checking" });
      }
    }
  }
  pending(intent: ArchiveCleanupIntent): DeferredArchiveWorktree[] {
    const owner = this.owners.get(buildThreadIdentityKey(intent.backend, intent.threadId));
    const current = new Set([...owner?.worktrees.values() ?? []].map((row) => row.worktreePath));
    return (intent.deferredWorktrees ?? []).filter((row) => current.has(row.worktreePath));
  }

  /** Invalidate before the first read. A late completion cannot release a
   * reference which a newer directory mutation has changed again. */
  beginObservation(key: string): number {
    const generation = (this.observations.get(key) ?? 0) + 1;
    this.observations.set(key, generation);
    return generation;
  }

  async observe(key: string, generation: number, paths: readonly string[]): Promise<ArchiveCleanupIntent[]> {
    const affected = [...this.watchers.get(key)?.keys() ?? []];
    if (!affected.length) return [];
    const canonical = canonicalWorktreePaths();
    // An absent/relative path or failed read must never release ownership.
    const observed = await Promise.all(paths.map(canonical));
    if (this.observations.get(key) !== generation) return [];
    for (const ownerKey of affected) {
      const owner = this.owners.get(ownerKey);
      if (!owner) continue;
      for (const [checkout, worktree] of [...owner.worktrees]) {
        if (!worktree.blockers.includes(key)) continue;
        if (observed.some((value) => value === checkout || value.startsWith(checkout + path.sep))) continue;
        const blockers = worktree.blockers.filter((blocker) => blocker !== key);
        this.setRow(ownerKey, owner, checkout, { ...worktree, blockers, phase: blockers.length ? worktree.phase : "ready" });
      }
    }
    affected.sort((left, right) => (this.owners.get(left)?.seq ?? 0) - (this.owners.get(right)?.seq ?? 0));
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
        if (selected.has(checkout) || (readyOnly && !isReady(worktree))) continue;
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
    return new Set(this.supplied.get(referencePath(worktreePath))?.keys() ?? []);
  }

  private setRow(key: string, owner: Owner, checkout: string, row: PendingWorktree): void {
    const previous = owner.worktrees.get(checkout);
    if (previous) this.unindex(key, checkout, previous);
    owner.worktrees.set(checkout, row);
    this.index(key, checkout, row);
  }

  private deleteRow(key: string, checkout: string): void {
    const owner = this.owners.get(key);
    const row = owner?.worktrees.get(checkout);
    if (!owner || !row) return;
    this.unindex(key, checkout, row);
    owner.worktrees.delete(checkout);
    if (!owner.worktrees.size) this.owners.delete(key);
  }

  private index(key: string, checkout: string, row: PendingWorktree): void {
    // Failed attempts without a known blocker wait for startup or an
    // explicit retry, never a timer or their own archive completion.
    for (const blocker of row.blockers) count(this.watchers, blocker, key, 1);
    let owners = this.checkoutOwners.get(checkout);
    if (!owners) this.checkoutOwners.set(checkout, owners = new Set());
    owners.add(key);
    count(this.supplied, referencePath(row.worktreePath), checkout, 1);
    if (isReady(row)) this.ready.set(key, (this.ready.get(key) ?? 0) + 1);
  }

  private unindex(key: string, checkout: string, row: PendingWorktree): void {
    for (const blocker of row.blockers) count(this.watchers, blocker, key, -1);
    const owners = this.checkoutOwners.get(checkout);
    owners?.delete(key);
    if (owners && !owners.size) this.checkoutOwners.delete(checkout);
    count(this.supplied, referencePath(row.worktreePath), checkout, -1);
    if (isReady(row)) {
      const remaining = (this.ready.get(key) ?? 1) - 1;
      if (remaining) this.ready.set(key, remaining);
      else this.ready.delete(key);
    }
  }
}

function isReady(row: PendingWorktree): boolean {
  return row.phase === "ready" && row.blockers.length === 0;
}

function count(map: Map<string, Map<string, number>>, outer: string, inner: string, delta: number): void {
  let counts = map.get(outer);
  if (!counts) map.set(outer, counts = new Map());
  const next = (counts.get(inner) ?? 0) + delta;
  if (next > 0) counts.set(inner, next);
  else counts.delete(inner);
  if (!counts.size) map.delete(outer);
}
