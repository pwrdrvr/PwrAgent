import { listingDiagnostics } from "../diagnostics/listing-diagnostics";
import type { NavigationQueryIndex } from "@pwragent/owner-core/navigation-query-projection";
import { navigationQuerySnapshotAuxiliaryBytes, navigationQuerySnapshotSharedThreads, navigationQuerySnapshotToken, releaseNavigationQuerySnapshotProjection } from "@pwragent/owner-core/navigation-query-projection";

const RETAINED_BYTE_BUDGET = 8 * 1024 * 1024;

/** Measure only enough of a snapshot to admit it. Native JSON serialization
 * runs on bounded row batches, avoiding one full temporary snapshot string.
 * The shell includes empty-array brackets; batches add contents and commas.
 * Every retained snapshot is charged exactly its original JSON UTF-8 size.
 */
function rowBytes(rows: readonly unknown[], start = 0, remaining = RETAINED_BYTE_BUDGET): number {
  let bytes = 0;
  for (let offset = start; offset < rows.length; offset += 128) {
    bytes += Buffer.byteLength(JSON.stringify(rows.slice(offset, offset + 128))) - 2 + (offset ? 1 : 0);
    if (bytes > remaining) break;
  }
  return bytes;
}

function retainedIndexBytes(index: NavigationQueryIndex, sharedRows: number, budget: number,
  sizeRows: (rows: readonly unknown[], start: number, remaining: number) => number): number {
  let bytes = Buffer.byteLength(JSON.stringify({ ...index, threads: [], directories: [], inputRequestThreadKeys: [],
    ...(index.stacks ? { stacks: [] } : {}),
  }));
  for (const [offset, stack] of (index.stacks ?? []).entries()) {
    if (bytes > budget) break;
    const { layers, ...header } = stack;
    bytes += Buffer.byteLength(JSON.stringify({ ...header, layers: [] })) + (offset ? 1 : 0);
    if (bytes <= budget) bytes += sizeRows(layers, 0, budget - bytes);
  }
  if (bytes <= budget) bytes += sizeRows(index.threads, sharedRows, budget - bytes);
  if (bytes <= budget) bytes += sizeRows(index.directories, 0, budget - bytes);
  if (bytes <= budget && index.inputRequestThreadKeys) bytes += rowBytes([...index.inputRequestThreadKeys], 0, budget - bytes);
  return bytes;
}

/**
 * Called by a scan after its provider listing and before its SQLite
 * projection. It throws only when the scan should hand its readers to the
 * follow-up instead (see `NavigationIndexReadPool`).
 */
export type NavigationIndexCheckpoint = () => void;
type Load = (signal: AbortSignal, checkpoint: NavigationIndexCheckpoint, previous: () => NavigationQueryIndex | undefined) => Promise<NavigationQueryIndex>;
type Member = { pending: Pending };
type Pending = {
  projection: boolean;
  controller: AbortController;
  members: Set<Member>;
  version?: string;
  /** A change landed after this scan began. Its readers still get it. */
  stale: boolean;
  /** It took readers from an overtaken scan, so it finishes no matter what. */
  inherited: boolean;
  started: boolean;
  load: Load;
  promise: Promise<NavigationQueryIndex>;
  settle?: { resolve: (index: NavigationQueryIndex) => void; reject: (error: unknown) => void };
};
type Slot = { current?: Pending; next?: Pending };

type Charge = { bytes: number; leases: number };
type ThreadCharge = Charge & { rows: NonNullable<ReturnType<typeof navigationQuerySnapshotSharedThreads>> };

class HandOff extends Error {}

/**
 * Shared physical reads with optional short, version-keyed, byte-bounded reuse.
 *
 * A change during a scan never fails or restarts it. It only stops later
 * readers from joining; they wait for one queued follow-up, which every
 * reader that arrives meanwhile shares. A key has at most one scan running
 * and one queued, however many changes land.
 *
 * An overtaken scan finishes for its readers, with one saving: if it is
 * still before its SQLite projection and the follow-up already has readers,
 * it hands its readers to that follow-up and stops. The follow-up has to run
 * anyway, so this adds no scan and skips a projection nobody would keep. A
 * scan that received readers this way never hands them on, so a reader waits
 * for at most two scans.
 */
export class NavigationIndexReadPool {
  private readonly slots = new Map<string, Slot>();
  private readonly physical = new Set<Pending>();
  private readers = 0;
  private readonly retained = new Map<string, { index: NavigationQueryIndex; backing: Charge; threads?: ThreadCharge; expires: number;
    discardAt: number; timer: ReturnType<typeof setTimeout>; owner: Pending }>();
  private readonly collectionBytes = new WeakMap<readonly unknown[], { start: number; bytes: number }>();
  private retainedBytes = 0;

  constructor(private readonly retentionMs = 0, private readonly revalidationMs = retentionMs) {}

  private evict(key: string): void {
    const entry = this.retained.get(key);
    if (!entry) return;
    this.retained.delete(key);
    if (--entry.backing.leases === 0) this.retainedBytes -= entry.backing.bytes;
    if (entry.threads && --entry.threads.leases === 0) this.retainedBytes -= entry.threads.bytes;
    clearTimeout(entry.timer);
    entry.owner.controller.abort();
  }

  private stopServing(key: string): void {
    const entry = this.retained.get(key);
    if (!entry || !entry.expires) return;
    const remaining = entry.discardAt - Date.now();
    if (remaining <= 0 || this.revalidationMs <= this.retentionMs || !navigationQuerySnapshotToken(entry.index)) {
      this.evict(key);
      return;
    }
    // The old inventory can certify identical backing in a fresh scan.
    // It cannot answer reads or keep its source subscription alive.
    entry.expires = 0;
    entry.owner.controller.abort();
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.evict(key), remaining);
    entry.timer.unref?.();
  }

  private retain(key: string, index: NavigationQueryIndex, owner: Pending): void {
    if (!this.retentionMs || owner.stale || owner.controller.signal.aborted) return;
    // Owner and viewer leases have independent generations and lifetimes.
    // Charge only certified identical objects together, including the native
    // row prefix when the viewer has appended pins. At most eight live keys.
    const rows = navigationQuerySnapshotSharedThreads(index);
    const sizeRows = (collection: readonly unknown[], start: number, remaining: number): number => {
      if (!rows) return rowBytes(collection, start, remaining);
      const cached = this.collectionBytes.get(collection);
      if (cached?.start === start) return cached.bytes;
      const bytes = rowBytes(collection, start, remaining);
      if (bytes <= remaining) this.collectionBytes.set(collection, { start, bytes });
      return bytes;
    };
    const entries = rows ? [...this.retained.values()] : [];
    const threads = rows ? entries.find((entry) => entry.threads?.rows === rows)?.threads
      ?? { rows, bytes: sizeRows(rows, 0, RETAINED_BYTE_BUDGET), leases: 0 } : undefined;
    const prefixBytes = threads?.bytes ?? 0;
    if (prefixBytes > RETAINED_BYTE_BUDGET) return;
    let backing = entries.find((entry) => entry.index === index)?.backing;
    if (!backing) {
      let bytes = retainedIndexBytes(index, rows?.length ?? 0, RETAINED_BYTE_BUDGET - prefixBytes, sizeRows);
      if (prefixBytes + bytes > RETAINED_BYTE_BUDGET) return;
      const auxiliaryBytes = navigationQuerySnapshotAuxiliaryBytes(index);
      if (prefixBytes + bytes + auxiliaryBytes > RETAINED_BYTE_BUDGET) {
        releaseNavigationQuerySnapshotProjection(index);
      } else bytes += auxiliaryBytes;
      backing = { bytes, leases: 0 };
    }
    if (backing.leases++ === 0) this.retainedBytes += backing.bytes;
    if (threads && threads.leases++ === 0) this.retainedBytes += threads.bytes;
    this.evict(key);
    while (this.retained.size >= 8 || this.retainedBytes > RETAINED_BYTE_BUDGET) this.evict(this.retained.keys().next().value!);
    const now = Date.now();
    const timer = setTimeout(() => this.stopServing(key), this.retentionMs);
    timer.unref?.();
    this.retained.set(key, { index, backing, threads, expires: now + this.retentionMs,
      discardAt: now + this.revalidationMs, timer, owner });
  }

  retainedUsage(): { entries: number; bytes: number } { return { entries: this.retained.size, bytes: this.retainedBytes }; }

  /** A change landed: the running scan stops admitting readers. */
  invalidate(key: string): void {
    const current = this.slots.get(key)?.current;
    if (current) current.stale = true;
    this.stopServing(key);
  }

  private start(key: string, slot: Slot, owned: Pending): void {
    owned.started = true;
    slot.current = owned;
    if (!owned.projection) this.physical.add(owned);
    const settle = owned.settle!;
    owned.settle = undefined;
    const checkpoint = (): void => {
      if (owned.stale && !owned.inherited && slot.next?.members.size) {
        listingDiagnostics.record(stage, "overtaken");
        throw new HandOff();
      }
    };
    const stage = owned.projection ? "viewer-index" : "index";
    const previous = () => {
      const entry = this.retained.get(key);
      if (entry && entry.discardAt > Date.now()) return entry.index;
    };
    const traced = listingDiagnostics.trace(stage, {}, () => owned.load(owned.controller.signal, checkpoint, previous));
    listingDiagnostics.remember(owned.promise, traced);
    traced.then((index) => {
      try {
        if (!owned.stale) this.retain(key, index, owned);
        settle.resolve(index);
      } catch (error) {
        settle.reject(error);
      }
    }, (error: unknown) => {
      if (!(error instanceof HandOff) || !owned.members.size) return settle.reject(error);
      // The follow-up's own readers may have left since the checkpoint.
      const next = slot.next ??= this.create(owned.load, owned.version, owned.projection);
      for (const member of owned.members) {
        member.pending = next;
        next.members.add(member);
      }
      owned.members.clear();
      // Nobody reads this scan now; end its lifetime and event listener.
      owned.stale = true;
      owned.controller.abort();
      next.inherited = true;
      next.promise.then(settle.resolve, settle.reject);
      listingDiagnostics.link(stage, "coalesced", next.promise);
    }).finally(() => {
      this.physical.delete(owned);
      if (slot.current === owned) slot.current = undefined;
      const next = slot.next;
      slot.next = undefined;
      if (next) this.start(key, slot, next);
      else if (!slot.current && this.slots.get(key) === slot) this.slots.delete(key);
    });
  }

  private create(load: Load, version: string | undefined, projection: boolean): Pending {
    const owned: Pending = { projection, controller: new AbortController(), members: new Set(), version, stale: false, inherited: false,
      started: false, load, promise: undefined as unknown as Promise<NavigationQueryIndex> };
    owned.promise = new Promise<NavigationQueryIndex>((resolve, reject) => { owned.settle = { resolve, reject }; });
    // A reader that leaves sees its own rejection; no one else awaits this.
    owned.promise.catch(() => undefined);
    return owned;
  }

  /** Derived viewer work shares reader/retention budgets but consumes no
   * physical source slot: its nested owner read owns that admission.
   */
  read(key: string, load: Load, signal?: AbortSignal, version?: string, kind: "source" | "projection" = "source"): Promise<NavigationQueryIndex> {
    signal?.throwIfAborted();
    const projection = kind === "projection";
    const stage = projection ? "viewer-index" : "index";
    const retained = this.retained.get(key);
    if (retained && retained.owner.version === version && retained.expires > Date.now()) {
      listingDiagnostics.link(stage, "cache-hit", retained.owner.promise);
      return Promise.resolve(retained.index);
    }
    if (retained) this.stopServing(key);
    if (this.readers >= 256) return Promise.reject(new Error("Navigation index consumer admission is full."));
    let slot = this.slots.get(key);
    let owned: Pending;
    const current = slot?.current;
    if (slot && current && !current.stale && current.version === version) {
      owned = current;
      listingDiagnostics.link(stage, "coalesced", owned.promise);
    } else if (slot && current) {
      // The running scan predates this reader's changes, durable or evented.
      // Share the one follow-up; it has not read anything yet, so it takes
      // the latest version.
      current.stale = true;
      owned = slot.next ??= this.create(load, version, projection);
      owned.version = version;
      listingDiagnostics.link(stage, "coalesced", owned.promise);
    } else {
      if (!projection && this.physical.size >= 8) return Promise.reject(new Error("Navigation index source admission is full."));
      slot = {};
      this.slots.set(key, slot);
      owned = this.create(load, version, projection);
      this.start(key, slot, owned);
    }
    const ownedSlot = slot;
    const member: Member = { pending: owned };
    owned.members.add(member);
    this.readers += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const release = (): boolean => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener("abort", abort);
        this.readers -= 1;
        // A hand-off may have moved this reader to the follow-up.
        const pending = member.pending;
        pending.members.delete(member);
        if (!pending.members.size) {
          if (!pending.started) {
            if (ownedSlot.next === pending) ownedSlot.next = undefined;
          } else if (this.retained.get(key)?.owner !== pending) {
            pending.stale = true;
            pending.controller.abort();
          }
        }
        return true;
      };
      const abort = (): void => { if (release()) {
        listingDiagnostics.link(stage, "cancel", member.pending.promise);
        reject(signal?.reason ?? new Error("Navigation index read cancelled."));
      } };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      owned.promise.then((index) => { if (release()) resolve(index); }, (error) => { if (release()) reject(error); });
    });
  }

  usage(): { physical: number; readers: number } { return { physical: this.physical.size, readers: this.readers }; }
}
