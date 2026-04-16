import type {
  AppServerBackendKind,
  AppServerThreadSummary,
  LinkedDirectorySummary,
  ThreadIdentifier,
} from "./app-server";

export type InboxReason = "new-thread" | "updated-since-seen";

export type ThreadInboxState = {
  inInbox: boolean;
  reason?: InboxReason;
  lastSeenAt?: number;
  lastSeenUpdatedAt?: number;
};

export type NavigationThreadSummary = AppServerThreadSummary & {
  inbox: ThreadInboxState;
};

export type NavigationSnapshot = {
  backend: AppServerBackendKind;
  fetchedAt: number;
  unchanged: boolean;
  threads: NavigationThreadSummary[];
  inboxThreadIds: ThreadIdentifier[];
};

export type GetNavigationSnapshotRequest = {
  backend?: AppServerBackendKind;
  filter?: string;
};

export type MarkThreadSeenRequest = {
  backend?: AppServerBackendKind;
  threadId: ThreadIdentifier;
  seenAt?: number;
  seenUpdatedAt?: number;
};

export type MarkThreadSeenResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  seenAt: number;
  seenUpdatedAt?: number;
};

export type ThreadOverlayState = {
  threadId: ThreadIdentifier;
  lastSeenAt?: number;
  lastSeenUpdatedAt?: number;
  dismissedAt?: number;
  snoozedUntil?: number;
  extraLinkedDirectories: LinkedDirectorySummary[];
};
