import { sortSubthreadSummaries } from "@pwragent/shared/subthreads";
import { threadProviderIdentity } from "@pwragent/shared/provider-picker";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type {
  AppServerBackendKind,
  LinkedDirectorySummary,
} from "@pwragent/shared/contracts/normalized-app-server";
import type {
  NavigationCounts,
  NavigationStarMapFacetCounts,
  NavigationDirectorySummary,
  NavigationDirectoryRow,
  NavigationDirectoryGitStatus,
  NavigationDirectoryGitProof,
  NavigationDirectoryGitRevisions,
  NavigationIdentity,
  NavigationQuery,
  NavigationQueryCoverage,
  NavigationQueryEntry,
  NavigationQueryPage,
  NavigationModelInventoryRow,
  NavigationQueryRequest,
  NavigationRow,
  NavigationRowHomeProject,
  NavigationThreadSummary,
  NavigationMetadataDependencies,
  PrSummary,
} from "@pwragent/shared/contracts/navigation";
import type { NavigationStarMapSignals } from "@pwragent/shared/navigation-star-map-filters";
import { STACK_UNSETTLED_REASONS } from "@pwragent/shared/stacks/stack-automation";
import { MAX_COMPACT_STACK_MEMBERSHIPS, readCompactStackMemberships, type StackSummary } from "@pwragent/shared/stacks/stack-status";
import {
  buildThreadIdentityKey,
  isNavigationThreadRunning,
  NAVIGATION_QUERY_MAX_PAGE_ROWS,
  buildPullRequestStatusKey,
  navigationThreadInAttentionScope,
} from "@pwragent/shared/contracts/navigation";
import { federatedThreadIdentityKey } from "@pwragent/shared/contracts/federation";
import { comparePinnedThreads } from "@pwragent/shared/thread-pins";
import {
  comparePullRequestStack,
  pullRequestRollupPriority,
  resolveLifecycleState,
} from "@pwragent/shared/pull-request-rollup";
import { canonicalizeNavigationPath, classifyDirectory, directoryIncludesCheckout } from "@pwragent/shared/directory-navigation";
import {
  countNavigationStarMapFacets,
  passesNavigationStarMapFilters,
} from "@pwragent/shared/navigation-star-map-filters";
import { rankDirectoryMentionMatches } from "@pwragent/shared/directory-mention-match";
import { rankThreadJumpMatches } from "@pwragent/shared/thread-jump-match";
import { textMatchesJumpQuery } from "@pwragent/shared/jump-search-text";
import { navigationWorkingStatePath } from "@pwragent/shared/navigation-query-events";
import { DIRECTORY_GIT_PROOF_MAX_KEYS, DIRECTORY_GIT_PROOF_MAX_KEY_LENGTH, readNavigationMetadataDependencies } from "@pwragent/shared/navigation-metadata-dependencies";
import {
  navigationAttentionIdentity,
  type NavigationAttentionOrder,
} from "./navigation-attention-order";

const MAX_ROW_NESTED_RECORDS = 16;

export type NavigationQueryMaterialization = {
  coverage: NavigationQueryCoverage;
  counts: NavigationCounts;
  collectionSize?: number;
  directoryMatch?: NavigationQueryPage["directoryMatch"];
  selectionDirectory?: NavigationDirectoryRow;
  metadataDependencies?: NavigationMetadataDependencies;
  facets?: NavigationStarMapFacetCounts;
  directories: NavigationDirectoryRow[];
  collectionKind?: "directories";
  entries: NavigationQueryEntry[];
  /** Entry positions whose owner attachments are read on demand. */
  pullRequestPositions?: number[];
  modelGroups?: NavigationModelInventoryRow[];
  queryKey: string;
};

/** Complete compact owner inventory used to answer bounded queries. */
export type NavigationQueryIndex = {
  /** Exact stack detail, stored once per owner inventory. */
  stacks?: StackSummary[];
  localInstanceId?: string;
  coverage?: NavigationQueryCoverage;
  directories: NavigationDirectorySummary[];
  /** Verified case spellings of local directories, keyed by the visible project key. */
  directoryCaseAliases?: Record<string, string[]>;
  /** Worktree directory keys folded into each primary project. */
  worktreeProjectAliases?: Record<string, string[]>;
  /** The checkout supplying fallback repository identity for a synthesized parent project. */
  worktreeRepositorySources?: Record<string, { key: string; repositoryRevision?: string }>;
  threads: NavigationThreadSummary[];
  inputRequestThreadKeys?: ReadonlySet<string>;
  /** The observation clock value taken when this index's listing began. */
  observedAt?: number;
};

type ProjectionIndex = {
  threadsByIdentity: Map<string, NavigationThreadSummary>;
  threadsByLegacyKey: Map<string, NavigationThreadSummary>;
  parentCandidates: Map<string, NavigationThreadSummary[]>;
  repositories: ReturnType<typeof repositoryIdentitiesByPath>;
  checkoutProjects: ReadonlyMap<string, NavigationDirectorySummary>;
  workspaceProjects: ReadonlyMap<string, NavigationDirectorySummary>;
  childCountByParent: Map<string, number>;
  viewerChildCountByParent: Map<string, number>;
};

export type NavigationProjectionWork = (stage: "index" | "children", threads: number) => void;

// Only detached, deeply frozen snapshots enter this table. A mutable provider
// array (or a caller reusing its index object after a mutation) never does.
// The existing index pool owns their lifetime; this is not another index pool.
const snapshots = new WeakMap<NavigationQueryIndex, { token: symbol; sharedThreads: readonly NavigationThreadSummary[]; rowOwners?: readonly string[]; projection?: ProjectionIndex; bytes: number; onWork?: NavigationProjectionWork }>();
const SNAPSHOT_SET_READ_METHODS = new Set([
  "has", "keys", "values", "entries", "union", "intersection",
  "difference", "symmetricDifference", "isSubsetOf", "isSupersetOf", "isDisjointFrom",
]);

function freezeSnapshot(value: unknown): boolean {
  if (value && typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    // Freezing a Date, Map or typed array does not freeze its backing data.
    // Compact inventories are JSON records; unfamiliar backing uses the
    // ordinary uncached projection rather than receiving certification.
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
    for (const child of Object.values(value)) if (!freezeSnapshot(child)) return false;
    Object.freeze(value);
  }
  return true;
}

/** A detached immutable inventory, admitted under the index pool's byte budget. */
export function createNavigationQuerySnapshot(index: NavigationQueryIndex, onWork?: NavigationProjectionWork,
  owner?: NavigationQueryIndex): NavigationQueryIndex {
  if (owner === index && snapshots.has(owner)) return owner;
  const prefix = owner && snapshots.get(owner)?.sharedThreads;
  // Viewer pins append to the certified native rows. Only reuse the exact
  // immutable prefix. Unknown or independently replaced rows are detached.
  const shared = prefix && prefix.length <= index.threads.length
    && prefix.every((row, position) => row === index.threads[position]) ? prefix : undefined;
  const { inputRequestThreadKeys, ...json } = index;
  const copy: NavigationQueryIndex = structuredClone(shared ? { ...json, threads: json.threads.slice(shared.length) } : json);
  for (const child of Object.values(copy)) if (!freezeSnapshot(child)) return index;
  if (shared) {
    copy.threads = [...shared, ...copy.threads];
    Object.freeze(copy.threads);
  }
  if (inputRequestThreadKeys) {
    // Object.freeze(Set) still permits add/delete. Expose only read operations
    // on a private copy so the certification also covers approval membership.
    const keys = new Set(inputRequestThreadKeys);
    const readers = new Map<PropertyKey, unknown>();
    copy.inputRequestThreadKeys = Object.freeze(new Proxy(keys, {
      get(target, property, receiver) {
        if (property === "size") return target.size;
        if (property === "add" || property === "delete" || property === "clear") {
          return () => { throw new TypeError("Navigation snapshot membership is immutable."); };
        }
        if (property === "forEach") return (callback: (value: string, key: string, set: ReadonlySet<string>) => void, thisArg?: unknown) => {
          target.forEach((key) => callback.call(thisArg, key, key, copy.inputRequestThreadKeys!));
        };
        // Bind only Set's read methods, never Object.valueOf (which would
        // expose the backing Set) or the constructor. This also supports the
        // newer non-mutating Set operations when provided by the runtime.
        if (property === Symbol.iterator || SNAPSHOT_SET_READ_METHODS.has(String(property))) {
          if (readers.has(property)) return readers.get(property);
          const method = Reflect.get(target, property, target) as unknown;
          const reader: unknown = typeof method === "function" ? method.bind(target) : method;
          readers.set(property, reader);
          return reader;
        }
        return Reflect.get(target, property, receiver);
      },
    }));
  }
  Object.freeze(copy);
  // JSON size is the pool's existing inventory charge. Charge auxiliary maps
  // conservatively as well: references/buckets plus UTF-16 identity/path keys.
  const projection = buildProjectionIndex(copy, onWork);
  let bytes = 1_024 + 512 * copy.threads.length + 256 * copy.directories.length;
  for (const map of Object.values(projection)) for (const key of map.keys()) bytes += 2 * key.length;
  // Off-page rows and foreign parents are dependencies too. Keep the proof
  // optional and bounded even when the viewer has links across a large fleet.
  const owners = new Set<string>();
  for (const thread of copy.threads) {
    const target = thread.federation?.ref.target;
    if (target?.scope === "remote") owners.add(target.instanceId);
    if (thread.parentThreadInstanceId) owners.add(thread.parentThreadInstanceId);
    if (owners.size > 8) break;
  }
  const rowOwners = owners.size <= 8 && [...owners].every((id) => id.length <= 120)
    ? Object.freeze([...owners].sort()) : undefined;
  snapshots.set(copy, { sharedThreads: shared ?? copy.threads, rowOwners, token: Symbol("navigation-index"), projection, bytes, onWork });
  return copy;
}

/** Identity only: Attention views must not extend an inventory's retention. */
export function navigationQuerySnapshotToken(index: NavigationQueryIndex): symbol | undefined {
  return snapshots.get(index)?.token;
}

/** Only a complete, certified serving inventory can exclude off-page owners. */
export function navigationQuerySnapshotRowOwners(index: NavigationQueryIndex): readonly string[] | undefined {
  return index.coverage?.state === "complete" ? snapshots.get(index)?.rowOwners : undefined;
}

/** Immutable prefix charged once across retained owner and viewer snapshots. */
export function navigationQuerySnapshotSharedThreads(index: NavigationQueryIndex): readonly NavigationThreadSummary[] | undefined {
  return snapshots.get(index)?.sharedThreads;
}

export function navigationQuerySnapshotAuxiliaryBytes(index: NavigationQueryIndex): number {
  return snapshots.get(index)?.bytes ?? 0;
}

/** The pool may keep a large inventory without its optional acceleration. */
export function releaseNavigationQuerySnapshotProjection(index: NavigationQueryIndex): void {
  const snapshot = snapshots.get(index);
  if (!snapshot) return;
  snapshot.projection = undefined;
  snapshot.bytes = 0;
}

function hashValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("base64url");
}

function navigationIdentity(thread: NavigationThreadSummary): NavigationIdentity {
  return {
    backend: thread.source,
    threadId: thread.id,
    ...(thread.federation?.ref.target.scope === "remote"
      ? { ownerInstanceId: thread.federation.ref.target.instanceId }
      : {}),
  };
}

function identityKey(identity: NavigationIdentity): string {
  return [
    identity.ownerInstanceId ?? "local",
    identity.backend,
    identity.threadId,
  ].join("\u0000");
}

function threadKey(thread: NavigationThreadSummary): string {
  return identityKey(navigationIdentity(thread));
}

function parentIdentity(
  thread: NavigationThreadSummary,
  candidatesByOwner: ReadonlyMap<string, readonly NavigationThreadSummary[]>,
): NavigationIdentity | undefined {
  if (!thread.parentThreadId) {
    return undefined;
  }
  let ownerInstanceId = thread.parentThreadInstanceId
    ?? (thread.federation?.ref.target.scope === "remote" ? thread.federation.ref.target.instanceId : undefined);
  // Legacy local handoffs copied their launcher's group root but omitted its
  // remote owner. Recover only from recorded provenance and an identical root,
  // never from a same-id peer guess or when a local parent really exists.
  if (!ownerInstanceId && thread.handoffOrigin?.groupingMode === "subthread"
    && !(candidatesByOwner.get(JSON.stringify([null, thread.parentThreadId])) ?? []).some((candidate) =>
      candidate.source === (thread.parentThreadBackend ?? thread.source))) {
    const origin = thread.handoffOrigin;
    const launcher = (candidatesByOwner.get(JSON.stringify([null, origin.sourceThreadId])) ?? [])
      .find((candidate) => candidate.source === origin.sourceBackend);
    if (launcher?.parentThreadId === thread.parentThreadId
      && (launcher.parentThreadBackend ?? launcher.source) === (thread.parentThreadBackend ?? thread.source)) {
      ownerInstanceId = launcher.parentThreadInstanceId;
    }
  }
  const candidates = candidatesByOwner.get(JSON.stringify([ownerInstanceId ?? null, thread.parentThreadId])) ?? [];
  // Older overlays omitted the backend. Resolve only against complete owner
  // membership; an absent or ambiguous parent remains an unresolved child.
  const parent = !thread.parentThreadBackend
    ? candidates.find((candidate) => candidate.source === thread.source) ?? (candidates.length === 1 ? candidates[0] : undefined)
    : undefined;
  const backend = thread.parentThreadBackend ?? parent?.source ?? thread.source;
  const resolvedParent = candidates.find((candidate) => candidate.source === backend);
  if (resolvedParent) ownerInstanceId = navigationIdentity(resolvedParent).ownerInstanceId;
  return {
    backend,
    threadId: thread.parentThreadId,
    ...(ownerInstanceId ? { ownerInstanceId } : {}),
  };
}

function isOrdinaryThread(thread: NavigationThreadSummary): boolean {
  return thread.codexNativeSubAgent === undefined;
}

/**
 * The top-level row a lens renders a thread under: its oldest ancestor in the
 * complete inventory. A parent that is absent leaves the thread its own root,
 * and the walk stops at the same 32 levels the group budget allows.
 */
function lensRootResolver(params: {
  threadsByIdentity: ReadonlyMap<string, NavigationThreadSummary>;
  parentCandidates: ReadonlyMap<string, readonly NavigationThreadSummary[]>;
}): (thread: NavigationThreadSummary) => NavigationThreadSummary {
  const roots = new Map<NavigationThreadSummary, NavigationThreadSummary>();
  return (thread) => {
    const known = roots.get(thread);
    if (known) return known;
    let root = thread;
    const visited = new Set<NavigationThreadSummary>([thread]);
    for (let depth = 0; depth < 32; depth += 1) {
      const parent = parentIdentity(root, params.parentCandidates);
      const parentThread = parent ? params.threadsByIdentity.get(identityKey(parent)) : undefined;
      if (!parentThread || visited.has(parentThread)) break;
      visited.add(parentThread);
      root = parentThread;
    }
    roots.set(thread, root);
    return root;
  };
}

/** Resolve reachability against the complete inventory, never a loaded page.
 * A local child can outlive a viewer mount of its remote parent. Keep the
 * relationship on its row, but give directory/selection queries a root to
 * render until that parent is mounted again.
 */
function availableParentIdentity(
  thread: NavigationThreadSummary,
  candidatesByOwner: ReadonlyMap<string, readonly NavigationThreadSummary[]>,
  coverage: NavigationQueryCoverage | undefined,
): NavigationIdentity | undefined {
  const parent = parentIdentity(thread, candidatesByOwner);
  if (!parent) return undefined;
  // Discovery still in progress cannot establish that a parent is absent.
  if (coverage && coverage.state !== "complete") return parent;
  const candidates = candidatesByOwner.get(JSON.stringify([parent.ownerInstanceId ?? null, parent.threadId])) ?? [];
  return candidates.some((candidate) => candidate.source === parent.backend) ? parent : undefined;
}

/** Directory grouping can only hide a child under a parent in that directory.
 * Use complete membership, before pin splitting or pagination, so a parent
 * in another project cannot leave a counted child without a visible root.
 * The row keeps its actual relationship for other lenses and group actions.
 */
function directoryParentResolver(
  members: readonly NavigationThreadSummary[],
  parentCandidates: ReadonlyMap<string, readonly NavigationThreadSummary[]>,
): (thread: NavigationThreadSummary) => NavigationIdentity | undefined {
  const memberKeys = new Set(members.map(threadKey));
  return (thread) => {
    const parent = parentIdentity(thread, parentCandidates);
    return parent && memberKeys.has(identityKey(parent)) ? parent : undefined;
  };
}

function directoryMemberThreads(
  directory: NavigationDirectorySummary | undefined,
  threadsByLegacyKey: ReadonlyMap<string, NavigationThreadSummary>,
): NavigationThreadSummary[] {
  return directory?.threadKeys
    .map((key) => threadsByLegacyKey.get(key))
    .filter((thread): thread is NavigationThreadSummary => Boolean(thread)) ?? [];
}

function matchesDirectoryKey(index: NavigationQueryIndex, directory: NavigationDirectorySummary, key: string): boolean {
  return directory.key === key || index.directoryCaseAliases?.[directory.key]?.includes(key) === true;
}

function matchesDirectoryPath(index: NavigationQueryIndex, directory: NavigationDirectorySummary, path: string): boolean {
  return directory.path === path
    || (index.directoryCaseAliases?.[directory.key] !== undefined
      && matchesDirectoryKey(index, directory, `directory:${canonicalizeNavigationPath(path)}`));
}

function findDirectory(index: NavigationQueryIndex, key: string, allowPath = false): NavigationDirectorySummary | undefined {
  return index.directories.find((directory) => matchesDirectoryKey(index, directory, key)
    || (allowPath && matchesDirectoryPath(index, directory, key)));
}

function queryDirectory(params: {
  query: NavigationQueryRequest["query"];
  index: NavigationQueryIndex;
  threadsByLegacyKey: ReadonlyMap<string, NavigationThreadSummary>;
}): NavigationDirectorySummary | undefined {
  const { query } = params;
  if (query.kind === "directory" || query.kind === "children") {
    return query.directoryKey ? findDirectory(params.index, query.directoryKey) : undefined;
  }
  if (query.kind === "messaging-threads" && query.directoryKey) {
    return findDirectory(params.index, query.directoryKey, true);
  }
  if (query.kind === "exact" && query.ancestryScope === "directory") {
    if (query.identities.length !== 1) throw new Error("Directory-scoped ancestry requires exactly one thread identity.");
    const key = identityKey(query.identities[0]!);
    return params.index.directories.find((directory) => directory.threadKeys.some((member) => {
      const thread = params.threadsByLegacyKey.get(member);
      return thread && threadKey(thread) === key;
    }));
  }
  return undefined;
}

function isActive(thread: NavigationThreadSummary): boolean {
  return isNavigationThreadRunning(thread);
}

function countsForThreads(
  threads: readonly NavigationThreadSummary[],
  options: { backends?: boolean } = {},
): NavigationCounts {
  const distinct = new Map<string, NavigationThreadSummary>();
  for (const thread of threads) {
    if (!isOrdinaryThread(thread)) {
      continue;
    }
    distinct.set(threadKey(thread), thread);
  }
  let active = 0;
  let activeRemote = 0;
  let pinned = 0;
  let unread = 0;
  let review = 0;
  for (const thread of distinct.values()) {
    const threadActive = isActive(thread);
    const threadUnread = thread.inbox.inInbox;
    if (threadActive) active += 1;
    if (threadActive && thread.federation?.ref.target.scope === "remote") activeRemote += 1;
    if (thread.pinnedRank) pinned += 1;
    if (threadUnread) unread += 1;
    if (threadUnread && !threadActive) review += 1;
  }
  // Provider chips need to know whether every thread shares one provider.
  // `providers` tells a Codex model provider (MathOS) apart from OpenAI;
  // `backends` stays for viewers that predate it.
  const backends = options.backends
    ? [...new Set<AppServerBackendKind>(
        [...distinct.values()].map((thread) => thread.source),
      )].sort()
    : undefined;
  const providers = options.backends
    ? [...new Set([...distinct.values()].map((thread) => threadProviderIdentity(thread.source, thread.model)))].sort()
    : undefined;
  return {
    total: distinct.size,
    active,
    ...(activeRemote ? { activeRemote } : {}),
    ...(pinned ? { pinned } : {}),
    unread,
    review,
    ...(backends ? { backends } : {}),
    ...(providers ? { providers } : {}),
  };
}

function limitRecords<T>(items: readonly T[] | undefined): {
  items?: T[];
  truncated: boolean;
} {
  if (!items || items.length === 0) {
    return { truncated: false };
  }
  return {
    items: items.slice(0, MAX_ROW_NESTED_RECORDS),
    truncated: items.length > MAX_ROW_NESTED_RECORDS,
  };
}

function previewPullRequests(prs: PrSummary[] | undefined, stackLeadPrKey?: string): PrSummary[] | undefined {
  if (!prs || prs.length <= MAX_ROW_NESTED_RECORDS) return prs;
  // The newest PR in stack order leads. Readiness ties use attachment order
  // for Minimal and stack order for the overflow after removing the lead.
  let lead = 0;
  let representative = 0;
  for (let index = 1; index < prs.length; index += 1) {
    const pr = prs[index]!;
    if (comparePullRequestStack(pr, prs[lead]!) <= 0) lead = index;
    if (pullRequestRollupPriority(pr) < pullRequestRollupPriority(prs[representative]!)) {
      representative = index;
    }
  }
  let overflowRepresentative = lead === prs.length - 1 ? prs.length - 2 : prs.length - 1;
  const active: number[] = [];
  const finished: number[] = [];
  for (let index = prs.length - 1; index >= 0; index -= 1) {
    if (index === lead) continue;
    const pr = prs[index]!;
    const best = prs[overflowRepresentative]!;
    const priority = pullRequestRollupPriority(pr) - pullRequestRollupPriority(best);
    if (priority < 0 || (priority === 0 && comparePullRequestStack(pr, best) < 0)) {
      overflowRepresentative = index;
    }
    const candidates = resolveLifecycleState(pr) === "open" ? active : finished;
    if (candidates.length < MAX_ROW_NESTED_RECORDS) candidates.push(index);
  }
  // Fill the remaining slots with recent active work, then completed history.
  const retained = new Set([lead, representative, overflowRepresentative]);
  if (stackLeadPrKey) {
    const stackLead = prs.findIndex((pr) => buildPullRequestStatusKey(pr) === stackLeadPrKey);
    if (stackLead >= 0) retained.add(stackLead);
  }
  for (const index of [...active, ...finished]) {
    if (retained.size === MAX_ROW_NESTED_RECORDS) break;
    retained.add(index);
  }
  return [...retained]
    .sort((a, b) => a - b)
    .map((index) => prs[index]!);
}

export function projectNavigationPullRequests(prs?: PrSummary[], stackLeadPrKey?: string): Pick<NavigationRow, "prs" | "prsTruncated" | "prCount"> {
  const preview = previewPullRequests(prs, stackLeadPrKey);
  return {
    ...(preview?.length ? { prs: preview } : {}),
    ...(prs && prs.length > MAX_ROW_NESTED_RECORDS ? { prsTruncated: true, prCount: prs.length } : {}),
  };
}

function projectStackMemberships(thread: Pick<NavigationThreadSummary, "stacks" | "stackMemberships">): Pick<NavigationRow, "stackMemberships"> {
  const stackMemberships = readCompactStackMemberships(thread).slice(0, MAX_COMPACT_STACK_MEMBERSHIPS).flatMap((entry) => {
    if (typeof entry.key !== "string" || typeof entry.name !== "string" || !Number.isSafeInteger(entry.position)
      || !Number.isSafeInteger(entry.count) || entry.position < 1 || entry.position > entry.count) return [];
    const { heldBy, basePr } = entry;
    const positiveNumber = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
    return [{
      key: entry.key.length <= 512 ? entry.key : createHash("sha256").update(entry.key).digest("hex"),
      name: entry.name.slice(0, 160),
      inferred: entry.inferred === true,
      position: entry.position,
      count: entry.count,
      ...(typeof entry.repository === "string" && entry.repository.length <= 512 ? { repository: entry.repository } : {}),
      ...(positiveNumber(entry.number) ? { number: entry.number } : {}),
      ...(typeof entry.trunk === "string" ? { trunk: entry.trunk.slice(0, 160) } : {}),
      ...(typeof entry.hasOpenPr === "boolean" ? { hasOpenPr: entry.hasOpenPr } : {}),
      ...(basePr && positiveNumber(basePr.number) ? {
        basePr: {
          number: basePr.number,
          ...(typeof basePr.branch === "string" && basePr.branch.length <= 1024 ? { branch: basePr.branch } : {}),
          ...(["open", "merged", "closed"].includes(basePr.lifecycleState ?? "") ? { lifecycleState: basePr.lifecycleState } : {}),
          ...(["passing", "failing", "pending", "unknown"].includes(basePr.checkState ?? "") ? { checkState: basePr.checkState } : {}),
          ...(basePr.mergeState === "conflicting" ? { mergeState: basePr.mergeState } : {}),
        },
      } : {}),
      ...(STACK_UNSETTLED_REASONS.includes(entry.unsettled!) ? { unsettled: entry.unsettled } : {}),
      ...(heldBy && typeof heldBy.branch === "string" && STACK_UNSETTLED_REASONS.includes(heldBy.reason) ? {
        heldBy: { branch: heldBy.branch.slice(0, 160), reason: heldBy.reason,
          ...(positiveNumber(heldBy.number) ? { number: heldBy.number } : {}) },
      } : {}),
      health: typeof entry.health === "string" && entry.health.length <= 16 ? entry.health : "unknown" as const,
      ...(typeof entry.threadKey === "string" && entry.threadKey.length <= 512 ? { threadKey: entry.threadKey } : {}),
      ...(typeof entry.parentThreadKey === "string" && entry.parentThreadKey.length <= 512 ? { parentThreadKey: entry.parentThreadKey } : {}),
      ...(entry.parentMerged === true ? { parentMerged: true } : {}),
      ...(typeof entry.detailRevision === "string" && entry.detailRevision.length <= 64 ? { detailRevision: entry.detailRevision } : {}),
    }];
  });
  return stackMemberships.length ? { stackMemberships } : {};
}

function projectNavigationRow(params: {
  childCount: number;
  viewerChildCount?: number;
  needsInput: boolean;
  repositories: ReadonlyMap<string, RepositoryIdentity>;
  thread: NavigationThreadSummary & { nativeSubAgentCount?: number };
  homeProject?: NavigationRowHomeProject;
  checkoutProject?: NavigationDirectorySummary;
  omitPullRequests?: boolean;
}): NavigationRow {
  const { thread } = params;
  const linkedDirectories = limitRecords(thread.federation
    // A peer's thread already carries its owner's identities. Its paths name
    // the peer's checkouts, so a local lookup could only mislabel them.
    ? thread.linkedDirectories
    : withRepositoryIdentities(thread.linkedDirectories, params.repositories));
  const reactions = limitRecords(thread.reactions);
  const messagingBindings = limitRecords(thread.messagingBindings);
  const prCiWatches = limitRecords(thread.prCiWatches);
  const nativeSubAgentCount = thread.nativeSubAgentCount ?? thread.codexNativeSubAgents?.length ?? 0;
  const projected = {
    ref: navigationIdentity(thread),
    id: thread.id,
    source: thread.source,
    title: thread.title,
    titleSource: thread.titleSource,
    ...(thread.createdAt !== undefined ? { createdAt: thread.createdAt } : {}),
    ...(thread.updatedAt !== undefined ? { updatedAt: thread.updatedAt } : {}),
    ...(thread.archivedAt !== undefined ? { archivedAt: thread.archivedAt } : {}),
    ...(thread.threadStatus ? { threadStatus: thread.threadStatus } : {}),
    ...(thread.hasActiveSubAgent ? { hasActiveSubAgent: true } : {}),
    ...(thread.hasBackgroundTasks ? { hasBackgroundTasks: true } : {}),
    ...(thread.hasAgentCommands ? { hasAgentCommands: true } : {}),
    inbox: thread.inbox,
    ...(thread.projectKey ? { projectKey: thread.projectKey } : {}),
    ...(params.checkoutProject ? {
      checkoutProject: {
        key: params.checkoutProject.key,
        label: params.checkoutProject.label,
        repositoryKey: params.checkoutProject.gitStatus?.originRepository ?? params.checkoutProject.repositoryKey,
      },
    } : thread.checkoutProject ? { checkoutProject: thread.checkoutProject } : {}),
    linkedDirectories: linkedDirectories.items ?? [],
    ...(linkedDirectories.truncated ? { linkedDirectoriesTruncated: true } : {}),
    ...(thread.gitBranch ? { gitBranch: thread.gitBranch } : {}),
    ...(thread.gitOriginUrl ? { gitOriginUrl: thread.gitOriginUrl } : {}),
    ...(thread.observedGitBranch
      ? { observedGitBranch: thread.observedGitBranch }
      : {}),
    ...(thread.gitWorkingState
      ? { gitWorkingState: thread.gitWorkingState }
      : {}),
    ...(thread.gitWorkingStateFetchedAt !== undefined
      ? { gitWorkingStateFetchedAt: thread.gitWorkingStateFetchedAt }
      : {}),
    ...(thread.primaryGitRepository
      ? { primaryGitRepository: thread.primaryGitRepository }
      : {}),
    ...(thread.federation
      ? {
          federation: {
            ref: thread.federation.ref,
            instanceLabel: thread.federation.instanceLabel,
            ...(thread.federation.peerStatus
              ? { peerStatus: thread.federation.peerStatus }
              : {}),
            ...(thread.federation.capabilities
              ? { capabilities: thread.federation.capabilities }
              : {}),
            ...(thread.federation.derivedFromMountedParent
              ? { derivedFromMountedParent: true }
              : {}),
            ...(thread.federation.celestialIcon
              ? { celestialIcon: thread.federation.celestialIcon }
              : {}),
          },
        }
      : {}),
    ...(thread.pinnedRank ? { pinnedRank: thread.pinnedRank } : {}),
    ...(thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : {}),
    ...(thread.parentThreadBackend
      ? { parentThreadBackend: thread.parentThreadBackend }
      : {}),
    ...(thread.parentThreadInstanceId
      ? { parentThreadInstanceId: thread.parentThreadInstanceId }
      : {}),
    ordinaryChildCount: params.childCount,
    ...(params.viewerChildCount !== undefined ? { viewerChildCount: params.viewerChildCount } : {}),
    nativeSubAgentGroupPresent: nativeSubAgentCount > 0,
    ...(nativeSubAgentCount > 0 ? { nativeSubAgentCount } : {}),
    ...(thread.subthreadsCollapsed !== undefined
      ? { subthreadsCollapsed: thread.subthreadsCollapsed }
      : {}),
    ...(reactions.items ? { reactions: reactions.items } : {}),
    ...(reactions.truncated ? { reactionsTruncated: true } : {}),
    ...(thread.lock ? { lock: thread.lock } : {}),
    ...(thread.checkoutHibernated ? { checkoutHibernated: true } : {}),
    ...(thread.keepCheckoutAwake ? { keepCheckoutAwake: true } : {}),
    ...(!params.omitPullRequests ? projectNavigationPullRequests(thread.prs, thread.stackLeadPrKey) : {}),
    ...(thread.stackLeadPrKey && thread.stackLeadPrKey.length <= 1024 ? { stackLeadPrKey: thread.stackLeadPrKey } : {}),
    ...projectStackMemberships(thread),
    ...(messagingBindings.items
      ? { messagingBindings: messagingBindings.items }
      : {}),
    ...(messagingBindings.truncated
      ? { messagingBindingsTruncated: true }
      : {}),
    ...(thread.automationSummary
      ? { automationSummary: thread.automationSummary }
      : {}),
    ...(thread.agentChange ? { agentChange: thread.agentChange } : {}),
    ...(thread.agent
      ? {
          agent: {
            name: thread.agent.name,
            instructionLineCount: thread.agent.instructionLineCount,
            instructionsTooLong: thread.agent.instructionsTooLong,
            updatedAt: thread.agent.updatedAt,
          },
        }
      : {}),
    ...(thread.executionMode ? { executionMode: thread.executionMode } : {}),
    ...(thread.model ? { model: thread.model } : {}),
    ...(thread.serviceTier ? { serviceTier: thread.serviceTier } : {}),
    ...(thread.reasoningEffort
      ? { reasoningEffort: thread.reasoningEffort }
      : {}),
    ...(thread.fastMode !== undefined ? { fastMode: thread.fastMode } : {}),
    ...(thread.workspaceHandoff
      ? { workspaceHandoff: thread.workspaceHandoff }
      : {}),
    needsInput: params.needsInput,
    queueCount: thread.queuedTurns?.length ?? 0,
    queueState: thread.queuedTurns ? "ready" as const : "unknown" as const,
    ...(thread.queuedExecutionMode
      ? { queuedExecutionMode: thread.queuedExecutionMode }
      : {}),
    ...(thread.prAutoDispatchEnabled !== undefined
      ? { prAutoDispatchEnabled: thread.prAutoDispatchEnabled }
      : {}),
    ...(prCiWatches.items ? { prCiWatches: prCiWatches.items } : {}),
    ...(thread.scheduledStart ? { scheduledStart: thread.scheduledStart } : {}),
    ...(params.homeProject ? { homeProject: params.homeProject } : {}),
  };
  return {
    ...projected,
    rowRevision: hashValue(projected),
  };
}

function projectDirectoryGitStatus(status: NavigationDirectoryGitStatus | undefined): NavigationDirectoryRow["gitStatus"] {
  if (!status) {
    return undefined;
  }
  return {
    ...(status.currentBranch ? { currentBranch: status.currentBranch } : {}),
    ...(status.defaultBranch ? { defaultBranch: status.defaultBranch } : {}),
    ...(status.upstreamBranch ? { upstreamBranch: status.upstreamBranch } : {}),
    ...(status.ahead !== undefined ? { ahead: status.ahead } : {}),
    ...(status.behind !== undefined ? { behind: status.behind } : {}),
    ...(status.syncState ? { syncState: status.syncState } : {}),
    ...(status.statusUnavailableReason
      ? { statusUnavailableReason: status.statusUnavailableReason }
      : {}),
    ...(status.worktreeCreationAvailable !== undefined
      ? { worktreeCreationAvailable: status.worktreeCreationAvailable }
      : {}),
    ...(status.worktreeCreationUnavailableReason
      ? {
          worktreeCreationUnavailableReason:
            status.worktreeCreationUnavailableReason,
        }
      : {}),
  };
}

export function navigationDirectoryRepositoryRevision(status: NavigationDirectoryGitStatus | undefined): string | undefined {
  const remotes = status?.remoteRepositories;
  if ((status?.originRepository?.length ?? 0) > 1024
    || (remotes && (remotes.length > 32 || remotes.some((remote) => remote.length > 1024)))) return undefined;
  return hashValue(["repository", status?.originRepository, remotes]);
}

/** Compare the current write with the serving snapshot, independently of prior notifications or writers. */
export function navigationDirectoryGitRevisions(status: NavigationDirectoryGitStatus | undefined): NavigationDirectoryGitRevisions | undefined {
  const repository = navigationDirectoryRepositoryRevision(status);
  if (!repository) return undefined;
  const descriptor = projectDirectoryGitStatus(status);
  if (Object.values(descriptor ?? {}).some((value) => typeof value === "string" && value.length > 1024)) return undefined;
  return { version: 1, repository, descriptor: hashValue(["descriptor", repository, descriptor]) };
}

function buildDirectoryRows(params: {
  snapshot: NavigationQueryIndex;
  threadsByLegacyKey: Map<string, NavigationThreadSummary>;
  parentCandidates: ReadonlyMap<string, readonly NavigationThreadSummary[]>;
}): NavigationDirectoryRow[] {
  return params.snapshot.directories.map((directory) => {
    const memberThreads = directoryMemberThreads(directory, params.threadsByLegacyKey);
    const parentOf = directoryParentResolver(memberThreads, params.parentCandidates);
    const rootThreads: NavigationThreadSummary[] = [];
    const children = new Map<string, NavigationThreadSummary[]>();
    for (const thread of memberThreads) {
      const parent = parentOf(thread);
      if (!parent) {
        rootThreads.push(thread);
      } else {
        const key = identityKey(parent);
        const siblings = children.get(key) ?? [];
        siblings.push(thread);
        children.set(key, siblings);
      }
    }
    const pinnedRootCount = rootThreads.filter((thread) => thread.pinnedRank).length;
    // Count the complete unpinned forest once, without loading child pages.
    // A child's own pin does not move it out of its root's section.
    const pending = rootThreads.filter((thread) => !thread.pinnedRank);
    const visited = new Set<string>();
    let unpinnedThreadCount = 0;
    while (pending.length) {
      const thread = pending.pop()!;
      const key = threadKey(thread);
      if (visited.has(key)) continue;
      visited.add(key);
      if (isOrdinaryThread(thread)) unpinnedThreadCount += 1;
      for (const child of children.get(key) ?? []) pending.push(child);
    }
    const gitStatus = projectDirectoryGitStatus(directory.gitStatus);
    // A checkout reads its own remotes; a placeholder carries the peer's.
    const repositoryKey = directory.gitStatus?.originRepository ?? directory.repositoryKey;
    const repositoryKeys = directory.gitStatus?.remoteRepositories?.length
      ? directory.gitStatus.remoteRepositories
      : directory.repositoryKeys;
    return {
      key: directory.key,
      kind: directory.kind,
      label: directory.label,
      ...(directory.path ? { path: directory.path } : {}),
      ...(directory.checkoutPaths ? { checkoutPaths: directory.checkoutPaths } : {}),
      ...(repositoryKey ? { repositoryKey } : {}),
      ...(repositoryKeys?.length ? { repositoryKeys } : {}),
      ...(directory.localAvailability
        ? { localAvailability: directory.localAvailability }
        : {}),
      counts: countsForThreads(memberThreads),
      pinnedRootCount,
      unpinnedRootCount: rootThreads.length - pinnedRootCount,
      unpinnedThreadCount,
      ...(directory.latestUpdatedAt !== undefined
        ? { latestUpdatedAt: directory.latestUpdatedAt }
        : {}),
      ...(directory.pinnedRank ? { pinnedRank: directory.pinnedRank } : {}),
      ...(directory.directoryThreadsCollapsed !== undefined
        ? { directoryThreadsCollapsed: directory.directoryThreadsCollapsed }
        : {}),
      // A placeholder row stands for a peer's project. It shows that
      // project's setting only when its threads name one project on one peer.
      ...(directory.forgeAutomation && (!directory.localAvailability || directory.peerProject)
        ? { forgeAutomation: directory.forgeAutomation }
        : {}),
      ...(directory.localAvailability && directory.peerProject
        ? { peerProject: directory.peerProject }
        : {}),
      ...(gitStatus ? { gitStatus } : {}),
      launchpadPresent: Boolean(directory.launchpad),
      ...(directory.launchpad?.backend ? { launchpadBackend: directory.launchpad.backend } : {}),
    };
  });
}

function selectIndexedDirectories(
  index: NavigationQueryIndex,
  query: Extract<NavigationQuery, { kind: "directory-index" }>,
): NavigationDirectorySummary[] {
  const candidates = query.keys || query.paths ? index.directories.filter((directory) =>
    query.keys?.some((key) => matchesDirectoryKey(index, directory, key) || directoryIncludesCheckout(directory, key))
    || query.paths?.some((path) => matchesDirectoryPath(index, directory, path))
    || directory.checkoutPaths?.some((path) => query.paths?.includes(path))) : index.directories;
  const filter = query.filter?.trim() ?? "";
  if (query.match === "mention") {
    return rankDirectoryMentionMatches(candidates, filter, homedir());
  }
  return filter ? candidates.filter((directory) => textMatchesJumpQuery(directory.label, filter)
    || textMatchesJumpQuery(directory.path, filter)
    || directory.checkoutPaths?.some((path) => textMatchesJumpQuery(path, filter))) : candidates;
}

/**
 * Repository identity per directory path, from the cached Git status.
 *
 * A row's `key` is an absolute path, so it names a checkout on ONE
 * machine. The Star Map's Projects lens pools a whole federation, and
 * keying its bodies on the path drew the same repository once per machine
 * (and twice on a machine holding two clones of it). The origin is the
 * only part of a checkout that reads the same everywhere.
 */
function repositoryIdentitiesByPath(
  index: NavigationQueryIndex,
): Map<string, RepositoryIdentity> {
  const identities = new Map<string, RepositoryIdentity>();
  for (const directory of index.directories) {
    // NOT trimmed: callers look these up with the same raw `path` the
    // thread carries, and normalizing on only one side is a miss that reads
    // as a repository silently failing to match.
    const path = directory.path;
    const repositoryKey = directory.gitStatus?.originRepository ?? directory.repositoryKey;
    const repositoryKeys = directory.gitStatus?.remoteRepositories;
    if (!path || (!repositoryKey && !repositoryKeys?.length)) continue;
    identities.set(path, {
      ...(repositoryKey ? { repositoryKey } : {}),
      ...(repositoryKeys?.length ? { repositoryKeys } : {}),
    });
  }
  return identities;
}

type RepositoryIdentity = Pick<LinkedDirectorySummary, "repositoryKey" | "repositoryKeys">;

/**
 * Stamp each linked directory with the repository of the checkout it names,
 * so a viewer that has never checked the project out can still tell it apart
 * from an unrelated checkout with the same folder name. The collapsed path
 * first, then the directory's own, as the Star Map's geometry looks them up.
 */
function withRepositoryIdentities(
  directories: LinkedDirectorySummary[],
  repositories: ReadonlyMap<string, RepositoryIdentity>,
): LinkedDirectorySummary[] {
  if (!repositories.size) return directories;
  return directories.map((directory) => {
    const descriptor = classifyDirectory(directory);
    // A Workspaces scratch folder names no project; never give it one.
    if (descriptor.kind !== "directory") return directory;
    const identity = (descriptor.path ? repositories.get(descriptor.path) : undefined)
      ?? repositories.get(directory.path);
    return identity ? { ...directory, ...identity } : directory;
  });
}

/** Project geometry counts primary membership once, independent of loaded cards. */
function buildProjectGeometry(
  index: NavigationQueryIndex,
  projectMembership: Pick<ProjectionIndex, "checkoutProjects" | "workspaceProjects">,
): NavigationDirectoryRow[] {
  const projects = new Map<string, NavigationDirectoryRow>();
  const launchpads = new Set(index.directories.filter((directory) => directory.launchpad).map((directory) => directory.key));
  const repositories = repositoryIdentitiesByPath(index);
  const seen = new Set<string>();
  for (const thread of index.threads) {
    if (!isStarMapOwnerThread(thread) || seen.has(threadKey(thread))) continue;
    seen.add(threadKey(thread));
    const primary = thread.linkedDirectories[0];
    const home = starMapProjectForThread(thread, projectMembership);
    const descriptor = home ?? (primary ? classifyDirectory(primary) : undefined);
    const key = descriptor?.key ?? "__no-project__";
    let project = projects.get(key);
    if (!project) {
      const segments = (descriptor?.path ?? primary?.path)?.split(/[\\/]/).filter(Boolean);
      // The collapsed path first, then the thread's own: a worktree shares
      // its repository's remote, so either answers the same question and
      // only one of them may have a cached status.
      const repositoryKey =
        (descriptor?.path ? repositories.get(descriptor.path)?.repositoryKey : undefined)
        ?? (home ? undefined : primary?.path ? repositories.get(primary.path)?.repositoryKey : undefined);
      project = {
        key,
        kind: descriptor?.kind ?? "unlinked",
        label: home?.label ?? (descriptor ? (descriptor.label !== primary?.label ? descriptor.label : segments?.at(-1) ?? descriptor.label) : "No project"),
        path: descriptor?.path,
        ...(home?.checkoutPaths ? { checkoutPaths: home.checkoutPaths } : {}),
        ...(repositoryKey ? { repositoryKey } : {}),
        counts: { total: 0, active: 0, unread: 0, review: 0 },
        pinnedRootCount: 0,
        unpinnedRootCount: 0,
        launchpadPresent: launchpads.has(key),
      };
      projects.set(key, project);
    }
    project.counts.total += 1;
    const active = isActive(thread);
    if (active) project.counts.active += 1;
    if (thread.inbox.inInbox) {
      project.counts.unread += 1;
      if (!active) project.counts.review += 1;
    }
    if (!thread.parentThreadId) {
      if (thread.pinnedRank !== undefined) project.pinnedRootCount += 1;
      else project.unpinnedRootCount += 1;
    }
    project.latestUpdatedAt = Math.max(project.latestUpdatedAt ?? 0, thread.updatedAt ?? 0);
  }

  // Keep checkout exclusions when a configured group loses its last visible
  // thread. Carry the group on the geometry of the same origin without
  // adding an empty project or a new card page for it.
  const emptyGroupsByOrigin = new Map<string, number>();
  for (const directory of index.directories) {
    if (!directory.checkoutPaths?.length || !directory.path || projects.has(directory.key)) continue;
    const origin = repositories.get(directory.path)?.repositoryKey;
    if (origin) emptyGroupsByOrigin.set(origin, (emptyGroupsByOrigin.get(origin) ?? 0) + 1);
  }
  if (emptyGroupsByOrigin.size > 0) {
    for (const project of projects.values()) {
      const emptyGroupCount = project.repositoryKey && emptyGroupsByOrigin.get(project.repositoryKey);
      if (emptyGroupCount) project.emptyCheckoutGroupCount = emptyGroupCount;
    }
  }
  return [...projects.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function normalizeQuery(query: NavigationQuery): NavigationQuery {
  if (query.kind === "group-members") return { ...query, roots: [...query.roots].sort((left, right) => identityKey(left).localeCompare(identityKey(right))) };
  if (query.kind === "messaging-threads" || query.kind === "messaging-projects") {
    return { ...query, filter: query.filter?.trim().toLowerCase() || undefined,
      ...(query.allowedBackends ? { allowedBackends: [...new Set(query.allowedBackends)].sort() } : {}) };
  }

  if (query.kind === "star-map") {
    return { kind: "star-map", ...(query.projectKey !== undefined ? { projectKey: query.projectKey } : {}), filters: Object.fromEntries(Object.entries(query.filters)
      .filter(([, value]) => value !== "neutral").sort(([left], [right]) => left.localeCompare(right))) };
  }
  if (query.kind === "lens" || query.kind === "directory-index") {
    return {
      ...query,
      ...(query.kind === "directory-index" && query.keys ? { keys: [...new Set(query.keys)].sort() } : {}),
      ...(query.kind === "directory-index" && query.paths ? { paths: [...new Set(query.paths)].sort() } : {}),
      ...(query.filter?.trim().toLowerCase()
        ? { filter: query.filter.trim().toLowerCase() }
        : { filter: undefined }),
    };
  }
  if (query.kind === "search") {
    return { ...query, text: query.text.trim().toLowerCase() };
  }
  if (query.kind === "directory") {
    return {
      ...query,
      roots: query.roots ?? "all",
      disclosedParentThreadKeys: [
        ...new Set(query.disclosedParentThreadKeys ?? []),
      ].sort(),
    };
  }
  if (query.kind === "exact") {
    return {
      ...query,
      identities: [...query.identities].sort((left, right) =>
        identityKey(left).localeCompare(identityKey(right))),
    };
  }
  return query;
}

export function navigationQueryKey(request: NavigationQueryRequest): string {
  return hashValue({
    inventory: request.inventory ?? "owner",
    backend: request.backend ?? "all",
    attentionView: request.attentionView,
    query: normalizeQuery(request.query),
  });
}

function rowOrderKey(index: number): string {
  return index.toString(36).padStart(10, "0");
}

function compareUpdated(left: NavigationThreadSummary, right: NavigationThreadSummary): number {
  return (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    || threadKey(left).localeCompare(threadKey(right));
}

function compareCreated(left: NavigationThreadSummary, right: NavigationThreadSummary): number {
  return (right.createdAt ?? 0) - (left.createdAt ?? 0)
    || threadKey(left).localeCompare(threadKey(right));
}

function compareDirectoryMembers(
  left: NavigationThreadSummary,
  right: NavigationThreadSummary,
): number {
  if (Boolean(left.pinnedRank) !== Boolean(right.pinnedRank)) {
    return left.pinnedRank ? -1 : 1;
  }
  if (left.pinnedRank && right.pinnedRank) {
    const pinned = comparePinnedThreads(left, right);
    if (pinned !== 0) return pinned;
  }
  return compareCreated(left, right);
}

function isStarMapOwnerThread(thread: NavigationThreadSummary): boolean {
  return isOrdinaryThread(thread) && thread.archivedAt === undefined
    && thread.federation?.ref.target.scope !== "remote";
}

function checkoutProjectForThread(
  thread: NavigationThreadSummary,
  checkoutProjects: ProjectionIndex["checkoutProjects"],
): NavigationDirectorySummary | undefined {
  return thread.federation ? undefined : checkoutProjects.get(buildThreadIdentityKey(thread.source, thread.id));
}

function starMapProjectForThread(
  thread: NavigationThreadSummary,
  { workspaceProjects, checkoutProjects }: Pick<ProjectionIndex, "checkoutProjects" | "workspaceProjects">,
): NavigationDirectorySummary | undefined {
  return workspaceProjects.get(buildThreadIdentityKey(thread.source, thread.id))
    ?? checkoutProjectForThread(thread, checkoutProjects);
}

function starMapProjectKey(
  thread: NavigationThreadSummary,
  projectMembership: Pick<ProjectionIndex, "checkoutProjects" | "workspaceProjects">,
): string {
  const home = starMapProjectForThread(thread, projectMembership);
  if (home) return home.key;
  const primary = thread.linkedDirectories[0];
  return primary ? classifyDirectory(primary).key : "__no-project__";
}

function starMapSignals(thread: NavigationThreadSummary, index: NavigationQueryIndex): NavigationStarMapSignals {
  const active = isActive(thread);
  const unread = thread.inbox.inInbox && thread.inbox.reason === "updated-since-seen";
  return {
    active,
    unread,
    attention: active || unread,
    approval: !thread.federation && (index.inputRequestThreadKeys?.has(buildThreadIdentityKey(thread.source, thread.id)) ?? false),
    pr: thread.prs?.some((pr) => pr.state !== "merged" && pr.state !== "closed"
      && pr.lifecycleState !== "merged" && pr.lifecycleState !== "closed") ?? false,
    unpushed: (thread.gitWorkingState?.unpushedCommits ?? 0) > 0,
    pinned: thread.pinnedRank !== undefined,
    agent: thread.agent !== undefined,
  };
}

function selectQueryThreads(params: {
  query: NavigationQuery;
  index: NavigationQueryIndex;
  threadsByIdentity: Map<string, NavigationThreadSummary>;
  threadsByLegacyKey: Map<string, NavigationThreadSummary>;
  parentCandidates: ReadonlyMap<string, readonly NavigationThreadSummary[]>;
  checkoutProjects: ProjectionIndex["checkoutProjects"];
  workspaceProjects: ProjectionIndex["workspaceProjects"];
  /** A split lens's root resolver, shared with the page's collection size. */
  lensRootOf?: (thread: NavigationThreadSummary) => NavigationThreadSummary;
}): NavigationThreadSummary[] {
  const ordinaryThreads = params.index.threads.filter(isOrdinaryThread);
  const query = params.query;
  if (query.kind === "messaging-threads" || query.kind === "messaging-projects") {
    const directory = query.directoryKey ? findDirectory(params.index, query.directoryKey, true) : undefined;
    const members = directory ? new Set(directory.threadKeys.flatMap((key) => {
      const thread = params.threadsByLegacyKey.get(key);
      return thread ? [threadKey(thread)] : [];
    })) : undefined;
    const filter = query.kind === "messaging-threads" ? query.filter?.trim().toLowerCase() : undefined;
    return ordinaryThreads.filter((thread) => {
      if (query.agentOnly && !thread.agent) return false;
      if (query.excludeFullAccess && thread.executionMode === "full-access") return false;
      if (query.allowedBackends && !query.allowedBackends.includes(thread.source)) return false;
      if (query.directoryKey && (!members || !members.has(threadKey(thread)))) return false;
      if (!filter) return true;
      // Preserve searches on the automation picker's displayed provider metadata.
      const provider = thread.source.startsWith("acp:") ? thread.source.slice("acp:".length) : thread.source;
      const pickerText = `${thread.agent?.name ?? thread.title} ${provider} - ${thread.title} ${thread.title}`;
      return [pickerText, thread.id, thread.title, thread.summary, thread.agent?.name, thread.agent?.instructions, thread.projectKey,
        ...thread.linkedDirectories.flatMap((linked) => [linked.label, linked.path, linked.worktreePath])]
        .some((value) => value?.toLowerCase().includes(filter));
    }).sort(compareUpdated);
  }
  if (query.kind === "directory-index" || query.kind === "star-map-geometry" || query.kind === "model-inventory") {
    return [];
  }
  if (query.kind === "star-map") {
    const projectKey = query.projectKey ? findDirectory(params.index, query.projectKey)?.key ?? query.projectKey : undefined;
    return ordinaryThreads.filter(isStarMapOwnerThread)
      .filter((thread) => projectKey === undefined || starMapProjectKey(thread, params) === projectKey)
      .filter((thread) => (thread.pinnedRank !== undefined && query.filters.pinned !== "exclude")
        || passesNavigationStarMapFilters(starMapSignals(thread, params.index), query.filters))
      .sort((left, right) => {
        if ((left.pinnedRank !== undefined) !== (right.pinnedRank !== undefined)) return left.pinnedRank !== undefined ? -1 : 1;
        return left.pinnedRank !== undefined && right.pinnedRank !== undefined
          ? comparePinnedThreads(left, right) : compareUpdated(left, right);
      });
  }
  if (query.kind === "lens") {
    const filter = query.filter?.trim().toLowerCase();
    const rootOf = params.lensRootOf;
    const threads = ordinaryThreads
      .filter((thread) => {
        if (query.lens === "attention") {
          if (!isActive(thread) && !thread.inbox.inInbox) return false;
          if (query.attention && !navigationThreadInAttentionScope(thread, query.attention)) return false;
        }
        // A subtree follows its root, so a pinned thread's children render
        // in its tray in the Pinned group and never orphaned in the list.
        if (rootOf && (rootOf(thread).pinnedRank !== undefined) !== (query.roots === "pinned")) return false;
        if (!filter) return true;
        return thread.title.toLowerCase().includes(filter)
          || thread.linkedDirectories.some((directory) =>
            directory.path.toLowerCase().includes(filter));
      });
    if (rootOf && query.roots === "pinned") {
      // One global pin order, the same rank Directories edits. A root's
      // descendants sort directly behind it, in creation order.
      return threads.sort((left, right) => {
        const leftRoot = rootOf(left);
        const rightRoot = rootOf(right);
        if (leftRoot !== rightRoot) return comparePinnedThreads(leftRoot, rightRoot);
        if ((left === leftRoot) !== (right === rightRoot)) return left === leftRoot ? -1 : 1;
        return compareCreated(left, right);
      });
    }
    return threads.sort(query.lens === "recents" ? compareCreated : compareUpdated);
  }
  if (query.kind === "directory") {
    const directory = findDirectory(params.index, query.directoryKey);
    if (!directory) return [];
    const disclosedParents = new Set(query.disclosedParentThreadKeys ?? []);
    const members = directoryMemberThreads(directory, params.threadsByLegacyKey);
    const parentOf = directoryParentResolver(members, params.parentCandidates);
    return members
      .filter((thread) => {
        const parent = parentOf(thread);
        if (parent) return disclosedParents.has(buildThreadIdentityKey(parent.backend, parent.threadId));
        return query.roots === "pinned" ? thread.pinnedRank !== undefined
          : query.roots === "unpinned" ? thread.pinnedRank === undefined : true;
      })
      .sort(compareDirectoryMembers);
  }
  if (query.kind === "group-members") {
    const ordinary = new Set(ordinaryThreads);
    const children = new Map<string, NavigationThreadSummary[]>();
    for (const thread of ordinaryThreads) {
      const parent = parentIdentity(thread, params.parentCandidates);
      if (!parent) continue;
      const key = identityKey(parent);
      const members = children.get(key) ?? [];
      members.push(thread);
      children.set(key, members);
    }
    const result: NavigationThreadSummary[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (ref: NavigationIdentity, depth: number): void => {
      const key = identityKey(ref);
      if (visited.has(key)) return;
      if (visiting.has(key) || depth > 32) throw new Error("Thread group has a cycle or exceeds the 32-level group budget.");
      visiting.add(key);
      for (const child of children.get(key) ?? []) visit(navigationIdentity(child), depth + 1);
      visiting.delete(key);
      visited.add(key);
      const thread = params.threadsByIdentity.get(key);
      if (thread && ordinary.has(thread)) result.push(thread);
    };
    for (const root of query.roots) visit(root, 0);
    return result;
  }
  if (query.kind === "children") {
    const parentThread = params.threadsByIdentity.get(identityKey(query.parent));
    const members = query.directoryKey === undefined ? undefined : new Set(directoryMemberThreads(
      findDirectory(params.index, query.directoryKey), params.threadsByLegacyKey,
    ));
    if (members && (!parentThread || !members.has(parentThread))) return [];
    const children = ordinaryThreads.filter((thread) => {
      if (members && !members.has(thread)) return false;
      const parent = parentIdentity(thread, params.parentCandidates);
      return parent && identityKey(parent) === identityKey(query.parent);
    });
    return sortSubthreadSummaries(parentThread ?? {}, children);
  }

  if (query.kind === "search") {
    const text = query.text.trim().toLowerCase();
    if (!text) return [];
    return rankThreadJumpMatches(ordinaryThreads, text);
  }

  const selected = new Map<string, NavigationThreadSummary>();
  const visiting = new Set<string>();
  const directory = queryDirectory(params);
  const parentOf = query.ancestryScope === "directory"
    ? directoryParentResolver(directoryMemberThreads(directory, params.threadsByLegacyKey), params.parentCandidates) : undefined;
  const addWithAncestry = (thread: NavigationThreadSummary): void => {
    const key = threadKey(thread);
    if (selected.has(key) || visiting.has(key)) return;
    visiting.add(key);
    const parent = parentOf ? parentOf(thread) : parentIdentity(thread, params.parentCandidates);
    if (query.includeAncestry && parent) {
      const parentThread = params.threadsByIdentity.get(identityKey(parent));
      if (parentThread) addWithAncestry(parentThread);
    }
    selected.set(key, thread);
    visiting.delete(key);
  };
  for (const identity of query.identities.slice(0, NAVIGATION_QUERY_MAX_PAGE_ROWS)) {
    const thread = params.threadsByIdentity.get(identityKey(identity));
    if (thread) addWithAncestry(thread);
  }
  return [...selected.values()];
}

function buildModelInventory(threads: readonly NavigationThreadSummary[]): NavigationModelInventoryRow[] {
  const groups = new Map<string, NavigationModelInventoryRow>();
  for (const thread of threads) {
    const model = thread.model?.trim() || undefined;
    const key = JSON.stringify([thread.source, model, thread.modelMigrationRevision]);
    const group = groups.get(key) ?? { backend: thread.source, model, modelMigrationRevision: thread.modelMigrationRevision, threadCount: 0, fastThreadCount: 0 };
    group.threadCount += 1;
    if (thread.fastMode === true || thread.serviceTier === "ultrafast") group.fastThreadCount += 1;
    groups.set(key, group);
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([, group]) => group);
}

/**
 * The Directories project each thread this instance owns is filed under, for
 * `group-members` rows. A viewer reads its pinned rows through those pages
 * and shows the project's Forge Automation on the placeholder row that
 * stands for it. A peer's thread and a placeholder carry none: their project
 * belongs to another instance.
 */
function buildHomeProjects(
  directories: readonly NavigationDirectorySummary[],
  threadsByLegacyKey: ReadonlyMap<string, NavigationThreadSummary>,
): Map<NavigationThreadSummary, NavigationRowHomeProject> {
  const homes = new Map<NavigationThreadSummary, NavigationRowHomeProject>();
  for (const directory of directories) {
    if (directory.kind !== "directory" || !directory.key.startsWith("directory:")
      || directory.localAvailability) continue;
    const home: NavigationRowHomeProject = {
      directoryKey: directory.key,
      ...(directory.forgeAutomation ? { forgeAutomation: directory.forgeAutomation } : {}),
    };
    for (const key of directory.threadKeys) {
      const thread = threadsByLegacyKey.get(key);
      if (thread && !thread.federation && !homes.has(thread)) homes.set(thread, home);
    }
  }
  return homes;
}

function buildThreadsByLegacyKey(index: NavigationQueryIndex): Map<string, NavigationThreadSummary> {
  return new Map(
    index.threads.map((thread) => [
      thread.federation?.ref.target.scope === "remote" ? federatedThreadIdentityKey(thread.federation.ref) : buildThreadIdentityKey(thread.source, thread.id),
      thread,
    ]),
  );
}

function buildParentCandidates(index: NavigationQueryIndex): Map<string, NavigationThreadSummary[]> {
  const parentCandidates = new Map<string, NavigationThreadSummary[]>();
  for (const thread of index.threads) {
    const ref = navigationIdentity(thread);
    const key = JSON.stringify([ref.ownerInstanceId ?? null, ref.threadId]);
    const candidates = parentCandidates.get(key) ?? [];
    candidates.push(thread);
    parentCandidates.set(key, candidates);
    // Federation relationships carry an absolute owner ID, including when
    // that owner is this viewer. Alias only our known identity to local rows.
    if (!ref.ownerInstanceId && index.localInstanceId) {
      parentCandidates.set(JSON.stringify([index.localInstanceId, ref.threadId]), candidates);
    }
  }
  return parentCandidates;
}

function buildChildCounts(
  threads: readonly NavigationThreadSummary[] | ReadonlySet<NavigationThreadSummary>,
  prepared: Pick<ProjectionIndex, "threadsByIdentity" | "parentCandidates">,
  onWork?: NavigationProjectionWork,
): Pick<ProjectionIndex, "childCountByParent" | "viewerChildCountByParent"> {
  const childCountByParent = new Map<string, number>();
  const viewerChildCountByParent = new Map<string, number>();
  const scoped = threads instanceof Set ? threads : undefined;
  onWork?.("children", scoped ? scoped.size : (threads as readonly NavigationThreadSummary[]).length);
  for (const thread of threads) {
    const parent = parentIdentity(thread, prepared.parentCandidates);
    if (!parent || !isOrdinaryThread(thread)) continue;
    if (scoped) {
      const parentThread = prepared.threadsByIdentity.get(identityKey(parent));
      if (!parentThread || !scoped.has(parentThread)) continue;
    }
    const key = identityKey(parent);
    childCountByParent.set(key, (childCountByParent.get(key) ?? 0) + 1);
    if (parent.ownerInstanceId && navigationIdentity(thread).ownerInstanceId !== parent.ownerInstanceId) {
      viewerChildCountByParent.set(key, (viewerChildCountByParent.get(key) ?? 0) + 1);
    }
  }
  return { childCountByParent, viewerChildCountByParent };
}

function buildProjectionIndex(index: NavigationQueryIndex, onWork?: NavigationProjectionWork, includeChildCounts = true): ProjectionIndex {
  onWork?.("index", index.threads.length);
  const checkoutProjects = new Map<string, NavigationDirectorySummary>();
  const workspaceProjects = new Map<string, NavigationDirectorySummary>();
  const foldedProjects = new Map<string, NavigationDirectorySummary>();
  const caseProjects = new Map<string, NavigationDirectorySummary>();
  for (const directory of index.directories) {
    if (directory.checkoutPaths) {
      for (const key of directory.threadKeys) checkoutProjects.set(key, directory);
    }
    // The owner has already collapsed allowed scratch roots in Directories.
    if (directory.kind === "workspace") {
      for (const key of directory.threadKeys) workspaceProjects.set(key, directory);
    }
    for (const key of index.worktreeProjectAliases?.[directory.key] ?? []) foldedProjects.set(key, directory);
    const caseAliases = index.directoryCaseAliases?.[directory.key];
    if (caseAliases) {
      caseProjects.set(directory.key, directory);
      for (const key of caseAliases) caseProjects.set(key, directory);
    }
  }
  if (foldedProjects.size || caseProjects.size) {
    for (const thread of index.threads) {
      const primary = thread.linkedDirectories[0];
      if (!primary || thread.federation) continue;
      const project = (caseProjects.size ? caseProjects.get(classifyDirectory(primary).key) : undefined)
        ?? foldedProjects.get(`directory:${canonicalizeNavigationPath(primary.path)}`);
      if (project) checkoutProjects.set(buildThreadIdentityKey(thread.source, thread.id), project);
    }
  }
  const maps = {
    threadsByIdentity: new Map(index.threads.map((thread) => [threadKey(thread), thread])),
    threadsByLegacyKey: buildThreadsByLegacyKey(index),
    parentCandidates: buildParentCandidates(index),
    repositories: repositoryIdentitiesByPath(index),
    checkoutProjects,
    workspaceProjects,
  };
  return { ...maps, ...(includeChildCounts ? buildChildCounts(index.threads, maps, onWork)
    : { childCountByParent: new Map<string, number>(), viewerChildCountByParent: new Map<string, number>() }) };
}

/** Code vocabulary only: a reason never carries a thread ID, title or path. */
export type NavigationAnchorMissingReason =
  | "not-indexed"
  | "other-owner"
  | "archived"
  | "directory-not-indexed"
  | "other-directory"
  | "child"
  | "pinned"
  | "unpinned"
  | "filtered"
  | "ref-mismatch";

/**
 * Why an anchor is absent from the query it was resolved against, judged by
 * the same index and membership rules the projection used. `ref-mismatch`
 * means the row passes every directory membership rule and still did not
 * match: an identity disagreement between viewer and owner, not a change.
 */
export function explainMissingNavigationAnchor(params: {
  index: NavigationQueryIndex;
  request: NavigationQueryRequest;
}): NavigationAnchorMissingReason {
  const { anchor, query } = params.request;
  if (anchor?.kind !== "thread") {
    return anchor && !params.index.directories.some((directory) => directory.key === anchor.key)
      ? "directory-not-indexed" : "filtered";
  }
  const thread = params.index.threads.find((candidate) => threadKey(candidate) === identityKey(anchor.ref));
  if (!thread) {
    const sameId = params.index.threads.filter((candidate) => candidate.source === anchor.ref.backend && candidate.id === anchor.ref.threadId);
    // A local row named by this owner's own instance ID is one identity
    // spelled two ways, not a row that belongs to another owner.
    if (anchor.ref.ownerInstanceId && anchor.ref.ownerInstanceId === params.index.localInstanceId
      && sameId.some((candidate) => !navigationIdentity(candidate).ownerInstanceId)) return "ref-mismatch";
    return sameId.length ? "other-owner" : "not-indexed";
  }
  // Directory membership ignores archive state, so it names only filtered queries.
  if (query.kind !== "directory") return thread.archivedAt !== undefined ? "archived" : "filtered";
  const directory = params.index.directories.find((candidate) => candidate.key === query.directoryKey);
  if (!directory) return "directory-not-indexed";
  const threadsByLegacyKey = buildThreadsByLegacyKey(params.index);
  if (!directory.threadKeys.some((key) => threadsByLegacyKey.get(key) === thread)) return "other-directory";
  const parent = directoryParentResolver(directoryMemberThreads(directory, threadsByLegacyKey), buildParentCandidates(params.index))(thread);
  if (parent) {
    return query.disclosedParentThreadKeys?.includes(buildThreadIdentityKey(parent.backend, parent.threadId))
      ? "ref-mismatch" : "child";
  }
  if (query.roots === "unpinned" && thread.pinnedRank !== undefined) return "pinned";
  if (query.roots === "pinned" && thread.pinnedRank === undefined) return "unpinned";
  return "ref-mismatch";
}

function projectionMetadataDependencies(params: {
  index: NavigationQueryIndex;
  request: NavigationQueryRequest;
  selectedThreads: readonly NavigationThreadSummary[];
  countsThreads: readonly NavigationThreadSummary[];
  descriptor: NavigationDirectorySummary | undefined;
  threadsByLegacyKey: ReadonlyMap<string, NavigationThreadSummary>;
}): NavigationMetadataDependencies | undefined {
  const { index, request, selectedThreads, countsThreads, descriptor, threadsByLegacyKey } = params;
  const { kind } = request.query;
  if (index.coverage?.state !== "complete") return undefined;
  const viewer = request.inventory === "viewer";
  const ownerSidebar = !viewer && request.consumer === "main-sidebar";
  if (kind !== "directory" && kind !== "exact" && kind !== "children"
    && !(viewer && kind === "directory-index")) return undefined;
  if (!viewer && !ownerSidebar) return undefined;

  // Count dependencies include off-page members and selection descriptors.
  // Working-state chips only depend on rows this query can actually return.
  const descriptorDirectories = kind === "directory-index" ? index.directories : descriptor ? [descriptor] : [];
  const dependencies = new Set([...selectedThreads, ...countsThreads,
    ...descriptorDirectories.flatMap((directory) => directoryMemberThreads(directory, threadsByLegacyKey))]);
  const threadKeys = new Set<string>();
  const prKeys = new Set<string>();
  const workingStatePaths = new Set<string>();
  for (const thread of dependencies) {
    const ref = navigationIdentity(thread);
    threadKeys.add(JSON.stringify([ref.ownerInstanceId ?? null, ref.backend, ref.threadId]));
  }
  // Count descriptors do not display PRs, and peer previews cannot prove
  // raw attachment absence. Only local viewer proofs can name raw keys.
  const prKeysComplete = selectedThreads.every((thread) => !thread.federation && (viewer || !thread.prs?.length));
  if (viewer && prKeysComplete) {
    for (const thread of selectedThreads) for (const pr of thread.prs ?? []) prKeys.add(buildPullRequestStatusKey(pr));
  }
  if (ownerSidebar) for (const thread of selectedThreads) {
    const path = navigationWorkingStatePath(thread);
    if (path) workingStatePaths.add(path);
  }
  return readNavigationMetadataDependencies({ version: 1, threadKeys: [...threadKeys].sort(), prKeys: [...prKeys].sort(),
    ...(prKeysComplete ? { prKeysComplete: true } : {}),
    ...(ownerSidebar ? { workingStatePaths: [...workingStatePaths].sort() } : {}) });
}

function collectionDirectoryGitProof(params: {
  selected: readonly NavigationThreadSummary[];
  descriptors: readonly NavigationDirectorySummary[];
  index: NavigationQueryIndex;
  projection: ProjectionIndex;
}): NavigationDirectoryGitProof | undefined {
  // Bound optional work as well as the wire representation. Large collections
  // keep ordinary invalidation. A truncated list can never exclude a write.
  const { selected, descriptors, index, projection } = params;
  if (selected.length > 512 || descriptors.length > DIRECTORY_GIT_PROOF_MAX_KEYS) return undefined;
  const dirs = new Map<NavigationDirectorySummary, "descriptor" | "repository">();
  const paths = new Set<string>();
  let remainingLinks = 512;
  for (const dir of descriptors) dirs.set(dir, "descriptor");
  for (const thread of selected) {
    if (thread.federation) continue;
    const checkout = checkoutProjectForThread(thread, projection.checkoutProjects);
    if (checkout && !dirs.has(checkout)) dirs.set(checkout, "repository");
    remainingLinks -= thread.linkedDirectories.length;
    if (dirs.size > DIRECTORY_GIT_PROOF_MAX_KEYS || remainingLinks < 0) return undefined;
    for (const link of thread.linkedDirectories) {
      const descriptor = classifyDirectory(link);
      if (descriptor.kind !== "directory") continue;
      paths.add(link.path);
      if (descriptor.path) paths.add(descriptor.path);
      if (paths.size > 64) return undefined;
    }
  }
  // Mirror both path lookups in withRepositoryIdentities, even for a
  // checkout whose first origin may be added after this page is served.
  if (paths.size) {
    if (index.directories.length > 512) return undefined;
    for (const dir of index.directories) {
      if (dir.path && paths.has(dir.path) && !dirs.has(dir)) dirs.set(dir, "repository");
      if (dirs.size > DIRECTORY_GIT_PROOF_MAX_KEYS) return undefined;
    }
  }
  const directories: Array<readonly [string, string]> = [];
  for (const [dir, part] of dirs) {
    if (!dir.key || dir.key.length > DIRECTORY_GIT_PROOF_MAX_KEY_LENGTH) return undefined;
    const revisions = navigationDirectoryGitRevisions(dir.gitStatus);
    if (!revisions) return undefined;
    directories.push(Object.freeze([dir.key, revisions[part]] as const));
    const source = index.worktreeRepositorySources?.[dir.key];
    if (source) {
      if (!source.repositoryRevision || source.key.length > DIRECTORY_GIT_PROOF_MAX_KEY_LENGTH) return undefined;
      directories.push(Object.freeze([source.key, source.repositoryRevision] as const));
    }
    if (directories.length > DIRECTORY_GIT_PROOF_MAX_KEYS) return undefined;
  }
  directories.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return Object.freeze({ version: 1, directories: Object.freeze(directories) });
}

export function projectNavigationQuery(params: {
  index: NavigationQueryIndex;
  request: NavigationQueryRequest;
  attentionOrder?: NavigationAttentionOrder;
  onIndexWork?: NavigationProjectionWork;
  deferPullRequests?: boolean;
  includeDirectoryGitProof?: boolean;
}): NavigationQueryMaterialization & { directoryGitProof?: NavigationDirectoryGitProof } {
  const query = params.request.query;
  const inventory = params.request.inventory ?? "owner";
  if (query.kind === "model-inventory") {
    const owned = params.index.threads.filter((thread) => isStarMapOwnerThread(thread)
      && (!params.request.backend || params.request.backend === "all" || params.request.backend === thread.source));
    return { coverage: params.index.coverage ?? { state: "complete" }, counts: countsForThreads(owned), directories: [], entries: [], modelGroups: buildModelInventory(owned), queryKey: navigationQueryKey(params.request) };
  }
  const snapshot = snapshots.get(params.index);
  const onWork = params.onIndexWork ?? snapshot?.onWork;
  const prepared = snapshot?.projection ?? buildProjectionIndex(params.index, onWork, false);
  const { threadsByIdentity, threadsByLegacyKey, parentCandidates, repositories, checkoutProjects, workspaceProjects } = prepared;
  const scopedDirectory = queryDirectory({ query, index: params.index, threadsByLegacyKey });
  const scopedMembers = scopedDirectory ? new Set(directoryMemberThreads(scopedDirectory, threadsByLegacyKey)) : undefined;
  const { childCountByParent, viewerChildCountByParent } = scopedMembers
    ? buildChildCounts(scopedMembers, prepared, onWork)
    : snapshot?.projection ?? buildChildCounts(params.index.threads, prepared, onWork);
  const lensRootOf = query.kind === "lens" && query.roots
    ? lensRootResolver({ threadsByIdentity, parentCandidates }) : undefined;
  const selectedThreads = selectQueryThreads({
    query,
    index: params.index,
    threadsByIdentity,
    threadsByLegacyKey,
    parentCandidates,
    checkoutProjects,
    workspaceProjects,
    lensRootOf,
  });
  if (((query.kind === "lens" && query.lens === "attention")
    || (query.kind === "star-map" && query.filters.attention === "include")) && params.attentionOrder) {
    const members = params.attentionOrder.members;
    selectedThreads.sort((left, right) => {
      if (query.kind === "star-map") {
        if ((left.pinnedRank !== undefined) !== (right.pinnedRank !== undefined)) return left.pinnedRank !== undefined ? -1 : 1;
        if (left.pinnedRank !== undefined && right.pinnedRank !== undefined) return comparePinnedThreads(left, right);
      }
      return (members.get(navigationAttentionIdentity(right))?.rank ?? 0)
        - (members.get(navigationAttentionIdentity(left))?.rank ?? 0);
    });
  }
  if (query.kind === "messaging-projects") {
    const eligibleKeys = new Set(selectedThreads.map(threadKey));
    const eligibleByLegacyKey = new Map([...threadsByLegacyKey].filter(([, thread]) => eligibleKeys.has(threadKey(thread))));
    let sourceDirectories = params.index.directories;
    if (query.scratchpadFirst) {
      const scratchpads = sourceDirectories.filter((directory) => directory.kind === "workspace")
        .sort((left, right) => (right.latestUpdatedAt ?? 0) - (left.latestUpdatedAt ?? 0) || left.key.localeCompare(right.key));
      if (scratchpads.length > 1) {
        sourceDirectories = [{ ...scratchpads[0]!, threadKeys: [...new Set(scratchpads.flatMap((directory) => directory.threadKeys))] },
          ...sourceDirectories.filter((directory) => directory.kind !== "workspace")];
      }
    }
    const filter = query.filter?.trim().toLowerCase();
    const directories = buildDirectoryRows({ snapshot: { ...params.index, directories: sourceDirectories }, threadsByLegacyKey: eligibleByLegacyKey, parentCandidates })
      .filter((directory) => !filter || [directory.key, directory.label, directory.path,
        query.scratchpadFirst && directory.kind === "workspace" ? "Workspaces Scratchpad" : undefined]
        .some((value) => value?.toLowerCase().includes(filter)))
      .sort((left, right) => (query.scratchpadFirst ? Number(right.kind === "workspace") - Number(left.kind === "workspace") : 0)
        || (right.latestUpdatedAt ?? 0) - (left.latestUpdatedAt ?? 0) || left.label.localeCompare(right.label));
    return { coverage: params.index.coverage ?? { state: "complete" }, counts: countsForThreads(selectedThreads),
      collectionSize: directories.length, collectionKind: "directories", directories, entries: [], queryKey: navigationQueryKey(params.request) };
  }
  // Attention can include a child while excluding its idle/read parent. Base
  // placement on the current filtered membership, before pagination: such a
  // child needs its own row, but a qualifying parent on a later page must keep
  // its group. Incomplete provider discovery must not hide known active/unread
  // children while their missing or idle parents cannot render. A later index
  // can regroup them. Preserve the actual relationship in row metadata for actions.
  const attentionMemberKeys = query.kind === "lens" && query.lens === "attention"
    ? new Set(selectedThreads.map(threadKey)) : undefined;
  const directoryMembers = query.kind === "directory" || (query.kind === "exact" && query.ancestryScope === "directory")
    ? directoryMemberThreads(scopedDirectory, threadsByLegacyKey)
    : undefined;
  const directoryParentOf = directoryMembers ? directoryParentResolver(directoryMembers, parentCandidates) : undefined;
  const homeProjects = query.kind === "group-members"
    ? buildHomeProjects(params.index.directories, threadsByLegacyKey) : undefined;
  // Exact metadata batches can contain only some mounted siblings. Keep the
  // native parent's complete order as a scalar, without exporting its full
  // subthreadOrder collection or depending on viewer pin summaries.
  const siblingOrders = new Map<string, number>();
  if (inventory === "owner" && query.kind === "exact") {
    const parents = new Map<string, NavigationThreadSummary>();
    for (const thread of selectedThreads) {
      const parent = parentIdentity(thread, parentCandidates);
      if (navigationIdentity(thread).ownerInstanceId || !parent || parent.ownerInstanceId) continue;
      const parentThread = threadsByIdentity.get(identityKey(parent));
      if (parentThread) parents.set(identityKey(parent), parentThread);
    }
    const siblings = new Map<string, NavigationThreadSummary[]>();
    for (const thread of params.index.threads) {
      if (!isOrdinaryThread(thread) || navigationIdentity(thread).ownerInstanceId) continue;
      const parent = parentIdentity(thread, parentCandidates);
      const key = parent && identityKey(parent);
      if (!key || !parents.has(key)) continue;
      const children = siblings.get(key) ?? [];
      children.push(thread);
      siblings.set(key, children);
    }
    for (const [key, children] of siblings) {
      sortSubthreadSummaries(parents.get(key)!, children).forEach((thread, order) => siblingOrders.set(threadKey(thread), order));
    }
  }
  const pullRequestPositions: number[] = [];
  const membershipOnly = (query.kind === "group-members" && query.membershipOnly)
    || query.kind === "directory-index" || query.kind === "star-map-geometry";
  const entries = selectedThreads.map((thread, index): NavigationQueryEntry => {
    const defer = params.deferPullRequests && !thread.federation && Boolean(thread.prs?.length);
    if (defer && !membershipOnly) pullRequestPositions.push(index);
    const parent = parentIdentity(thread, parentCandidates);
    const placementParent = attentionMemberKeys && parent && !attentionMemberKeys.has(identityKey(parent))
      ? undefined
      : directoryParentOf ? directoryParentOf(thread)
      : query.kind === "exact" && query.includeAncestry
      ? availableParentIdentity(thread, parentCandidates, params.index.coverage) : parent;
    return {
      row: projectNavigationRow({
        childCount: childCountByParent.get(threadKey(thread)) ?? 0,
        ...(params.request.inventory === "viewer" && navigationIdentity(thread).ownerInstanceId
          ? { viewerChildCount: viewerChildCountByParent.get(threadKey(thread)) ?? 0 } : {}),
        needsInput: starMapSignals(thread, params.index).approval,
        repositories,
        thread: parent?.ownerInstanceId && !thread.parentThreadInstanceId
          ? { ...thread, parentThreadInstanceId: parent.ownerInstanceId } : thread,
        homeProject: homeProjects?.get(thread),
        checkoutProject: query.kind === "star-map"
          ? starMapProjectForThread(thread, prepared)
          : checkoutProjectForThread(thread, checkoutProjects),
        omitPullRequests: membershipOnly || defer,
      }),
      orderKey: rowOrderKey(index),
      ...(siblingOrders.has(threadKey(thread)) ? { siblingOrder: siblingOrders.get(threadKey(thread))! } : {}),
      ...(params.attentionOrder?.members.has(navigationAttentionIdentity(thread))
        ? { attentionRank: params.attentionOrder.members.get(navigationAttentionIdentity(thread))!.rank }
        : {}),
      placement: placementParent
        ? { kind: "child", parent: placementParent }
        : { kind: "root" },
    };
  });
  const includeDirectories = query.kind === "directory-index"
    || query.kind === "star-map-geometry";
  const countsThreads = query.kind === "directory"
    ? directoryMembers ?? []
    : query.kind === "star-map"
      ? (query.projectKey === undefined ? params.index.threads.filter(isStarMapOwnerThread) : selectedThreads)
      : query.kind === "exact"
      || query.kind === "search"
      || query.kind === "messaging-threads"
      || query.kind === "children"
      || query.kind === "group-members"
      // A split lens counts its own bucket: the Pinned group's collapsed
      // header reports running and unread work inside it alone.
      || (query.kind === "lens" && query.roots !== undefined)
      ? selectedThreads
      : params.index.threads;
  const exactDescriptor = query.kind === "exact" && selectedThreads.length
    ? params.index.directories.find((directory) => directory.threadKeys.some((key) => selectedThreads[0] === threadsByLegacyKey.get(key))) : undefined;
  const descriptor = query.kind === "exact" ? exactDescriptor : scopedDirectory;
  const indexedDirectories = query.kind === "directory-index" ? selectIndexedDirectories(params.index, query) : undefined;
  // A mixed viewer can place remote pins using local project metadata. Its
  // authored row set alone cannot exclude a change to that placement.
  const directoryGitProof = params.includeDirectoryGitProof && snapshot && params.index.coverage?.state === "complete"
    && params.request.consumer === "main-sidebar"
    && (inventory === "owner" || (snapshot.rowOwners?.length === 0
      && !(query.kind === "exact" && query.resolveFromOwners)))
    && (query.kind === "directory" || query.kind === "children" || query.kind === "exact" || query.kind === "lens"
      || (inventory === "owner" && query.kind === "group-members") || indexedDirectories)
    ? collectionDirectoryGitProof({ selected: indexedDirectories ? [] : selectedThreads,
        descriptors: indexedDirectories ?? (descriptor ? [descriptor] : []), index: params.index, projection: prepared })
    : undefined;
  const metadataDependencies = projectionMetadataDependencies({ index: params.index, request: params.request,
    selectedThreads, countsThreads, descriptor, threadsByLegacyKey });
  return {
    coverage: params.index.coverage ?? { state: "complete" },
    ...(metadataDependencies ? { metadataDependencies } : {}),
    ...(directoryGitProof ? { directoryGitProof } : {}),
    // Both pages count every owner thread, so both can say which providers
    // the owner uses. Provider chips hide while that is a single provider.
    counts: countsForThreads(countsThreads, {
      backends: query.kind === "directory-index"
        || (query.kind === "star-map" && query.projectKey === undefined),
    }),
    ...(descriptor ? { selectionDirectory: buildDirectoryRows({ snapshot: { ...params.index, directories: [descriptor] },
      threadsByLegacyKey, parentCandidates })[0] } : {}),
    // The split's acknowledgment as well as its size: an owner that predates
    // `roots` sets no collection size on a lens page, so the viewer knows to
    // filter that page itself.
    ...(lensRootOf ? { collectionSize: selectedThreads.filter((thread) => lensRootOf(thread) === thread).length } : {}),
    ...(query.kind === "messaging-threads" ? { collectionSize: entries.length } : {}),
    ...(query.kind === "star-map" ? {
      facets: countNavigationStarMapFacets(
        [...new Map(params.index.threads.filter(isStarMapOwnerThread).map((thread) => [threadKey(thread), thread])).values()]
          .map((thread) => starMapSignals(thread, params.index)),
        query.filters,
      ),
    } : {}),
    ...(includeDirectories ? { collectionKind: "directories" as const } : {}),
    ...(query.kind === "directory-index" && query.match === "mention" ? { directoryMatch: "mention" as const } : {}),
    directories: query.kind === "star-map-geometry" ? buildProjectGeometry(params.index, prepared)
      : indexedDirectories ? buildDirectoryRows({
        snapshot: { ...params.index, directories: indexedDirectories },
        threadsByLegacyKey,
        parentCandidates,
      }) : [],
    entries,
    ...(pullRequestPositions.length ? { pullRequestPositions } : {}),
    queryKey: navigationQueryKey(params.request),
  };
}
