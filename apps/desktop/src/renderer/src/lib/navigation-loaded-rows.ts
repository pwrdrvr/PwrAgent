import type {
  FederationTarget, NavigationCounts, NavigationDirectoryRow, NavigationDirectoryGitStatus,
  NavigationLaunchpadDefaults, NavigationLaunchpadDraft, NavigationThreadSummary, NavigationRow,
} from "@pwragent/shared";
import { threadSummaryIdentityKey } from "./federated-thread-events";

/** Owner descriptors plus independently loaded configuration or a viewer-local launchpad. */
export type NavigationDirectoryView = Pick<NavigationDirectoryRow,
  "key" | "kind" | "label" | "path" | "localAvailability" | "pinnedRank" | "directoryThreadsCollapsed"
> & {
  counts?: NavigationCounts;
  pinnedRootCount?: number;
  unpinnedRootCount?: number;
  latestUpdatedAt?: number;
  launchpadPresent?: boolean;
  launchpadBackend?: NavigationDirectoryRow["launchpadBackend"];
  gitStatus?: NavigationDirectoryGitStatus;
  launchpad?: NavigationLaunchpadDraft;
};

export type NavigationPresentedThread = NavigationThreadSummary & Partial<Pick<NavigationRow,
  "ref" | "rowRevision" | "ordinaryChildCount" | "nativeSubAgentGroupPresent" | "nativeSubAgentCount"
>>;

/** Loaded row overlays only. Collection membership/count/readiness stays in query resources. */
export type NavigationLoadedRows = {
  threadRows: ReadonlyMap<string, NavigationPresentedThread>;
  directoryRows: ReadonlyMap<string, NavigationDirectoryView>;
  launchpadDefaults?: NavigationLaunchpadDefaults;
  federationTarget?: FederationTarget;
};

const threadArrays = new WeakMap<ReadonlyMap<string, NavigationPresentedThread>, NavigationPresentedThread[]>();
const directoryArrays = new WeakMap<ReadonlyMap<string, NavigationDirectoryView>, NavigationDirectoryView[]>();
const emptyThreads: NavigationPresentedThread[] = [];
const emptyDirectories: NavigationDirectoryView[] = [];
export function loadedThreadRows(rows?: NavigationLoadedRows): NavigationPresentedThread[] {
  if (!rows) return emptyThreads;
  let value = threadArrays.get(rows.threadRows);
  if (!value) { value = [...rows.threadRows.values()]; threadArrays.set(rows.threadRows, value); }
  return value;
}
export function loadedDirectoryRows(rows?: NavigationLoadedRows): NavigationDirectoryView[] {
  if (!rows) return emptyDirectories;
  let value = directoryArrays.get(rows.directoryRows);
  if (!value) { value = [...rows.directoryRows.values()]; directoryArrays.set(rows.directoryRows, value); }
  return value;
}
export function indexLoadedThreadRows(rows: readonly NavigationThreadSummary[]): ReadonlyMap<string, NavigationPresentedThread> {
  return new Map(rows.map((thread) => [threadSummaryIdentityKey(thread), thread]));
}
export function indexLoadedDirectoryRows(rows: readonly NavigationDirectoryView[]): ReadonlyMap<string, NavigationDirectoryView> {
  return new Map(rows.map((directory) => [directory.key, directory]));
}
export function loadedUnreadThreadKeys(rows: NavigationLoadedRows): string[] {
  return [...rows.threadRows].filter(([, thread]) => thread.inbox.inInbox).map(([key]) => key);
}
