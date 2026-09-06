import { createHash } from "node:crypto";
import type {
  NavigationCounts,
  NavigationDirectorySummary,
  NavigationDirectoryRow,
  NavigationIdentity,
  NavigationQuery,
  NavigationQueryEntry,
  NavigationQueryRequest,
  NavigationRow,
  NavigationThreadSummary,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  NAVIGATION_QUERY_MAX_PAGE_ROWS,
} from "@pwragent/shared";
import {
  navigationAttentionIdentity,
  type NavigationAttentionOrder,
} from "./navigation-attention-order";

const MAX_ROW_NESTED_RECORDS = 16;

export type NavigationQueryMaterialization = {
  counts: NavigationCounts;
  directories: NavigationDirectoryRow[];
  entries: NavigationQueryEntry[];
  queryKey: string;
};

/** Complete compact owner inventory used to answer bounded queries. */
export type NavigationQueryIndex = {
  directories: NavigationDirectorySummary[];
  threads: NavigationThreadSummary[];
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
): NavigationIdentity | undefined {
  if (!thread.parentThreadId) {
    return undefined;
  }
  return {
    backend: thread.parentThreadBackend ?? thread.source,
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
  let unread = 0;
  let review = 0;
  for (const thread of distinct.values()) {
    const threadActive = isActive(thread);
    const threadUnread = thread.inbox.inInbox;
    if (threadActive) active += 1;
    if (threadUnread) unread += 1;
    if (threadUnread && !threadActive) review += 1;
  }
  return {
    total: distinct.size,
    active,
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
    };
  });
}

function normalizeQuery(query: NavigationQuery): NavigationQuery {
  if (query.kind === "lens") {
    return {
      ...query,
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
    consumer: request.consumer,
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
    const pinned = left.pinnedRank.localeCompare(right.pinnedRank);
    if (pinned !== 0) return pinned;
  }
  return compareCreated(left, right);
}

function selectQueryThreads(params: {
  query: NavigationQuery;
  index: NavigationQueryIndex;
  threadsByIdentity: Map<string, NavigationThreadSummary>;
  threadsByLegacyKey: Map<string, NavigationThreadSummary>;
}): NavigationThreadSummary[] {
  const ordinaryThreads = params.index.threads.filter(isOrdinaryThread);
  const query = params.query;
  if (query.kind === "directory-index" || query.kind === "star-map-geometry") {
    return [];
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
        const parent = parentIdentity(thread);
        return !parent
          || disclosedParents.has(buildThreadIdentityKey(parent.backend, parent.threadId));
      })
      .sort(compareDirectoryMembers);
  }
  if (query.kind === "search") {
    const text = query.text.trim().toLowerCase();
    if (!text) return [];
    return ordinaryThreads
      .filter((thread) => thread.title.toLowerCase().includes(text)
        || thread.linkedDirectories.some((directory) =>
          directory.path.toLowerCase().includes(text)))
      .sort(compareUpdated);
  }

  const selected = new Map<string, NavigationThreadSummary>();
  const addWithAncestry = (thread: NavigationThreadSummary): void => {
    const key = threadKey(thread);
    if (selected.has(key)) return;
    const parent = parentIdentity(thread);
    if (query.includeAncestry && parent) {
      const parentThread = params.threadsByIdentity.get(identityKey(parent));
      if (parentThread) addWithAncestry(parentThread);
    }
    selected.set(key, thread);
  };
  for (const identity of query.identities.slice(0, NAVIGATION_QUERY_MAX_PAGE_ROWS)) {
    const thread = params.threadsByIdentity.get(identityKey(identity));
    if (thread) addWithAncestry(thread);
  }
  return [...selected.values()];
}

export function projectNavigationQuery(params: {
  index: NavigationQueryIndex;
  request: NavigationQueryRequest;
  attentionOrder?: NavigationAttentionOrder;
}): NavigationQueryMaterialization {
  const query = params.request.query;
  const threadsByIdentity = new Map(
    params.index.threads.map((thread) => [threadKey(thread), thread]),
  );
  const threadsByLegacyKey = new Map(
    params.index.threads.map((thread) => [
      buildThreadIdentityKey(thread.source, thread.id),
      thread,
    ]),
  );
  const childCountByParent = new Map<string, number>();
  for (const thread of params.index.threads) {
    const parent = parentIdentity(thread);
    if (!parent || !isOrdinaryThread(thread)) continue;
    const key = identityKey(parent);
    childCountByParent.set(key, (childCountByParent.get(key) ?? 0) + 1);
  }
  const selectedThreads = selectQueryThreads({
    query,
    index: params.index,
    threadsByIdentity,
    threadsByLegacyKey,
  });
  if (query.kind === "lens" && query.lens === "attention" && params.attentionOrder) {
    const members = params.attentionOrder.members;
    selectedThreads.sort((left, right) =>
      (members.get(navigationAttentionIdentity(right))?.rank ?? 0)
      - (members.get(navigationAttentionIdentity(left))?.rank ?? 0));
  }
  const entries = selectedThreads.map((thread, index): NavigationQueryEntry => {
    const parent = parentIdentity(thread);
    return {
      row: projectNavigationRow({
        childCount: childCountByParent.get(threadKey(thread)) ?? 0,
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
    : query.kind === "exact"
      || query.kind === "search"
      ? selectedThreads
      : params.index.threads;
  return {
    counts: countsForThreads(countsThreads),
    directories: includeDirectories
      ? buildDirectoryRows({ snapshot: params.index, threadsByLegacyKey })
      : [],
    entries,
    queryKey: navigationQueryKey(params.request),
  };
}
