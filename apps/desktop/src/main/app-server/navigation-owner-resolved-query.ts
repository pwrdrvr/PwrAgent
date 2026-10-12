import { createHash } from "node:crypto";
import type {
  FederationRemoteTarget,
  NavigationIdentity,
  NavigationQueryPage,
  NavigationQueryRequest,
  NavigationRow,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { NAVIGATION_QUERY_MAX_PAGE_ROWS } from "@pwragent/shared";
import { isFederationPeerUnavailableError } from "../federation/federation-peer-unavailable-error";
import {
  projectNavigationQuery,
  type NavigationQueryIndex,
  type NavigationQueryMaterialization,
} from "./navigation-query-projection";

type PeerStatus = NonNullable<NavigationRow["federation"]>["peerStatus"];

type OwnerResult = { instanceId: string; identities: NavigationIdentity[] }
  & ({ rows: NavigationRow[] } | { peerStatus: PeerStatus });

/** At most 100 identities plus their ancestry: a few owner pages, never an unbounded walk. */
const MAX_OWNER_READS = 8;
/**
 * Half the pool's read deadline. A connected owner that stops answering is
 * served from held rows, rather than holding this machine's own rows until
 * the whole page expires.
 */
const OWNER_READ_BUDGET_MS = 5_000;

type OwnerReadOptions = { signal: AbortSignal; deadlineAt: number };
type ReadOwnerPage = (target: FederationRemoteTarget, request: NavigationQueryRequest,
  options: OwnerReadOptions) => Promise<NavigationQueryPage>;

function identityKey(ref: NavigationIdentity): string {
  return JSON.stringify([ref.ownerInstanceId ?? null, ref.backend, ref.threadId]);
}

function summaryIdentity(thread: NavigationThreadSummary): NavigationIdentity {
  return { backend: thread.source, threadId: thread.id,
    ...(thread.federation?.ref.target.scope === "remote" ? { ownerInstanceId: thread.federation.ref.target.instanceId } : {}) };
}

/** The parent a peer's row names, when that parent belongs to the same peer. */
function sameOwnerParent(thread: NavigationThreadSummary, instanceId: string): NavigationIdentity | undefined {
  if (!thread.parentThreadId || (thread.parentThreadInstanceId && thread.parentThreadInstanceId !== instanceId)) return undefined;
  return { backend: thread.parentThreadBackend ?? thread.source, threadId: thread.parentThreadId, ownerInstanceId: instanceId };
}

/** A held row for an owner that cannot answer: dimmed, and never a live turn. */
function heldRow<T extends NavigationThreadSummary | NavigationRow>(row: T, peerStatus: PeerStatus): T {
  // A saved running flag is not evidence of a live turn in this process.
  const { threadStatus, ...rest } = row;
  return { ...rest, ...(threadStatus && threadStatus !== "active" ? { threadStatus } : {}),
    ...(row.federation ? { federation: { ...row.federation, peerStatus } } : {}) } as T;
}

/** Settles when the signal aborts, even if the read it bounds ignores cancellation. */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** The owner's row, plus what only this viewer knows: its pin rank and its own children. */
function viewerRow(owner: NavigationRow, projected: NavigationRow): NavigationRow {
  const { rowRevision: _rowRevision, pinnedRank: _ownerRank, viewerChildCount: _viewerChildCount, ...row } = owner;
  const viewerChildCount = projected.viewerChildCount ?? 0;
  const presented = { ...row, ...(projected.pinnedRank ? { pinnedRank: projected.pinnedRank } : {}),
    ordinaryChildCount: owner.ordinaryChildCount + viewerChildCount, viewerChildCount };
  return { ...presented, rowRevision: createHash("sha256").update(JSON.stringify(presented)).digest("base64url") };
}

/**
 * Owner rows this viewer last resolved, in process memory only. They hold a
 * row whose owner later cannot answer and that no peer snapshot covers.
 */
export class OwnerResolvedRowMemory {
  private readonly rows = new Map<string, NavigationRow>();

  constructor(private readonly maxRows = 1024) {}

  remember(rows: Iterable<NavigationRow>): void {
    for (const row of rows) {
      const key = identityKey(row.ref);
      this.rows.delete(key);
      this.rows.set(key, row);
    }
    for (const key of this.rows.keys()) {
      if (this.rows.size <= this.maxRows) break;
      this.rows.delete(key);
    }
  }

  forget(refs: Iterable<NavigationIdentity>): void {
    for (const ref of refs) this.rows.delete(identityKey(ref));
  }

  get(ref: NavigationIdentity): NavigationRow | undefined {
    return this.rows.get(identityKey(ref));
  }
}

async function readOwnerRows(params: {
  request: NavigationQueryRequest;
  target: FederationRemoteTarget;
  identities: NavigationIdentity[];
  includeAncestry?: boolean;
  readOwnerPage: ReadOwnerPage;
  options: OwnerReadOptions;
}): Promise<NavigationRow[]> {
  const { request } = params;
  const ownerRequest: NavigationQueryRequest = {
    protocol: request.protocol, inventory: "owner", consumer: request.consumer,
    ...(request.backend ? { backend: request.backend } : {}),
    ...(request.readReason ? { readReason: request.readReason } : {}),
    ...(request.diagnostic ? { diagnostic: request.diagnostic } : {}),
    deadlineAt: params.options.deadlineAt,
    federationTarget: params.target,
    query: { kind: "exact", identities: params.identities, includeAncestry: params.includeAncestry },
    pageSize: NAVIGATION_QUERY_MAX_PAGE_ROWS,
  };
  let page = await params.readOwnerPage(params.target, ownerRequest, params.options);
  const rows = page.entries.map(({ row }) => row);
  for (let reads = 1; page.nextCursor; reads += 1) {
    if (reads >= MAX_OWNER_READS) throw new Error("Owner exact read did not complete within its page budget.");
    page = await params.readOwnerPage(params.target, { ...ownerRequest, cursor: page.nextCursor }, params.options);
    rows.push(...page.entries.map(({ row }) => row));
  }
  return rows;
}

/**
 * One viewer page over identities owned by any instance. This machine's
 * threads and mounted peer rows come from its viewer inventory. Each peer
 * that answers supplies its own rows through an owner exact read. A peer
 * that cannot answer is served from rows this viewer already holds, dimmed,
 * and an identity with no held row is omitted: an offline peer is never an
 * error for the page.
 */
export async function materializeOwnerResolvedNavigation(params: {
  request: NavigationQueryRequest;
  /** This machine's viewer inventory: its own threads plus mounted peer rows. */
  loadViewerIndex: () => Promise<NavigationQueryIndex>;
  /** One stamped owner page. Throws when the owner cannot answer. */
  readOwnerPage: ReadOwnerPage;
  /** A peer's last snapshot rows, without waiting on the peer. */
  cachedOwnerThreads: (instanceId: string) => readonly NavigationThreadSummary[];
  memory: OwnerResolvedRowMemory;
  signal?: AbortSignal;
  deadlineAt?: number;
  ownerReadBudgetMs?: number;
  onOwnerFailure?: (instanceId: string, error: unknown) => void;
}): Promise<NavigationQueryMaterialization> {
  const query = params.request.query;
  if (query.kind !== "exact" || !query.resolveFromOwners) {
    throw new Error("Owner-resolved navigation requires an owner-resolved exact query.");
  }
  const byOwner = new Map<string, NavigationIdentity[]>();
  for (const ref of query.identities) {
    if (!ref.ownerInstanceId) continue;
    const refs = byOwner.get(ref.ownerInstanceId) ?? [];
    refs.push(ref);
    byOwner.set(ref.ownerInstanceId, refs);
  }
  const [index, ...owners] = await Promise.all([
    params.loadViewerIndex(),
    ...[...byOwner].map(async ([instanceId, identities]): Promise<OwnerResult> => {
      const deadlineAt = Math.min(params.deadlineAt ?? Infinity, Date.now() + (params.ownerReadBudgetMs ?? OWNER_READ_BUDGET_MS));
      const budget = AbortSignal.timeout(Math.max(0, deadlineAt - Date.now()));
      const signal = params.signal ? AbortSignal.any([params.signal, budget]) : budget;
      try {
        const rows = await Promise.race([readOwnerRows({ request: params.request, target: { scope: "remote", instanceId },
          identities, includeAncestry: query.includeAncestry, readOwnerPage: params.readOwnerPage,
          options: { deadlineAt, signal } }), aborted(signal)]);
        return { instanceId, identities, rows };
      } catch (error) {
        params.signal?.throwIfAborted();
        params.onOwnerFailure?.(instanceId, error);
        // A connected owner that fails is degraded, as in the mounted-pin merge.
        const peerStatus: PeerStatus = isFederationPeerUnavailableError(error) ? "disconnected" : "degraded";
        return { instanceId, identities, peerStatus };
      }
    }),
  ]);
  params.signal?.throwIfAborted();

  const threads = new Map(index.threads.map((thread) => [identityKey(summaryIdentity(thread)), thread]));
  const ownerRows = new Map<string, NavigationRow>();
  const place = (row: NavigationRow): void => {
    const key = identityKey(row.ref);
    // A mounted row keeps this viewer's pin rank. The owner's pin order never crosses.
    const { pinnedRank: _ownerRank, ...summary } = row;
    const viewerRank = threads.get(key)?.pinnedRank;
    threads.set(key, viewerRank ? { ...summary, pinnedRank: viewerRank } : summary);
    ownerRows.set(key, row);
  };
  for (const owner of owners) {
    if ("rows" in owner) {
      for (const row of owner.rows) place(row);
      params.memory.remember(owner.rows);
      const returned = new Set(owner.rows.map((row) => identityKey(row.ref)));
      params.memory.forget(owner.identities.filter((ref) => !returned.has(identityKey(ref))));
      continue;
    }
    // Mounted rows are already in the viewer inventory, held by the pin merge.
    let cached: Map<string, NavigationThreadSummary> | undefined;
    for (const identity of owner.identities) {
      const seen = new Set<string>();
      let ref: NavigationIdentity | undefined = identity;
      while (ref && !seen.has(identityKey(ref)) && !threads.has(identityKey(ref))) {
        const key = identityKey(ref);
        seen.add(key);
        const remembered = params.memory.get(ref);
        if (remembered) {
          place(heldRow(remembered, owner.peerStatus));
          ref = sameOwnerParent(remembered, owner.instanceId);
          continue;
        }
        cached ??= new Map(params.cachedOwnerThreads(owner.instanceId)
          .map((thread) => [identityKey(summaryIdentity(thread)), thread]));
        const snapshot = cached.get(key);
        if (!snapshot) break;
        const { pinnedRank: _ownerRank, ...summary } = heldRow(snapshot, owner.peerStatus);
        threads.set(key, summary);
        ref = sameOwnerParent(snapshot, owner.instanceId);
      }
    }
  }

  const materialization = projectNavigationQuery({ index: { ...index, threads: [...threads.values()] }, request: params.request });
  return {
    ...materialization,
    // Each owner names its own home directory. A page spanning owners has none.
    selectionDirectory: undefined,
    entries: materialization.entries.map((entry) => {
      const owned = ownerRows.get(identityKey(entry.row.ref));
      return owned ? { ...entry, row: viewerRow(owned, entry.row) } : entry;
    }),
  };
}
