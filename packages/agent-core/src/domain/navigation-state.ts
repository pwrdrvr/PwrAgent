import type {
  AppServerBackendKind,
  AppServerThreadSummary,
  LinkedDirectorySummary,
  NavigationSnapshot,
  NavigationThreadSummary,
  ThreadOverlayState,
} from "@pwragnt/shared";
import { deriveInboxState, rankInboxThreadIds } from "./inbox";

function dedupeLinkedDirectories(
  directories: LinkedDirectorySummary[],
): LinkedDirectorySummary[] {
  const byId = new Map<string, LinkedDirectorySummary>();

  for (const directory of directories) {
    byId.set(directory.id, directory);
  }

  return [...byId.values()].sort((left, right) =>
    left.label.localeCompare(right.label),
  );
}

export function materializeNavigationThreads(params: {
  firstSnapshot: boolean;
  now?: number;
  overlayByThreadId: Record<string, ThreadOverlayState | undefined>;
  previousKnownThreadIds: string[];
  threads: AppServerThreadSummary[];
}): NavigationThreadSummary[] {
  const previousKnownThreadIds = new Set(params.previousKnownThreadIds);

  return params.threads.map((thread) => {
    const overlay = params.overlayByThreadId[thread.id];
    const linkedDirectories = dedupeLinkedDirectories([
      ...thread.linkedDirectories,
      ...(overlay?.extraLinkedDirectories ?? []),
    ]);

    return {
      ...thread,
      linkedDirectories,
      inbox: deriveInboxState({
        firstSnapshot: params.firstSnapshot,
        isNewThread: !previousKnownThreadIds.has(thread.id),
        now: params.now,
        overlay,
        thread,
      }),
    };
  });
}

export function buildNavigationSnapshot(params: {
  backend: AppServerBackendKind;
  fetchedAt: number;
  firstSnapshot: boolean;
  now?: number;
  overlayByThreadId: Record<string, ThreadOverlayState | undefined>;
  previousKnownThreadIds: string[];
  threads: AppServerThreadSummary[];
  unchanged: boolean;
}): NavigationSnapshot {
  const threads = materializeNavigationThreads({
    firstSnapshot: params.firstSnapshot,
    now: params.now,
    overlayByThreadId: params.overlayByThreadId,
    previousKnownThreadIds: params.previousKnownThreadIds,
    threads: params.threads,
  });

  return {
    backend: params.backend,
    fetchedAt: params.fetchedAt,
    unchanged: params.unchanged,
    threads,
    inboxThreadIds: rankInboxThreadIds(threads),
  };
}

export function buildNavigationSnapshotHash(params: {
  backend: AppServerBackendKind;
  threads: NavigationThreadSummary[];
}): string {
  return JSON.stringify({
    backend: params.backend,
    threads: params.threads.map((thread) => ({
      id: thread.id,
      updatedAt: thread.updatedAt ?? null,
      gitBranch: thread.gitBranch ?? null,
      linkedDirectories: thread.linkedDirectories.map((directory) => ({
        id: directory.id,
        kind: directory.kind,
        path: directory.path,
      })),
      inbox: {
        inInbox: thread.inbox.inInbox,
        reason: thread.inbox.reason ?? null,
        lastSeenUpdatedAt: thread.inbox.lastSeenUpdatedAt ?? null,
      },
    })),
  });
}
