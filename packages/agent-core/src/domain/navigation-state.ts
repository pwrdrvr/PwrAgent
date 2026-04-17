import type {
  AppServerBackendScope,
  AppServerThreadSummary,
  LinkedDirectorySummary,
  NavigationSnapshot,
  NavigationThreadSummary,
  ThreadOverlayState,
} from "@pwragnt/shared";
import { buildThreadIdentityKey } from "@pwragnt/shared";
import { deriveInboxState, rankInboxThreadKeys } from "./inbox";

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
  overlayByThreadKey: Record<string, ThreadOverlayState | undefined>;
  previousKnownThreadKeys: string[];
  threads: AppServerThreadSummary[];
}): NavigationThreadSummary[] {
  const previousKnownThreadKeys = new Set(params.previousKnownThreadKeys);

  return params.threads.map((thread) => {
    const threadKey = buildThreadIdentityKey(thread.source, thread.id);
    const overlay = params.overlayByThreadKey[threadKey];
    const linkedDirectories = dedupeLinkedDirectories([
      ...thread.linkedDirectories,
      ...(overlay?.extraLinkedDirectories ?? []),
    ]);

    return {
      ...thread,
      linkedDirectories,
      inbox: deriveInboxState({
        firstSnapshot: params.firstSnapshot,
        isNewThread: !previousKnownThreadKeys.has(threadKey),
        now: params.now,
        overlay,
        thread,
      }),
    };
  });
}

export function buildNavigationSnapshot(params: {
  backend: AppServerBackendScope;
  fetchedAt: number;
  firstSnapshot: boolean;
  now?: number;
  overlayByThreadKey: Record<string, ThreadOverlayState | undefined>;
  previousKnownThreadKeys: string[];
  threads: AppServerThreadSummary[];
  unchanged: boolean;
}): NavigationSnapshot {
  const threads = materializeNavigationThreads({
    firstSnapshot: params.firstSnapshot,
    now: params.now,
    overlayByThreadKey: params.overlayByThreadKey,
    previousKnownThreadKeys: params.previousKnownThreadKeys,
    threads: params.threads,
  });

  return {
    backend: params.backend,
    fetchedAt: params.fetchedAt,
    unchanged: params.unchanged,
    threads,
    inboxThreadKeys: rankInboxThreadKeys(threads),
  };
}

export function buildNavigationSnapshotHash(params: {
  backend: AppServerBackendScope;
  threads: NavigationThreadSummary[];
}): string {
  return JSON.stringify({
    backend: params.backend,
    threads: params.threads.map((thread) => ({
      source: thread.source,
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
