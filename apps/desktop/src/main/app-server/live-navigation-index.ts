import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import { normalizeRenamedTitleSource } from "@pwragent/shared/contracts/normalized-app-server";
import type { AppServerBackendKind, AppServerBackendScope, AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { buildThreadIdentityKey, parseThreadIdentityKey, type NavigationThreadSummary, type NavigationIdentity } from "@pwragent/shared/contracts/navigation";
import { NAVIGATION_LIVE_INDEX_RECONCILED_METHOD, navigationInvalidationMayChangeMembership, navigationQueryEventRequiresRefresh } from "@pwragent/shared/navigation-query-events";
import { compactNavigationProviderRow } from "@pwragent/shared/navigation-state";
import { createNavigationQuerySnapshot, replaceNavigationQueryRows, type NavigationQueryIndex } from "@pwragent/owner-core/navigation-query-projection";
import { nextNavigationObservation } from "./navigation-observation-clock";
import { isDeepStrictEqual } from "node:util";

type ProviderRow = AppServerThreadSummary & { nativeSubAgentCount?: number };
type ApplyViewer = (index: NavigationQueryIndex) => NavigationQueryIndex;
export type NavigationViewerProjection = {
  source: object;
  /** Local rows and directory positions precede all mounted peers. */
  appendsPins?: true;
  prepare(): Promise<ApplyViewer>;
};
type ViewerState = {
  epoch: number;
  version: string;
  requestedVersion: string;
  prepare?: Promise<void>;
  apply?: ApplyViewer;
  page?: { owner: NavigationQueryIndex; index: NavigationQueryIndex };
};

type Listing = { rows: AppServerThreadSummary[]; coverage: NavigationQueryIndex["coverage"]; verifyAfterSeed?: boolean; checkoutsAfterSeed?: boolean };
type RowChange = {
  backend: AppServerBackendKind;
  id: string;
  enrichment?: boolean;
  removed?: boolean;
  discovered?: boolean;
  listing?: ProviderRow;
  directoriesChanged?: boolean;
  provider?: Partial<ProviderRow>;
};
type Source = {
  backend: AppServerBackendScope;
  recheckMs?: number;
  visibility?(observedAt: number): (index: NavigationQueryIndex) => void;
  version(): string;
  sqlite(rows: ProviderRow[]): Promise<ProviderRow[]>;
  changedKeys(before: string, after: string): string[] | undefined;
  list(scope: AppServerBackendScope, saved: boolean): Promise<Listing>;
  status?(row: ProviderRow): ProviderRow["threadStatus"];
  cached(backend: AppServerBackendKind, id: string): AppServerThreadSummary | undefined;
  join(rows: ProviderRow[], coverage: NavigationQueryIndex["coverage"], checkouts: "saved" | "reuse" | "refresh"): Promise<NavigationQueryIndex>;
  decorate?(rows: NavigationThreadSummary[]): NavigationThreadSummary[];
  forget?(key: string): void;
  dependents?(key: string): Iterable<string> | undefined;
  projectRows(rows: ProviderRow[], hasProvider: (key: string) => boolean): Promise<NavigationThreadSummary[]>;
  directories(rows: NavigationThreadSummary[]): Promise<Pick<NavigationQueryIndex, "directories" | "directoryCaseAliases" | "worktreeProjectAliases" | "worktreeRepositorySources">>;
  inputKeys(): ReadonlySet<string>;
  notify(): void;
  failed(error: unknown): void;
};

function compact(row: ProviderRow): ProviderRow {
  return structuredClone({ ...compactNavigationProviderRow(row), nativeSubAgentCount: row.codexNativeSubAgents?.length ?? row.nativeSubAgentCount ?? 0 });
}

function key(row: AppServerThreadSummary): string {
  return buildThreadIdentityKey(row.source, row.id);
}

function directoryInputsChanged(previous: NavigationThreadSummary | undefined, row: NavigationThreadSummary | undefined): boolean {
  return !previous || !row || (previous.updatedAt ?? 0) > (row.updatedAt ?? 0)
    || previous.projectKey !== row.projectKey || previous.gitOriginUrl !== row.gitOriginUrl
    || previous.createdAt !== row.createdAt || !isDeepStrictEqual(previous.linkedDirectories, row.linkedDirectories);
}

/** One writer per owner/scope. Readers retain immutable observations through asynchronous page projection.
 * Gaps request replacement inputs. A row notice received during replacement is drained before publication.
 */
export class LiveNavigationIndex {
  private providers = new Map<string, ProviderRow>();
  private rows = new Map<string, NavigationThreadSummary>();
  private positions = new Map<string, number>();
  private publishedPositions = this.positions;
  private snapshot?: NavigationQueryIndex;
  private lastPatch?: { from: WeakRef<NavigationQueryIndex>; to: NavigationQueryIndex; rows: number[]; directories: number[] };
  private directoryPositions = new Map<string, number[]>();
  private changes = new Map<string, RowChange>();
  private readonly gaps = new Set<AppServerBackendScope | "overlay" | "saved" | "checkout">();
  private pending?: Promise<void>;
  private reconciling = false;
  private background?: ReturnType<typeof Promise.withResolvers<void>>;
  private version: string;
  private disposed = false;
  private needsRetry = false;
  private scheduled?: NodeJS.Immediate;
  private viewerEpoch = 0;
  private visibilityChanged = true;
  private lastDiscovery = 0;
  private readonly viewers = new WeakMap<object, ViewerState>();

  constructor(private readonly source: Source) {
    this.version = source.version();
  }

  close(): void {
    this.disposed = true;
    if (this.scheduled) clearImmediate(this.scheduled);
  }

  private schedule(): void {
    if (this.scheduled || this.pending || !this.snapshot || this.disposed) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      void this.start().catch((error: unknown) => this.source.failed(error));
    });
  }

  private mark(change: RowChange): void {
    if (this.source.backend !== "all" && this.source.backend !== change.backend) return;
    const id = buildThreadIdentityKey(change.backend, change.id);
    const previous = this.changes.get(id);
    this.changes.set(id, {
      ...previous, ...change,
      enrichment: change.enrichment === true && (!previous || previous.enrichment === true),
      directoriesChanged: change.directoriesChanged || previous?.directoriesChanged,
      removed: change.discovered ? false : change.removed || previous?.removed,
      discovered: change.discovered || previous?.discovered,
      provider: { ...previous?.provider, ...change.provider },
    });
  }

  refreshRows(keys: Iterable<string>, enrichment = false): void {
    for (const key of keys) {
      const row = this.providers.get(key);
      if (row && (!this.changes.has(key) || (!enrichment && this.changes.get(key)?.enrichment))) {
        this.mark({ backend: row.source, id: row.id, enrichment });
      }
    }
    this.schedule();
  }

  event(event: AgentEvent): void {
    const n = event.notification;
    if (n.method === "navigation/invalidated" && n.params.sourceMethod === NAVIGATION_LIVE_INDEX_RECONCILED_METHOD) return;
    if (n.method === "navigation/remoteThreadPins/changed" || n.method === "federation/peerStatus/changed"
      || n.method === "federation/eventStream/changed" || event.federationTarget?.scope === "remote") {
      if (n.method === "federation/peerStatus/changed" || navigationQueryEventRequiresRefresh(n.method, n.params)) this.viewerEpoch++;
      return;
    }
    if (n.method === "navigation/sidebarEnrichment/updated" || n.method === "pullRequest/status/updated"
      || !navigationQueryEventRequiresRefresh(n.method, n.params)) return;
    this.visibilityChanged ||= navigationInvalidationMayChangeMembership(n.method);
    if (n.method === "navigation/providerThreads/refreshed") {
      const provider = (n.params as { backend?: AppServerBackendKind }).backend;
      if (!provider || this.source.backend === "all" || this.source.backend === provider) this.gaps.add(provider ?? this.source.backend);
    } else if (n.method === "thread/pin/reordered") {
      for (const id of Object.keys(n.params.pinnedRanks ?? {})) {
        const ref = parseThreadIdentityKey(id);
        if (ref) this.mark({ backend: ref.backend, id: ref.threadId });
      }
      this.viewerEpoch++;
    } else {
      const params = n.params as { threadId?: string; parentThreadId?: string; thread?: { id?: string }; threadIds?: string[] };
      const ids = n.method === "navigation/threadDirectories/updated" ? params.threadIds
        : [params.threadId ?? params.thread?.id ?? params.parentThreadId];
      if (!ids?.length || !ids[0]) this.gaps.add("overlay");
      else for (const id of ids) {
        if (!id) continue;
        const status = n.method === "thread/status/changed" ? (n.params.status as { type?: unknown } | undefined)?.type
          : n.method === "turn/started" ? "active"
          : ["turn/completed", "turn/failed", "turn/cancelled"].includes(n.method) ? "idle" : undefined;
        const provider: Partial<ProviderRow> = {};
        if (status === "active" || status === "idle" || status === "unknown" || status === "notLoaded") provider.threadStatus = status;
        if (n.method === "thread/name/updated" && typeof n.params.threadName === "string" && n.params.threadName.trim()) {
          provider.title = n.params.threadName.trim();
          provider.titleSource = normalizeRenamedTitleSource(n.params.titleSource);
        }
        this.mark({ backend: event.backend, id, provider, directoriesChanged: n.method === "navigation/threadDirectories/updated",
          discovered: n.method === "thread/started" || n.method === "thread/unarchived", removed: n.method === "thread/archived" || n.method === "thread/deleted" });
      }
    }
    this.schedule();
  }

  private observeVersion(): void {
    const version = this.source.version();
    const before = this.version;
    if (before === version) return;
    this.version = version;
    if (version.split(/[|:]/, 1)[0] !== before.split(/[|:]/, 1)[0]) {
      this.gaps.add("saved");
      return;
    }
    const keys = this.source.changedKeys(before, version);
    if (!keys) this.gaps.add("overlay");
    else this.refreshRows(keys);
  }

  async read(): Promise<NavigationQueryIndex> {
    this.observeVersion();
    if (this.needsRetry || (this.snapshot && this.source.recheckMs && Date.now() - this.lastDiscovery >= this.source.recheckMs)) {
      this.gaps.add(this.source.backend);
    }
    if (this.snapshot && (this.gaps.size || this.reconciling)) {
      this.schedule();
      return this.snapshot;
    }
    if (!this.snapshot) await this.start();
    else if (this.pending || this.changes.size) {
      const pending = this.start();
      // A row edit normally completes before this read. Structural edits can
      // discover physical checkouts, in which case the last observation wins.
      await Promise.race([pending, this.background!.promise]);
    }
    return this.snapshot!;
  }

  attachments(ref: NavigationIdentity) {
    const position = this.publishedPositions.get(buildThreadIdentityKey(ref.backend, ref.threadId));
    return position === undefined ? [] : this.snapshot?.threads[position]?.prs ?? [];
  }

  async viewer(owner: NavigationQueryIndex, viewer: NavigationViewerProjection, version: string): Promise<NavigationQueryIndex> {
    let state = this.viewers.get(viewer.source);
    if (!state) this.viewers.set(viewer.source, state = { epoch: -1, version: "", requestedVersion: version });
    state.requestedVersion = version;
    const epoch = this.viewerEpoch;
    if (!state.prepare && (state.epoch !== epoch || state.version !== version)) {
      const cached = state.apply;
      state.prepare = viewer.prepare().then((apply) => {
        const current = epoch === this.viewerEpoch && state.requestedVersion === version;
        if (current || !cached) {
          state.apply = apply;
          state.page = undefined;
          state.version = version;
          state.epoch = epoch;
        }
        if ((cached || !current) && !this.disposed) this.source.notify();
      }).finally(() => { state.prepare = undefined; });
      if (cached) void state.prepare.catch((error: unknown) => this.source.failed(error));
    }
    if (!state.apply) await state.prepare;
    if (state.page?.owner === owner) return state.page.index;
    const page = state.page;
    const patch = this.lastPatch;
    let index: NavigationQueryIndex;
    if (viewer.appendsPins && page && page.owner === page.index) index = owner;
    else if (viewer.appendsPins && page && patch?.to === owner && patch.from.deref() === page.owner) {
      const rows = new Map(patch.rows.map((pos) => [pos, owner.threads[pos]!]));
      const counts = new Map(patch.directories.map((pos) => {
        const mounted = page.index.directories[pos]!;
        const local = owner.directories[pos]!;
        return [pos, { ...mounted, latestUpdatedAt: local.latestUpdatedAt,
          needsAttentionCount: mounted.needsAttentionCount + local.needsAttentionCount - page.owner.directories[pos]!.needsAttentionCount }] as const;
      }));
      index = replaceNavigationQueryRows(page.index, rows, owner.inputRequestThreadKeys ?? new Set(), owner.observedAt!, counts);
    } else index = createNavigationQuerySnapshot(state.apply!(owner), undefined, owner);
    state.page = { owner, index };
    return index;
  }

  private start(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = undefined;
    this.background = Promise.withResolvers<void>();
    this.pending = Promise.resolve().then(() => this.drain()).catch((error: unknown) => {
      this.needsRetry = true;
      throw error;
    }).finally(() => {
      this.pending = undefined;
      this.background = undefined;
      this.reconciling = false;
      if (!this.needsRetry && (this.gaps.size || this.changes.size)) this.schedule();
    });
    return this.pending;
  }

  private async drain(): Promise<void> {
    const observedAt = nextNavigationObservation();
    const prior = this.snapshot;
    let index = prior;
    this.needsRetry = false;
    this.observeVersion();
    const gaps = [...this.gaps];
    this.gaps.clear();
    this.reconciling = !index || Boolean(gaps.length);
    const visibility = this.reconciling || this.visibilityChanged ? this.source.visibility?.(observedAt) : undefined;
    this.visibilityChanged = false;
    // A named provider can replace just its partition while every other
    // provider and its overlay rows stay mounted.
    if (index && gaps.length && gaps.every((scope) => scope !== "checkout" && scope !== "saved" && scope !== "overlay" && scope !== this.source.backend)) {
      for (const scope of gaps) {
        if (scope === "checkout" || scope === "saved" || scope === "overlay") continue;
        const observed = await this.source.list(scope, false);
        const fresh = new Set<string>();
        const changes = new Map<string, RowChange>();
        for (const row of observed.rows) {
          if (row.source !== scope) continue;
          const id = key(row);
          fresh.add(id);
          const provider = compact(row);
          if (isDeepStrictEqual(provider, this.providers.get(id))) continue;
          changes.set(id, { backend: row.source, id: row.id, discovered: true, listing: provider });
        }
        if (observed.coverage?.state === "complete") for (const [id, row] of this.providers) {
          if (row.source === scope && !fresh.has(id)) changes.set(id, { backend: scope, id: row.id, removed: true });
        }
        index = await this.apply(index, changes);
        // A scoped success cannot certify coverage of another provider.
        if (observed.coverage?.state !== "complete" || index.coverage?.state !== "complete") this.gaps.add(this.source.backend);
      }
    } else if (!index || gaps.length) {
      const scopes = !index || gaps.includes(this.source.backend) ? [this.source.backend] : gaps;
      let coverage = index?.coverage;
      for (const scope of scopes) {
        if (scope === "overlay" || scope === "checkout") continue;
        if (scope === "saved") {
          const rows = await this.source.sqlite([...this.providers.values()]);
          this.providers = new Map(rows.map((row) => [key(row), compact(row)]));
          continue;
        }
        const providerScope = scope;
        this.lastDiscovery = Date.now();
        const listing = await this.source.list(providerScope, !prior);
        if (this.disposed) throw new Error("Navigation source was replaced.");
        // A failed provider listing has no authority to remove its saved rows.
        if (listing.coverage?.state === "complete" || !prior) {
          if (providerScope === this.source.backend) this.providers.clear();
          else for (const [id, row] of this.providers) if (row.source === scope) this.providers.delete(id);
        }
        for (const row of listing.rows) this.providers.set(key(row), compact(row));
        coverage = listing.coverage;
        if (!prior && listing.verifyAfterSeed) this.gaps.add(this.source.backend);
        else if (!prior && listing.checkoutsAfterSeed) this.gaps.add("checkout");
      }
      const joined = await this.source.join([...this.providers.values()], coverage, !prior ? "saved"
        : gaps.every((scope) => scope === "overlay" || scope === "saved") ? "reuse" : "refresh");
      if (this.disposed) throw new Error("Navigation source was replaced.");
      index = createNavigationQuerySnapshot({ ...joined, observedAt }, undefined, undefined, prior);
      this.rememberDirectories(index);
      this.rows = new Map(index.threads.map((row) => [key(row), row]));
      this.positions = new Map(index.threads.map((row, i) => [key(row), i]));
    }
    while (this.changes.size && !this.disposed) {
      const changes = this.changes;
      this.changes = new Map();
      index = await this.apply(index!, changes);
    }
    if (this.disposed) throw new Error("Navigation source was replaced.");
    if (this.lastPatch?.to !== index) this.lastPatch = undefined;
    this.snapshot = index;
    this.publishedPositions = this.positions;
    if (index && !this.gaps.size && !this.visibilityChanged) visibility?.(index);
    if (prior && this.reconciling) this.source.notify();
  }

  private rememberDirectories(index: NavigationQueryIndex): void {
    this.directoryPositions.clear();
    index.directories.forEach((directory, position) => {
      for (const id of directory.threadKeys) {
        const positions = this.directoryPositions.get(id);
        if (positions) positions.push(position);
        else this.directoryPositions.set(id, [position]);
      }
    });
  }

  private async apply(index: NavigationQueryIndex, changes: Map<string, RowChange>): Promise<NavigationQueryIndex> {
    const observedAt = nextNavigationObservation();
    for (const id of [...changes.keys()]) for (const child of this.source.dependents?.(id) ?? []) {
      const row = this.providers.get(child);
      if (row && !changes.has(child)) changes.set(child, { backend: row.source, id: row.id });
    }
    const inputs: ProviderRow[] = [];
    for (const [id, change] of changes) {
      if (change.enrichment) continue;
      if (change.removed) { this.providers.delete(id); this.source.forget?.(id); continue; }
      const previous = this.providers.get(id);
      if (!previous && !change.discovered) continue;
      const cached = change.listing ?? this.source.cached(change.backend, change.id);
      if (!previous && !cached) {
        this.gaps.add(change.backend);
        continue;
      }
      const base = change.listing ?? (cached && (!previous || change.discovered) ? compact(cached) : previous!);
      const provider = { ...base, ...change.provider };
      if (change.directoriesChanged && cached) {
        provider.projectKey = cached.projectKey;
        provider.linkedDirectories = structuredClone(cached.linkedDirectories);
        provider.gitOriginUrl = cached.gitOriginUrl;
        provider.gitBranch = cached.gitBranch;
        provider.observedGitBranch = cached.observedGitBranch;
      }
      if (cached?.updatedAt !== undefined && (provider.updatedAt ?? 0) < cached.updatedAt) provider.updatedAt = cached.updatedAt;
      provider.threadStatus = this.source.status?.(provider) ?? provider.threadStatus;
      if (change.discovered) delete provider.archivedAt;
      if (provider.source === "codex" && provider.projectKey && (previous?.projectKey !== provider.projectKey
        || !isDeepStrictEqual(previous.linkedDirectories, provider.linkedDirectories))) this.gaps.add("checkout");
      inputs.push(provider);
      this.providers.set(id, provider);
    }
    const base = inputs.length ? await this.source.projectRows(inputs, (key) => this.providers.has(key)) : [];
    for (const [id, change] of changes) {
      const row = change.enrichment && this.rows.get(id);
      if (row) base.push(row);
    }
    const projected = new Map((this.source.decorate?.(base) ?? base).map((row) => [key(row), row]));
    const replacements = new Map<number, NavigationThreadSummary>();
    let geometry = false;
    const directories = new Map<number, NavigationQueryIndex["directories"][number]>();
    for (const id of changes.keys()) {
      const row = projected.get(id);
      const previous = this.rows.get(id);
      if (isDeepStrictEqual(previous, row)) continue;
      geometry ||= directoryInputsChanged(previous, row);
      if (!geometry && previous && row && (previous.inbox.inInbox !== row.inbox.inInbox || previous.updatedAt !== row.updatedAt)) {
        for (const position of this.directoryPositions.get(id) ?? []) {
          const directory = directories.get(position) ?? index.directories[position]!;
          directories.set(position, { ...directory, latestUpdatedAt: Math.max(directory.latestUpdatedAt ?? 0, row.updatedAt ?? 0),
            needsAttentionCount: directory.needsAttentionCount + Number(row.inbox.inInbox) - Number(previous.inbox.inInbox) });
        }
      }
      if (row) {
        this.rows.set(id, row);
        if (previous) replacements.set(this.positions.get(id)!, row);
      } else this.rows.delete(id);
    }
    const inputRequestThreadKeys = this.source.inputKeys();
    if (!geometry) {
      const next = replaceNavigationQueryRows(index, replacements, inputRequestThreadKeys, observedAt, directories);
      if (index !== next) this.lastPatch = { from: new WeakRef(index), to: next, rows: [...replacements.keys()], directories: [...directories.keys()] };
      return next;
    }
    const threads = [...this.rows.values()];
    // If physical directory discovery spans a turn of the event loop, release
    // waiting displays and announce completion when the observation is ready.
    const release = setImmediate(() => {
      this.reconciling = true;
      this.background?.resolve();
    });
    const projects = await this.source.directories(threads).finally(() => clearImmediate(release));
    const next = createNavigationQuerySnapshot({ ...projects, coverage: index.coverage, threads, inputRequestThreadKeys,
      observedAt }, undefined, undefined, index);
    this.rememberDirectories(next);
    this.positions = new Map(next.threads.map((row, i) => [key(row), i]));
    return next;
  }
}
