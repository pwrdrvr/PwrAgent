import { createHash, randomUUID } from "node:crypto";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { NavigationIdentity, NavigationQueryPage, NavigationQueryRequest, PrSummary } from "@pwragent/shared/contracts/navigation";
import {
  NAVIGATION_ATTENTION_SCOPES,
  NAVIGATION_QUERY_MAX_PAGE_ROWS,
  NAVIGATION_QUERY_MAX_RESULT_BYTES,
  NAVIGATION_QUERY_PROTOCOL_VERSION,
} from "@pwragent/shared/contracts/navigation";
import {
  explainMissingNavigationAnchor,
  navigationQueryKey,
  projectNavigationQuery,
  navigationQuerySnapshotRowOwners,
  projectNavigationPullRequests,
  projectRetainedAttention,
  navigationAttentionDelta,
  navigationQuerySnapshotToken,
  type NavigationEntrySources,
  type NavigationQueryIndex,
  type NavigationQueryMaterialization,
} from "./navigation-query-projection";
import {
  navigationAttentionMemberBytes,
  navigationAttentionOrderFollows,
  navigationAttentionIdentity,
  navigationAttentionTurnMember,
  reconcileNavigationAttentionOrder,
  reconcileNavigationAttentionDelta,
  type NavigationAttentionOrder,
  type NavigationAttentionRowEdit,
} from "./navigation-attention-order";
import { currentNavigationObservation, nextNavigationObservation } from "./navigation-observation-clock";
import type { NavigationAttentionPageRows } from "./navigation-attention-page";

const NAVIGATION_QUERY_CURSOR_IDLE_MS = 60_000;
const NAVIGATION_QUERY_MAX_GENERATIONS = 8;
const NAVIGATION_QUERY_MAX_RETAINED_BYTES = 32 * 1024 * 1024;
const NAVIGATION_ATTENTION_MAX_VIEWS = 64;
const NAVIGATION_ATTENTION_MAX_BYTES = 8 * 1024 * 1024;
const COMPLETE_ATTENTION_CACHE_BYTES = 2 * 1024 * 1024;

export type NavigationQueryErrorCode =
  | "navigation_busy"
  | "navigation_cursor_expired"
  | "navigation_anchor_missing"
  | "navigation_invalid_request"
  | "navigation_item_too_large";

export class NavigationQueryError extends Error {
  readonly code: NavigationQueryErrorCode;

  constructor(code: NavigationQueryErrorCode, message: string) {
    // Electron serializes Error.message but drops custom fields such as code.
    super(`[${code}] ${message}`);
    this.name = "NavigationQueryError";
    this.code = code;
  }
}

type NavigationQueryGeneration = {
  completeRevision: string;
  createdAt: number;
  generation: string;
  lastAccessedAt: number;
  materialization: NavigationQueryMaterialization;
  viewerRowOwners?: readonly string[];
  directoryGitProof?: NavigationQueryPage["directoryGitProof"];
  retainedBytes: number;
  scopeKey: string;
  attentionViewId?: string;
  /** A retained generation can reuse projection from identical certified input. */
  snapshotToken?: symbol;
  projectionRequest?: string;
  incremental?: boolean;
  acceleration?: GenerationAcceleration;
  /** Membership and attachment presence, independent of read-time PR projection. */
  sourceRevision?: string;
  pullRequests?: Map<number, ReturnType<typeof projectNavigationPullRequests>>;
  attentionRows?: NavigationAttentionPageRows;
  attentionRevision?: symbol;
};

type AttentionView = {
  order: NavigationAttentionOrder;
  bytes: number;
  memberBytes: number;
  removedBytes: number;
  promoteOnTurnEnd: boolean;
  backend: NavigationQueryRequest["backend"];
  remoteMembers: Set<string>;
  indexToken?: symbol;
  revision: symbol;
  previousRevision?: symbol;
  listed: Set<string>;
  pending: Set<string>;
  latestBoundary: number;
  observedAt: number;
  overtaken?: boolean;
  failed?: boolean;
};

type CompleteAttentionProjection = Pick<NavigationQueryGeneration,
  "scopeKey" | "attentionViewId" | "lastAccessedAt" | "attentionRows" | "attentionRevision" | "projectionRequest" | "retainedBytes">;

export type NavigationPullRequestProjection = {
  read: (threads: NavigationIdentity[]) => Promise<PrSummary[][]>;
  verify: (batches: PrSummary[][]) => Promise<PrSummary[][]>;
};
type PullRequestObservation = readonly [number, ReturnType<typeof projectNavigationPullRequests>];

function pullRequestPositions(generation: NavigationQueryGeneration, start: number, count: number): number[] {
  if (generation.attentionRows) return generation.attentionRows.deferredPositions(start, count);
  const positions = generation.materialization.pullRequestPositions ?? [];
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (positions[mid]! < start) low = mid + 1;
    else high = mid;
  }
  const result: number[] = [];
  for (let i = low; i < positions.length && positions[i]! < start + count; i++) result.push(positions[i]!);
  return result;
}

async function readPullRequestPositions(generation: NavigationQueryGeneration, positions: number[], load: NavigationPullRequestProjection["read"]): Promise<PullRequestObservation[]> {
  if (!positions.length) return [];
  const results = await load(positions.map((position) => entryAt(generation, position)!.row.ref));
  return positions.map((position, index) => [
    position,
    projectNavigationPullRequests(results[index], entryAt(generation, position)!.row.stackLeadPrKey),
  ] as const);
}

function entryAt(generation: NavigationQueryGeneration, position: number) {
  return generation.attentionRows ? generation.attentionRows.at(position) : generation.materialization.entries[position];
}

function hasDeferredPullRequests(generation: NavigationQueryGeneration): boolean {
  return generation.attentionRows?.hasDeferred ?? Boolean(generation.materialization.pullRequestPositions);
}

function withPullRequestPositions(generation: NavigationQueryGeneration, rows: PullRequestObservation[]): NavigationQueryGeneration {
  if (!rows.length) return generation;
  const observations = new Map(generation.pullRequests);
  let retainedBytes = generation.retainedBytes;
  for (const [position, projection] of rows) {
    // Overlapping continuation readers can finish in either order. The first
    // observation owns this row for the lifetime of the cursor generation.
    if (observations.has(position)) continue;
    observations.set(position, projection);
    retainedBytes += serializedBytes([position, projection]);
  }
  let directoryGitProof = generation.directoryGitProof;
  if (directoryGitProof && retainedBytes > NAVIGATION_QUERY_MAX_RETAINED_BYTES) {
    retainedBytes -= serializedBytes({ directoryGitProof }) - 1;
    directoryGitProof = undefined;
  }
  let viewerRowOwners = generation.viewerRowOwners;
  if (viewerRowOwners && retainedBytes > NAVIGATION_QUERY_MAX_RETAINED_BYTES) {
    // A later cursor page can discover PRs. Drop the optional field before
    // refusing new observations. Existing cursor revisions still name the
    // same rows and membership, as when a page omits the proof to fit the wire.
    retainedBytes -= serializedBytes({ viewerRowOwners }) - 1;
    viewerRowOwners = undefined;
  }
  return { ...generation, directoryGitProof, viewerRowOwners, pullRequests: observations, retainedBytes };
}

type NavigationQueryCursor = {
  generation: string;
  offset: number;
  queryKey: string;
  scopeKey: string;
};

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function attentionRemovalBytes(key: string): number {
  return serializedBytes(key) + 24;
}

function encodeCursor(cursor: NavigationQueryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): NavigationQueryCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<NavigationQueryCursor>;
    if (
      typeof parsed.generation !== "string"
      || typeof parsed.offset !== "number"
      || !Number.isSafeInteger(parsed.offset)
      || parsed.offset < 0
      || typeof parsed.queryKey !== "string"
      || typeof parsed.scopeKey !== "string"
    ) {
      throw new Error("invalid cursor fields");
    }
    return parsed as NavigationQueryCursor;
  } catch {
    throw new NavigationQueryError(
      "navigation_invalid_request",
      "Navigation cursor is malformed.",
    );
  }
}

function validateRequest(request: NavigationQueryRequest): void {
  if (!request || request.protocol !== NAVIGATION_QUERY_PROTOCOL_VERSION) {
    throw new NavigationQueryError(
      "navigation_invalid_request",
      `Navigation query protocol ${NAVIGATION_QUERY_PROTOCOL_VERSION} is required.`,
    );
  }
  if (request.inventory !== undefined && request.inventory !== "owner" && request.inventory !== "viewer") {
    throw new NavigationQueryError("navigation_invalid_request", "Navigation inventory must be owner or viewer.");
  }
  if (request.inventory === "viewer" && request.federationTarget?.scope === "remote") {
    throw new NavigationQueryError("navigation_invalid_request", "Viewer navigation inventory is available only on this machine.");
  }
  if (
    request.attentionView !== undefined
    && (typeof request.attentionView.id !== "string"
      || request.attentionView.id.length < 1
      || request.attentionView.id.length > 128
      || typeof request.attentionView.promoteOnTurnEnd !== "boolean")
  ) {
    throw new NavigationQueryError(
      "navigation_invalid_request",
      "Navigation Attention requires a bounded view identity and promotion policy.",
    );
  }
  if (
    request.pageSize !== undefined
    && (!Number.isSafeInteger(request.pageSize)
      || request.pageSize < 1
      || request.pageSize > NAVIGATION_QUERY_MAX_PAGE_ROWS)
  ) {
    throw new NavigationQueryError(
      "navigation_invalid_request",
      "Navigation page size must be between 1 and 100.",
    );
  }
  const range = request.retainedRange;
  if (range && (request.cursor || request.completeBaselineRevision
    || typeof range.revision !== "string" || range.revision.length > 128
    || typeof range.ownerEpoch !== "string" || range.ownerEpoch.length > 128
    || !Number.isSafeInteger(range.start) || range.start < 0
    || !Number.isSafeInteger(range.count) || range.count < 1
    || !Number.isSafeInteger(range.start + range.count))) {
    throw new NavigationQueryError("navigation_invalid_request", "Invalid retained navigation range.");
  }
  if (request.anchor && (request.cursor || request.completeBaselineRevision
    || !["thread", "directory"].includes(request.anchor.kind)
    || (request.anchor.kind === "thread" && (!request.anchor.ref?.backend || !request.anchor.ref.threadId))
    || (request.anchor.kind === "directory" && !request.anchor.key))) {
    throw new NavigationQueryError("navigation_invalid_request", "Navigation rebaseline requires one explicit anchor without a cursor or unchanged baseline.");
  }
  if (request.query.kind === "star-map") {
    if (request.query.projectKey !== undefined
      && (typeof request.query.projectKey !== "string" || !request.query.projectKey || request.query.projectKey.length > 4096)) {
      throw new NavigationQueryError("navigation_invalid_request", "Invalid Star Map project key.");
    }
    const keys = new Set(["attention", "approval", "pr", "unpushed", "pinned", "agent"]);
    if (!request.query.filters || Object.entries(request.query.filters).some(([key, value]) =>
      !keys.has(key) || !["neutral", "include", "exclude"].includes(value))) {
      throw new NavigationQueryError("navigation_invalid_request", "Invalid Star Map filter selection.");
    }
  }
  if (request.query.kind === "messaging-threads" || request.query.kind === "messaging-projects") {
    const query = request.query;
    if ((query.allowedBackends !== undefined && (!Array.isArray(query.allowedBackends) || query.allowedBackends.length > 64
      || query.allowedBackends.some((backend) => typeof backend !== "string" || !backend)))
      || (query.filter !== undefined && (typeof query.filter !== "string" || query.filter.length > 256))) {
      throw new NavigationQueryError("navigation_invalid_request", "Messaging queries accept at most 64 backends and a 256-character filter.");
    }
  }
  if (request.query.kind === "directory-index") {
    const { keys, paths } = request.query;
    if ((keys !== undefined && !Array.isArray(keys)) || (paths !== undefined && !Array.isArray(paths))
      || [...(keys ?? []), ...(paths ?? [])].length > 100
      || [...(keys ?? []), ...(paths ?? [])].some((key) => typeof key !== "string" || !key)) {
      throw new NavigationQueryError("navigation_invalid_request", "Exact directory metadata accepts at most 100 keys or paths.");
    }
  }
  if (request.query.kind === "directory" && request.query.roots !== undefined
    && !["all", "pinned", "unpinned"].includes(request.query.roots)) {
    throw new NavigationQueryError("navigation_invalid_request", "Invalid directory root disclosure.");
  }
  if (request.query.kind === "directory" && request.query.settled !== undefined
    && (!["exclude", "only"].includes(request.query.settled)
      || (request.query.roots !== undefined && request.query.roots !== "all" && request.query.roots !== "unpinned"))) {
    throw new NavigationQueryError("navigation_invalid_request", "Invalid directory Settled split.");
  }
  if (request.query.kind === "lens" && request.query.roots !== undefined
    && !["pinned", "unpinned"].includes(request.query.roots)) {
    throw new NavigationQueryError("navigation_invalid_request", "Invalid lens root split.");
  }
  if (request.query.kind === "lens" && request.query.attention !== undefined
    && (request.query.lens !== "attention"
      || !(NAVIGATION_ATTENTION_SCOPES as readonly string[]).includes(request.query.attention))) {
    throw new NavigationQueryError("navigation_invalid_request", "Invalid Attention scope.");
  }
  if (request.query.kind === "exact" && request.query.identities.length > 100) {
    throw new NavigationQueryError(
      "navigation_invalid_request",
      "An exact navigation query accepts at most 100 identities.",
    );
  }
  // Owner resolution reads this machine's peers. A peer's request is owner
  // inventory and must never make this instance read on its behalf.
  if (request.query.kind === "exact" && request.query.resolveFromOwners
    && (request.inventory !== "viewer" || request.federationTarget?.scope === "remote")) {
    throw new NavigationQueryError(
      "navigation_invalid_request",
      "Owner-resolved navigation is available only to this machine's viewer inventory.",
    );
  }
  if (request.query.kind === "group-members" && (!Array.isArray(request.query.roots)
    || !request.query.roots.length || request.query.roots.length > 100)) {
    throw new NavigationQueryError("navigation_invalid_request", "Group discovery accepts one to 100 root identities.");
  }
  if (request.query.kind === "group-members" && request.query.membershipOnly !== undefined && request.query.membershipOnly !== true) {
    throw new NavigationQueryError("navigation_invalid_request", "The group membership-only flag must be true when supplied.");
  }
  if (
    request.query.kind === "directory"
    && (request.query.disclosedParentThreadKeys?.length ?? 0) > 100
  ) {
    throw new NavigationQueryError(
      "navigation_invalid_request",
      "A directory navigation query accepts at most 100 disclosures.",
    );
  }
}

type EntryDigest = { hash: string; bytes: number };
type EntryTree = EntryDigest[][];
type GenerationAcceleration = {
  sources: NavigationEntrySources;
  tree: EntryTree;
};

function accelerationBytes(generation: NavigationQueryGeneration): number {
  // Two digest nodes per entry, level arrays and the weak source-to-entry lookup.
  return generation.acceleration ? 1024 + 512 * generation.materialization.entries.length : 0;
}

/** Balance by position. Stable entries reuse their leaf digest; only ancestors
 * of changed leaves need hashing. No serialized payload is retained. */
function fingerprintEntries(entries: NavigationQueryMaterialization["entries"], previous?: NavigationQueryGeneration) {
  const prior = previous?.acceleration?.tree;
  let bytes = 2 + Math.max(entries.length - 1, 0);
  let level = entries.map((entry, i): EntryDigest => {
    let leaf = previous?.materialization.entries[i] === entry ? prior?.[0]?.[i] : undefined;
    if (!leaf) {
      const json = JSON.stringify(entry);
      leaf = { hash: createHash("sha256").update(json).digest("base64url"), bytes: Buffer.byteLength(json) };
    }
    bytes += leaf.bytes;
    if (bytes > NAVIGATION_QUERY_MAX_RETAINED_BYTES) throw new NavigationQueryError("navigation_busy", "Navigation query exceeds the process retained-memory budget.");
    return leaf;
  });
  const tree = [level];
  while (level.length > 1) {
    const next: EntryDigest[] = [];
    const old = prior?.[tree.length - 1];
    const oldParents = prior?.[tree.length];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      if (!right) next.push(left);
      else if (oldParents && old?.[i] === left && old[i + 1] === right) next.push(oldParents[i / 2]!);
      else next.push({ hash: createHash("sha256").update(left.hash).update(right.hash).digest("base64url"), bytes: left.bytes + right.bytes });
    }
    tree.push(next);
    level = next;
  }
  return { tree, bytes, hash: level[0]?.hash ?? "" };
}

/** Stream canonical fields, substituting the ordered entry digest on live sidebar reads.
 * Admission always counts the full serialized payload, including those entries. */
export function fingerprintNavigationMaterialization(materialization: NavigationQueryMaterialization, viewerRowOwners?: readonly string[],
  directoryGitProof?: NavigationQueryPage["directoryGitProof"], entryDigest?: { hash: string; bytes: number; length?: number }): {
  revision: string; retainedBytes: number; viewerRowOwners?: readonly string[]; directoryGitProof?: NavigationQueryPage["directoryGitProof"];
} {
  const hash = createHash("sha256");
  let retainedBytes = 0;
  if (entryDigest) hash.update("sidebar-entries-v1\0");
  const append = (value: string, bytes = Buffer.byteLength(value, "utf8")) => {
    retainedBytes += bytes;
    if (retainedBytes > NAVIGATION_QUERY_MAX_RETAINED_BYTES) {
      throw new NavigationQueryError("navigation_busy", "Navigation query exceeds the process retained-memory budget.");
    }
    hash.update(value);
  };
  append("{");
  let first = true;
  for (const [key, value] of Object.entries(materialization)) {
    if (value === undefined) continue;
    if (!first) append(",");
    first = false;
    append(JSON.stringify(key));
    append(":");
    if (key === "entries" && entryDigest) {
      append(JSON.stringify([entryDigest.length ?? materialization.entries.length, entryDigest.hash]), entryDigest.bytes);
    } else if (Array.isArray(value)) {
      append("[");
      for (let index = 0; index < value.length; index += 1) {
        if (index) append(",");
        append(JSON.stringify(value[index]) ?? "null");
      }
      append("]");
    } else append(JSON.stringify(value));
  }
  // Reserve the closing brace. Hash and retain only the optional proofs that fit.
  const admit = <T>(key: string, proof: T | undefined) => {
    if (!proof) return undefined;
    const field = `,"${key}":${JSON.stringify(proof)}`;
    if (retainedBytes + Buffer.byteLength(field) + 1 > NAVIGATION_QUERY_MAX_RETAINED_BYTES) return undefined;
    append(field);
    return proof;
  };
  viewerRowOwners = admit("viewerRowOwners", viewerRowOwners);
  directoryGitProof = admit("directoryGitProof", directoryGitProof);
  append("}");
  return { revision: hash.digest("base64url"), retainedBytes,
    ...(viewerRowOwners ? { viewerRowOwners } : {}), ...(directoryGitProof ? { directoryGitProof } : {}) };
}

// A local caller owns its page. Retained entries can back several generations,
// while the directory proof is deeply frozen at construction.
function pageForReader(page: NavigationQueryPage, generation: NavigationQueryGeneration): NavigationQueryPage {
  if (!generation.incremental) return page;
  const { directoryGitProof, ...mutable } = page;
  const detached = structuredClone(mutable);
  return directoryGitProof ? { ...detached, directoryGitProof } : detached;
}

function pageBase(params: {
  generation: NavigationQueryGeneration;
  ownerEpoch: string;
}): Omit<NavigationQueryPage, "complete" | "entries"> {
  const { generation } = params;
  return {
    protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
    queryKey: generation.materialization.queryKey,
    generation: generation.generation,
    ownerEpoch: params.ownerEpoch,
    countsRevision: generation.completeRevision,
    coverage: generation.materialization.coverage,
    counts: generation.materialization.counts,
    ...(generation.materialization.metadataDependencies && !generation.materialization.metadataDependencies.workingStatePaths
      ? { metadataDependencies: generation.materialization.metadataDependencies } : {}),
    ...(generation.materialization.collectionSize !== undefined ? { collectionSize: generation.materialization.collectionSize } : {}),
    ...(generation.materialization.directoryMatch ? { directoryMatch: generation.materialization.directoryMatch } : {}),
    ...(generation.materialization.selectionDirectory ? { selectionDirectory: generation.materialization.selectionDirectory } : {}),
    ...(generation.materialization.facets ? { facets: generation.materialization.facets } : {}),
  };
}

export class NavigationQueryStore {
  private readonly ownerEpoch = randomUUID();
  private readonly attentionLifetimes = new Map<string, { closedAt?: number }>();
  private readonly generations = new Map<string, NavigationQueryGeneration>();
  private readonly currentGenerationByScopeAndQuery = new Map<string, string>();
  private readonly attentionViews = new Map<string, AttentionView>();
  // A complete page has no cursor authority. Keep only its bounded projection
  // so a small active scope can still apply the next status batch.
  private readonly completeAttention = new Map<string, CompleteAttentionProjection>();

  constructor(
    private readonly options: {
      now?: () => number;
      onCursorHit?: () => void;
      onOvertakenRead?: () => void;
      onAttentionWork?: (stage: "rank" | "membership" | "remote-membership", rows: number) => void;
    } = {},
  ) {}

  async readPage(params: {
    loadIndex: () => Promise<NavigationQueryIndex>;
    pullRequests?: NavigationPullRequestProjection;
    /** Reuse projected entries and their ordered content digest across sidebar generations. */
    incremental?: boolean;
    request: NavigationQueryRequest;
    scopeKey: string;
  }): Promise<NavigationQueryPage> {
    validateRequest(params.request);
    const now = this.options.now?.() ?? Date.now();
    this.expireIdle(now);
    const attentionKey = params.request.attentionView ? JSON.stringify([params.scopeKey, params.request.attentionView.id]) : undefined;
    let lifetime = attentionKey ? this.attentionLifetimes.get(attentionKey) : undefined;
    if (attentionKey && !lifetime) {
      const bytes = [...this.attentionLifetimes.keys(), attentionKey].reduce((total, key) => total + serializedBytes(key) + 32, 0);
      if (this.attentionLifetimes.size >= 256 || bytes > 256 * 1024) throw new NavigationQueryError("navigation_busy", "Attention lifetime admission is occupied.");
      lifetime = {};
      this.attentionLifetimes.set(attentionKey, lifetime);
    }
    if (lifetime?.closedAt !== undefined) throw new NavigationQueryError("navigation_invalid_request", "This Attention view has closed. Open a new view lifetime.");
    const queryKey = navigationQueryKey(params.request);
    const pageSize = params.request.pageSize ?? NAVIGATION_QUERY_MAX_PAGE_ROWS;
    let generation: NavigationQueryGeneration;
    let newCurrentKey: string | undefined;
    let attentionCacheKey: string | undefined;
    let offset = 0;
    let projectedPullRequests: PullRequestObservation[] = [];
    let firstPage: NavigationQueryPage | undefined;

    if (params.request.cursor) {
      const cursor = decodeCursor(params.request.cursor);
      if (cursor.scopeKey !== params.scopeKey || cursor.queryKey !== queryKey) {
        throw new NavigationQueryError(
          "navigation_invalid_request",
          "Navigation cursor does not belong to this requester and query.",
        );
      }
      const retained = this.generations.get(cursor.generation);
      if (!retained) {
        throw new NavigationQueryError(
          "navigation_cursor_expired",
          "Navigation cursor expired; rebaseline around the visible anchor.",
        );
      }
      // Cursor JSON is caller-controlled. Verify the retained authority too,
      // rather than trusting a rewritten scope/query in the encoded cursor.
      if (retained.scopeKey !== params.scopeKey
        || retained.materialization.queryKey !== queryKey) {
        throw new NavigationQueryError(
          "navigation_invalid_request",
          "Navigation generation does not belong to this requester and query.",
        );
      }
      this.options.onCursorHit?.();
      generation = retained;
      offset = cursor.offset;
    } else {
      // An index that does not say when its listing began is taken to have
      // begun with this read.
      const readStartedAt = currentNavigationObservation();
      let index = await params.loadIndex();
      const pullRequests = params.pullRequests;
      // Star Map filters and facets depend on PR state before selecting rows.
      // Give that resource a verified inventory for its own read.
      const needsPullRequestMembership = params.request.query.kind === "star-map";
      if (needsPullRequestMembership && pullRequests) {
        const attached = index.threads.filter((thread) => !thread.federation && thread.prs?.length);
        if (attached.length) {
          const verified = await pullRequests.verify(attached.map((thread) => thread.prs!));
          const byThread = new Map(attached.map((thread, i) => [thread, verified[i]!]));
          index = { ...index, threads: index.threads.map((thread) => byThread.has(thread)
            ? { ...thread, prs: byThread.get(thread) } : thread) };
        }
      }
      if (lifetime?.closedAt !== undefined) throw new NavigationQueryError("navigation_invalid_request", "This Attention view closed during its owner read.");
      const attentionView = this.reconcileAttentionView(params.scopeKey, params.request, index, index.observedAt ?? readStartedAt);
      const attentionOrder = attentionView?.order;
      const currentKey = `${params.scopeKey}\u0000${queryKey}`;
      attentionCacheKey = currentKey;
      const currentId = this.currentGenerationByScopeAndQuery.get(currentKey);
      const retained = currentId ? this.generations.get(currentId) : undefined;
      const incremental = params.incremental === true;
      const current = Boolean(retained?.incremental) === incremental ? retained : undefined;
      const deferPullRequests = Boolean(pullRequests) && !needsPullRequestMembership;
      // Attention order advances separately. A Star Map with live PR
      // membership has already replaced its certified index above.
      const snapshotToken = attentionOrder ? undefined : navigationQuerySnapshotToken(index);
      const attentionRevision = attentionView?.revision ?? snapshotToken;
      const projectionRequest = (snapshotToken || incremental) ? createHash("sha256").update(JSON.stringify([
        params.request.query, params.request.backend, params.request.inventory, params.request.consumer, deferPullRequests,
      ])).digest("base64url") : undefined;
      if (snapshotToken && current?.snapshotToken === snapshotToken && current.projectionRequest === projectionRequest
        && !hasDeferredPullRequests(current)) {
        generation = current;
      } else {
        const sources: NavigationEntrySources | undefined = incremental ? { entries: new WeakMap() } : undefined;
        const previous = current?.projectionRequest === projectionRequest ? current : undefined;
        const delta = navigationAttentionDelta(index);
        const from = attentionView ? attentionView.previousRevision : delta?.from;
        const complete = this.completeAttention.get(currentKey);
        const priorAttention = complete && complete.projectionRequest === projectionRequest
          && (complete.attentionRevision === attentionRevision || complete.attentionRevision === from) ? complete : previous;
        const changed = priorAttention?.attentionRows && attentionRevision && priorAttention.attentionRevision === attentionRevision
          ? new Map<string, NavigationAttentionRowEdit>()
          : from && priorAttention?.attentionRevision === from ? delta?.rows : undefined;
        const onWork = this.options.onAttentionWork;
        const attention = incremental ? projectRetainedAttention({ index, request: params.request, order: attentionOrder,
          deferPullRequests, previous: priorAttention?.attentionRows && changed ? { rows: priorAttention.attentionRows, changed } : undefined,
          onMembership: onWork && ((rows) => onWork("membership", rows)),
        }) : undefined;
        const { directoryGitProof: gitProof, ...materialization } = attention
          ? { ...attention.materialization, directoryGitProof: attention.directoryGitProof }
          : projectNavigationQuery({
            index, request: params.request, attentionOrder, includeDirectoryGitProof: true, deferPullRequests,
            entrySources: sources, previousSources: previous?.acceleration?.sources,
          });
        const owners = params.request.inventory === "viewer" && params.request.consumer === "main-sidebar"
          ? navigationQuerySnapshotRowOwners(index) : undefined;
        const digest = sources && materialization.entries.length ? fingerprintEntries(materialization.entries, previous) : undefined;
        const acceleration = sources?.geometry && digest ? { sources, tree: digest.tree } : undefined;
        const { revision, retainedBytes, viewerRowOwners, directoryGitProof } = fingerprintNavigationMaterialization(
          materialization, owners, gitProof, attention?.rows.digest ?? digest);
        if (current?.completeRevision === revision && !materialization.pullRequestPositions && !attention?.rows.hasDeferred) {
          generation = current;
          if (generation.projectionRequest !== projectionRequest) generation.acceleration = undefined;
          generation.snapshotToken = snapshotToken;
          generation.projectionRequest = projectionRequest;
          const priorAttentionBytes = generation.attentionRows?.backingBytes;
          const nextAttentionBytes = attention?.rows.backingBytes;
          generation.attentionRows = attention?.rows;
          generation.attentionRevision = attentionRevision;
          // Proof inputs can change privately while the wire revision stays
          // equal. Admit the new backing under the same cursor generation.
          if (priorAttentionBytes !== undefined && nextAttentionBytes !== undefined && priorAttentionBytes !== nextAttentionBytes) {
            generation.retainedBytes += nextAttentionBytes - priorAttentionBytes;
            this.retainGeneration(generation);
          }
        } else {
          generation = {
            incremental, acceleration,
            completeRevision: revision,
            createdAt: now,
            generation: randomUUID(),
            lastAccessedAt: now,
            materialization,
            viewerRowOwners,
            directoryGitProof,
            retainedBytes,
            scopeKey: params.scopeKey,
            attentionViewId: params.request.attentionView?.id,
            snapshotToken,
            projectionRequest,
            attentionRows: attention?.rows,
            attentionRevision,
          };
          if (retainedBytes > NAVIGATION_QUERY_MAX_RETAINED_BYTES) {
            throw new NavigationQueryError("navigation_busy", "Navigation query exceeds the process retained-memory budget.");
          }
          newCurrentKey = currentKey;
        }
      }
      if (params.request.anchor) offset = this.anchorOffset(generation, params.request, index);
      if (hasDeferredPullRequests(generation)) {
        generation.sourceRevision = generation.completeRevision;
        const revision = generation.sourceRevision;
        const prepared = await this.preparePullRequestGeneration({
          generation, current, request: params.request, pageOffset: offset, load: pullRequests!.read,
        });
        if (lifetime?.closedAt !== undefined) throw new NavigationQueryError("navigation_invalid_request", "This Attention view closed during its owner read.");
        projectedPullRequests = prepared.projected;
        if (prepared.reused) {
          generation = prepared.reused;
          newCurrentKey = undefined;
        } else {
          generation.completeRevision = createHash("sha256").update(revision).update(generation.generation).digest("base64url");
          firstPage = this.buildPage({ generation, offset, ownerEpoch: this.ownerEpoch, pageSize,
            projectedPullRequests: new Map(projectedPullRequests) });
          // Only a full result that fits on the wire can share a revision
          // across reads without a retained generation.
          if (offset === 0 && firstPage.complete) {
            generation.completeRevision = createHash("sha256").update(revision)
              .update(JSON.stringify(projectedPullRequests)).digest("base64url");
            firstPage.countsRevision = generation.completeRevision;
          }
        }
      }
      if (
        params.request.completeBaselineRevision
        && params.request.completeBaselineRevision === generation.completeRevision
      ) {
        const unchanged: NavigationQueryPage = {
          ...pageBase({ generation, ownerEpoch: this.ownerEpoch }),
          entries: [],
          directories: [],
          complete: true,
          unchanged: true,
        };
        this.finishPage(unchanged, generation);
        generation.lastAccessedAt = now;
        if (attentionCacheKey && this.completeAttention.has(attentionCacheKey)) {
          this.rememberCompleteAttention(attentionCacheKey, generation);
        }
        return pageForReader(unchanged, generation);
      }
    }

    const range = params.request.retainedRange;
    if (range && range.revision === generation.completeRevision && range.ownerEpoch === this.ownerEpoch) {
      const size = generation.materialization.modelGroups?.length
        ?? generation.attentionRows?.length
        ?? (generation.materialization.directories.length || generation.materialization.entries.length);
      if (range.start + range.count > size) {
        throw new NavigationQueryError("navigation_invalid_request", "Retained range exceeds its matching generation.");
      }
      const page = this.buildPage({ generation, offset: range.start + range.count,
        ownerEpoch: this.ownerEpoch, pageSize: 0 });
      page.rangeStart = range.start;
      page.rangeUnchanged = { start: range.start, count: range.count };
      this.finishPage(page, generation);
      generation.lastAccessedAt = now;
      if (newCurrentKey && page.nextCursor) {
        this.retainGeneration(generation);
        this.currentGenerationByScopeAndQuery.set(newCurrentKey, generation.generation);
      }
      if (attentionCacheKey && this.completeAttention.has(attentionCacheKey)) {
        this.rememberCompleteAttention(attentionCacheKey, generation);
      }
      return pageForReader(page, generation);
    }

    if (params.request.cursor && hasDeferredPullRequests(generation)) {
      if (!params.pullRequests) throw new NavigationQueryError("navigation_invalid_request", "Navigation cursor needs its owner's attachment projection.");
      const positions = pullRequestPositions(generation, offset, pageSize).filter((position) => !generation.pullRequests?.has(position));
      projectedPullRequests = await readPullRequestPositions(generation, positions, params.pullRequests.read);
      const retained = this.generations.get(generation.generation);
      if (!retained) {
        throw new NavigationQueryError("navigation_cursor_expired", "Navigation cursor expired during attachment projection; rebaseline around the visible anchor.");
      }
      generation = retained;
    }
    const page = firstPage ?? this.buildPage({
      generation,
      offset,
      ownerEpoch: this.ownerEpoch,
      pageSize,
      projectedPullRequests: projectedPullRequests.length ? new Map(projectedPullRequests) : undefined,
    });
    // Failed pages and candidates that fell outside the wire byte budget
    // must never publish PR observations into an existing generation.
    if ((newCurrentKey && page.nextCursor) || (params.request.cursor && projectedPullRequests.length)) {
      const observed = projectedPullRequests.filter(([position]) => position < offset + page.entries.length);
      this.retainGeneration({ ...withPullRequestPositions(generation, observed), lastAccessedAt: now });
    } else {
      generation.lastAccessedAt = now;
    }
    // Only an issued cursor needs retained authority. Complete exact reads and
    // one-page lists must not consume the active pagination generation budget.
    if (newCurrentKey && page.nextCursor) {
      this.currentGenerationByScopeAndQuery.set(newCurrentKey, generation.generation);
    }
    if (attentionCacheKey && generation.attentionRows) {
      if (!offset && page.complete) this.rememberCompleteAttention(attentionCacheKey, generation);
      else if (!offset) this.completeAttention.delete(attentionCacheKey);
    }
    return pageForReader(page, generation);
  }

  private rememberCompleteAttention(key: string, generation: NavigationQueryGeneration): void {
    this.completeAttention.delete(key);
    if (!generation.attentionRows || generation.attentionRows.length > NAVIGATION_QUERY_MAX_PAGE_ROWS
      || generation.retainedBytes > COMPLETE_ATTENTION_CACHE_BYTES) return;
    const { scopeKey, attentionViewId, lastAccessedAt, attentionRows, attentionRevision, projectionRequest, retainedBytes } = generation;
    this.completeAttention.set(key, { scopeKey, attentionViewId, lastAccessedAt, attentionRows, attentionRevision, projectionRequest, retainedBytes });
    let bytes = 0;
    for (const entry of this.completeAttention.values()) bytes += entry.retainedBytes;
    for (const [key, entry] of this.completeAttention) {
      if (bytes <= COMPLETE_ATTENTION_CACHE_BYTES && this.completeAttention.size <= NAVIGATION_QUERY_MAX_GENERATIONS) break;
      bytes -= entry.retainedBytes;
      this.completeAttention.delete(key);
    }
  }

  private anchorOffset(generation: NavigationQueryGeneration, request: NavigationQueryRequest, index?: NavigationQueryIndex): number {
    const anchor = request.anchor!;
    const offset = anchor.kind === "directory"
      ? generation.materialization.directories.findIndex((directory) => directory.key === anchor.key)
      : generation.attentionRows ? generation.attentionRows.position(anchor.ref)
      : generation.materialization.entries.findIndex(({ row }) => row.ref.backend === anchor.ref.backend
        && row.ref.threadId === anchor.ref.threadId && row.ref.ownerInstanceId === anchor.ref.ownerInstanceId);
    if (offset >= 0) return offset;
    const reason = index ? explainMissingNavigationAnchor({ index, request }) : "filtered";
    throw new NavigationQueryError("navigation_anchor_missing", `The visible navigation anchor is no longer in this query (reason: ${reason}). Choose another item or restart this list explicitly.`);
  }

  private async preparePullRequestGeneration(params: {
    generation: NavigationQueryGeneration;
    current?: NavigationQueryGeneration;
    request: NavigationQueryRequest;
    pageOffset: number;
    load: NavigationPullRequestProjection["read"];
  }): Promise<{ reused?: NavigationQueryGeneration; projected: PullRequestObservation[] }> {
    const { current, generation, request, pageOffset, load } = params;
    const pagePositions = pullRequestPositions(generation, pageOffset, request.pageSize ?? NAVIGATION_QUERY_MAX_PAGE_ROWS);
    if (current?.sourceRevision === generation.sourceRevision && current?.pullRequests) {
      const range = request.retainedRange;
      const proof = range?.ownerEpoch === this.ownerEpoch && range.revision === current.completeRevision
        ? pullRequestPositions(generation, range.start, range.count)
        : request.completeBaselineRevision === current.completeRevision
          ? generation.attentionRows ? generation.attentionRows.allDeferredPositions(NAVIGATION_QUERY_MAX_PAGE_ROWS)
            : generation.materialization.pullRequestPositions : undefined;
      // A revision can acknowledge prior observations only. Never turn an
      // arbitrary retained range into permission to validate the inventory.
      if (proof && proof.length === current.pullRequests.size && proof.length <= NAVIGATION_QUERY_MAX_PAGE_ROWS
        && proof.every((position) => current.pullRequests!.has(position))) {
        const fresh = await readPullRequestPositions(generation, proof, load);
        if (this.generations.get(current.generation) === current
          && fresh.every(([position, prs]) => JSON.stringify(prs) === JSON.stringify(current.pullRequests!.get(position)))) {
          return { reused: current, projected: [] };
        }
      }
    }
    return { projected: await readPullRequestPositions(generation, pagePositions, load) };
  }

  /** Window teardown releases order lifetime; page expiry deliberately does not. */
  releaseAttentionView(scopeKey: string, viewId: string): void {
    const lifetime = this.attentionLifetimes.get(JSON.stringify([scopeKey, viewId]));
    if (lifetime) lifetime.closedAt = this.options.now?.() ?? Date.now();
    for (const [key, generation] of this.generations) {
      if (generation.scopeKey === scopeKey && generation.attentionViewId === viewId) this.generations.delete(key);
    }
    for (const [key, generationId] of this.currentGenerationByScopeAndQuery) {
      if (!this.generations.has(generationId)) this.currentGenerationByScopeAndQuery.delete(key);
    }
    this.attentionViews.delete(JSON.stringify([scopeKey, viewId]));
    for (const [key, projection] of this.completeAttention) {
      if (projection.scopeKey === scopeKey && projection.attentionViewId === viewId) this.completeAttention.delete(key);
    }
  }

  /**
   * Reads for one view overlap, and a read can be served an index whose
   * listing began before a boundary the store already applied. The index is
   * served and reconciled, never reread: the reducer leaves alone whatever
   * the order observed after that listing began (see the observation clock).
   */
  private reconcileAttentionView(
    scopeKey: string,
    request: NavigationQueryRequest,
    index: NavigationQueryIndex,
    observedAt: number,
  ): AttentionView | undefined {
    if (!request.attentionView) return undefined;
    const { id, promoteOnTurnEnd } = request.attentionView;
    const key = JSON.stringify([scopeKey, id]);
    const previous = this.attentionViews.get(key);
    if (previous?.failed) throw new NavigationQueryError("navigation_busy", "Attention metadata exceeded its budget. Close this view and open a new one.");
    const indexToken = navigationQuerySnapshotToken(index);
    const sameView = previous && previous.promoteOnTurnEnd === promoteOnTurnEnd && previous.backend === request.backend;
    if (indexToken && sameView && previous.indexToken === indexToken && previous.observedAt === observedAt && !previous.pending.size) {
      if (previous.overtaken) this.options.onOvertakenRead?.();
      return previous;
    }
    if (!previous && this.attentionViews.size >= NAVIGATION_ATTENTION_MAX_VIEWS) {
      throw new NavigationQueryError("navigation_busy", "Attention view budget is occupied.");
    }
    const complete = !index.coverage || index.coverage.state === "complete";
    const delta = navigationAttentionDelta(index);
    const budget = NAVIGATION_ATTENTION_MAX_BYTES - this.attentionBytes() + (previous?.bytes ?? 0);
    if (sameView && delta && previous.indexToken === delta.from && previous.observedAt < observedAt
      && !previous.overtaken && previous.latestBoundary <= observedAt
      && [...previous.pending].every((id) => delta.rows.has(id))) {
      this.options.onAttentionWork?.("rank", delta.rows.size);
      const patch = reconcileNavigationAttentionDelta({ order: previous.order, rows: delta.rows, promoteOnTurnEnd, observedAt });
      let memberBytes = previous.memberBytes;
      let removedBytes = 0;
      const removed = new Map<string, number>();
      for (const [id, member] of patch.members) {
        const old = previous.order.members.get(id);
        memberBytes += navigationAttentionMemberBytes(id, member) - navigationAttentionMemberBytes(id, old);
        if (old && !member) {
          removed.set(id, observedAt);
          removedBytes += attentionRemovalBytes(id);
        }
      }
      const bytes = previous.bytes + memberBytes - previous.memberBytes + removedBytes - previous.removedBytes;
      if (bytes > budget) throw new NavigationQueryError("navigation_busy", "Attention metadata exceeds its retained budget.");
      for (const [id, member] of patch.members) {
        if (member) previous.order.members.set(id, member);
        else previous.order.members.delete(id);
        if (member && !member.awaitingBaseline) previous.listed.add(id);
        else previous.listed.delete(id);
      }
      previous.order.removed = removed;
      previous.order.nextRank = patch.nextRank;
      if (complete) previous.order.listedAt = observedAt;
      // Each agreeing, unchanged member logically shares the listing stamp.
      // Materialize those stamps only before a full (possibly stale) listing.
      previous.previousRevision = previous.revision;
      previous.revision = Symbol("attention-view");
      previous.indexToken = indexToken;
      previous.observedAt = observedAt;
      previous.memberBytes = memberBytes;
      previous.removedBytes = removedBytes;
      previous.bytes = bytes;
      previous.pending.clear();
      return previous;
    }

    if (previous) {
      for (const id of previous.listed) previous.order.members.get(id)!.observedAt = previous.observedAt;
    }
    const listed = new Set<string>();
    this.options.onAttentionWork?.("rank", index.threads.length);
    const order = reconcileNavigationAttentionOrder({
      previous: previous?.order, threads: index.threads, complete, promoteOnTurnEnd, observedAt,
      onListed: (id) => listed.add(id),
    });
    const overtaken = previous && navigationAttentionOrderFollows(previous.order, observedAt);
    if (overtaken) this.options.onOvertakenRead?.();
    const remoteMembers = complete ? new Set<string>() : new Set(previous?.remoteMembers);
    this.options.onAttentionWork?.("remote-membership", index.threads.length);
    for (const thread of index.threads) {
      if (thread.federation?.ref.target.scope === "remote") remoteMembers.add(navigationAttentionIdentity(thread));
    }
    let memberBytes = 0;
    for (const [id, member] of order.members) memberBytes += navigationAttentionMemberBytes(id, member);
    let removedBytes = 0;
    for (const id of order.removed?.keys() ?? []) removedBytes += attentionRemovalBytes(id);
    const bytes = 128 + memberBytes + removedBytes + serializedBytes([...remoteMembers]);
    if (bytes > budget) throw new NavigationQueryError("navigation_busy", "Attention metadata exceeds its retained budget.");
    const view: AttentionView = { order, bytes, memberBytes, removedBytes, promoteOnTurnEnd, backend: request.backend,
      remoteMembers, indexToken, observedAt, overtaken, listed, pending: new Set(), latestBoundary: 0, revision: Symbol("attention-view") };
    this.attentionViews.set(key, view);
    return view;
  }

  private attentionBytes(): number {
    let bytes = 0;
    for (const view of this.attentionViews.values()) bytes += view.bytes;
    return bytes;
  }

  /** Boundary events maintain session ranks even while the viewer browses another lens. */
  observeAttentionEvent(event: AgentEvent): void {
    const method = event.notification.method;
    const status = "status" in event.notification.params ? event.notification.params.status as { type?: unknown } | undefined : undefined;
    const active = method === "turn/started" ? true
      : ["turn/completed", "turn/failed", "turn/cancelled"].includes(method) ? false
      : method === "thread/status/changed" ? status?.type === "active" ? true : status?.type === "idle" ? false : undefined : undefined;
    const remove = method === "thread/archived";
    const seen = method === "navigation/thread/seen";
    if (active === undefined && !remove && !seen) return;
    const params = event.notification.params as { threadId?: string; turnId?: string; turn?: { id?: string } };
    if (typeof params.threadId !== "string") return;
    const owner = event.federationTarget?.scope === "remote" ? event.federationTarget.instanceId : null;
    const key = JSON.stringify([owner, event.backend, params.threadId]);
    if (owner && ![...this.attentionViews.values()].some((view) => view.remoteMembers.has(key))) return;
    const observedAt = nextNavigationObservation();
    let retainedBytes = this.attentionBytes();
    for (const view of this.attentionViews.values()) {
      if (view.failed || (view.backend && view.backend !== "all" && view.backend !== event.backend)
        || (owner && !view.remoteMembers.has(key))) continue;
      const old = view.order.members.get(key);
      const removed = remove || (seen && !old?.active);
      const member = !removed && active !== undefined ? navigationAttentionTurnMember({ previous: view.order, key, active,
        turnId: params.turnId ?? params.turn?.id, promoteOnTurnEnd: view.promoteOnTurnEnd, observedAt }) : undefined;
      if (!removed && !member) continue;
      const memberBytes = view.memberBytes + navigationAttentionMemberBytes(key, member) - navigationAttentionMemberBytes(key, old);
      const removedBytes = view.removedBytes + (Number(removed) - Number(Boolean(view.order.removed?.has(key)))) * attentionRemovalBytes(key);
      const bytes = view.bytes + memberBytes - view.memberBytes + removedBytes - view.removedBytes;
      if (retainedBytes - view.bytes + bytes > NAVIGATION_ATTENTION_MAX_BYTES) {
        view.failed = true;
        continue;
      }
      if (member) {
        view.order.members.set(key, member);
        view.order.nextRank = Math.max(view.order.nextRank, member.rank + 1);
      } else view.order.members.delete(key);
      if (removed) (view.order.removed ??= new Map()).set(key, observedAt);
      else view.order.removed?.delete(key);
      retainedBytes += bytes - view.bytes;
      view.bytes = bytes;
      view.memberBytes = memberBytes;
      view.removedBytes = removedBytes;
      view.listed.delete(key);
      view.pending.add(key);
      view.latestBoundary = observedAt;
    }
  }

  private buildPage(params: {
    generation: NavigationQueryGeneration;
    offset: number;
    ownerEpoch: string;
    pageSize: number;
    projectedPullRequests?: ReadonlyMap<number, PullRequestObservation[1]>;
  }): NavigationQueryPage {
    const materialization = params.generation.materialization;
    const collectionKind = materialization.modelGroups ? "models"
      : materialization.collectionKind === "directories" || materialization.directories.length > 0 ? "directories" : "entries";
    const collection = materialization.modelGroups ?? (collectionKind === "directories" ? materialization.directories : materialization.entries);
    const length = params.generation.attentionRows?.length ?? collection.length;
    if (params.offset > length) {
      throw new NavigationQueryError(
        "navigation_invalid_request",
        "Navigation cursor offset is outside its generation.",
      );
    }
    const page: NavigationQueryPage = {
      ...pageBase({
        generation: params.generation,
        ownerEpoch: params.ownerEpoch,
      }),
      entries: [],
      ...(params.offset ? { rangeStart: params.offset } : {}),
      ...(collectionKind === "models" ? { modelGroups: [] } : collectionKind === "directories" ? { directories: [] } : {}),
      complete: false,
    };
    let bytes = serializedBytes(page);
    let nextOffset = params.offset;
    for (
      ; nextOffset < length
        && nextOffset - params.offset < params.pageSize;
      nextOffset += 1
    ) {
      const entry = collectionKind === "entries" ? entryAt(params.generation, nextOffset) : undefined;
      const prs = params.generation.pullRequests?.get(nextOffset) ?? params.projectedPullRequests?.get(nextOffset);
      const item = entry && prs ? { ...entry, row: { ...entry.row, ...prs } } : entry ?? collection[nextOffset]!;
      // The empty collection's brackets have already been charged. Each
      // candidate adds one row and, after the first, one separating comma.
      const candidateBytes = bytes + serializedBytes(item) + Number(nextOffset > params.offset);
      const candidateNextOffset = nextOffset + 1;
      const cursorBytes = candidateNextOffset < length
        ? serializedBytes({ nextCursor: encodeCursor({
          generation: params.generation.generation,
          offset: candidateNextOffset,
          queryKey: params.generation.materialization.queryKey,
          scopeKey: params.generation.scopeKey,
        }) }) - 1
        : 0;
      if (candidateBytes + cursorBytes > NAVIGATION_QUERY_MAX_RESULT_BYTES) {
        if (nextOffset === params.offset) {
          throw new NavigationQueryError(
            "navigation_item_too_large",
            "One navigation row exceeds the result budget; read its exact detail.",
          );
        }
        break;
      }
      bytes = candidateBytes;
      if (collectionKind === "models") {
        page.modelGroups!.push(item as NonNullable<NavigationQueryPage["modelGroups"]>[number]);
      } else if (collectionKind === "directories") {
        page.directories!.push(item as NonNullable<NavigationQueryPage["directories"]>[number]);
      } else {
        page.entries.push(item as NavigationQueryPage["entries"][number]);
      }
    }
    page.complete = nextOffset >= length;
    if (!page.complete) {
      page.nextCursor = encodeCursor({
        generation: params.generation.generation,
        offset: nextOffset,
        queryKey: params.generation.materialization.queryKey,
        scopeKey: params.generation.scopeKey,
      });
    }
    this.finishPage(page, params.generation);
    return page;
  }

  private finishPage(page: NavigationQueryPage, generation: NavigationQueryGeneration): void {
    // A range acknowledgment can pass here again after its cursor was built.
    // Price the required rows once, then spend only spare bytes on proofs.
    delete page.viewerRowOwners;
    delete page.directoryGitProof;
    const metadata = generation.materialization.metadataDependencies;
    if (metadata?.workingStatePaths) delete page.metadataDependencies;
    let bytes = serializedBytes(page);
    if (bytes > NAVIGATION_QUERY_MAX_RESULT_BYTES) {
      throw new NavigationQueryError("navigation_item_too_large", "Navigation response exceeds the result budget.");
    }
    const fits = (field: object) => {
      const size = serializedBytes(field) - 1;
      if (bytes + size > NAVIGATION_QUERY_MAX_RESULT_BYTES) return false;
      bytes += size;
      return true;
    };
    const { viewerRowOwners, directoryGitProof } = generation;
    if (viewerRowOwners && fits({ viewerRowOwners })) page.viewerRowOwners = viewerRowOwners;
    if (metadata?.workingStatePaths && fits({ metadataDependencies: metadata })) page.metadataDependencies = metadata;
    // An acknowledgment already names the exact revision of the prior rows
    // and proofs. Keep potentially multi-directory metadata off idle replies.
    if (!page.unchanged && !page.rangeUnchanged && directoryGitProof && fits({ directoryGitProof })) {
      page.directoryGitProof = directoryGitProof;
    }
  }

  private retainGeneration(
    generation: NavigationQueryGeneration,
  ): NavigationQueryGeneration {
    // Continuations can fill in previously unread PR rows. Re-admit their
    // enlarged backing without charging the same generation twice.
    if (generation.retainedBytes > NAVIGATION_QUERY_MAX_RETAINED_BYTES) {
      throw new NavigationQueryError(
        "navigation_busy",
        "Navigation query exceeds the process retained-memory budget.",
      );
    }
    this.generations.delete(generation.generation);
    let retainedBytes = [...this.generations.values()]
      .reduce((total, item) => total + item.retainedBytes, 0);
    // A cursor is a bounded cache lease, not an admission reservation. Normal
    // refreshes and additional disclosed folders must be able to make progress.
    // Prefer superseded generations, then the least recently used cursor.
    const currentIds = new Set(this.currentGenerationByScopeAndQuery.values());
    const evictable = [...this.generations.values()].sort((left, right) =>
      Number(currentIds.has(left.generation)) - Number(currentIds.has(right.generation))
      || left.lastAccessedAt - right.lastAccessedAt);
    // Reuse metadata is optional. Drop it before it can displace any cursor or
    // proof, including when a continuation increases its attachment backing.
    let workingBytes = retainedBytes + generation.retainedBytes + accelerationBytes(generation);
    for (const candidate of evictable) workingBytes += accelerationBytes(candidate);
    for (const candidate of [...evictable, generation]) {
      if (workingBytes <= NAVIGATION_QUERY_MAX_RETAINED_BYTES) break;
      workingBytes -= accelerationBytes(candidate);
      candidate.acceleration = undefined;
    }
    // Proofs already sent belong to the immutable revision. A continuation
    // can omit their backing without expiring either owner's cursor.
    if (retainedBytes + generation.retainedBytes > NAVIGATION_QUERY_MAX_RETAINED_BYTES) {
      for (const candidate of [...evictable, generation]) {
        if (!candidate.directoryGitProof) continue;
        const freed = serializedBytes({ directoryGitProof: candidate.directoryGitProof }) - 1;
        candidate.directoryGitProof = undefined;
        candidate.retainedBytes -= freed;
        if (candidate !== generation) retainedBytes -= freed;
        if (retainedBytes + generation.retainedBytes <= NAVIGATION_QUERY_MAX_RETAINED_BYTES) break;
      }
    }
    while (
      this.generations.size >= NAVIGATION_QUERY_MAX_GENERATIONS
      || retainedBytes + generation.retainedBytes > NAVIGATION_QUERY_MAX_RETAINED_BYTES
    ) {
      const oldest = evictable.shift();
      if (!oldest) break;
      this.generations.delete(oldest.generation);
      retainedBytes -= oldest.retainedBytes;
      for (const [key, id] of this.currentGenerationByScopeAndQuery) {
        if (id === oldest.generation) this.currentGenerationByScopeAndQuery.delete(key);
      }
    }
    this.generations.set(generation.generation, generation);
    return generation;
  }

  private expireIdle(now: number): void {
    for (const [key, projection] of this.completeAttention) {
      if (now - projection.lastAccessedAt > NAVIGATION_QUERY_CURSOR_IDLE_MS) this.completeAttention.delete(key);
    }
    for (const [key, lifetime] of this.attentionLifetimes) {
      if (lifetime.closedAt !== undefined && now - lifetime.closedAt > NAVIGATION_QUERY_CURSOR_IDLE_MS) this.attentionLifetimes.delete(key);
    }
    for (const generation of this.generations.values()) {
      if (now - generation.lastAccessedAt <= NAVIGATION_QUERY_CURSOR_IDLE_MS) {
        continue;
      }
      this.generations.delete(generation.generation);
    }
    for (const [key, generationId] of this.currentGenerationByScopeAndQuery) {
      if (!this.generations.has(generationId)) {
        this.currentGenerationByScopeAndQuery.delete(key);
      }
    }
  }
}
