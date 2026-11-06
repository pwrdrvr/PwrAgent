import path from "node:path";
import type { AppServerBackendKind, AppServerThreadSummary, ThreadOverlayState } from "@pwragent/shared";
import { canonicalWorktreePaths } from "./archive-worktree-references";

/** What a change notification says about the identity's archive membership. */
export type FleetChange = "archived" | "active" | "deleted" | "provider" | "overlay";

export type FleetRow = {
  key: string;
  backend: AppServerBackendKind;
  threadId: string;
  archived: boolean;
  /** The provider's identity-level row, before overlay links are merged. */
  base: AppServerThreadSummary;
  /** Identity-level row with the overlay's workspace links merged in. */
  thread: AppServerThreadSummary;
  overlay?: ThreadOverlayState;
  /** Every workspace path the row names: cwd, linked and retained checkouts. */
  paths: readonly string[];
  /** Linked directories the overlay marks as externally managed. */
  externalPaths: readonly string[];
  /** The provider names no workspace; overlay links cannot prove it disjoint. */
  unknownWorkspace?: boolean;
};

type Entry = FleetRow & {
  /** Canonical forms of `paths`; undefined when ownership is unknown. */
  canonical?: string[];
  /** Every path that resolved, indexed even when another one failed. */
  resolved: string[];
  /** Canonical path -> the supplied paths that resolved to it. */
  supplied: Map<string, string[]>;
  /** An external marker that cannot be resolved protects every checkout. */
  externalUnknown: boolean;
};

type Membership = "archived" | "active" | "deleted";
type Dirty = { epoch: number; changes: Set<FleetChange>; membership?: Membership };

function ancestors(value: string): string[] {
  const result: string[] = [];
  let current = value;
  for (;;) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) return result;
    current = parent;
  }
}

/**
 * Archive cleanup's view of the thread fleet for one queue batch.
 *
 * One complete provider and overlay read builds it. After that, the writers
 * and notifications that already fence removal admission mark single
 * identities dirty, and only those identities are read again. A change with no
 * identity, a foreign database writer, or a failed incremental read requests a
 * complete rebuild instead. Every mark carries an epoch: a read that started
 * before a newer mark can never settle that mark, so a stale async observation
 * cannot hide a later change.
 *
 * Lookups go through a canonical-path index, so a checkout's related threads
 * cost O(related + path depth) rather than a pass over the fleet. Threads whose
 * workspace cannot be resolved are related to every checkout.
 */
export class ArchiveFleetIndex {
  private readonly entries = new Map<string, Entry>();
  /** Canonical path -> identity -> its canonical paths equal to or inside it. */
  private readonly under = new Map<string, Map<string, Set<string>>>();
  /** Canonical path -> identities with exactly that path. */
  private readonly exact = new Map<string, Set<string>>();
  private readonly unknown = new Set<string>();
  private readonly externalUnknown = new Set<string>();
  private readonly byThreadId = new Map<string, Set<string>>();
  private readonly byParent = new Map<string, Set<string>>();
  private readonly dirty = new Map<string, Dirty>();
  /** Preliminary discovery results by canonical scope; see `memo`. */
  private readonly memos = new Map<string, { value?: unknown; keys: ReadonlySet<string> }>();
  private readonly memoScopesByKey = new Map<string, Set<string>>();
  /** Canonical path -> memo scopes equal to or inside it. */
  private readonly memoScopesUnder = new Map<string, Set<string>>();
  /** Path-scoped writes not yet covered by a complete read. */
  private readonly pathWrites: Array<{ epoch: number; path: string }> = [];
  private epoch = 0;
  private built = false;
  /** Epoch of the newest rebuild request not yet covered by a read. */
  private rebuildEpoch?: number;
  private resolve = canonicalWorktreePaths();
  /** Newest provider `updatedAt` known to be covered by this index. */
  codexWatermark?: number;
  /** Change tokens observed before the complete read began. */
  overlayToken?: string;
  claudeToken?: string;
  rebuildReason?: string;

  get size(): number { return this.entries.size; }
  get needsRebuild(): boolean { return !this.built || this.rebuildEpoch !== undefined; }
  get dirtyCount(): number { return this.dirty.size; }

  /** The epoch to pass to a read that begins now. */
  beginRead(): number {
    return ++this.epoch;
  }

  markDirty(key: string, change: FleetChange): void {
    const current = this.dirty.get(key);
    const dirty: Dirty = { epoch: ++this.epoch, changes: new Set(current?.changes ?? []), membership: current?.membership };
    dirty.changes.add(change);
    // Notifications arrive in order; the latest membership change wins.
    if (change === "archived" || change === "active" || change === "deleted") dirty.membership = change;
    this.dirty.set(key, dirty);
    this.forgetMemosOf(key);
  }

  /** A read already in flight cannot satisfy this request. */
  requestRebuild(reason: string): void {
    this.rebuildEpoch = ++this.epoch;
    this.rebuildReason ??= reason;
    this.forgetAllMemos();
  }

  /** A path-scoped workspace write whose identity is announced later. */
  async notePathWrite(paths: readonly string[]): Promise<void> {
    for (const value of paths.length ? paths : [""]) {
      if (!value || !path.isAbsolute(value)) {
        this.requestRebuild("workspace write without an absolute path");
        continue;
      }
      const epoch = ++this.epoch;
      try { this.pathWrites.push({ epoch, path: await canonicalWorktreePaths()(value) }); }
      catch { this.requestRebuild("workspace write path could not be resolved"); }
    }
  }

  /** True when a noted write could have attached a thread to this scope. */
  async pathWriteRelates(scopePath: string): Promise<boolean> {
    if (!this.pathWrites.length) return false;
    let scope: string;
    try { scope = await canonicalWorktreePaths()(scopePath); }
    catch { return true; }
    return this.pathWrites.some(({ path: value }) => within(scope, value) || within(value, scope));
  }

  dirtyEntries(): Array<{ key: string; epoch: number; changes: ReadonlySet<FleetChange>; membership?: Membership }> {
    return [...this.dirty].map(([key, { epoch, changes, membership }]) => ({ key, epoch, changes, membership }));
  }

  /** Clears a mark only when no newer change arrived during the read. */
  settle(key: string, epoch: number): void {
    const dirty = this.dirty.get(key);
    if (dirty && dirty.epoch <= epoch) this.dirty.delete(key);
  }

  /** Replace every row from one complete read that began at `epoch`. */
  async replaceAll(rows: readonly FleetRow[], epoch: number, observed: {
    codexWatermark?: number; overlayToken?: string; claudeToken?: string;
  }): Promise<void> {
    this.resolve = canonicalWorktreePaths();
    this.forgetAllMemos();
    this.entries.clear();
    this.under.clear();
    this.exact.clear();
    this.unknown.clear();
    this.externalUnknown.clear();
    this.byThreadId.clear();
    this.byParent.clear();
    for (const row of rows) await this.upsert(row);
    for (const [key, dirty] of this.dirty) if (dirty.epoch <= epoch) this.dirty.delete(key);
    // A write noted during the read may postdate the rows it touched.
    const pending = this.pathWrites.filter((write) => write.epoch > epoch);
    this.pathWrites.splice(0, this.pathWrites.length, ...pending);
    this.codexWatermark = observed.codexWatermark;
    this.overlayToken = observed.overlayToken;
    this.claudeToken = observed.claudeToken;
    this.built = true;
    // A request that arrived during the read still applies to its result.
    if (this.rebuildEpoch !== undefined && this.rebuildEpoch > epoch) return;
    this.rebuildEpoch = undefined;
    this.rebuildReason = undefined;
  }

  async upsert(row: FleetRow): Promise<void> {
    this.delete(row.key);
    await this.insert(row);
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.forgetMemosNear(key, entry.resolved, entry.canonical === undefined || entry.externalUnknown);
    this.entries.delete(key);
    this.unknown.delete(key);
    this.externalUnknown.delete(key);
    for (const value of entry.resolved) {
      remove(this.exact, value, key);
      for (const ancestor of ancestors(value)) {
        const keys = this.under.get(ancestor);
        keys?.delete(key);
        if (keys && !keys.size) this.under.delete(ancestor);
      }
    }
    remove(this.byThreadId, entry.threadId, key);
    const parent = entry.overlay?.parentThreadId;
    if (parent) remove(this.byParent, parent, key);
  }

  get(key: string): FleetRow | undefined {
    return this.entries.get(key);
  }

  rows(keys: Iterable<string>): FleetRow[] {
    const result: FleetRow[] = [];
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry) result.push(entry);
    }
    return result;
  }

  rowsForBackend(backend: AppServerBackendKind): FleetRow[] {
    return [...this.entries.values()].filter((row) => row.backend === backend);
  }

  /** Active rows grouped under this parent by the overlay. */
  childrenOf(parentThreadId: string): FleetRow[] {
    return this.rows(this.byParent.get(parentThreadId) ?? []).filter((row) => !row.archived);
  }

  withThreadId(threadId: string): FleetRow[] {
    return this.rows(this.byThreadId.get(threadId) ?? []);
  }

  /**
   * Identities whose workspace is the scope, inside it, or an ancestor of it,
   * plus every identity whose workspace or external marker is unknown.
   */
  async related(scopePath: string): Promise<Set<string>> {
    const result = new Set([...this.unknown, ...this.externalUnknown]);
    let scope: string;
    try { scope = await this.resolve(scopePath); }
    catch {
      // An unresolvable scope cannot prove any identity disjoint.
      for (const key of this.entries.keys()) result.add(key);
      return result;
    }
    for (const key of this.under.get(scope)?.keys() ?? []) result.add(key);
    for (const ancestor of ancestors(scope)) for (const key of this.exact.get(ancestor) ?? []) result.add(key);
    return result;
  }

  /**
   * The supplied paths of `key` that relate to any scope, or undefined when
   * every path must be considered: the owner is unknown, or a scope cannot be
   * resolved. An owner of hundreds of checkouts is related to each of them,
   * but only one of its paths is about any one checkout.
   */
  async relatedPaths(key: string, scopePaths: readonly string[]): Promise<string[] | undefined> {
    const entry = this.entries.get(key);
    if (!entry || !entry.canonical || entry.externalUnknown) return undefined;
    const result = new Set<string>();
    for (const scopePath of scopePaths) {
      let scope: string;
      try { scope = await this.resolve(scopePath); }
      catch { return undefined; }
      for (const value of this.under.get(scope)?.get(key) ?? []) for (const supplied of entry.supplied.get(value) ?? []) result.add(supplied);
      for (const ancestor of ancestors(scope)) for (const supplied of entry.supplied.get(ancestor) ?? []) result.add(supplied);
    }
    return [...result];
  }

  private async insert(row: FleetRow): Promise<void> {
    const entry: Entry = { ...row, resolved: [], supplied: new Map(), externalUnknown: false };
    const canonical: string[] = [];
    let unknown = row.paths.length === 0 || row.unknownWorkspace === true;
    for (const value of row.paths) {
      try {
        const resolved = await this.resolve(value);
        canonical.push(resolved);
        entry.supplied.set(resolved, [...entry.supplied.get(resolved) ?? [], value]);
      } catch { unknown = true; }
    }
    // External markers are also workspace paths, so they are indexed above;
    // here only an unresolvable one matters.
    for (const value of row.externalPaths) {
      try { await this.resolve(value); }
      catch { entry.externalUnknown = true; }
    }
    entry.resolved = [...new Set(canonical)];
    entry.canonical = unknown ? undefined : entry.resolved;
    this.entries.set(row.key, entry);
    if (!entry.canonical) this.unknown.add(row.key);
    if (entry.externalUnknown) this.externalUnknown.add(row.key);
    // Even an unknown row indexes the paths it could resolve.
    for (const value of entry.resolved) {
      add(this.exact, value, row.key);
      for (const ancestor of ancestors(value)) {
        let keys = this.under.get(ancestor);
        if (!keys) this.under.set(ancestor, keys = new Map());
        let paths = keys.get(row.key);
        if (!paths) keys.set(row.key, paths = new Set());
        paths.add(value);
      }
    }
    add(this.byThreadId, row.threadId, row.key);
    const parent = row.overlay?.parentThreadId;
    if (parent) add(this.byParent, parent, row.key);
    this.forgetMemosNear(row.key, entry.resolved, entry.canonical === undefined || entry.externalUnknown);
  }

  /**
   * Reuse one scope's preliminary discovery across jobs in the batch. Many
   * archived owners of one checkout would otherwise each enumerate the whole
   * group. A memo is dropped when any identity in it changes, when a row is
   * written near the scope, or when an unknown owner appears; a change during
   * `compute` keeps its result from being stored. Removal admission never
   * reads a memo.
   */
  async memo<T>(scopePath: string, compute: (keys: ReadonlySet<string>) => Promise<T>): Promise<T> {
    let scope: string;
    try { scope = await this.resolve(scopePath); }
    catch { return await compute(await this.related(scopePath)); }
    const existing = this.memos.get(scope);
    if (existing && "value" in existing) return existing.value as T;
    const keys = await this.related(scopePath);
    const slot: { value?: unknown; keys: ReadonlySet<string> } = { keys };
    this.memos.set(scope, slot);
    for (const key of keys) add(this.memoScopesByKey, key, scope);
    for (const ancestor of ancestors(scope)) add(this.memoScopesUnder, ancestor, scope);
    let value: T;
    try { value = await compute(keys); }
    catch (error) {
      if (this.memos.get(scope) === slot) this.forgetMemo(scope);
      throw error;
    }
    if (this.memos.get(scope) === slot) slot.value = value;
    return value;
  }

  private forgetMemo(scope: string): void {
    const slot = this.memos.get(scope);
    if (!slot) return;
    this.memos.delete(scope);
    for (const key of slot.keys) remove(this.memoScopesByKey, key, scope);
    for (const ancestor of ancestors(scope)) remove(this.memoScopesUnder, ancestor, scope);
  }

  private forgetAllMemos(): void {
    this.memos.clear();
    this.memoScopesByKey.clear();
    this.memoScopesUnder.clear();
  }

  private forgetMemosOf(key: string): void {
    for (const scope of [...this.memoScopesByKey.get(key) ?? []]) this.forgetMemo(scope);
  }

  /** A row written at these paths can join any scope it relates to. */
  private forgetMemosNear(key: string, paths: readonly string[], unknown: boolean): void {
    if (unknown) {
      this.forgetAllMemos();
      return;
    }
    this.forgetMemosOf(key);
    for (const value of paths) {
      for (const ancestor of ancestors(value)) if (this.memos.has(ancestor)) this.forgetMemo(ancestor);
      for (const scope of [...this.memoScopesUnder.get(value) ?? []]) this.forgetMemo(scope);
    }
  }
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

function remove(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  set?.delete(value);
  if (set && !set.size) map.delete(key);
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
