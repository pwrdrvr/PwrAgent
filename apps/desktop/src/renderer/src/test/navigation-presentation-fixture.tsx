import { useMemo, useRef, useState, type ComponentProps } from "react";
import { classifyDirectory, type NavigationDirectorySummary, type NavigationQueryRequest, type NavigationThreadSummary } from "@pwragent/shared";
import { Sidebar } from "../features/navigation/Sidebar";
import { DirectoriesList } from "../features/navigation/DirectoriesList";
import { createAttentionOrderState, reconcileAttentionOrder } from "../features/navigation/attention-order";
import { createNavigationPageState, navigationIdentityKey } from "../lib/navigation-query-state";
import { threadSummaryIdentityKey } from "../lib/federated-thread-events";
import type { NavigationWindowResource } from "../lib/navigation-window-queries";
import { navigationQueryFixture } from "./navigation-query-fixture";

type FixtureProps = {
  browseMode?: "attention" | "drafts" | "inbox" | "recents" | "directories";
  directories: ComponentProps<typeof Sidebar>["directories"];
  threads: NavigationThreadSummary[];
  selectedItemKey?: string;
  thinkingThreadKeys?: Record<string, boolean>;
  attentionPromoteOnTurnEnd?: boolean;
  draftThreadKeys?: Record<string, boolean>;
};

/** Whole test populations play the owner; the components receive distinct pages and descriptors. */
function usePresentationOwner(props: FixtureProps) {
  const [limits, setLimits] = useState<Record<string, number>>({});
  const order = useRef(createAttentionOrderState());
  const ownerThreads = props.threads.map((thread) => props.thinkingThreadKeys?.[threadSummaryIdentityKey(thread)]
    ? { ...thread, threadStatus: "active" as const } : thread);
  const attention = reconcileAttentionOrder({ previous: order.current,
    threads: ownerThreads.filter((thread) => thread.threadStatus === "active" || thread.inbox.inInbox)
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)),
    promoteOnTurnEnd: props.attentionPromoteOnTurnEnd ?? true });
  order.current = attention.state;
  const selectedThreadDirectoryKeys = props.directories.filter((directory) => {
    const membership = (directory as NavigationDirectorySummary).threadKeys;
    return membership ? membership.includes(props.selectedItemKey ?? "")
      : ownerThreads.find((thread) => threadSummaryIdentityKey(thread) === props.selectedItemKey)?.linkedDirectories.some((linked) => classifyDirectory(linked).key === directory.key);
  }).map((directory) => directory.key);
  const selectedThread = ownerThreads.find((thread) => threadSummaryIdentityKey(thread) === props.selectedItemKey);
  const resources = new Map<string, NavigationWindowResource>();
  const add = (id: string, query: NavigationQueryRequest["query"], threads = ownerThreads) => {
    const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", query,
      pageSize: limits[id] ?? (query.kind === "directory-index" ? 100 : 10) };
    if (query.kind === "directory" && selectedThread && !selectedThread.parentThreadId
      && selectedThreadDirectoryKeys.includes(query.directoryKey)) {
      request.anchor = { kind: "thread", ref: { backend: selectedThread.source, threadId: selectedThread.id,
        ownerInstanceId: selectedThread.federation?.ref.target.scope === "remote" ? selectedThread.federation.ref.target.instanceId : undefined } };
    }
    const page = navigationQueryFixture(request, { directories: props.directories, threads });
    resources.set(id, { id, loading: false, state: { ...createNavigationPageState(request), page, stale: false } });
    return page;
  };
  const index = add("directory-index", { kind: "directory-index" });
  const mode = props.browseMode ?? "directories";
  if (mode === "drafts") add('drafts:"":0', { kind: "exact", identities: ownerThreads
    .filter((thread) => props.draftThreadKeys?.[threadSummaryIdentityKey(thread)])
    .map((thread) => ({ backend: thread.source, threadId: thread.id })), includeAncestry: true });
  else if (mode !== "directories") add("lens", { kind: "lens", lens: mode }, mode === "attention" ? attention.threads : ownerThreads);
  for (const directory of props.directories) add(`directory:${directory.key}`, { kind: "directory", directoryKey: directory.key,
    roots: directory.directoryThreadsCollapsed ? "pinned" : "all" });
  for (const thread of ownerThreads) {
    const parent = { backend: thread.source, threadId: thread.id,
      ownerInstanceId: thread.federation?.ref.target.scope === "remote" ? thread.federation.ref.target.instanceId : undefined };
    add(`children:${navigationIdentityKey(parent)}`, { kind: "children", parent });
  }
  const directories = (index.directories ?? []).map((descriptor) => ({ ...descriptor,
    launchpad: props.directories.find((directory) => directory.key === descriptor.key)?.launchpad }));
  const loadMore = async (id: string) => setLimits((current) => ({ ...current, [id]: (current[id] ?? 10) + 10 }));
  const navigation = { resources, directories: index.directories ?? [], selectedDirectoryKeys: undefined, connected: true,
    invalidate: () => undefined, refresh: async () => undefined, loadMore,
    rebaseline: async () => undefined, restart: async () => undefined, setVisibleAnchor: () => undefined };
  return { directories, navigation, selectedThreadDirectoryKeys };
}

export function FixtureSidebar(props: ComponentProps<typeof Sidebar>) {
  const owner = usePresentationOwner(props);
  const markDirectoriesSeen = useMemo(() => props.onMarkDirectoriesSeen ?? (props.onMarkThreadsSeen ? async (keys: string[]) => {
    const membership = new Set(props.directories.filter((directory) => keys.includes(directory.key))
      .flatMap((directory) => (directory as NavigationDirectorySummary).threadKeys ?? []));
    await props.onMarkThreadsSeen!(props.threads.filter((thread) => membership.has(threadSummaryIdentityKey(thread)) && thread.inbox.inInbox));
  } : undefined), [props.onMarkDirectoriesSeen, props.onMarkThreadsSeen, props.directories, props.threads]);
  return <Sidebar {...props} directories={owner.directories} pagedNavigation={props.pagedNavigation ?? owner.navigation}
    selectedThreadDirectoryKeys={owner.selectedThreadDirectoryKeys} onMarkDirectoriesSeen={markDirectoriesSeen} />;
}
export function FixtureDirectoriesList(props: ComponentProps<typeof DirectoriesList>) {
  const owner = usePresentationOwner(props);
  return <DirectoriesList {...props} directories={owner.directories} pagedNavigation={props.pagedNavigation ?? owner.navigation}
    selectedThreadDirectoryKeys={owner.selectedThreadDirectoryKeys} />;
}
