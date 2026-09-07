import { sortSubthreadSummaries } from "@pwragent/shared";
import { createHash } from "node:crypto";
import type {
  NavigationCounts,
  NavigationStarMapFacetCounts,
  NavigationStarMapSignals,
  NavigationDirectorySummary,
  NavigationDirectoryRow,
  NavigationIdentity,
  NavigationQuery,
  NavigationQueryCoverage,
  NavigationQueryEntry,
  NavigationModelInventoryRow,
  NavigationQueryRequest,
  NavigationRow,
  NavigationThreadSummary,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  federatedThreadIdentityKey,
  comparePinnedThreads,
  classifyDirectory,
  countNavigationStarMapFacets,
  passesNavigationStarMapFilters,
  NAVIGATION_QUERY_MAX_PAGE_ROWS,
  rankThreadJumpMatches,
} from "@pwragent/shared";
import {
  navigationAttentionIdentity,
  type NavigationAttentionOrder,
} from "./navigation-attention-order";

const MAX_ROW_NESTED_RECORDS = 16;

export type NavigationQueryMaterialization = {
  coverage: NavigationQueryCoverage;
  counts: NavigationCounts;
  facets?: NavigationStarMapFacetCounts;
  directories: NavigationDirectoryRow[];
  entries: NavigationQueryEntry[];
  modelGroups?: NavigationModelInventoryRow[];
  queryKey: string;
};

/** Complete compact owner inventory used to answer bounded queries. */
export type NavigationQueryIndex = {
  coverage?: NavigationQueryCoverage;
  directories: NavigationDirectorySummary[];
  threads: NavigationThreadSummary[];
  inputRequestThreadKeys?: ReadonlySet<string>;
};

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
  const ownerInstanceId = thread.parentThreadInstanceId
    ?? (thread.federation?.ref.target.scope === "remote" ? thread.federation.ref.target.instanceId : undefined);
  const candidates = candidatesByOwner.get(JSON.stringify([ownerInstanceId ?? null, thread.parentThreadId])) ?? [];
  // Older overlays omitted the backend. Resolve only against complete owner
  // membership; an absent or ambiguous parent remains an unresolved child.
  const parent = !thread.parentThreadBackend
    ? candidates.find((candidate) => candidate.source === thread.source) ?? (candidates.length === 1 ? candidates[0] : undefined)
    : undefined;
  return {
    backend: thread.parentThreadBackend ?? parent?.source ?? thread.source,
    threadId: thread.parentThreadId,
    ...(thread.parentThreadInstanceId
      ? { ownerInstanceId: thread.parentThreadInstanceId }
      : thread.federation?.ref.target.scope === "remote"
        ? { ownerInstanceId: thread.federation.ref.target.instanceId }
        : {}),
  };
}

function isOrdinaryThread(thread: NavigationThreadSummary): boolean {
  return thread.codexNativeSubAgent === undefined;
}

function isActive(thread: NavigationThreadSummary): boolean {
  return thread.threadStatus === "active";
}

function countsForThreads(threads: readonly NavigationThreadSummary[]): NavigationCounts {
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
  return {
    total: distinct.size,
    active,
    ...(activeRemote ? { activeRemote } : {}),
    ...(pinned ? { pinned } : {}),
    unread,
    review,
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

function projectNavigationRow(params: {
  childCount: number;
  needsInput: boolean;
  thread: NavigationThreadSummary;
}): NavigationRow {
  const { thread } = params;
  const linkedDirectories = limitRecords(thread.linkedDirectories);
  const reactions = limitRecords(thread.reactions);
  const prs = limitRecords(thread.prs);
  const messagingBindings = limitRecords(thread.messagingBindings);
  const nativeSubAgentCount = thread.codexNativeSubAgents?.length ?? 0;
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
    inbox: thread.inbox,
    ...(thread.projectKey ? { projectKey: thread.projectKey } : {}),
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
    nativeSubAgentGroupPresent: nativeSubAgentCount > 0,
    ...(nativeSubAgentCount > 0 ? { nativeSubAgentCount } : {}),
    ...(thread.subthreadsCollapsed !== undefined
      ? { subthreadsCollapsed: thread.subthreadsCollapsed }
      : {}),
    ...(reactions.items ? { reactions: reactions.items } : {}),
    ...(reactions.truncated ? { reactionsTruncated: true } : {}),
    ...(prs.items ? { prs: prs.items } : {}),
    ...(prs.truncated ? { prsTruncated: true } : {}),
    ...(messagingBindings.items
      ? { messagingBindings: messagingBindings.items }
      : {}),
    ...(messagingBindings.truncated
      ? { messagingBindingsTruncated: true }
      : {}),
    ...(thread.automationSummary
      ? { automationSummary: thread.automationSummary }
      : {}),
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
    ...(thread.scheduledStart ? { scheduledStart: thread.scheduledStart } : {}),
  };
  return {
    ...projected,
    rowRevision: hashValue(projected),
  };
}

function projectDirectoryGitStatus(
  directory: NavigationDirectorySummary,
): NavigationDirectoryRow["gitStatus"] {
  const status = directory.gitStatus;
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

function buildDirectoryRows(params: {
  snapshot: NavigationQueryIndex;
  threadsByLegacyKey: Map<string, NavigationThreadSummary>;
}): NavigationDirectoryRow[] {
  return params.snapshot.directories.map((directory) => {
    const memberThreads = directory.threadKeys
      .map((key) => params.threadsByLegacyKey.get(key))
      .filter((thread): thread is NavigationThreadSummary => Boolean(thread));
    const rootThreads = memberThreads.filter((thread) => !thread.parentThreadId);
    const pinnedRootCount = rootThreads.filter((thread) => thread.pinnedRank).length;
    const gitStatus = projectDirectoryGitStatus(directory);
    return {
      key: directory.key,
      kind: directory.kind,
      label: directory.label,
      ...(directory.path ? { path: directory.path } : {}),
      ...(directory.localAvailability
        ? { localAvailability: directory.localAvailability }
        : {}),
      counts: countsForThreads(memberThreads),
      pinnedRootCount,
      unpinnedRootCount: rootThreads.length - pinnedRootCount,
      ...(directory.latestUpdatedAt !== undefined
        ? { latestUpdatedAt: directory.latestUpdatedAt }
        : {}),
      ...(directory.pinnedRank ? { pinnedRank: directory.pinnedRank } : {}),
      ...(directory.directoryThreadsCollapsed !== undefined
        ? { directoryThreadsCollapsed: directory.directoryThreadsCollapsed }
        : {}),
      ...(gitStatus ? { gitStatus } : {}),
      launchpadPresent: Boolean(directory.launchpad),
      ...(directory.launchpad?.backend ? { launchpadBackend: directory.launchpad.backend } : {}),
    };
  });
}

/** Project geometry counts primary membership once, independent of loaded cards. */
function buildProjectGeometry(index: NavigationQueryIndex): NavigationDirectoryRow[] {
  const projects = new Map<string, NavigationDirectoryRow>();
  const launchpads = new Set(index.directories.filter((directory) => directory.launchpad).map((directory) => directory.key));
  const seen = new Set<string>();
  for (const thread of index.threads) {
    if (!isStarMapOwnerThread(thread) || seen.has(threadKey(thread))) continue;
    seen.add(threadKey(thread));
    const primary = thread.linkedDirectories[0];
    const descriptor = primary ? classifyDirectory(primary) : undefined;
    const key = descriptor?.key ?? "__no-project__";
    let project = projects.get(key);
    if (!project) {
      const segments = (descriptor?.path ?? primary?.path)?.split(/[\\/]/).filter(Boolean);
      project = {
        key,
        kind: descriptor?.kind ?? "unlinked",
        label: descriptor ? (descriptor.label !== primary?.label ? descriptor.label : segments?.at(-1) ?? descriptor.label) : "No project",
        path: descriptor?.path,
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
  return [...projects.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function normalizeQuery(query: NavigationQuery): NavigationQuery {
  if (query.kind === "star-map") {
    return { kind: "star-map", filters: Object.fromEntries(Object.entries(query.filters)
      .filter(([, value]) => value !== "neutral").sort(([left], [right]) => left.localeCompare(right))) };
  }
  if (query.kind === "lens" || query.kind === "directory-index") {
    return {
      ...query,
      ...(query.kind === "directory-index" && query.keys ? { keys: [...new Set(query.keys)].sort() } : {}),
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
}): NavigationThreadSummary[] {
  const ordinaryThreads = params.index.threads.filter(isOrdinaryThread);
  const query = params.query;
  if (query.kind === "directory-index" || query.kind === "star-map-geometry" || query.kind === "model-inventory") {
    return [];
  }
  if (query.kind === "star-map") {
    return ordinaryThreads.filter(isStarMapOwnerThread)
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
    return ordinaryThreads
      .filter((thread) => {
        if (query.lens === "attention") {
          if (!isActive(thread) && !thread.inbox.inInbox) return false;
        }
        if (!filter) return true;
        return thread.title.toLowerCase().includes(filter)
          || thread.linkedDirectories.some((directory) =>
            directory.path.toLowerCase().includes(filter));
      })
      .sort(query.lens === "recents" ? compareCreated : compareUpdated);
  }
  if (query.kind === "directory") {
    const directory = params.index.directories.find(
      (candidate) => candidate.key === query.directoryKey,
    );
    if (!directory) return [];
    const disclosedParents = new Set(query.disclosedParentThreadKeys ?? []);
    return directory.threadKeys
      .map((key) => params.threadsByLegacyKey.get(key))
      .filter((thread): thread is NavigationThreadSummary => Boolean(thread))
      .filter((thread) => {
        const parent = parentIdentity(thread, params.parentCandidates);
        if (parent) return disclosedParents.has(buildThreadIdentityKey(parent.backend, parent.threadId));
        return query.roots === "pinned" ? thread.pinnedRank !== undefined
          : query.roots === "unpinned" ? thread.pinnedRank === undefined : true;
      })
      .sort(compareDirectoryMembers);
  }
  if (query.kind === "children") {
    const parentThread = params.threadsByIdentity.get(identityKey(query.parent));
    const children = ordinaryThreads.filter((thread) => {
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
  const addWithAncestry = (thread: NavigationThreadSummary): void => {
    const key = threadKey(thread);
    if (selected.has(key) || visiting.has(key)) return;
    visiting.add(key);
    const parent = parentIdentity(thread, params.parentCandidates);
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
    if (thread.fastMode === true) group.fastThreadCount += 1;
    groups.set(key, group);
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([, group]) => group);
}

export function projectNavigationQuery(params: {
  index: NavigationQueryIndex;
  request: NavigationQueryRequest;
  attentionOrder?: NavigationAttentionOrder;
}): NavigationQueryMaterialization {
  const query = params.request.query;
  if (query.kind === "model-inventory") {
    const owned = params.index.threads.filter((thread) => isStarMapOwnerThread(thread)
      && (!params.request.backend || params.request.backend === "all" || params.request.backend === thread.source));
    return { coverage: params.index.coverage ?? { state: "complete" }, counts: countsForThreads(owned), directories: [], entries: [], modelGroups: buildModelInventory(owned), queryKey: navigationQueryKey(params.request) };
  }
  const threadsByIdentity = new Map(
    params.index.threads.map((thread) => [threadKey(thread), thread]),
  );
  const threadsByLegacyKey = new Map(
    params.index.threads.map((thread) => [
      thread.federation?.ref.target.scope === "remote" ? federatedThreadIdentityKey(thread.federation.ref) : buildThreadIdentityKey(thread.source, thread.id),
      thread,
    ]),
  );
  const parentCandidates = new Map<string, NavigationThreadSummary[]>();
  for (const thread of params.index.threads) {
    const ref = navigationIdentity(thread);
    const key = JSON.stringify([ref.ownerInstanceId ?? null, ref.threadId]);
    const candidates = parentCandidates.get(key) ?? [];
    candidates.push(thread);
    parentCandidates.set(key, candidates);
  }
  const childCountByParent = new Map<string, number>();
  for (const thread of params.index.threads) {
    const parent = parentIdentity(thread, parentCandidates);
    if (!parent || !isOrdinaryThread(thread)) continue;
    const key = identityKey(parent);
    childCountByParent.set(key, (childCountByParent.get(key) ?? 0) + 1);
  }
  const selectedThreads = selectQueryThreads({
    query,
    index: params.index,
    threadsByIdentity,
    threadsByLegacyKey,
    parentCandidates,
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
  const entries = selectedThreads.map((thread, index): NavigationQueryEntry => {
    const parent = parentIdentity(thread, parentCandidates);
    return {
      row: projectNavigationRow({
        childCount: childCountByParent.get(threadKey(thread)) ?? 0,
        needsInput: starMapSignals(thread, params.index).approval,
        thread,
      }),
      orderKey: rowOrderKey(index),
      ...(params.attentionOrder?.members.has(navigationAttentionIdentity(thread))
        ? { attentionRank: params.attentionOrder.members.get(navigationAttentionIdentity(thread))!.rank }
        : {}),
      placement: parent
        ? { kind: "child", parent }
        : { kind: "root" },
    };
  });
  const includeDirectories = query.kind === "directory-index"
    || query.kind === "star-map-geometry";
  const countsThreads = query.kind === "directory"
    ? params.index.directories
        .find((directory) => directory.key === query.directoryKey)
        ?.threadKeys
        .map((key) => threadsByLegacyKey.get(key))
        .filter((thread): thread is NavigationThreadSummary => Boolean(thread))
      ?? []
    : query.kind === "star-map"
      ? params.index.threads.filter(isStarMapOwnerThread)
      : query.kind === "exact"
      || query.kind === "search"
      || query.kind === "children"
      ? selectedThreads
      : params.index.threads;
  return {
    coverage: params.index.coverage ?? { state: "complete" },
    counts: countsForThreads(countsThreads),
    ...(query.kind === "star-map" ? {
      facets: countNavigationStarMapFacets(
        [...new Map(params.index.threads.filter(isStarMapOwnerThread).map((thread) => [threadKey(thread), thread])).values()]
          .map((thread) => starMapSignals(thread, params.index)),
        query.filters,
      ),
    } : {}),
    directories: includeDirectories
      ? (query.kind === "star-map-geometry" ? buildProjectGeometry(params.index)
        : buildDirectoryRows({ snapshot: params.index, threadsByLegacyKey }))
          .filter((directory) => query.kind !== "directory-index" || !query.keys || query.keys.includes(directory.key))
          .filter((directory) => query.kind !== "directory-index"
            || !query.filter?.trim()
            || `${directory.label}\n${directory.path ?? ""}`.toLowerCase()
              .includes(query.filter.trim().toLowerCase()))
      : [],
    entries,
    queryKey: navigationQueryKey(params.request),
  };
}
