import { threadSummaryIdentityKey } from "../lib/federated-thread-events";
import { navigationThreadSelectionKey } from "../lib/navigation-query-state";
import {
  classifyDirectory,
  rankThreadJumpMatches,
  type NavigationDirectorySummary,
  type NavigationQueryPage,
  type NavigationQueryRequest,
  type NavigationThreadSummary,
  type NavigationRow,
} from "@pwragent/shared";

type FixtureDirectory = Pick<NavigationDirectorySummary, "key" | "kind" | "label" | "path" | "latestUpdatedAt" | "pinnedRank" | "directoryThreadsCollapsed" | "gitStatus" | "launchpad" | "localAvailability"> & {
  threadKeys?: string[];
};
const key = threadSummaryIdentityKey;
const parentKey = (thread: NavigationThreadSummary) => thread.parentThreadId
  ? navigationThreadSelectionKey({ backend: thread.parentThreadBackend ?? thread.source, threadId: thread.parentThreadId,
      ownerInstanceId: thread.parentThreadInstanceId ?? (thread.federation?.ref.target.scope === "remote" ? thread.federation.ref.target.instanceId : undefined) }) : undefined;
const counts = (threads: readonly NavigationThreadSummary[]) => ({ total: threads.length,
  ...(threads.some((thread) => thread.pinnedRank) ? { pinned: threads.filter((thread) => thread.pinnedRank).length } : {}),
  active: threads.filter((thread) => thread.threadStatus === "active").length,
  activeRemote: threads.filter((thread) => thread.threadStatus === "active" && thread.federation?.ref.target.scope === "remote").length,
  unread: threads.filter((thread) => thread.inbox.inInbox).length,
  review: threads.filter((thread) => thread.inbox.inInbox && thread.threadStatus !== "active").length });

/** Test-owned complete population projected into the same independently paged collections as the owner. */
export function navigationQueryFixture(
  request: NavigationQueryRequest,
  population: {
    directories?: readonly FixtureDirectory[];
    threads?: readonly NavigationThreadSummary[];
  },
): NavigationQueryPage {
  const query = request.query;
  const target = request.federationTarget;
  const hasMountedRows = population.threads?.some((thread) => thread.federation);
  let all: NavigationThreadSummary[] = [...population.threads ?? []].map((thread) => target?.scope === "remote" && !hasMountedRows
    ? { ...thread, federation: { ref: { backend: thread.source, threadId: thread.id, target }, instanceLabel: target.instanceId, peerStatus: "connected" } } : thread);
  if (query.kind === "group-members" && request.inventory !== "viewer") all = all.filter((thread) =>
    (thread.federation?.ref.target.scope === "remote" ? thread.federation.ref.target.instanceId : undefined)
      === (target?.scope === "remote" ? target.instanceId : undefined));
  const byKey = new Map(all.map((thread) => [key(thread), thread]));
  const resolveParentKey = (thread: NavigationThreadSummary) => {
    const declared = parentKey(thread);
    if (!declared || thread.parentThreadBackend || byKey.has(declared)) return declared;
    const owner = thread.parentThreadInstanceId ?? (thread.federation?.ref.target.scope === "remote" ? thread.federation.ref.target.instanceId : undefined);
    const candidates = all.filter((candidate) => candidate.id === thread.parentThreadId
      && (candidate.federation?.ref.target.scope === "remote" ? candidate.federation.ref.target.instanceId : undefined) === owner);
    return candidates.length === 1 ? key(candidates[0]!) : declared;
  };
  const inDirectory = (directory: FixtureDirectory) => all.filter((thread) =>
    directory.threadKeys?.includes(key(thread)) || thread.linkedDirectories.some((linked) => classifyDirectory(linked).key === directory.key));
  let threads = all;
  if (query.kind === "group-members") {
    threads = [];
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      for (const child of all.filter((thread) => !thread.codexNativeSubAgent && resolveParentKey(thread) === id)) visit(key(child));
      const root = byKey.get(id);
      if (root && !root.codexNativeSubAgent) threads.push(root);
    };
    for (const root of query.roots) visit(navigationThreadSelectionKey(root));
  }
  if (query.kind === "search") threads = rankThreadJumpMatches(all, query.text);
  if (query.kind === "lens") {
    if (query.lens === "attention") threads = all.filter((thread) => thread.threadStatus === "active" || thread.inbox.inInbox);
    else threads = [...all].sort((left, right) => query.lens === "recents"
      ? (right.createdAt ?? 0) - (left.createdAt ?? 0) : (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  }
  if (query.kind === "directory") {
    const directory = population.directories?.find((directory) => directory.key === query.directoryKey);
    const members = directory ? inDirectory(directory) : [];
    const memberKeys = new Set(members.map(key));
    threads = members.filter((thread) => !resolveParentKey(thread) || !memberKeys.has(resolveParentKey(thread)!))
      .filter((thread) => query.roots === "pinned" ? Boolean(thread.pinnedRank) : query.roots === "unpinned" ? !thread.pinnedRank : true)
      .sort((left, right) => left.pinnedRank && right.pinnedRank ? Number(left.pinnedRank) - Number(right.pinnedRank)
        : Number(Boolean(right.pinnedRank)) - Number(Boolean(left.pinnedRank)) || (right.createdAt ?? 0) - (left.createdAt ?? 0));
  }
  if (query.kind === "children") threads = all.filter((thread) => resolveParentKey(thread) === navigationThreadSelectionKey(query.parent));
  if (query.kind === "exact") {
    const selected = new Map<string, NavigationThreadSummary>();
    const add = (thread: NavigationThreadSummary): void => {
      if (selected.has(key(thread))) return;
      selected.set(key(thread), thread);
      const parent = byKey.get(resolveParentKey(thread) ?? "");
      if (query.includeAncestry && parent) add(parent);
    };
    for (const ref of query.identities) {
      const thread = byKey.get(navigationThreadSelectionKey(ref));
      if (thread) add(thread);
    }
    threads = [...selected.values()];
  }
  const descriptors = (population.directories ?? [])
    .filter((directory) => query.kind !== "directory-index" || ((!query.keys || query.keys.includes(directory.key))
      && (!query.filter || `${directory.label}\n${directory.path ?? ""}`.toLowerCase().includes(query.filter.toLowerCase()))))
    .map((directory) => {
      const members = inDirectory(directory);
      const memberKeys = new Set(members.map(key));
      const roots = members.filter((thread) => !resolveParentKey(thread) || !memberKeys.has(resolveParentKey(thread)!));
      return { key: directory.key, kind: directory.kind, label: directory.label, path: directory.path,
        pinnedRank: directory.pinnedRank, directoryThreadsCollapsed: directory.directoryThreadsCollapsed, localAvailability: directory.localAvailability,
        gitStatus: directory.gitStatus, latestUpdatedAt: directory.latestUpdatedAt, counts: counts(members),
        pinnedRootCount: roots.filter((thread) => thread.pinnedRank).length,
        unpinnedRootCount: roots.filter((thread) => !thread.pinnedRank).length,
        launchpadPresent: Boolean(directory.launchpad), launchpadBackend: directory.launchpad?.backend };
    });
  const size = request.pageSize ?? 100;
  const anchor = request.anchor;
  const offset = anchor ? anchor.kind === "directory"
    ? descriptors.findIndex((directory) => directory.key === anchor.key)
    : threads.findIndex((thread) => key(thread) === navigationThreadSelectionKey(anchor.ref))
    : Number(request.cursor ?? 0);
  if (offset < 0) throw new Error("Navigation anchor is no longer in this query.");
  const total = query.kind === "directory-index" ? descriptors.length : threads.length;
  const next = offset + size < total ? String(offset + size) : undefined;
  return {
    ...(offset ? { rangeStart: offset } : {}),
    protocol: 2, queryKey: JSON.stringify(query), generation: "fixture", ownerEpoch: "fixture", countsRevision: "fixture",
    coverage: { state: "complete" }, counts: counts(query.kind === "directory-index" ? all : threads), complete: !next, nextCursor: next,
    directories: query.kind === "directory-index" ? descriptors.slice(offset, offset + size) : [],
    entries: query.kind === "directory-index" ? [] : threads.slice(offset, offset + size).map((thread, index) => {
      const owner = thread.federation?.ref.target;
      const row: NavigationRow = {
        ref: { backend: thread.source, threadId: thread.id, ownerInstanceId: owner?.scope === "remote" ? owner.instanceId : undefined },
        rowRevision: "fixture", id: thread.id, source: thread.source, title: thread.title, titleSource: thread.titleSource,
        createdAt: thread.createdAt, updatedAt: thread.updatedAt, threadStatus: thread.threadStatus,
        linkedDirectories: thread.linkedDirectories, inbox: thread.inbox, prs: thread.prs, gitBranch: thread.gitBranch,
        gitWorkingState: thread.gitWorkingState, gitWorkingStateFetchedAt: thread.gitWorkingStateFetchedAt,
        federation: thread.federation, pinnedRank: thread.pinnedRank, parentThreadId: thread.parentThreadId,
        parentThreadBackend: thread.parentThreadBackend, parentThreadInstanceId: thread.parentThreadInstanceId,
        subthreadsCollapsed: thread.subthreadsCollapsed, reactions: thread.reactions, model: thread.model,
        executionMode: thread.executionMode, serviceTier: thread.serviceTier, reasoningEffort: thread.reasoningEffort,
        fastMode: thread.fastMode, ordinaryChildCount: all.filter((child) => resolveParentKey(child) === key(thread)).length,
        nativeSubAgentGroupPresent: Boolean(thread.codexNativeSubAgents?.length), nativeSubAgentCount: thread.codexNativeSubAgents?.length,
        queueCount: 0, queueState: "unknown",
      };
      const resolvedParent = byKey.get(resolveParentKey(thread) ?? "");
      return { row, orderKey: String(offset + index), placement: thread.parentThreadId
        ? { kind: "child", parent: { backend: thread.parentThreadBackend ?? resolvedParent?.source ?? thread.source, threadId: thread.parentThreadId,
            ownerInstanceId: thread.parentThreadInstanceId ?? row.ref.ownerInstanceId } }
        : { kind: "root" } };
    }),
  };
}
