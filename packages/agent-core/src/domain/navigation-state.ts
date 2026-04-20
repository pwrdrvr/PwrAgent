import type {
  DirectoryLaunchpadOverlayState,
  NavigationDirectoryGitStatus,
  AppServerBackendScope,
  AppServerThreadSummary,
  LinkedDirectorySummary,
  NavigationSnapshot,
  NavigationThreadSummary,
  NavigationLaunchpadDefaults,
  ThreadOverlayState,
} from "@pwragnt/shared";
import { buildThreadIdentityKey } from "@pwragnt/shared";
import { deriveInboxState, rankInboxThreadKeys } from "./inbox";
import { buildDirectorySummaries } from "./directory-navigation";

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
      executionMode: overlay?.executionMode ?? thread.executionMode ?? "default",
      model: overlay?.model ?? thread.model,
      reasoningEffort: overlay?.reasoningEffort ?? thread.reasoningEffort,
      serviceTier: overlay?.serviceTier ?? thread.serviceTier,
      fastMode: overlay?.fastMode ?? thread.fastMode,
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
  gitStatusByDirectoryKey?: Record<string, NavigationDirectoryGitStatus | undefined>;
  launchpadDefaults?: NavigationLaunchpadDefaults;
  launchpadsByKey?: Record<string, DirectoryLaunchpadOverlayState | undefined>;
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
    directories: buildDirectorySummaries({
      threads,
      launchpadsByKey: params.launchpadsByKey,
      gitStatusByKey: params.gitStatusByDirectoryKey,
    }),
    launchpadDefaults: params.launchpadDefaults ?? {
      backend: "codex",
      executionMode: "default",
    },
  };
}

export function buildNavigationSnapshotHash(params: {
  backend: AppServerBackendScope;
  directories?: NavigationSnapshot["directories"];
  launchpadDefaults?: NavigationLaunchpadDefaults;
  threads: NavigationThreadSummary[];
}): string {
  return JSON.stringify({
    backend: params.backend,
    threads: params.threads.map((thread) => ({
      source: thread.source,
      id: thread.id,
      title: thread.title,
      titleSource: thread.titleSource,
      summary: thread.summary ?? null,
      projectKey: thread.projectKey ?? null,
      updatedAt: thread.updatedAt ?? null,
      gitBranch: thread.gitBranch ?? null,
      executionMode: thread.executionMode ?? "default",
      model: thread.model ?? null,
      reasoningEffort: thread.reasoningEffort ?? null,
      serviceTier: thread.serviceTier ?? null,
      fastMode: thread.fastMode ?? null,
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
    directories: (params.directories ?? []).map((directory) => ({
      key: directory.key,
      kind: directory.kind,
      label: directory.label,
      path: directory.path ?? null,
      threadKeys: directory.threadKeys,
      needsAttentionCount: directory.needsAttentionCount,
      latestUpdatedAt: directory.latestUpdatedAt ?? null,
      launchpad: directory.launchpad
        ? {
            backend: directory.launchpad.backend,
            executionMode: directory.launchpad.executionMode,
            prompt: directory.launchpad.prompt,
            workMode: directory.launchpad.workMode,
            branchName: directory.launchpad.branchName ?? null,
            updatedAt: directory.launchpad.updatedAt,
          }
        : null,
      gitStatus: directory.gitStatus
        ? {
            currentBranch: directory.gitStatus.currentBranch ?? null,
            upstreamBranch: directory.gitStatus.upstreamBranch ?? null,
            ahead: directory.gitStatus.ahead ?? null,
            behind: directory.gitStatus.behind ?? null,
            branches: directory.gitStatus.branches ?? [],
            syncState: directory.gitStatus.syncState ?? null,
          }
        : null,
    })),
    launchpadDefaults: params.launchpadDefaults ?? {
      backend: "codex",
      executionMode: "default",
    },
  });
}
