import { navigationDiagnosticCause, navigationDiagnosticTrigger, safeNavigationDiagnosticTrigger, type NavigationDiagnosticCause } from "../../../shared/navigation-diagnostic-cause";
import {
  createNavigationDiagnosticView, navigationDiagnosticOrigin, navigationDiagnosticPageShape, navigationListingDiagnostics,
  type NavigationSeenDecision, type NavigationSeenReason,
} from "./navigation-listing-diagnostics";
import {
  NAVIGATION_QUERY_MAX_PAGE_ROWS,
  NAVIGATION_QUERY_MAX_RESULT_BYTES,
} from "@pwragent/shared/contracts/navigation";
import { navigationQueryPageBudgetBytes } from "@pwragent/shared/navigation-remote-owner";
import {
  navigationInvalidationMayChangeMembership,
  NAVIGATION_SIDEBAR_ENRICHMENT_UPDATED_METHOD,
  navigationPullRequestKeysMayMatch,
  navigationQueryEventRequiresRefresh,
  navigationWorkingStatePath,
  readNavigationDirectoryScope,
} from "@pwragent/shared/navigation-query-events";
import { readDirectoryGitProof, readDirectoryGitRevisions, readNavigationMetadataDependencies } from "@pwragent/shared/navigation-metadata-dependencies";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import { federationTargetKey, type FederationTarget } from "@pwragent/shared/contracts/federation";
import type {
  NavigationDirectoryGitRevisions,
  NavigationIdentity,
  NavigationMetadataDependencies,
  NavigationQueryAnchor,
  NavigationQueryEntry,
  NavigationQueryPage,
  NavigationQueryRequest,
} from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "./desktop-api";
import { federationTargetsEqual } from "./federated-thread-events";
import {
  applyNavigationPage, beginNavigationPageRead, createNavigationPageState,
  failNavigationPageRead, isNavigationAnchorMissing, isNavigationContinuationInvalid,
  isNavigationCursorExpired, navigationAnchorsEqual,
  navigationFallbackAnchor, navigationIdentitiesEqual, navigationIdentityKey, navigationRetainedRange, type NavigationPageState,
} from "./navigation-query-state";

// Changes to one owner's threads or checkouts. A PR status can affect a local thread
// through its forge identity and therefore does not belong in this set.
const OWNER_ROW_CHANGES = new Set([
  "thread/started", "thread/archived", "thread/unarchived", "thread/deleted", "thread/parent/set", "thread/parent/cleared",
  "thread/pin/added", "thread/pin/removed", "thread/pin/reordered", "thread/subthreadsCollapsed/updated", "thread/subthreadOrder/updated",
  "thread/settled/updated", "thread/status/changed", "thread/subAgents/updated", "thread/name/updated", "thread/modelSettings/updated",
  "thread/backgroundTasks/updated", "thread/turnQueue/updated", "navigation/thread/seen", "federation/peerStatus/changed",
  "turn/started", "turn/completed", "turn/failed", "turn/cancelled", "navigation/directoryGitStatus/updated",
  "navigation/threadDirectories/updated",
]);
const MAX_CONCURRENT_READS = 4;
const MAX_DEMAND_BYTES = 1024 * 1024;
const MAX_RETAINED_BYTES = 8 * 1024 * 1024;
const MAX_RECENT_PIN_PUBLICATIONS = 64;
const MAX_WORKING_STATE_PATHS_PER_READ = 32;
const MAX_SEEN_THREADS_PER_READ = 32;
/** One click loads a block of rows. Demand page sizes pace a first paint; an
 * explicit continuation is the operator asking for the rest, and answering it
 * with one transport page costs a click and a scroll for every page. */
const LOAD_MORE_ROWS = 100;
/** An owner that clamps a page to the byte budget still finishes a click in a
 * few reads. The chain is bounded so it can never become an unbounded scan. */
const MAX_LOAD_MORE_READS = 8;
/** A click also spends at most one read deadline chasing the rest of its
 * block. A slow owner ends it with the rows it did deliver and the button
 * still in place, rather than with a spinner whose length nobody can bound. */
const MAX_LOAD_MORE_MS = 10_000;
const RESUME_BUDGET_REACHED = Symbol("navigation-resume-budget");
let nextWindow = 0;

export type NavigationWindowResource = {
  id: string;
  state: NavigationPageState;
  loading: boolean;
  /** Cached membership awaiting a fresh owner read; existing row metadata wins. */
  restoredFromCache?: boolean;
  /** Latest publication extends a previously accepted immutable owner generation. */
  extendedFromCursor?: boolean;
};
export type NavigationWindowQueriesState = {
  resources: ReadonlyMap<string, NavigationWindowResource>;
  admissionError?: string;
};
type WindowPageRows = Pick<NavigationQueryPage, "ownerEpoch" | "queryKey" | "remoteOwner" | "entries" | "directories">;

/** A retained range can have a new page shell or append another block. Keep only
 * weak references to its individual rows so mounted rows remain usable as a base. */
function rememberWindowPage(page: NavigationQueryPage, token: string) {
  const { ownerEpoch, queryKey, remoteOwner } = page;
  const entries = page.entries.map((row) => new WeakRef(row));
  const directories = page.directories?.map((row) => new WeakRef(row));
  return { token, rows(): WindowPageRows | undefined {
    const liveEntries = entries.map((ref) => ref.deref());
    const liveDirectories = directories?.map((ref) => ref.deref());
    if (!liveEntries.every((row) => row !== undefined) || (liveDirectories && !liveDirectories.every((row) => row !== undefined))) return undefined;
    return { ownerEpoch, queryKey, remoteOwner, entries: liveEntries, directories: liveDirectories };
  } };
}

export function expandWindowNavigationPage(page: NavigationQueryPage, baseline?: WindowPageRows,
  token?: string): NavigationQueryPage | undefined {
  const { windowPagePatch: patch, ...result } = page;
  if (!patch?.slots) return patch?.base ? undefined : result;
  if (!baseline || token !== patch.base || page.ownerEpoch !== baseline.ownerEpoch || page.queryKey !== baseline.queryKey
    || page.remoteOwner?.instanceId !== baseline.remoteOwner?.instanceId || patch.slots.length > NAVIGATION_QUERY_MAX_PAGE_ROWS) return undefined;
  function expand<T>(previous: T[], replacements: T[], slots: number[]): T[] | undefined {
    let changed = 0;
    const rows: T[] = [];
    for (const slot of slots) {
      const row = slot === -1 ? replacements[changed++] : Number.isInteger(slot) ? previous[slot] : undefined;
      if (!row) return undefined;
      rows.push(row);
    }
    return changed === replacements.length ? rows : undefined;
  }
  if (patch.directories) {
    const directories = expand(baseline.directories ?? [], page.directories ?? [], patch.slots);
    return directories && { ...result, directories };
  }
  const entries = expand(baseline.entries, page.entries, patch.slots);
  if (!entries) return undefined;
  for (const [position, orderKey] of Object.entries(patch.orderKeys ?? {})) {
    const index = Number(position);
    if (!Number.isSafeInteger(index) || !entries[index] || typeof orderKey !== "string") return undefined;
    entries[index] = { ...entries[index]!, orderKey };
  }
  return { ...result, entries };
}

type Resource = {
  wireBase?: ReturnType<typeof rememberWindowPage>;
  diagnosticResource: number;
  diagnosticBatch?: number;
  diagnosticRefreshBatch?: number;
  diagnosticLogical?: number;
  diagnosticTrigger?: string;
  diagnosticCaller?: string;
  diagnosticCause?: NavigationDiagnosticCause;
  diagnosticInvalidations?: number;
  requestKey: string;
  token: string;
  value: NavigationWindowResource;
  pending?: Promise<void>;
  refreshCompletion?: Promise<void>;
  /** Metadata notices observed after dispatch and awaiting the replacement baseline. */
  membershipRead?: {
    paths: Set<string>;
    batch?: number;
    cause?: NavigationDiagnosticCause;
    trigger?: string;
    seen?: { batches: Map<string, number>; count: number; diagnosticGeneration?: number };
  };
  /** A correlated viewer pin publication is waiting for this resource. */
  pinPublicationPending?: boolean;
  refreshAfterPending: boolean;
  invalidated: boolean;
  /** Row metadata can be stale while complete membership still excludes unrelated events. */
  membershipUncertain?: boolean;
  /** Complete child identity does not prove PR attachments during their replacement. */
  prAttachmentsUncertain?: boolean;
  released: boolean;
  anchor?: NavigationQueryAnchor;
  /** Explicit continuation demand survives a short final page and later growth. */
  expandedRows?: number;
  resumeExpansion?: boolean;
  resumeBudget?: ResumeBudget;
  /** `navigationResumeQueryKey` of the request, computed once per resource. */
  resumeKey?: string;
};
/** One opening restores saved depth within one Load more click's bounds. Lists
 * opened together share it; the clock starts at the first read. */
type ResumeBudget = { reads: number; until?: number };
type OwnerPageProof = {
  dependencies?: NavigationMetadataDependencies;
  viewerRowOwners?: readonly string[];
  directoryGitProof?: NavigationQueryPage["directoryGitProof"];
  gitBytes: number;
  bytes: number;
};
type RetainableState = { state: NavigationPageState; ownerProof?: OwnerPageProof };
type ReplyDiagnostic = ReturnType<typeof navigationDiagnosticPageShape> & {
  generation: number;
  logical: number;
  attempt: number;
};
type SeenDecisionDiagnostic = {
  batch?: number;
  logical?: number;
  seenReason: NavigationSeenReason;
  seenDecision: NavigationSeenDecision;
  proofPresent?: boolean;
  proofAdmitted?: boolean;
};

function loadedRows(page: NavigationQueryPage | undefined): number {
  return page?.modelGroups?.length || page?.directories?.length || page?.entries.length || 0;
}

/** Semantic demand ignores object insertion order and identity-set ordering. */
export function navigationDemandKey(request: NavigationQueryRequest): string {
  return JSON.stringify(request, (key, value: unknown) => {
    if (key === "readReason" || key === "deadlineAt" || key === "diagnostic" || key === "windowPageBase") return undefined;
    if (Array.isArray(value) && ["identities", "roots", "keys"].includes(key)) {
      return [...value].sort((a, b) => JSON.stringify(a, Object.keys(a ?? {}).sort()).localeCompare(JSON.stringify(b, Object.keys(b ?? {}).sort())));
    }
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value;
  });
}

/** Stable across renderer lifetimes, but distinct for every lens/owner/collection. */
export function navigationResumeQueryKey(request: NavigationQueryRequest): string {
  return navigationDemandKey({ protocol: 2, consumer: "main-sidebar", query: request.query,
    inventory: request.inventory, backend: request.backend, federationTarget: request.federationTarget });
}

/** Prepared at the window's immutable demand boundary, never cached by caller object identity. */
export function prepareNavigationDemand(demand: ReadonlyMap<string, NavigationQueryRequest>) {
  const entries = new Map<string, { request: NavigationQueryRequest; requestKey: string }>();
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const [id, request] of demand) {
    bytes += encoder.encode(JSON.stringify([id, request])).byteLength;
    if (bytes > MAX_DEMAND_BYTES) break;
    entries.set(id, { request, requestKey: navigationDemandKey(request) });
  }
  return { entries, admissionError: entries.size !== demand.size
    ? "Navigation request metadata exceeds its memory budget." : undefined };
}

/** Window demand and loaded ranges only. All I/O shares the main-process query pool. */
export class NavigationWindowQueries {
  private readonly prefix = `navigation-window:${++nextWindow}`;
  private nextResource = 0;
  private readonly resources = new Map<string, Resource>();
  // Released transport leases need not discard the view. Keep recently used
  // ranges window-local, sharing the same byte budget as active resources.
  private readonly retained = new Map<string, { state: NavigationPageState; anchor?: NavigationQueryAnchor; expandedRows?: number; bytes: number }>();
  // Queries explicitly expanded via Load more during this window's lifetime.
  // Distinguishes in-instance operator intent from cold-startup resume state.
  private readonly sessionExpandedQueries = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private visible = true;
  private disposed = false;
  private activeReads = 0;
  private activePageBytes = 0;
  private ownerProofBytes = 0;
  // Optional proofs are only held for active pages and can be evicted without
  // replacing a published page or invalidating its rows.
  private readonly ownerPageProofs = new Map<NavigationQueryPage, OwnerPageProof>();
  private readonly pageSizes = new WeakMap<NavigationQueryPage, number>();
  private readonly pageDependencies = new WeakMap<NavigationQueryPage, NavigationMetadataDependencies | undefined>();
  private readonly recentPinPublications = new Set<string>();
  private readonly readWaiters = new Set<() => void>();
  private readonly pendingWindowRefreshes = new Map<string, Promise<void>>();
  private snapshot: NavigationWindowQueriesState = { resources: new Map() };

  private nextLogical = 0;
  private nextDiagnosticBatch = 0;
  private nextDiagnosticRead = 0;
  constructor(private readonly api: Pick<DesktopApi, "getNavigationQueryPage" | "releaseNavigationQuery">,
    private readonly diagnostic = { view: createNavigationDiagnosticView(), effect: 1 },
    private readonly resume: {
      loadedRowsByQuery?: Readonly<Record<string, number>>;
      onLoadMore?: (queryKey: string, rows: number) => void;
      onRangeReset?: (queryKey: string) => void;
    } = {}) {
    navigationListingDiagnostics.record({ ...diagnostic, phase: "effect" });
  }

  getSnapshot = (): NavigationWindowQueriesState => this.snapshot;
  /** Base demand keys survive refreshes and continuations without reserialization. */
  matchesDemand(demand: ReturnType<typeof prepareNavigationDemand>, snapshot: NavigationWindowQueriesState): boolean {
    if (snapshot !== this.snapshot || demand.admissionError || this.resources.size !== demand.entries.size) return false;
    for (const [id, { requestKey }] of demand.entries) {
      if (this.resources.get(id)?.requestKey !== requestKey) return false;
    }
    return true;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(): void {
    const admissionError = this.snapshot.admissionError;
    this.snapshot = { resources: new Map([...this.resources].map(([id, resource]) => [id, resource.value])), admissionError };
    for (const listener of this.listeners) listener();
  }

  private release(resource: Resource): void {
    this.finishResume(resource);
    navigationListingDiagnostics.record({ ...this.diagnostic, phase: "cancel", logical: resource.diagnosticLogical, count: resource.pending ? 1 : 0 });
    resource.released = true;
    resource.membershipRead = undefined;
    // Every lifetime has its own token: a delayed release cannot cancel its successor.
    void this.api.releaseNavigationQuery?.(resource.token).catch(() => undefined);
    this.wakeReaders();
  }

  private retainedKey(id: string, requestKey: string): string {
    return JSON.stringify([id, requestKey]);
  }

  /** Presentation ancestry only, never a response to the new exact query.
   * Borrow from the existing bounded range pool while a clicked, admitted
   * child resolves. Its current scoped placement must still reach that root. */
  selectionAncestry(selection: NavigationIdentity, target: FederationTarget | undefined,
    snapshot: NavigationWindowQueriesState): NavigationQueryPage | undefined {
    if (this.disposed) return undefined;
    const id = selection.ownerInstanceId && target?.scope !== "remote" ? "selected-viewer-mount" : "selected-context";
    const selectedResource = snapshot.resources.get(id);
    const selected = selectedResource?.state;
    const matches = (state: NavigationPageState | undefined): boolean => state?.request.query.kind === "exact"
      && state.request.query.identities.length === 1 && navigationIdentitiesEqual(state.request.query.identities[0]!, selection);
    if (!selectedResource?.restoredFromCache && matches(selected) && federationTargetsEqual(selected?.request.federationTarget, target)
      && (selected?.page || selected?.error)) return selected.error ? undefined : selected.page;
    const ownerResource = snapshot.resources.get("selected-context");
    const owner = ownerResource?.state;
    if (matches(owner) && owner?.error) return undefined;
    // Restored ranges supply provisional membership. Their old absence or
    // relationship cannot supersede the child the operator just clicked.
    const freshOwner = matches(owner) && !ownerResource?.restoredFromCache && !owner?.stale;
    const ownerRow = freshOwner && owner?.page
      ? owner.page.entries.find(({ row }) => navigationIdentitiesEqual(row.ref, selection))?.row : undefined;
    if (freshOwner && owner?.page && !ownerRow) return undefined;
    const candidates = [selected, ...[...this.retained.values()].reverse().map((entry) => entry.state)];
    const scopedPlacements = new Map<string, Map<string, NavigationQueryEntry>>();
    for (const candidate of candidates) {
      const query = candidate?.request.query;
      const page = candidate?.page;
      if (!candidate || candidate.error || query?.kind !== "exact" || query.identities.length !== 1 || !query.includeAncestry || query.ancestryScope !== "directory"
        || candidate.request.inventory !== (target?.scope === "remote" ? "owner" : "viewer")
        || !federationTargetsEqual(candidate.request.federationTarget, target) || !page?.selectionDirectory) continue;
      const root = page.entries.find((entry) => entry.placement.kind === "root");
      if (!root) continue;
      let placements = scopedPlacements.get(page.selectionDirectory.key);
      if (!placements) {
        placements = new Map();
        scopedPlacements.set(page.selectionDirectory.key, placements);
        for (const resource of snapshot.resources.values()) {
          const request = resource.state.request;
          if (request.query.kind !== "children" || request.query.directoryKey !== page.selectionDirectory.key
            || !federationTargetsEqual(request.federationTarget, target)) continue;
          for (const entry of resource.state.page?.entries ?? []) placements.set(navigationIdentityKey(entry.row.ref), entry);
        }
      }
      const clicked = placements.get(navigationIdentityKey(selection));
      if (!clicked) continue;
      // A fresh owner's relationship supersedes the old viewer observation.
      // Optional legacy qualifiers do not themselves change that relationship.
      const parentBackend = clicked.row.parentThreadBackend
        ?? (clicked.placement.kind === "child" && clicked.placement.parent.threadId === clicked.row.parentThreadId
          ? clicked.placement.parent.backend : clicked.row.source);
      if (ownerRow && (ownerRow.parentThreadId !== clicked.row.parentThreadId
        || (ownerRow.parentThreadBackend !== undefined && ownerRow.parentThreadBackend !== parentBackend)
        || (ownerRow.parentThreadInstanceId ?? ownerRow.ref.ownerInstanceId)
          !== (clicked.row.parentThreadInstanceId ?? clicked.row.ref.ownerInstanceId))) continue;
      const visited = new Set<string>();
      let ref = selection;
      while (!visited.has(navigationIdentityKey(ref))) {
        if (navigationIdentitiesEqual(ref, root.row.ref)) return page;
        visited.add(navigationIdentityKey(ref));
        const entry = placements.get(navigationIdentityKey(ref));
        if (entry?.placement.kind !== "child") break;
        ref = entry.placement.parent;
      }
    }
    return undefined;
  }

  /** Pages enter through IPC or immutable range merges; measure each owned value exactly once. */
  private pageBytes(page: NavigationQueryPage | undefined): number {
    if (!page) return 0;
    let bytes = this.pageSizes.get(page);
    if (bytes === undefined) {
      // Another owner's page counts as its owner measured it. What this
      // viewer filled in shares one block and is not charged per row.
      bytes = navigationQueryPageBudgetBytes(page);
      this.pageSizes.set(page, bytes);
    }
    return bytes;
  }

  private retainableState(state: NavigationPageState): RetainableState {
    const page = state.page;
    if (!page) return { state };
    const remote = state.request.federationTarget?.scope === "remote";
    const metadataDependencies = remote && page.metadataDependencies?.workingStatePaths ? page.metadataDependencies : undefined;
    const viewerRowOwners = !remote && state.request.inventory === "viewer" ? page.viewerRowOwners : undefined;
    const gitProof = page.directoryGitProof;
    if (!metadataDependencies && !viewerRowOwners && !gitProof) return { state };
    const rows = { ...page };
    if (gitProof) delete rows.directoryGitProof;
    if (metadataDependencies) delete rows.metadataDependencies;
    if (viewerRowOwners) delete rows.viewerRowOwners;
    // Removing a JSON field saves its name, value, and one separating comma.
    const encoder = new TextEncoder();
    const gitBytes = gitProof ? encoder.encode(JSON.stringify({ directoryGitProof: gitProof })).byteLength - 1 : 0;
    const ownerBytes = metadataDependencies || viewerRowOwners
      ? encoder.encode(JSON.stringify({ metadataDependencies, viewerRowOwners })).byteLength - 1 : 0;
    const proofBytes = ownerBytes + gitBytes;
    const rowBytes = this.pageBytes(page) - proofBytes;
    if (rows.remoteOwner?.ownerContentBytes !== undefined) {
      rows.remoteOwner = { ...rows.remoteOwner, ownerContentBytes: rowBytes };
    }
    this.pageSizes.set(rows, rowBytes);
    const dependencies = metadataDependencies && readNavigationMetadataDependencies(metadataDependencies);
    const directoryGitProof = gitProof ? readDirectoryGitProof(gitProof) : undefined;
    return { state: { ...state, page: rows }, ...(dependencies || viewerRowOwners || directoryGitProof
      ? { ownerProof: { dependencies, viewerRowOwners, directoryGitProof, gitBytes, bytes: proofBytes } } : {}) };
  }

  private deleteOwnerProof(page: NavigationQueryPage | undefined): void {
    if (!page) return;
    const proof = this.ownerPageProofs.get(page);
    if (!proof) return;
    this.ownerPageProofs.delete(page);
    this.ownerProofBytes -= proof.bytes;
  }

  private acceptState(resource: Resource, { state, ownerProof }: RetainableState, extendedFromCursor: boolean): void {
    const previous = resource.value.state.page;
    const bytes = this.activePageBytes + this.pageBytes(state.page) - this.pageBytes(previous);
    if (bytes > MAX_RETAINED_BYTES) throw new Error("Navigation retained-page budget reached. Collapse a directory or change lens to release pages.");
    if (state.page !== previous) this.deleteOwnerProof(previous);
    const spare = this.trimRetained(bytes, ownerProof ? ownerProof.bytes - ownerProof.gitBytes : 0);
    if (ownerProof?.gitBytes && ownerProof.bytes > spare) {
      ownerProof = this.withoutGitProof(ownerProof);
    }
    if (state.page && ownerProof && ownerProof.bytes <= spare && !this.ownerPageProofs.has(state.page)) {
      this.ownerPageProofs.set(state.page, ownerProof);
      this.ownerProofBytes += ownerProof.bytes;
    }
    this.activePageBytes = bytes;
    resource.value = { ...resource.value, state, restoredFromCache: false, extendedFromCursor };
  }

  private withoutGitProof(proof: OwnerPageProof): OwnerPageProof | undefined {
    return proof.dependencies || proof.viewerRowOwners
      ? { dependencies: proof.dependencies, viewerRowOwners: proof.viewerRowOwners, gitBytes: 0, bytes: proof.bytes - proof.gitBytes }
      : undefined;
  }

  private trimRetained(activeBytes: number, incomingOwnerBytes = 0): number {
    let bytes = activeBytes + [...this.retained.values()].reduce((total, entry) => total + entry.bytes, 0);
    for (const [key, entry] of this.retained) {
      if (bytes <= MAX_RETAINED_BYTES && this.retained.size <= 64) break;
      this.retained.delete(key);
      bytes -= entry.bytes;
    }
    // A Git proof spends spare capacity after the existing owner and off-page
    // membership proofs, including one arriving with this read.
    if (bytes + this.ownerProofBytes + incomingOwnerBytes > MAX_RETAINED_BYTES) {
      for (const [page, proof] of this.ownerPageProofs) {
        if (bytes + this.ownerProofBytes + incomingOwnerBytes <= MAX_RETAINED_BYTES) break;
        if (!proof.gitBytes) continue;
        this.ownerProofBytes -= proof.gitBytes;
        const remaining = this.withoutGitProof(proof);
        if (remaining) this.ownerPageProofs.set(page, remaining);
        else this.ownerPageProofs.delete(page);
      }
    }
    for (const page of this.ownerPageProofs.keys()) {
      if (bytes + this.ownerProofBytes <= MAX_RETAINED_BYTES) break;
      this.deleteOwnerProof(page);
    }
    return MAX_RETAINED_BYTES - bytes - this.ownerProofBytes;
  }

  setDemand(demand: ReadonlyMap<string, NavigationQueryRequest>): void {
    if (this.disposed) return;
    this.setPreparedDemand(prepareNavigationDemand(demand));
  }

  setPreparedDemand(demand: ReturnType<typeof prepareNavigationDemand>): void {
    if (this.disposed) return;
    const { entries: admitted, admissionError } = demand;
    let changed = false;
    for (const [id, resource] of this.resources) {
      const entry = admitted.get(id);
      if (!entry || entry.requestKey !== resource.requestKey) {
        this.finishResume(resource);
        if (resource.value.state.page) {
          const key = this.retainedKey(id, resource.requestKey);
          this.retained.delete(key);
          this.retained.set(key, { state: resource.value.state, anchor: resource.anchor, expandedRows: resource.expandedRows,
            bytes: this.pageBytes(resource.value.state.page) });
        }
        this.activePageBytes -= this.pageBytes(resource.value.state.page);
        this.deleteOwnerProof(resource.value.state.page);
        this.release(resource);
        this.resources.delete(id);
        changed = true;
      }
    }
    const added: Resource[] = [];
    let budget: ResumeBudget | undefined;
    for (const [id, { request, requestKey }] of admitted) {
      if (this.resources.has(id)) continue;
      const retainedKey = this.retainedKey(id, requestKey);
      const retained = this.retained.get(retainedKey);
      this.retained.delete(retainedKey);
      const resource: Resource = {
        requestKey, diagnosticResource: ++this.nextResource, token: `${this.prefix}:${this.nextResource}`,
        value: { id, state: retained ? { ...retained.state, stale: true, error: undefined } : createNavigationPageState(request),
          loading: false, restoredFromCache: Boolean(retained) },
        refreshAfterPending: false, invalidated: false, released: !this.visible, anchor: retained?.anchor ?? request.anchor,
        expandedRows: retained?.expandedRows,
        membershipUncertain: Boolean(retained),
      };
      // Saved depth is the operator's demand whenever the list opens, not
      // only at startup: an evicted cache, a list first opened later, or an
      // interrupted restore must not fall back to the first page.
      budget = this.armResume(resource, budget);
      this.resources.set(id, resource);
      this.activePageBytes += this.pageBytes(resource.value.state.page);
      added.push(resource);
      changed = true;
    }
    if (changed) {
      this.pendingWindowRefreshes.clear();
      this.trimRetained(this.activePageBytes);
      navigationListingDiagnostics.record({ ...this.diagnostic, phase: "demand", count: added.length });
    }
    let startedReads = false;
    if (this.visible) {
      for (const resource of added) {
        const read = this.read(resource, false, undefined, false, "demand", false);
        startedReads ||= Boolean(resource.pending);
        void read;
      }
    }
    if (changed || startedReads || admissionError !== this.snapshot.admissionError) {
      this.snapshot = { ...this.snapshot, admissionError };
      this.publish();
    }
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.pendingWindowRefreshes.clear();
    this.visible = visible;
    let budget: ResumeBudget | undefined;
    for (const resource of this.resources.values()) {
      if (!visible) {
        this.release(resource);
        resource.value = { ...resource.value, loading: false };
      } else {
        // Replace the lifetime rather than revive a released token or pending read.
        const next: Resource = { ...resource, token: `${this.prefix}:${++this.nextResource}`,
          released: false, pending: undefined, refreshCompletion: undefined, refreshAfterPending: false,
          invalidated: false, membershipUncertain: true };
        // Hiding the window ends a restore early. Showing it is a new opening.
        if (!next.resumeExpansion) budget = this.armResume(next, budget);
        this.resources.set(resource.value.id, next);
        next.diagnosticCause = "visibility";
        void this.read(next, false, undefined, false, undefined, false);
      }
    }
    this.publish();
  }

  refresh(id?: string, owners?: readonly FederationTarget[], invalidatedOnly = false, cause?: NavigationDiagnosticCause,
    trigger?: string, includeDirectoryIndex = false, requireNewObservation = false): Promise<void> {
    if (!this.visible || this.disposed) return Promise.resolve();
    if (requireNewObservation) this.pendingWindowRefreshes.clear();
    // One ordinary window refresh covers its completed pages as long as it
    // still has reads pending. An owner change or new demand ends that cover.
    const owner = owners?.[0];
    const windowScope = id === undefined && !invalidatedOnly && !trigger && !includeDirectoryIndex
      && !requireNewObservation && (!owners || owners.length === 1)
      ? (owner ? federationTargetKey(owner) : "all") : undefined;
    const pendingWindowRefresh = windowScope === undefined ? undefined : this.pendingWindowRefreshes.get(windowScope);
    if (pendingWindowRefresh) {
      navigationListingDiagnostics.record({ ...this.diagnostic, phase: "coalesced", cause });
      return pendingWindowRefresh;
    }
    const resources = id ? [this.resources.get(id)].filter((value): value is Resource => Boolean(value)) : [...this.resources.values()];
    // Keep the caller separate from the event that fenced each page: a queued
    // action can consume a seen/status invalidation without becoming its cause.
    const batch = ++this.nextDiagnosticBatch;
    const forceRead = (resource: Resource) => !invalidatedOnly || (includeDirectoryIndex && resource.value.id === "directory-index");
    const owesPinRead = (resource: Resource) => trigger === "action/remote-pin-add" && resource.pinPublicationPending;
    const selected = resources.filter((resource) => (forceRead(resource) || resource.invalidated || owesPinRead(resource))
      && (!owners || owners.some((owner) => federationTargetsEqual(owner, resource.value.state.request.federationTarget))));
    navigationListingDiagnostics.record({ ...this.diagnostic, phase: "refresh", batch, count: selected.length, invalidatedOnly,
      caller: safeNavigationDiagnosticTrigger(trigger), trigger: safeNavigationDiagnosticTrigger(trigger), cause });
    let startedReads = false;
    const refreshed = Promise.all(selected.map((resource) => {
      const pending = resource.pending;
      const retryJoinedPinRead = Boolean(pending && owesPinRead(resource));
      // Owner events already fence pending reads. Attribute the replacement
      // to this caller without scheduling another one for the same event.
      const replacePending = requireNewObservation && forceRead(resource);
      if (!pending || replacePending || resource.invalidated) {
        resource.diagnosticRefreshBatch = batch;
        if (!resource.diagnosticCause || resource.diagnosticCause === "refresh") resource.diagnosticCause = cause;
        resource.diagnosticTrigger ??= trigger;
        resource.diagnosticCaller ??= safeNavigationDiagnosticTrigger(trigger);
        // An unscoped refresh can discover membership missed while hidden or
        // between provider observations. A scoped row refresh already knows
        // exactly why its baseline is stale.
        if (!resource.invalidated) resource.membershipUncertain = true;
        if (pending && replacePending) resource.refreshAfterPending = true;
        void this.read(resource, false, undefined, false, "refresh", false);
        startedReads ||= !pending && Boolean(resource.pending);
      }
      const shared = this.waitForRefreshCompletion(resource);
      if (!retryJoinedPinRead) return shared;
      // The receipt can arrive while the broadcast's read is still in
      // flight. Give that failed read the same recovery as a late receipt.
      return shared?.then(() => {
        if (!this.isCurrent(resource) || !owesPinRead(resource)) return;
        void this.read(resource, false);
        return this.waitForRefreshCompletion(resource);
      });
    }));
    let completion = refreshed.then(() => undefined);
    if (windowScope !== undefined && selected.length > 0) {
      completion = completion.finally(() => {
        if (this.pendingWindowRefreshes.get(windowScope) === completion) this.pendingWindowRefreshes.delete(windowScope);
      });
      this.pendingWindowRefreshes.set(windowScope, completion);
    }
    // One refresh queues its reads in one turn. Publish every newly queued
    // read's loading state together, including a refresh of multiple owners.
    if (startedReads) this.publish();
    return completion;
  }

  private waitForRefreshCompletion(resource: Resource): Promise<void> | undefined {
    if (resource.refreshCompletion || !resource.pending) return resource.refreshCompletion;
    // Follow replacements once per resource, then settle every joined caller.
    const drain = async (first: Promise<void>) => {
      try {
        await first;
        while (this.isCurrent(resource) && resource.pending) await resource.pending;
      } finally {
        resource.refreshCompletion = undefined;
      }
    };
    resource.refreshCompletion = drain(resource.pending);
    return resource.refreshCompletion;
  }

  /** Invalidate transport baselines before canonical owner events can race a late page. */
  invalidate(id?: string, owners?: readonly FederationTarget[], event?: AgentEvent): void {
    let correlatedPinPublication = false;
    if (!id && event?.federationTarget?.scope !== "remote" && event?.notification.method === "navigation/remoteThreadPins/changed") {
      const publicationId = event.notification.params?.publicationId;
      // The broadcast and action reply can arrive in either order. Both
      // acknowledge the same completed writes and fence the same viewer.
      if (typeof publicationId === "string" && publicationId) {
        if (this.recentPinPublications.has(publicationId)) return;
        if (this.recentPinPublications.size === MAX_RECENT_PIN_PUBLICATIONS) {
          this.recentPinPublications.delete(this.recentPinPublications.values().next().value!);
        }
        this.recentPinPublications.add(publicationId);
        correlatedPinPublication = true;
      }
    }
    let changed = false;
    let count = 0;
    const batch = ++this.nextDiagnosticBatch;
    const directoryScope = event ? readNavigationDirectoryScope(event.navigationDirectoryScope) : undefined;
    const notification = event?.notification;
    const params = notification?.params as { sourceMethod?: unknown; threadId?: unknown; worktreePath?: unknown; rowChanges?: unknown } | undefined;
    const method = notification?.method === "navigation/invalidated" ? params?.sourceMethod : notification?.method;
    const workingState = method === "navigation/threadGitWorkingState/updated";
    const gitRevisions = notification?.method === "navigation/directoryGitStatus/updated"
      || (notification?.method === "navigation/invalidated" && notification.params?.sourceMethod === "navigation/directoryGitStatus/updated")
      ? readDirectoryGitRevisions(notification.params?.directoryGitRevisions) : undefined;
    for (const resource of this.resources.values()) {
      if (id && resource.value.id !== id) continue;
      if (owners && !owners.some((owner) => federationTargetsEqual(owner, resource.value.state.request.federationTarget))) continue;
      const affected = event ? this.eventAffectsResource(resource, event, directoryScope, gitRevisions) : true;
      if (!affected) continue;
      if (correlatedPinPublication) resource.pinPublicationPending = true;
      count++;
      if (workingState) {
        // A queued read already includes this observation. A discarded read
        // already owes a replacement, regardless of later Git notifications.
        if (resource.invalidated) continue;
        const read = resource.membershipRead;
        if (read && resource.membershipUncertain && typeof params?.worktreePath === "string" && params.worktreePath && params.worktreePath.length <= 1_024
          && federationTargetsEqual(resource.value.state.request.federationTarget, event?.federationTarget)
          && (read.paths.size < MAX_WORKING_STATE_PATHS_PER_READ || read.paths.has(params.worktreePath))) {
          // A relationship refresh can discover rows or change their paths.
          // The previous page cannot rule this out, but the returned page can.
          read.paths.add(params.worktreePath);
          read.batch = batch;
          read.cause = navigationDiagnosticCause(event);
          read.trigger = navigationDiagnosticTrigger(event);
          continue;
        }
      }
      if (method === "navigation/thread/seen" && event) {
        const deferred = !resource.invalidated && typeof params?.threadId === "string"
          && this.deferSeenDuringMembershipRead(resource, event, params.threadId, batch);
        if (navigationListingDiagnostics.isRecording()) {
          const { page } = resource.value.state;
          const reason = typeof affected === "string" ? affected : resource.membershipUncertain ? "uncertain-membership"
            : page?.coverage.state !== "complete" ? "partial-coverage"
            : !page.complete || (page.rangeStart ?? 0) > 0 ? "partial-range" : "missing-proof";
          this.recordSeenDecision(resource, page, { batch,
            logical: deferred ? resource.diagnosticLogical : undefined,
            seenReason: reason, seenDecision: deferred ? "defer" : resource.invalidated ? "covered" : "invalidate",
            ...this.diagnosticProof(page) });
        }
        if (deferred) continue;
      }
      const metadataRowChange = method === "navigation/remoteThreadPins/changed" && Array.isArray(params?.rowChanges);
      const childRowChange = resource.value.state.request.query.kind === "children"
        && (method === "thread/pin/added" || method === "thread/pin/removed"
          || metadataRowChange);
      // An instance-only summary notice can discover new mounted children.
      // Its pending replacement cannot use the old membership to exclude a
      // subsequent metadata change to one of those newly discovered rows.
      if (!childRowChange && !metadataRowChange && navigationInvalidationMayChangeMembership(method)) resource.membershipUncertain = true;
      if (method === "thread/pullRequests/updated" || method === "navigation/remoteThreadPins/changed") resource.prAttachmentsUncertain = true;
      // Pinning moves a root between two independent directory queries. Its
      // old section must stop using it as an anchor before the next read,
      // including when another event has already invalidated that section.
      if (event && this.movePinAnchor(resource, event)) changed = true;
      resource.diagnosticInvalidations = (resource.diagnosticInvalidations ?? 0) + 1;
      // Fence each physical read once. Further events before its replacement
      // are covered at dispatch and keep their own diagnostic records.
      if (resource.invalidated) continue;
      resource.diagnosticBatch = batch;
      resource.diagnosticTrigger = navigationDiagnosticTrigger(event);
      resource.diagnosticCause = navigationDiagnosticCause(event);
      this.fenceBaseline(resource);
      changed = true;
    }
    navigationListingDiagnostics.record({ ...this.diagnostic, phase: "invalidate", batch, count,
      cause: navigationDiagnosticCause(event), trigger: navigationDiagnosticTrigger(event),
      source: event ? event.federationTarget?.scope === "remote" ? "remote" : "local" : undefined });
    if (changed) {
      this.pendingWindowRefreshes.clear();
      this.publish();
    }
  }

  private fenceBaseline(resource: Resource): void {
    const read = resource.membershipRead;
    if (read?.seen) {
      // The replacement consumes these notices even when a different event
      // fences the read before its proof arrives.
      this.finishDeferredSeenDiagnostic(resource, resource.value.state.page, "baseline-fenced", "covered");
      resource.diagnosticInvalidations = (resource.diagnosticInvalidations ?? 0) + read.seen.count;
      read.seen = undefined;
    }
    resource.invalidated = true;
    // Some canonical events patch settled rows without scheduling a read.
    // Replace any pending page they discard so its counts cannot be stranded.
    if (resource.pending) resource.refreshAfterPending = true;
    const { state } = resource.value;
    resource.value = { ...resource.value, state: { ...state, stale: true, pendingSequence: state.pendingSequence + 1 } };
  }

  private deferSeenDuringMembershipRead(resource: Resource, event: AgentEvent, threadId: string, batch: number): boolean {
    const read = resource.membershipRead;
    const { request, page } = resource.value.state;
    if (!read || request.query.kind !== "children" || page?.coverage.state !== "complete"
      || !threadId || threadId.length > 1_024) return false;
    const target = request.federationTarget;
    const remote = target?.scope === "remote";
    if (remote && !federationTargetsEqual(target, event.federationTarget)) return false;
    const sourceOwner = event.federationTarget?.scope === "remote" ? event.federationTarget.instanceId : undefined;
    const ref = { backend: event.backend, threadId, ownerInstanceId: sourceOwner };
    const parent = request.query.parent;
    if (navigationIdentitiesEqual(ref, { ...parent, ownerInstanceId: parent.ownerInstanceId ?? (remote ? target.instanceId : undefined) })) return false;
    const key = navigationIdentityKey(remote ? { ...ref, ownerInstanceId: undefined } : ref);
    const dependencies = this.ownerPageProofs.get(page)?.dependencies ?? this.metadataDependencies(page);
    if (!dependencies || dependencies.threadKeys.includes(key)) return false;

    // An old baseline can only nominate an apparently offscreen notice for
    // verification. The replacement may add this child or count it through
    // the enclosing directory, even if the returned rows do not show it.
    const seen: NonNullable<typeof read.seen> = read.seen ??= { batches: new Map(), count: 0 };
    if (!seen.batches.has(key)) {
      if (seen.batches.size >= MAX_SEEN_THREADS_PER_READ) return false;
      seen.batches.set(key, batch);
    }
    seen.count += 1;
    if (navigationListingDiagnostics.isRecording()) seen.diagnosticGeneration = navigationListingDiagnostics.recordingGeneration;
    return true;
  }

  private recordSeenDecision(resource: Resource, page: NavigationQueryPage | undefined, decision: SeenDecisionDiagnostic): void {
    const { request } = resource.value.state;
    navigationListingDiagnostics.record({ ...this.diagnostic, phase: "seen-decision", resource: resource.diagnosticResource,
      query: request.query.kind, inventory: request.inventory ?? "owner",
      source: request.federationTarget?.scope === "remote" ? "remote" : "local",
      trigger: "navigation/thread/seen", ...decision, ...navigationDiagnosticPageShape(page) });
  }

  private finishDeferredSeenDiagnostic(resource: Resource, page: NavigationQueryPage | undefined, seenReason: NavigationSeenReason,
    seenDecision: NavigationSeenDecision, proofAdmitted?: boolean): void {
    const seen = resource.membershipRead?.seen;
    if (seen?.diagnosticGeneration === undefined || !navigationListingDiagnostics.isRecording(seen.diagnosticGeneration)) return;
    // All batches currently deferred on this read share the outcome. The notice can
    // belong to a newer capture interval than the original IPC dispatch.
    this.recordSeenDecision(resource, page, { logical: resource.diagnosticLogical, seenReason, seenDecision,
      ...(proofAdmitted === undefined ? this.diagnosticProof(page) : { proofAdmitted }) });
    seen.diagnosticGeneration = undefined;
  }

  private needsSeenReplacement(resource: Resource, candidate?: RetainableState): boolean {
    const read = resource.membershipRead;
    if (!read?.seen || resource.invalidated) return false;
    const { batches } = read.seen;
    const page = candidate?.state.page;
    const dependencies = page?.coverage.state === "complete"
      ? candidate?.ownerProof?.dependencies ?? this.metadataDependencies(page) : undefined;
    const match = dependencies?.threadKeys.find((key) => batches.has(key));
    const batch = match === undefined ? batches.values().next().value : batches.get(match);
    const reason = match !== undefined ? "thread-dependency" : dependencies ? "proof-excludes"
      : page && page.coverage.state !== "complete" ? "partial-coverage" : "missing-proof";
    this.finishDeferredSeenDiagnostic(resource, page, reason, reason === "proof-excludes" ? "exclude" : "replace", Boolean(dependencies));
    if (dependencies && match === undefined) {
      // The proof covers off-page counts for this entire cursor generation.
      read.seen = undefined;
      return false;
    }
    resource.diagnosticBatch = batch;
    resource.diagnosticCause = "metadata";
    resource.diagnosticTrigger = "navigation/thread/seen";
    this.fenceBaseline(resource);
    return true;
  }

  private needsWorkingStateReplacement(resource: Resource, candidate?: RetainableState,
    evidence: "require-exclusion" | "match-only" = "require-exclusion"): boolean {
    const read = resource.membershipRead;
    if (!read?.paths.size || resource.invalidated) return false;
    const { request } = resource.value.state;
    const target = request.federationTarget;
    const ownerId = target?.scope === "remote" ? target.instanceId : undefined;
    const page = candidate?.state.page;
    const ownerPaths = page?.coverage.state === "complete" ? candidate?.ownerProof?.dependencies?.workingStatePaths : undefined;
    if (evidence === "match-only") {
      // A known checkout match already fences this generation. An incomplete
      // page without a match can still resolve the notice on a later page.
      const matches = ownerPaths?.some((path) => read.paths.has(path)) ?? page?.entries.some(({ row }) =>
        row.ref.ownerInstanceId === ownerId && (!row.linkedDirectoriesTruncated || row.projectKey?.trim())
        && read.paths.has(navigationWorkingStatePath(row) ?? ""));
      if (!matches) return false;
    } else if (page?.coverage.state === "complete" && (ownerPaths
      ? !ownerPaths.some((path) => read.paths.has(path)) : this.excludesWorkingStatePaths(request, page, ownerId, read.paths))) {
      read.paths.clear();
      return false;
    }
    resource.diagnosticBatch = read.batch;
    resource.diagnosticCause = read.cause;
    resource.diagnosticTrigger = read.trigger;
    resource.diagnosticInvalidations = (resource.diagnosticInvalidations ?? 0) + read.paths.size;
    this.fenceBaseline(resource);
    return true;
  }

  private excludesWorkingStatePaths(request: NavigationQueryRequest, page: NavigationQueryPage,
    ownerId: string | undefined, changed: string | ReadonlySet<string>): boolean {
    const { query } = request;
    return page.coverage.state === "complete" && page.complete && (page.rangeStart ?? 0) === 0
      && (query.kind !== "exact" || query.identities.every((ref) => page.entries.some(({ row }) => navigationIdentitiesEqual(row.ref,
        { ...ref, ownerInstanceId: ref.ownerInstanceId ?? ownerId }))))
      && page.entries.every(({ row }) => {
        if (row.ref.ownerInstanceId !== ownerId) return true;
        if (row.linkedDirectoriesTruncated && !row.projectKey?.trim()) return false;
        const path = navigationWorkingStatePath(row);
        return !path || (typeof changed === "string" ? path !== changed : !changed.has(path));
      });
  }

  private movePinAnchor(resource: Resource, event: AgentEvent): boolean {
    const { request, page } = resource.value.state;
    const anchor = resource.anchor;
    if (request.query.kind !== "directory" || anchor?.kind !== "thread") return false;
    const params = event.notification.params as { sourceMethod?: string; threadId?: string; instanceId?: string; pinned?: boolean;
      anchorChanges?: NavigationIdentity[]; settledAt?: number };
    const method = event.notification.method === "navigation/invalidated" ? params.sourceMethod : event.notification.method;
    const viewerPin = method === "navigation/remoteThreadPins/changed";
    const pinned = viewerPin ? params.pinned : method === "thread/pin/added" ? true
      : method === "thread/pin/removed" ? false : undefined;
    // Settle moves a root between Unpinned and Settled the same way.
    const settled = method === "thread/settled/updated" ? params.settledAt !== undefined : undefined;
    const leaves = pinned !== undefined ? request.query.roots === (pinned ? "unpinned" : "pinned")
      : settled !== undefined && request.query.settled === (settled ? "exclude" : "only");
    if (!leaves || !params.threadId) return false;
    // Owner pins never change a mounted thread's viewer-owned rank.
    if (!federationTargetsEqual(request.federationTarget, event.federationTarget)
      || (viewerPin && (request.federationTarget?.scope === "remote" || !params.instanceId))) return false;
    const ref = { backend: event.backend, threadId: params.threadId,
      ownerInstanceId: viewerPin ? params.instanceId
        : event.federationTarget?.scope === "remote" ? event.federationTarget.instanceId : undefined };
    const moved = viewerPin && params.anchorChanges?.length ? params.anchorChanges : [ref];
    const moves = (ref: NavigationIdentity) => moved.some((changed) => navigationIdentitiesEqual(changed, ref));
    if (!moves(anchor.ref)) return false;
    const entries = page?.entries ?? [];
    const index = entries.findIndex(({ row }) => navigationIdentitiesEqual(row.ref, anchor.ref));
    const neighbor = entries.find(({ row }, i) => i > index && !moves(row.ref))
      ?? entries.findLast(({ row }, i) => i < index && !moves(row.ref));
    resource.anchor = neighbor ? { kind: "thread", ref: neighbor.row.ref } : undefined;
    resource.value = { ...resource.value, state: { ...resource.value.state, rebaselineRequired: false } };
    return true;
  }

  private eventAffectsResource(resource: Resource, event: AgentEvent, directoryScope?: readonly string[],
    gitRevisions?: NavigationDirectoryGitRevisions): boolean | NavigationSeenReason {
    const request = resource.value.state.request;
    const params = event.notification.params as { sourceMethod?: unknown; threadId?: unknown; worktreePath?: unknown; directoryKey?: unknown; instanceId?: string;
      rowChanges?: Array<{ backend: AgentEvent["backend"]; threadId: string; ownerInstanceId: string }> };
    const method = event.notification.method === "navigation/invalidated" ? params?.sourceMethod : event.notification.method;
    const page = resource.value.state.page;
    const workingState = method === "navigation/threadGitWorkingState/updated";
    const seen = method === "navigation/thread/seen";
    if (method === NAVIGATION_SIDEBAR_ENRICHMENT_UPDATED_METHOD && request.query.kind === "directory-index") return false;
    // Working-state probes cannot change any directory descriptor or count.
    if (workingState && request.query.kind === "directory-index") return false;
    // A navigation gap needs a new direct owner baseline. Viewer membership
    // arrives separately when the summary cache publishes its fenced read.
    if (method === "federation/eventStream/changed" && event.federationTarget?.scope === "remote"
      && (!navigationQueryEventRequiresRefresh(method, params)
        || (request.inventory === "viewer" && request.federationTarget?.scope !== "remote"))) return false;
    // Remote subscriptions can be wider than this machine's mounts. Only
    // the serving viewer inventory can exclude an owner across pages. A
    // pending membership read may discover a new mount; keep its fence.
    const sourceOwner = event.federationTarget?.scope === "remote" ? event.federationTarget.instanceId : undefined;
    const viewerRowOwners = sourceOwner && page ? this.ownerPageProofs.get(page)?.viewerRowOwners : undefined;
    if (sourceOwner && request.federationTarget?.scope !== "remote" && request.inventory === "viewer"
      && !resource.membershipUncertain && page?.coverage.state === "complete" && viewerRowOwners) {
      const resolvesPeer = request.query.kind === "exact" && request.query.resolveFromOwners
        && request.query.identities.some((ref) => ref.ownerInstanceId === sourceOwner);
      // A compact PR notice only invalidates the serving peer's rows. A
      // full observation can patch the same PR across owned and mounted rows.
      const peerOnlyPrNotice = method === "pullRequest/status/updated" && event.notification.method === "navigation/invalidated";
      if (!resolvesPeer && !viewerRowOwners.includes(sourceOwner)
        && (peerOnlyPrNotice || (typeof method === "string" && OWNER_ROW_CHANGES.has(method)))) return false;
      // A pinned row's directory identity comes from the published pin
      // summary. A peer's Git notice refreshes its direct pages; a subsequent
      // local pin-summary publication refreshes this delegated projection.
      if (!resolvesPeer && gitRevisions && !resource.pending && !resource.value.state.stale) return false;
    }
    if (method === "pullRequest/status/updated") {
      // Directory counts and descriptors contain no PR status, even while a
      // read is in flight. An attachment change is a separate event.
      if (request.query.kind === "directory-index") return false;
      if (resource.membershipUncertain || resource.prAttachmentsUncertain || page?.coverage.state !== "complete") return true;
      const dependencies = this.ownerPageProofs.get(page)?.dependencies ?? this.metadataDependencies(page);
      const key = event.notification.method === "pullRequest/status/updated"
        && typeof event.notification.params.prKey === "string" ? event.notification.params.prKey : undefined;
      if (dependencies?.prKeysComplete) {
        // A viewer-local proof covers native rows only. Compact peer notices
        // leave them alone; full status observations can patch shared PRs.
        if (sourceOwner && request.inventory === "viewer" && request.federationTarget?.scope !== "remote"
          && event.notification.method === "navigation/invalidated") return false;
        const aliases = sourceOwner ? undefined : event.navigationPullRequestKeyAliases;
        return dependencies.prKeys.some((candidate) => !key || navigationPullRequestKeysMayMatch(candidate, key)
          || aliases?.some((alias) => navigationPullRequestKeysMayMatch(candidate, alias)));
      }
      // A verified preview can omit a stored attachment. Its absence
      // cannot rule out a status change that makes that attachment visible.
      return true;
    }
    if (gitRevisions && typeof params?.directoryKey === "string" && params.directoryKey
      && federationTargetsEqual(request.federationTarget, event.federationTarget)
      && !resource.membershipUncertain && !resource.pending && !resource.value.state.stale && page?.coverage.state === "complete") {
      const proof = this.ownerPageProofs.get(page)?.directoryGitProof;
      if (proof) {
        const revision = proof.directories.find(([key]) => key === params.directoryKey)?.[1];
        return revision !== undefined && revision !== gitRevisions.repository && revision !== gitRevisions.descriptor;
      }
    }
    const scopedActivity = method === "turn/started" && directoryScope !== undefined && request.query.kind === "children"
      && federationTargetsEqual(request.federationTarget, event.federationTarget);
    if ((seen || scopedActivity) && !resource.membershipUncertain && page?.coverage.state === "complete"
      && typeof params?.threadId === "string") {
      const dependencies = this.ownerPageProofs.get(page)?.dependencies ?? this.metadataDependencies(page);
      // The peer builds its proof before row expansion stamps federated refs.
      const ref = { backend: event.backend, threadId: params.threadId,
        ownerInstanceId: request.federationTarget?.scope === "remote" ? undefined : sourceOwner };
      if (dependencies) {
        if (dependencies.threadKeys.includes(navigationIdentityKey(ref))) return seen ? "thread-dependency" : true;
        const parent = request.query.kind === "children" && request.query.parent.backend === ref.backend
          && request.query.parent.threadId === ref.threadId && request.query.parent.ownerInstanceId === sourceOwner;
        return parent && (seen ? "parent-or-row" : true);
      }
    }
    if (request.federationTarget?.scope === "remote" && federationTargetsEqual(request.federationTarget, event.federationTarget)) {
      if (!resource.membershipUncertain && page?.coverage.state === "complete" && workingState) {
        const dependencies = this.ownerPageProofs.get(page)?.dependencies ?? this.metadataDependencies(page);
        if (typeof params?.worktreePath === "string" && dependencies?.workingStatePaths) {
          return dependencies.workingStatePaths.includes(params.worktreePath);
        }
      }
      // A descriptor's unread count includes siblings outside the exact
      // selection or tray. An older or partial page cannot exclude them.
      if (seen && page?.selectionDirectory
        && (request.query.kind === "exact" || request.query.kind === "children")) return "selection-directory";
    }
    if (request.inventory === "viewer" && request.federationTarget?.scope !== "remote" && !resource.membershipUncertain
      && page?.coverage.state === "complete" && request.query.kind !== "children") {
      const dependencies = this.metadataDependencies(page);
      if (dependencies && event.federationTarget?.scope !== "remote"
        && method === "navigation/remoteThreadPins/changed" && params.rowChanges && params.instanceId) {
        return params.rowChanges.some((ref) => dependencies.threadKeys.includes(navigationIdentityKey(ref)));
      }
      if (dependencies && !navigationInvalidationMayChangeMembership(method) && typeof params.threadId === "string") {
        const ref = { backend: event.backend, threadId: params.threadId,
          ownerInstanceId: event.federationTarget?.scope === "remote" ? event.federationTarget.instanceId : undefined };
        return dependencies.threadKeys.includes(navigationIdentityKey(ref)) && (seen ? "thread-dependency" : true);
      }
    }
    if (request.query.kind === "directory" && directoryScope && !resource.membershipUncertain
      && (!request.backend || request.backend === "all")
      && !navigationInvalidationMayChangeMembership(method)
      && method !== "navigation/directoryGitStatus/updated"
      && federationTargetsEqual(request.federationTarget, event.federationTarget)) {
      // The owner's all-provider membership includes off-page descendants.
      // Provider-filtered indexes can group the same thread under another key.
      // Directory Git updates also affect rows through secondary links, which
      // membership-only v1 scopes from earlier peers do not cover.
      // Loaded roots and linked paths cannot supply a negative membership proof.
      // A pending membership read retains its broad fence until accepted.
      return directoryScope.includes(request.query.directoryKey) && (seen ? "directory-scope" : true);
    }
    if (workingState && typeof params?.worktreePath === "string" && !resource.membershipUncertain && page
      && federationTargetsEqual(request.federationTarget, event.federationTarget)
      && this.excludesWorkingStatePaths(request, page, sourceOwner, params.worktreePath)) return false;
    if (request.query.kind === "children" && !resource.membershipUncertain
      && page?.complete && (page.rangeStart ?? 0) === 0 && page.coverage.state === "complete"
      && (!navigationInvalidationMayChangeMembership(method)
        || method === "thread/pin/added" || method === "thread/pin/removed"
        || (method === "navigation/remoteThreadPins/changed" && Array.isArray(params.rowChanges)))) {
      // Pins move roots between directory sections, but do not reparent children.
      // Metadata refreshes preserve this membership proof. Membership changes
      // withdraw it until their replacement is accepted, even while queued.
      // A pending membership refresh may discover rows absent from its baseline;
      // their subsequent events must fence that read and request a replacement.
      // Unknown membership events still discover newly created/reparented children.
      const ownerInstanceId = event.federationTarget?.scope === "remote" ? event.federationTarget.instanceId
        : method === "navigation/remoteThreadPins/changed" ? params.instanceId : undefined;
      if (method === "navigation/remoteThreadPins/changed" && params.rowChanges && params.instanceId
        && event.federationTarget?.scope !== "remote" && request.federationTarget?.scope !== "remote") {
        // The cache compared complete published populations, including
        // placement. Ordinary pin mutations and new members carry no proof.
        const parent = request.query.parent;
        return params.rowChanges.some((ref) => navigationIdentitiesEqual(parent, ref)
          || page.entries.some(({ row }) => navigationIdentitiesEqual(row.ref, ref)));
      }
      if (typeof params?.threadId === "string") {
        const ref = { backend: event.backend, threadId: params.threadId, ownerInstanceId };
        const matches = navigationIdentitiesEqual(request.query.parent, ref)
          || page.entries.some(({ row }) => navigationIdentitiesEqual(row.ref, ref));
        return matches && (seen ? "parent-or-row" : true);
      }
      if (method === "navigation/threadGitWorkingState/updated" && typeof params?.worktreePath === "string") {
        return !this.excludesWorkingStatePaths(request, page, ownerInstanceId, params.worktreePath);
      }
    }
    // Viewer exact pages also carry directory-wide selection descriptors.
    // A sibling's activity can change those counts without changing any exact
    // row, so their invalidation dependencies are wider than their identities.
    // Keep owner exact row scoping and conservative viewer count refreshes.
    if (request.federationTarget?.scope !== "remote" || request.query.kind !== "exact") return true;
    if (resource.membershipUncertain || navigationInvalidationMayChangeMembership(method)) return true;
    if (method === "navigation/directoryGitStatus/updated" && typeof params?.directoryKey === "string"
      && !resource.pending && !resource.value.state.stale && page?.coverage.state === "complete" && page.complete
      && page.entries.every(({ row }) => !row.checkoutProject && !row.linkedDirectoriesTruncated && !row.linkedDirectories.length)) {
      return page.selectionDirectory?.key === params.directoryKey || Boolean(page.directories?.some((directory) => directory.key === params.directoryKey));
    }
    const refs = [...request.query.identities, ...(page?.entries.map(({ row }) => row.ref) ?? [])];
    const ownerInstanceId = event.federationTarget?.scope === "remote" ? event.federationTarget.instanceId : undefined;
    if (typeof params?.threadId === "string") return refs.some((ref) => ref.backend === event.backend
      && ref.threadId === params.threadId && (ref.ownerInstanceId ?? undefined) === ownerInstanceId) && (seen ? "parent-or-row" : true);
    return true;
  }

  private metadataDependencies(page: NavigationQueryPage): NavigationMetadataDependencies | undefined {
    if (!this.pageDependencies.has(page)) this.pageDependencies.set(page, readNavigationMetadataDependencies(page.metadataDependencies));
    return this.pageDependencies.get(page);
  }

  private diagnosticProof(page: NavigationQueryPage | undefined): { proofPresent: boolean; proofAdmitted?: boolean } {
    if (!page) return { proofPresent: false, proofAdmitted: false };
    const admitted = this.ownerPageProofs.get(page)?.dependencies ?? this.pageDependencies.get(page);
    const proofPresent = Boolean(admitted) || page.metadataDependencies !== undefined;
    // Inline proofs are validated only when product logic consults them.
    const proofAdmitted = proofPresent && !admitted && !this.pageDependencies.has(page) ? undefined : Boolean(admitted);
    return { proofPresent, proofAdmitted };
  }

  setVisibleAnchor(id: string, anchor: NavigationQueryAnchor | undefined): void {
    const resource = this.resources.get(id);
    if (resource) resource.anchor = anchor;
  }

  async rebaseline(id: string, anchor: NavigationQueryAnchor): Promise<void> {
    const resource = this.resources.get(id);
    if (!resource) return;
    while (this.isCurrent(resource) && resource.pending) await resource.pending;
    if (!this.isCurrent(resource)) return;
    resource.anchor = anchor;
    resource.membershipUncertain = true;
    return this.read(resource, false, anchor);
  }

  /** The operator's explicit return to the start of a list, discarding its anchor and loaded range. */
  async restart(id: string): Promise<void> {
    const resource = this.resources.get(id);
    if (!resource) return;
    while (this.isCurrent(resource) && resource.pending) await resource.pending;
    if (!this.isCurrent(resource)) return;
    resource.anchor = undefined;
    resource.membershipUncertain = true;
    resource.value = { ...resource.value, state: { ...resource.value.state, rebaselineRequired: false, stale: true } };
    return this.read(resource, false, undefined, true);
  }

  async loadMore(id: string): Promise<void> {
    let resource = this.resources.get(id);
    if (!resource) return;
    const targetResumeKey = this.resumeKey(resource);
    // A refresh can begin between the button's render and its click, or a
    // demand update can replace the same collection while that refresh settles.
    while (resource && this.resumeKey(resource) === targetResumeKey && resource.pending) {
      await resource.pending;
      resource = this.resources.get(id);
    }
    if (!resource || !this.isCurrent(resource) || this.resumeKey(resource) !== targetResumeKey) return;
    await this.read(resource, true);
    const current = this.resources.get(id);
    if (current && this.isCurrent(current) && this.resumeKey(current) === targetResumeKey
      && current.value.state.page && !current.value.state.error && current.expandedRows) {
      const key = this.resumeKey(current);
      this.sessionExpandedQueries.add(key);
      // Asking for more never lowers the saved depth, even when a restore
      // stopped short of it and this click shows fewer rows.
      const rows = Math.max(current.expandedRows, this.resume.loadedRowsByQuery?.[key] ?? 0);
      this.resume.loadedRowsByQuery = { ...this.resume.loadedRowsByQuery, [key]: rows };
      this.resume.onLoadMore?.(key, rows);
    }
  }

  private isCurrent(resource: Resource): boolean {
    return !this.disposed && this.visible && !resource.released
      && this.resources.get(resource.value.id) === resource;
  }

  private wakeReaders(): void {
    for (const wake of this.readWaiters) wake();
    this.readWaiters.clear();
  }

  private canResumeExpansion(budget: ResumeBudget | undefined): boolean {
    return Boolean(budget && budget.reads > 0 && Date.now() < (budget.until ?? Infinity));
  }

  private resumeKey(resource: Resource): string {
    return resource.resumeKey ??= navigationResumeQueryKey(resource.value.state.request);
  }

  /** Restore the saved Load more depth when it exceeds what this list holds. A page
   * awaiting the operator's Reload reads nothing until then, so it never
   * starts a restore. */
  private armResume(resource: Resource, budget: ResumeBudget | undefined): ResumeBudget | undefined {
    if (!this.resume.loadedRowsByQuery || resource.value.state.rebaselineRequired) return budget;
    const rows = this.resume.loadedRowsByQuery[this.resumeKey(resource)];
    if (rows === undefined || rows <= Math.max(resource.expandedRows ?? 0, loadedRows(resource.value.state.page))) return budget;
    budget ??= { reads: MAX_LOAD_MORE_READS };
    resource.expandedRows = rows;
    resource.resumeExpansion = true;
    resource.resumeBudget = budget;
    return budget;
  }

  private finishResume(resource: Resource): void {
    if (!resource.resumeExpansion) return;
    // Each cold-start opening is a single attempt when it stops short, so
    // background events do not chase an unfulfilled saved target. Once a
    // restore reaches the end of the list, or for a list the operator already
    // expanded in this instance, preserve the expansion headroom so newly
    // added rows or a transient error never re-collapse the list.
    resource.resumeExpansion = false;
    resource.resumeBudget = undefined;
    const loaded = loadedRows(resource.value.state.page);
    const key = this.resumeKey(resource);
    if (resource.value.state.page?.complete) {
      resource.expandedRows = Math.max(resource.expandedRows ?? 0, loaded) || undefined;
    } else if (this.sessionExpandedQueries.has(key)) {
      resource.expandedRows = Math.max(
        resource.expandedRows ?? 0,
        this.resume.loadedRowsByQuery?.[key] ?? 0,
        loaded,
      ) || undefined;
    } else {
      resource.expandedRows = loaded || undefined;
    }
  }

  private async acquireReadSlot(resource: Resource): Promise<boolean> {
    while (this.isCurrent(resource) && this.activeReads >= MAX_CONCURRENT_READS) {
      await new Promise<void>((resolve) => this.readWaiters.add(resolve));
    }
    if (!this.isCurrent(resource)) return false;
    this.activeReads += 1;
    return true;
  }

  private read(resource: Resource, continuation: boolean, anchor?: NavigationQueryAnchor, fromStart = false,
    reason: NavigationQueryRequest["readReason"] = "refresh", publishLoading = true): Promise<void> {
    if (!this.isCurrent(resource)) return Promise.resolve();
    if (resource.pending) {
      navigationListingDiagnostics.record({ ...this.diagnostic, phase: "coalesced", logical: resource.diagnosticLogical });
      if (anchor) resource.refreshAfterPending = true;
      return resource.pending;
    }
    const explicitLoadMore = continuation;
    const explicitAnchor = anchor;
    anchor = continuation || fromStart ? undefined : anchor ?? resource.anchor;
    // A remembered anchor is not new recovery demand. Retrying it on every
    // background event clears and re-adds the same error, moving the sidebar.
    if (resource.value.state.rebaselineRequired && !explicitAnchor && !fromStart) return Promise.resolve();
    let cursor = continuation ? resource.value.state.page?.nextCursor : undefined;
    if (continuation && !cursor) return Promise.resolve();
    if (explicitLoadMore || explicitAnchor || fromStart) this.pendingWindowRefreshes.clear();
    const queryKey = this.resumeKey(resource);
    const previousExpandedRows = resource.expandedRows;
    const restoringBeforeRead = explicitAnchor || fromStart ? 0 : loadedRows(resource.value.state.page);
    const read = ++this.nextDiagnosticRead;
    const queuedAt = Date.now();
    const fields = { ...this.diagnostic, read, resource: resource.diagnosticResource,
      query: resource.value.state.request.query.kind,
      source: resource.value.state.request.federationTarget?.scope === "remote" ? "remote" as const : "local" as const,
      inventory: resource.value.state.request.inventory ?? "owner" as const };
    navigationListingDiagnostics.record({ ...fields, phase: "queued", cause: continuation ? "continuation" : explicitAnchor || fromStart ? "rebaseline" : resource.diagnosticCause ?? reason });
    const resuming = resource.resumeExpansion === true;
    const budget = resuming ? resource.resumeBudget : undefined;
    if (budget) budget.until ??= Date.now() + MAX_LOAD_MORE_MS;
    let started = beginNavigationPageRead(resource.value.state);
    resource.value = { ...resource.value, state: started, loading: true };
    if (publishLoading) this.publish();
    const promise = Promise.resolve().then(async () => {
      let acquired = false;
      // A published range can fold several IPC pages together. Correlate its
      // decision with the last contributing reply, without keeping a reply list.
      let lastReply: ReplyDiagnostic | undefined;
      const discardReply = () => {
        if (!lastReply) return;
        const { generation, ...reply } = lastReply;
        navigationListingDiagnostics.record({ ...fields, ...reply, phase: "reply", disposition: "discarded", proofAdmitted: false }, generation);
        lastReply = undefined;
      };
      const acceptReply = (next: RetainableState, reply: ReplyDiagnostic | undefined) => {
        const before = resource.value.state.page;
        this.acceptState(resource, next, Boolean(cursor));
        if (explicitLoadMore) this.sessionExpandedQueries.add(queryKey);
        if (reply === lastReply) lastReply = undefined;
        if (!reply || !navigationListingDiagnostics.isRecording(reply.generation)) return;
        const page = resource.value.state.page;
        const selectionBefore = before?.selectionDirectory;
        const selection = page?.selectionDirectory;
        const unreadBefore = before?.counts?.unread;
        const unread = page?.counts?.unread;
        const selectionUnreadBefore = selectionBefore?.counts?.unread;
        const selectionUnread = selection?.counts?.unread;
        navigationListingDiagnostics.record({ ...fields, logical: reply.logical, attempt: reply.attempt,
          phase: "reply", disposition: "accepted", ...navigationDiagnosticPageShape(page),
          ...this.diagnosticProof(page),
          unreadChanged: unreadBefore !== undefined && unread !== undefined ? unreadBefore !== unread : undefined,
          selectionUnreadChanged: selectionUnreadBefore !== undefined && selectionUnread !== undefined && selectionBefore?.key === selection?.key
            ? selectionUnreadBefore !== selectionUnread : undefined,
        }, reply.generation);
      };
      try {
        acquired = await this.acquireReadSlot(resource);
        if (!acquired) return;
        const waitMs = Math.max(0, Date.now() - queuedAt);
        // A queued read has made no observation yet. Consume invalidations at
        // dispatch; only events after this point require a replacement read.
        // A stale baseline (e.g. restored from cache or after a failed read)
        // also cannot safely extend its old cursor on an explicit Load more.
        if (resource.invalidated || (continuation && started.stale)) {
          if (continuation) {
            // A queued Load more still owns its block, but cannot extend a
            // cursor whose snapshot an event or prior failure invalidated.
            resource.expandedRows = loadedRows(started.page) + LOAD_MORE_ROWS;
            continuation = false;
            cursor = undefined;
          }
          anchor = fromStart ? undefined : explicitAnchor ?? resource.anchor;
          started = beginNavigationPageRead(resource.value.state);
          resource.value = { ...resource.value, state: started };
        }
        resource.invalidated = false;
        resource.refreshAfterPending = false;
        if (started.request.consumer === "main-sidebar" && resource.membershipUncertain) {
          resource.membershipRead = { paths: new Set() };
        }
        const diagnostic = { ...this.diagnostic, origin: navigationDiagnosticOrigin(), logical: ++this.nextLogical, attempt: 0,
          cause: continuation ? "continuation" as const : explicitAnchor || fromStart ? "rebaseline" as const : resource.diagnosticCause ?? reason ?? "refresh",
          invalidations: resource.diagnosticInvalidations ?? 0, trigger: resource.diagnosticTrigger, caller: resource.diagnosticCaller };
        const batch = resource.diagnosticBatch;
        const refreshBatch = resource.diagnosticRefreshBatch;
        resource.diagnosticBatch = undefined;
        resource.diagnosticRefreshBatch = undefined;
        resource.diagnosticLogical = diagnostic.logical;
        resource.diagnosticTrigger = undefined;
        resource.diagnosticCaller = undefined;
        resource.diagnosticCause = undefined;
        resource.diagnosticInvalidations = 0;
        if (!this.api.getNavigationQueryPage) throw new Error("Navigation query protocol 2 is required. Upgrade this instance.");
        const assertRetained = (next: NavigationPageState) => {
          const retainedBytes = this.activePageBytes - this.pageBytes(resource.value.state.page) + this.pageBytes(next.page);
          if (retainedBytes > MAX_RETAINED_BYTES) throw new Error("Navigation retained-page budget reached. Collapse a directory or change lens to release pages.");
        };
        // Rows already on screen are restored outside the saved-depth budget.
        const readPage = async (request: NavigationQueryRequest, restoringDisplayed = false, preceding?: RetainableState) => {
          // A page is measured as its owner measured it, so one that honored
          // the budget fits here. An owner that did not would send the same
          // page on every request, and a control that hit it could never
          // succeed again. Halve the rows and ask again instead of handing
          // the operator a button that fails identically on every press.
          let rows = request.pageSize ?? NAVIGATION_QUERY_MAX_PAGE_ROWS;
          for (;;) {
            const charged = resuming && !this.sessionExpandedQueries.has(queryKey)
              && Boolean(request.cursor) && !restoringDisplayed;
            if (charged) {
              // Unresolved notices reserve this slot for the replacement.
              // Check every attempt, including retries with a smaller page.
              if (!budget || !this.canResumeExpansion(budget) || this.needsWorkingStateReplacement(resource, preceding)) {
                throw RESUME_BUDGET_REACHED;
              }
              budget.reads -= 1;
            }
            diagnostic.attempt += 1;
            const sentAt = Date.now();
            const attemptFields = { ...fields, batch, refreshBatch, logical: diagnostic.logical, attempt: diagnostic.attempt,
              cause: diagnostic.cause, caller: diagnostic.caller, trigger: diagnostic.trigger, invalidations: diagnostic.invalidations,
              cursor: Boolean(request.cursor), rows, waitMs };
            const generation = navigationListingDiagnostics.recordingGeneration;
            navigationListingDiagnostics.record({ ...attemptFields, phase: "dispatch" });
            let page: NavigationQueryPage;
            try {
              const wireBase = resource.wireBase;
              const baseline = wireBase?.rows();
              const delta = request.consumer === "main-sidebar" && !request.cursor;
              const sent = { ...request, pageSize: rows, diagnostic: { ...diagnostic },
                ...(delta ? { windowPageBase: baseline ? wireBase!.token : "" } : {}),
                ...(charged && budget?.until !== undefined ? { deadlineAt: Math.min(request.deadlineAt ?? Infinity, budget.until) } : {}),
                readReason: continuation ? "continuation" : explicitAnchor || fromStart ? "rebaseline" : reason,
              } satisfies NavigationQueryRequest;
              page = await this.api.getNavigationQueryPage!(sent, resource.token);
              if (page.windowPagePatch) {
                const { token } = page.windowPagePatch;
                const expanded = expandWindowNavigationPage(page, baseline, wireBase?.token);
                if (expanded) {
                  page = expanded;
                  resource.wireBase = rememberWindowPage(page, token);
                } else {
                  resource.wireBase = undefined;
                  const fresh = await this.api.getNavigationQueryPage!({ ...sent, completeBaselineRevision: undefined,
                    retainedRange: undefined, windowPageBase: undefined }, resource.token);
                  const full = expandWindowNavigationPage(fresh);
                  if (!full || full.unchanged || full.rangeUnchanged) throw new Error("Navigation owner did not return a fresh page.");
                  page = full;
                  if (fresh.windowPagePatch) resource.wireBase = rememberWindowPage(page, fresh.windowPagePatch.token);
                }
              }
              navigationListingDiagnostics.record({ ...attemptFields, phase: "settled", outcome: "ok", durationMs: Math.max(0, Date.now() - sentAt) }, generation);
            } catch (error) {
              navigationListingDiagnostics.record({ ...attemptFields, phase: "settled", outcome: "error", durationMs: Math.max(0, Date.now() - sentAt) }, generation);
              throw error;
            }
            lastReply = navigationListingDiagnostics.isRecording(generation)
              ? { generation, logical: diagnostic.logical, attempt: diagnostic.attempt, ...navigationDiagnosticPageShape(page) }
              : undefined;
            if (this.pageBytes(page) <= NAVIGATION_QUERY_MAX_RESULT_BYTES) return page;
            discardReply();
            // One row over the budget is the owner's own error to raise.
            if (rows <= 1) throw new Error("Navigation page exceeds the bounded response size.");
            navigationListingDiagnostics.record({ ...this.diagnostic, phase: "retry", logical: diagnostic.logical, attempt: diagnostic.attempt, retry: "page-budget" });
            rows = Math.floor(rows / 2);
          }
        };
        // An anchor is remembered for every later refresh of this resource,
        // and the row it names can leave the owner's query first: archived,
        // reparented, moved, or pinned between a selection's exact read and
        // its directory's. Refusing the read stranded an error card and
        // blocked every refresh until the operator clicked Reload. Resume at
        // the nearest surviving row instead, then at the top.
        const readAround = async (request: NavigationQueryRequest) => {
          const missing = request.anchor;
          if (!missing) return readPage(request);
          for (const anchor of [missing, navigationFallbackAnchor(started.page, missing), undefined]) {
            if (anchor !== missing && navigationAnchorsEqual(anchor, missing)) continue;
            try {
              const page = await readPage(anchor === missing ? request
                : { ...request, anchor, retainedRange: undefined, completeBaselineRevision: undefined });
              if (anchor !== missing && navigationAnchorsEqual(resource.anchor, missing)) resource.anchor = anchor;
              return page;
            } catch (error) {
              if (!anchor || !isNavigationAnchorMissing(error)
                || !this.isCurrent(resource) || resource.value.state.pendingSequence !== started.pendingSequence) throw error;
              navigationListingDiagnostics.record({ ...this.diagnostic, phase: "retry", logical: diagnostic.logical, attempt: diagnostic.attempt, retry: "anchor-missing" });
            }
          }
          throw new Error("Navigation anchor fallback did not reach the top of its list.");
        };
        let page: NavigationQueryPage;
        // Only displayed rows bypass continuation limits. A persisted target
        // is expansion demand, and may exceed what the previous owner served.
        const restoring = explicitAnchor || fromStart ? 0 : loadedRows(started.page);
        if (explicitAnchor || fromStart) {
          resource.expandedRows = undefined;
          const key = navigationResumeQueryKey(started.request);
          this.sessionExpandedQueries.delete(key);
          if (this.resume.loadedRowsByQuery?.[key] !== undefined) {
            const loadedRows = { ...this.resume.loadedRowsByQuery };
            delete loadedRows[key];
            this.resume.loadedRowsByQuery = loadedRows;
          }
          this.resume.onRangeReset?.(key);
        }
        if (continuation) resource.expandedRows = restoring + LOAD_MORE_ROWS;
        const sessionExpanded = this.sessionExpandedQueries.has(queryKey);
        const wanted = Math.max(restoring, resource.expandedRows ?? 0);
        // A cursor read serves rows this window has already committed to: the
        // block an explicit click asked for, or the range a refresh must
        // restore. Neither is paced by the demand page size that bounds a
        // first paint, so read exactly what is still wanted in as few round
        // trips as the protocol allows. Owners clamp to their byte budget.
        const cursorPageSize = (loaded: number) =>
          Math.max(1, Math.min(NAVIGATION_QUERY_MAX_PAGE_ROWS, wanted - loaded));
        // Measured from the click, not from its first page: an owner slow
        // enough to spend the budget on one read has already made the
        // operator wait, and a second wait of the same length is not an
        // improvement on the button they still have.
        const extendUntil = Date.now() + MAX_LOAD_MORE_MS;
        const loadMoreRebuildPageSize = Math.max(
          started.request.pageSize ?? 0,
          Math.min(NAVIGATION_QUERY_MAX_PAGE_ROWS, wanted),
        );
        const rebuildForLoadMore = async (): Promise<NavigationQueryPage> => {
          resource.membershipUncertain = true;
          cursor = undefined;
          const previous = started.page;
          const firstDirectory = previous?.directories?.[0];
          const firstThread = previous?.entries[0]?.row.ref;
          const recoveryAnchor = resource.anchor ?? ((previous?.rangeStart ?? 0) > 0
            ? firstDirectory ? { kind: "directory" as const, key: firstDirectory.key }
              : firstThread ? { kind: "thread" as const, ref: firstThread } : undefined : undefined);
          return readAround({ ...started.request, anchor: recoveryAnchor, pageSize: loadMoreRebuildPageSize });
        };
        const isRecoverableCursorError = (error: unknown): boolean =>
          isNavigationCursorExpired(error) || isNavigationContinuationInvalid(error);
        let next: RetainableState;
        let nextReply: ReplyDiagnostic | undefined;
        try {
          page = await readAround({ ...started.request, cursor, anchor,
            ...(cursor ? { pageSize: cursorPageSize(loadedRows(started.page)) }
              : (explicitLoadMore || (resuming && sessionExpanded)) ? { pageSize: loadMoreRebuildPageSize } : {}),
            completeBaselineRevision: !fromStart && !anchor && !cursor && !started.stale && started.page?.complete && (started.page.rangeStart ?? 0) === 0 ? started.page.countsRevision : undefined,
            retainedRange: !fromStart && !explicitAnchor && !cursor && !explicitLoadMore
              && (anchor || !started.page?.complete || (started.page.rangeStart ?? 0) !== 0)
              ? navigationRetainedRange(started) : undefined,
          });
          if (!this.isCurrent(resource) || resource.value.state.pendingSequence !== started.pendingSequence) return;
          const priorState = resource.value.state;
          next = this.retainableState(applyNavigationPage({ state: priorState, sequence: started.pendingSequence, page, cursor }));
          nextReply = lastReply;
        } catch (error) {
          if (!cursor || !isRecoverableCursorError(error)) throw error;
          navigationListingDiagnostics.record({ ...this.diagnostic, phase: "retry", logical: diagnostic.logical, attempt: diagnostic.attempt, retry: "cursor-expired" });
          // Cursor eviction or generation/lease mismatch is recoverable, not a
          // permanently dead Load more button. Rebuild the displayed range plus
          // this click's block from the anchor in one bounded page.
          page = await rebuildForLoadMore();
          if (!this.isCurrent(resource) || resource.value.state.pendingSequence !== started.pendingSequence) return;
          const priorState = resource.value.state;
          next = this.retainableState(applyNavigationPage({ state: priorState, sequence: started.pendingSequence, page, cursor }));
          nextReply = lastReply;
        }
        const priorState = resource.value.state;
        // applyNavigationPage validated the retained query, epoch, revision
        // and range. Transfer only a proof still admitted for those rows.
        if (page.rangeUnchanged && priorState.page && !next.ownerProof?.directoryGitProof) {
          const prior = this.ownerPageProofs.get(priorState.page);
          if (prior?.directoryGitProof) next.ownerProof = { ...next.ownerProof, directoryGitProof: prior.directoryGitProof,
            gitBytes: prior.gitBytes, bytes: (next.ownerProof?.bytes ?? 0) + prior.gitBytes };
        }
        assertRetained(next.state);
        // A complete-baseline acknowledgment reuses the previous page.
        // Only a response with fresh dependency proof can exclude this notice.
        if (this.needsSeenReplacement(resource, page.unchanged ? undefined : next)) return;
        if (resuming && !sessionExpanded && next.state.page?.nextCursor && loadedRows(next.state.page) >= restoring
          && loadedRows(next.state.page) < wanted && this.canResumeExpansion(budget) && Date.now() < extendUntil) {
          // Saved expansion must not withhold the ordinary first page, nor
          // replace a longer cached range with it.
          if (this.needsWorkingStateReplacement(resource, next)) return;
          acceptReply(next, nextReply);
          nextReply = undefined;
          this.publish();
        }
        let extensions = 0;
        // Restore displayed rows before applying continuation budgets. Spare
        // capacity from an earlier Load more admits new rows under those same
        // budgets; a short final page does not revoke the operator's demand.
        while (next.state.page?.nextCursor && loadedRows(next.state.page) < wanted
          && (loadedRows(next.state.page) < restoring || ((!resuming || sessionExpanded || this.canResumeExpansion(budget))
            && extensions < MAX_LOAD_MORE_READS && Date.now() < extendUntil))) {
          const nextCursor = next.state.page.nextCursor;
          const before = loadedRows(next.state.page);
          const restoringDisplayed = before < restoring;
          if (this.needsSeenReplacement(resource, next)) return;
          if ((!resuming || sessionExpanded || restoringDisplayed) && this.needsWorkingStateReplacement(resource, next, "match-only")) return;
          try {
            const continuationPage = await readPage({ ...started.request, cursor: nextCursor, pageSize: cursorPageSize(before) }, restoringDisplayed, next);
            if (!this.isCurrent(resource) || resource.value.state.pendingSequence !== started.pendingSequence) return;
            const extended = this.retainableState(applyNavigationPage({ state: next.state, sequence: started.pendingSequence, page: continuationPage, cursor: nextCursor }));
            if (loadedRows(extended.state.page) <= before) throw new Error("Navigation range refresh did not advance.");
            assertRetained(extended.state);
            next = extended;
            nextReply = lastReply;
          } catch (error) {
            if (!this.isCurrent(resource) || resource.value.state.pendingSequence !== started.pendingSequence) return;
            if (error === RESUME_BUDGET_REACHED) break;
            // Discard a rebuild only while it still owes displayed rows.
            // Once restored, commit refreshed membership and metadata plus
            // any growth delivered before the failure. Continuations also
            // retain their progress; both paths still report the error.
            if (!cursor && loadedRows(next.state.page) < restoring) throw error;
            if (!this.needsSeenReplacement(resource, next) && !this.needsWorkingStateReplacement(resource, next)) acceptReply(next, nextReply);
            throw error;
          }
          extensions += 1;
        }
        if (this.needsSeenReplacement(resource, next) || this.needsWorkingStateReplacement(resource, next)) return;
        acceptReply(next, nextReply);
        resource.pinPublicationPending = false;
        resource.membershipUncertain = false;
        resource.prAttachmentsUncertain = false;
      } catch (error) {
        if (explicitLoadMore && loadedRows(resource.value.state.page) <= restoringBeforeRead) {
          resource.expandedRows = previousExpandedRows;
        }
        // An overtaken cursor cannot establish a new rebaseline requirement.
        if (this.isCurrent(resource) && !this.needsSeenReplacement(resource) && !this.needsWorkingStateReplacement(resource)) resource.value = { ...resource.value,
          state: failNavigationPageRead(resource.value.state, started.pendingSequence, error) };
      } finally {
        discardReply();
        resource.membershipRead = undefined;
        // An invalidation can discard the opening page before it is accepted.
        // Its coalesced replacement still owes the saved depth. Carry the same
        // budget into that read; a fenced response has not finished restoring.
        if (resuming && this.resources.get(resource.value.id) === resource
          && (!resource.refreshAfterPending || resource.value.state.pendingSequence === started.pendingSequence)) {
          this.finishResume(resource);
        }
        if (acquired) {
          this.activeReads -= 1;
          this.wakeReaders();
        }
        if (resource.pending === promise) resource.pending = undefined;
        if (this.isCurrent(resource)) {
          const repeat = resource.refreshAfterPending;
          resource.refreshAfterPending = false;
          if (repeat && !resource.value.state.rebaselineRequired) {
            if (explicitLoadMore && !resource.value.state.error) this.sessionExpandedQueries.add(queryKey);
            void this.read(resource, false);
          } else {
            resource.value = { ...resource.value, loading: false };
            this.publish();
          }
        }
      }
    });
    resource.pending = promise;
    return promise;
  }

  dispose(): void {
    if (this.disposed) return;
    navigationListingDiagnostics.record({ ...this.diagnostic, phase: "dispose" });
    this.disposed = true;
    this.pendingWindowRefreshes.clear();
    for (const resource of this.resources.values()) this.release(resource);
    this.resources.clear();
    this.activePageBytes = 0;
    this.ownerPageProofs.clear();
    this.ownerProofBytes = 0;
    this.retained.clear();
    this.publish();
    this.listeners.clear();
  }
}
