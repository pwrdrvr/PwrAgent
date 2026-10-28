import { listingDiagnostics } from "../diagnostics/listing-diagnostics";
import type { NavigationQueryIndex } from "./navigation-query-projection";

const RETAINED_BYTE_BUDGET = 8 * 1024 * 1024;

/** Measure only enough of a snapshot to admit it. Native JSON serialization
 * runs on bounded row batches, avoiding one full temporary snapshot string.
 * The shell includes empty-array brackets; batches add contents and commas.
 * Every retained snapshot is charged exactly its original JSON UTF-8 size.
 */
function retainedIndexBytes(index: NavigationQueryIndex): number {
  const inputRequestThreadKeys = [...(index.inputRequestThreadKeys ?? [])];
  let bytes = Buffer.byteLength(JSON.stringify({
    ...index, threads: [], directories: [], inputRequestThreadKeys: [],
  }));
  if (bytes > RETAINED_BYTE_BUDGET) return bytes;
  for (const rows of [index.threads, index.directories, inputRequestThreadKeys]) {
    for (let offset = 0; offset < rows.length; offset += 128) {
      bytes += Buffer.byteLength(JSON.stringify(rows.slice(offset, offset + 128))) - 2 + (offset ? 1 : 0);
      if (bytes > RETAINED_BYTE_BUDGET) return bytes;
    }
  }
  return bytes;
}

/**
 * Called by a scan after its provider listing and before its SQLite
 * projection. It throws only when the scan should hand its readers to the
 * follow-up instead (see `NavigationIndexReadPool`).
 */
export type NavigationIndexCheckpoint = () => void;
type Load = (signal: AbortSignal, checkpoint: NavigationIndexCheckpoint) => Promise<NavigationQueryIndex>;
type Member = { pending: Pending };
type Pending = {
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
  private readonly retained = new Map<string, { index: NavigationQueryIndex; bytes: number; expires: number; timer: ReturnType<typeof setTimeout>; owner: Pending }>();
  private retainedBytes = 0;

  constructor(private readonly retentionMs = 0) {}

  private evict(key: string): void {
    const entry = this.retained.get(key);
    if (!entry) return;
    this.retained.delete(key);
    this.retainedBytes -= entry.bytes;
    clearTimeout(entry.timer);
    entry.owner.controller.abort();
  }

  private retain(key: string, index: NavigationQueryIndex, owner: Pending): void {
    if (!this.retentionMs || owner.stale || owner.controller.signal.aborted) return;
    const bytes = retainedIndexBytes(index);
    if (bytes > RETAINED_BYTE_BUDGET) return;
    this.evict(key);
    while (this.retained.size >= 8 || this.retainedBytes + bytes > RETAINED_BYTE_BUDGET) this.evict(this.retained.keys().next().value!);
    const timer = setTimeout(() => this.evict(key), this.retentionMs);
    timer.unref?.();
    this.retained.set(key, { index, bytes, expires: Date.now() + this.retentionMs, timer, owner });
    this.retainedBytes += bytes;
  }

  retainedUsage(): { entries: number; bytes: number } { return { entries: this.retained.size, bytes: this.retainedBytes }; }

  /** A change landed: the running scan stops admitting readers. */
  invalidate(key: string): void {
    const current = this.slots.get(key)?.current;
    if (current) current.stale = true;
    this.evict(key);
  }

  private start(key: string, slot: Slot, owned: Pending): void {
    owned.started = true;
    slot.current = owned;
    this.physical.add(owned);
    const settle = owned.settle!;
    owned.settle = undefined;
    const checkpoint = (): void => {
      if (owned.stale && !owned.inherited && slot.next?.members.size) throw new HandOff();
    };
    const traced = listingDiagnostics.trace("index", {}, () => owned.load(owned.controller.signal, checkpoint));
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
      const next = slot.next ??= this.create(owned.load, owned.version);
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
      listingDiagnostics.link("index", "coalesced", next.promise);
    }).finally(() => {
      this.physical.delete(owned);
      if (slot.current === owned) slot.current = undefined;
      const next = slot.next;
      slot.next = undefined;
      if (next) this.start(key, slot, next);
      else if (!slot.current && this.slots.get(key) === slot) this.slots.delete(key);
    });
  }

  private create(load: Load, version: string | undefined): Pending {
    const owned: Pending = { controller: new AbortController(), members: new Set(), version, stale: false, inherited: false,
      started: false, load, promise: undefined as unknown as Promise<NavigationQueryIndex> };
    owned.promise = new Promise<NavigationQueryIndex>((resolve, reject) => { owned.settle = { resolve, reject }; });
    // A reader that leaves sees its own rejection; no one else awaits this.
    owned.promise.catch(() => undefined);
    return owned;
  }

  read(key: string, load: Load, signal?: AbortSignal, version?: string): Promise<NavigationQueryIndex> {
    signal?.throwIfAborted();
    const retained = this.retained.get(key);
    if (retained && retained.owner.version === version && retained.expires > Date.now()) {
      listingDiagnostics.link("index", "cache-hit", retained.owner.promise);
      return Promise.resolve(retained.index);
    }
    if (retained) this.evict(key);
    if (this.readers >= 256) return Promise.reject(new Error("Navigation index consumer admission is full."));
    let slot = this.slots.get(key);
    let owned: Pending;
    const current = slot?.current;
    if (slot && current && !current.stale && current.version === version) {
      owned = current;
      listingDiagnostics.link("index", "coalesced", owned.promise);
    } else if (slot && current) {
      // The running scan predates this reader's changes, durable or evented.
      // Share the one follow-up; it has not read anything yet, so it takes
      // the latest version.
      current.stale = true;
      owned = slot.next ??= this.create(load, version);
      owned.version = version;
      listingDiagnostics.link("index", "coalesced", owned.promise);
    } else {
      if (this.physical.size >= 8) return Promise.reject(new Error("Navigation index source admission is full."));
      slot = {};
      this.slots.set(key, slot);
      owned = this.create(load, version);
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
        listingDiagnostics.link("index", "cancel", member.pending.promise);
        reject(signal?.reason ?? new Error("Navigation index read cancelled."));
      } };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      owned.promise.then((index) => { if (release()) resolve(index); }, (error) => { if (release()) reject(error); });
    });
  }

  usage(): { physical: number; readers: number } { return { physical: this.physical.size, readers: this.readers }; }
}
