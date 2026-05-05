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
} from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { deriveInboxState, rankInboxThreadKeys } from "./inbox";
import { buildDirectorySummaries } from "./directory-navigation";

/** Check whether a linked directory was created by the handoff service. */
function isHandoffDirectory(directory: LinkedDirectorySummary): boolean {
  return (
    directory.id.startsWith("pwragent-handoff:") ||
    directory.id.startsWith("pwragnt-handoff:")  // legacy prefix from pre-rebrand data
  );
}

function dedupeLinkedDirectories(
  directories: LinkedDirectorySummary[],
): LinkedDirectorySummary[] {
  let overlayWorkspace: LinkedDirectorySummary | undefined;
  for (const directory of directories) {
    if (isHandoffDirectory(directory)) {
      overlayWorkspace = directory;
    }
  }
  const filteredDirectories = overlayWorkspace
    ? directories.filter(
        (directory) =>
          directory.id === overlayWorkspace.id ||
          (directory.kind !== "local" && directory.kind !== "worktree"),
      )
    : directories;
  const byId = new Map<string, LinkedDirectorySummary>();

  for (const directory of filteredDirectories) {
    byId.set(directory.id, directory);
  }

  return [...byId.values()].sort((left, right) =>
    left.label.localeCompare(right.label),
  );
}

function hasHandoffWorkspace(directories: LinkedDirectorySummary[]): boolean {
  return directories.some(isHandoffDirectory);
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
    const overlayGitBranch =
      overlay?.gitBranch ??
      (overlay?.observedGitBranch && hasHandoffWorkspace(overlay.extraLinkedDirectories)
        ? overlay.observedGitBranch
        : undefined);

    return {
      ...thread,
      gitBranch: overlayGitBranch ?? thread.gitBranch,
      observedGitBranch: overlay?.observedGitBranch ?? thread.observedGitBranch,
      retainedBranchDriftPairs: overlay?.retainedBranchDriftPairs,
      executionMode: overlay?.executionMode ?? thread.executionMode ?? "default",
      model: overlay?.model ?? thread.model,
      reasoningEffort: overlay?.reasoningEffort ?? thread.reasoningEffort,
      serviceTier: overlay?.serviceTier ?? thread.serviceTier,
      fastMode: overlay?.fastMode ?? thread.fastMode,
      linkedDirectories,
      worktreeSnapshots: overlay?.worktreeSnapshots ?? thread.worktreeSnapshots ?? [],
      reactions: overlay?.reactions ?? [],
      prs: overlay?.prs ?? [],
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
      observedGitBranch: thread.observedGitBranch ?? null,
      retainedBranchDriftPairs: (thread.retainedBranchDriftPairs ?? []).map((pair) => ({
        expectedBranch: pair.expectedBranch,
        observedBranch: pair.observedBranch,
        retainedAt: pair.retainedAt,
      })),
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
      worktreeSnapshots: (thread.worktreeSnapshots ?? []).map((snapshot) => ({
        id: snapshot.id,
        worktreePath: snapshot.worktreePath,
        repositoryPath: snapshot.repositoryPath,
        snapshotRef: snapshot.snapshotRef,
        snapshotCommit: snapshot.snapshotCommit,
        state: snapshot.state,
        archivedAt: snapshot.archivedAt ?? null,
        restoredAt: snapshot.restoredAt ?? null,
        unavailableReason: snapshot.unavailableReason ?? null,
      })),
      inbox: {
        inInbox: thread.inbox.inInbox,
        reason: thread.inbox.reason ?? null,
        lastSeenUpdatedAt: thread.inbox.lastSeenUpdatedAt ?? null,
      },
      reactions: thread.reactions ?? [],
      // Include prs in the hash so refreshThreadPullRequests writes to
      // the overlay actually propagate to the renderer. Without this,
      // the next snapshot tick computes an identical hash, gets marked
      // unchanged, and the renderer keeps the stale empty thread.prs.
      prs: (thread.prs ?? []).map((pr) => ({
        number: pr.number,
        org: pr.org,
        repo: pr.repo,
        state: pr.state,
        url: pr.url,
      })),
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
            imageAttachments: (directory.launchpad.imageAttachments ?? []).map((attachment) => ({
              id: attachment.id,
              height: attachment.height ?? null,
              name: attachment.name,
              size: attachment.size,
              type: attachment.type,
              url: attachment.url,
              width: attachment.width ?? null,
            })),
            workMode: directory.launchpad.workMode,
            branchName: directory.launchpad.branchName ?? null,
            settingsTouchedAt: directory.launchpad.settingsTouchedAt ?? null,
            updatedAt: directory.launchpad.updatedAt,
          }
        : null,
      gitStatus: directory.gitStatus
        ? {
            currentBranch: directory.gitStatus.currentBranch ?? null,
            defaultBranch: directory.gitStatus.defaultBranch ?? null,
            upstreamBranch: directory.gitStatus.upstreamBranch ?? null,
            ahead: directory.gitStatus.ahead ?? null,
            behind: directory.gitStatus.behind ?? null,
            branches: directory.gitStatus.branches ?? [],
            handoffBranches: directory.gitStatus.handoffBranches ?? [],
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
