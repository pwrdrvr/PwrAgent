import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppServerBackendKind,
  AppServerCollaborationModeRequest,
  AppServerReviewTarget,
  AppServerThreadImagePart,
  AppServerTurnInputItem,
  ArchiveThreadCleanupResult,
  HandoffThreadWorkspaceRequest,
  LinkedDirectorySummary,
  NavigationDirectorySummary,
  NavigationLaunchpadDefaults,
  NavigationLaunchpadDraft,
  NavigationSnapshot,
  NavigationThreadSummary,
  ThreadExecutionMode,
} from "@pwragent/shared";
import {
  buildAppendPinRank,
  buildPinnedRanks,
  buildThreadIdentityKey,
  comparePinnedThreads,
  shortenDerivedThreadTitle,
} from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";

export type BrowseMode = "recents" | "directories";

const ROOT_NEW_THREAD_WORKSPACE_LAUNCHPAD_KEY = "workspace:new-thread";
const ROOT_NEW_THREAD_WORKSPACE_LABEL = "Workspaces";
const NAVIGATION_BACKGROUND_REFRESH_INTERVAL_MS = 30_000;

type NavigationState = {
  loading: boolean;
  refreshing: boolean;
  error?: string;
  response?: NavigationSnapshot;
};

function buildLaunchpadSelectionKey(directoryKey: string): string {
  return `launchpad:${directoryKey}`;
}

function getDirectoryKeyFromLaunchpadSelection(selectionKey?: string): string | undefined {
  if (!selectionKey?.startsWith("launchpad:")) {
    return undefined;
  }

  return selectionKey.slice("launchpad:".length);
}

function formatArchiveCleanupFailure(
  cleanup: ArchiveThreadCleanupResult[]
): string | undefined {
  const failures = cleanup.filter(
    (item) => !item.removedWorktree || item.error || item.skippedReason
  );
  const firstFailure = failures[0];
  if (!firstFailure) {
    return undefined;
  }

  const reason = firstFailure.error ?? firstFailure.skippedReason ?? "cleanup was skipped";
  return firstFailure.worktreePath
    ? `Thread archived, but worktree cleanup failed for ${firstFailure.worktreePath}: ${reason}`
    : `Thread archived, but worktree cleanup was skipped: ${reason}`;
}

function linkedDirectoriesEqual(
  left: NavigationThreadSummary["linkedDirectories"],
  right: NavigationThreadSummary["linkedDirectories"]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((directory, index) => {
    const candidate = right[index];
    return (
      directory?.id === candidate?.id &&
      directory?.label === candidate?.label &&
      directory?.path === candidate?.path &&
      directory?.worktreePath === candidate?.worktreePath &&
      directory?.kind === candidate?.kind
    );
  });
}

function worktreeSnapshotsEqual(
  left: NavigationThreadSummary["worktreeSnapshots"],
  right: NavigationThreadSummary["worktreeSnapshots"]
): boolean {
  const leftSnapshots = left ?? [];
  const rightSnapshots = right ?? [];
  if (leftSnapshots.length !== rightSnapshots.length) {
    return false;
  }

  return leftSnapshots.every((snapshot, index) => {
    const candidate = rightSnapshots[index];
    if (!candidate) {
      return false;
    }

    return (
      snapshot.id === candidate.id &&
      snapshot.worktreePath === candidate.worktreePath &&
      snapshot.repositoryPath === candidate.repositoryPath &&
      snapshot.snapshotRef === candidate.snapshotRef &&
      snapshot.snapshotCommit === candidate.snapshotCommit &&
      snapshot.state === candidate.state &&
      snapshot.archivedAt === candidate.archivedAt &&
      snapshot.restoredAt === candidate.restoredAt
    );
  });
}

function threadInboxEqual(
  left: NavigationThreadSummary["inbox"],
  right: NavigationThreadSummary["inbox"]
): boolean {
  return (
    left.inInbox === right.inInbox &&
    left.reason === right.reason &&
    left.lastSeenAt === right.lastSeenAt &&
    left.lastSeenUpdatedAt === right.lastSeenUpdatedAt
  );
}

function retainedBranchDriftPairsEqual(
  left: NavigationThreadSummary["retainedBranchDriftPairs"],
  right: NavigationThreadSummary["retainedBranchDriftPairs"]
): boolean {
  const leftPairs = left ?? [];
  const rightPairs = right ?? [];
  if (leftPairs.length !== rightPairs.length) {
    return false;
  }

  return leftPairs.every((pair, index) => {
    const candidate = rightPairs[index];
    return (
      candidate?.expectedBranch === pair.expectedBranch &&
      candidate.observedBranch === pair.observedBranch &&
      candidate.retainedAt === pair.retainedAt
    );
  });
}

function messagingBindingsEqual(
  left: NavigationThreadSummary["messagingBindings"],
  right: NavigationThreadSummary["messagingBindings"]
): boolean {
  const leftBindings = left ?? [];
  const rightBindings = right ?? [];
  if (leftBindings.length !== rightBindings.length) {
    return false;
  }

  return leftBindings.every((binding, index) => {
    const candidate = rightBindings[index];
    return (
      candidate?.bindingId === binding.bindingId &&
      candidate.platform === binding.platform &&
      candidate.conversationKind === binding.conversationKind &&
      candidate.conversationTitle === binding.conversationTitle &&
      candidate.parentTitle === binding.parentTitle &&
      candidate.ancestorTitle === binding.ancestorTitle &&
      candidate.activeAt === binding.activeAt
    );
  });
}

function prSummariesEqual(
  left: NavigationThreadSummary["prs"],
  right: NavigationThreadSummary["prs"]
): boolean {
  const leftPrs = left ?? [];
  const rightPrs = right ?? [];
  if (leftPrs.length !== rightPrs.length) {
    return false;
  }

  return leftPrs.every((pr, index) => {
    const candidate = rightPrs[index];
    return (
      candidate?.number === pr.number &&
      candidate.org === pr.org &&
      candidate.repo === pr.repo &&
      candidate.state === pr.state &&
      candidate.url === pr.url
    );
  });
}

function reactionsEqual(
  left: NavigationThreadSummary["reactions"],
  right: NavigationThreadSummary["reactions"]
): boolean {
  const leftReactions = left ?? [];
  const rightReactions = right ?? [];
  if (leftReactions.length !== rightReactions.length) {
    return false;
  }

  return leftReactions.every(
    (reaction, index) => rightReactions[index] === reaction
  );
}

function threadSummariesEqual(
  left: NavigationThreadSummary,
  right: NavigationThreadSummary
): boolean {
  return (
    left.id === right.id &&
    left.source === right.source &&
    left.title === right.title &&
    left.titleSource === right.titleSource &&
    left.summary === right.summary &&
    left.projectKey === right.projectKey &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.gitBranch === right.gitBranch &&
    left.observedGitBranch === right.observedGitBranch &&
    left.executionMode === right.executionMode &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.serviceTier === right.serviceTier &&
    left.fastMode === right.fastMode &&
    left.pinnedRank === right.pinnedRank &&
    retainedBranchDriftPairsEqual(
      left.retainedBranchDriftPairs,
      right.retainedBranchDriftPairs
    ) &&
    linkedDirectoriesEqual(left.linkedDirectories, right.linkedDirectories) &&
    worktreeSnapshotsEqual(left.worktreeSnapshots, right.worktreeSnapshots) &&
    threadInboxEqual(left.inbox, right.inbox) &&
    // Bindings and PRs mutate independently of `updatedAt`: the messaging
    // store revokes a binding row without touching the thread row, and
    // GitHub PR detection runs on its own cadence. Reactions can also be
    // changed by another app instance while the backend thread record is
    // otherwise unchanged. Without these checks the reconciler reuses the
    // previous thread reference whenever nothing else changed and chips on
    // the row stay stale until something else triggers a re-render.
    messagingBindingsEqual(left.messagingBindings, right.messagingBindings) &&
    prSummariesEqual(left.prs, right.prs) &&
    reactionsEqual(left.reactions, right.reactions)
  );
}

function hasPlaceholderThreadTitle(thread: NavigationThreadSummary): boolean {
  return (
    thread.titleSource === "fallback" &&
    (thread.title === thread.id || thread.title === "Untitled thread")
  );
}

function reconcileNavigationSnapshot(
  previous: NavigationSnapshot | undefined,
  next: NavigationSnapshot
): NavigationSnapshot {
  if (!previous) {
    return next;
  }

  const previousByThreadKey = new Map(
    previous.threads.map((thread) => [
      buildThreadIdentityKey(thread.source, thread.id),
      thread,
    ])
  );
  return {
    ...next,
    threads: next.threads.map((thread) => {
      const previousThread = previousByThreadKey.get(
        buildThreadIdentityKey(thread.source, thread.id)
      );
      return previousThread && threadSummariesEqual(previousThread, thread)
        ? previousThread
        : thread;
    }),
  };
}

function updateThreadReactionsInSnapshot(
  snapshot: NavigationSnapshot | undefined,
  params: {
    backend: AppServerBackendKind;
    threadId: string;
    reactions: string[];
  },
): NavigationSnapshot | undefined {
  if (!snapshot) {
    return snapshot;
  }

  const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
  let changed = false;
  const threads = snapshot.threads.map((thread) => {
    if (buildThreadIdentityKey(thread.source, thread.id) !== threadKey) {
      return thread;
    }
    const current = thread.reactions ?? [];
    if (
      current.length === params.reactions.length &&
      current.every((emoji, index) => emoji === params.reactions[index])
    ) {
      return thread;
    }
    changed = true;
    return { ...thread, reactions: params.reactions };
  });

  if (!changed) {
    return snapshot;
  }

  return { ...snapshot, threads };
}

function updateThreadPinInSnapshot(
  snapshot: NavigationSnapshot | undefined,
  params: {
    backend: AppServerBackendKind;
    threadId: string;
    pinnedRank?: string;
  },
): NavigationSnapshot | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = snapshot.threads.map((thread) => {
    if (thread.source !== params.backend || thread.id !== params.threadId) {
      return thread;
    }
    if (thread.pinnedRank === params.pinnedRank) {
      return thread;
    }
    changed = true;
    return { ...thread, pinnedRank: params.pinnedRank };
  });

  return changed ? { ...snapshot, threads } : snapshot;
}

function updateThreadPinsInSnapshot(
  snapshot: NavigationSnapshot | undefined,
  params: {
    backend: AppServerBackendKind;
    pinnedRanks: Record<string, string>;
  },
): NavigationSnapshot | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = snapshot.threads.map((thread) => {
    if (thread.source !== params.backend) {
      return thread;
    }
    const pinnedRank = params.pinnedRanks[thread.id];
    if (!pinnedRank || thread.pinnedRank === pinnedRank) {
      return thread;
    }
    changed = true;
    return { ...thread, pinnedRank };
  });

  return changed ? { ...snapshot, threads } : snapshot;
}

function markThreadSeenInSnapshot(
  snapshot: NavigationSnapshot | undefined,
  params: {
    backend: AppServerBackendKind;
    threadId: string;
    seenUpdatedAt?: number;
  }
): NavigationSnapshot | undefined {
  if (!snapshot) {
    return snapshot;
  }

  const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
  let changed = false;
  const threads = snapshot.threads.map((thread) => {
    if (buildThreadIdentityKey(thread.source, thread.id) !== threadKey) {
      return thread;
    }

    if (!thread.inbox.inInbox && thread.inbox.lastSeenUpdatedAt === params.seenUpdatedAt) {
      return thread;
    }

    changed = true;
    return {
      ...thread,
      inbox: {
        ...thread.inbox,
        inInbox: false,
        reason: undefined,
        lastSeenAt: Date.now(),
        lastSeenUpdatedAt: params.seenUpdatedAt,
      },
    };
  });

  if (!changed) {
    return snapshot;
  }

  const directories = snapshot.directories ?? [];
  const threadInboxByKey = new Map(
    threads.map((thread) => [
      buildThreadIdentityKey(thread.source, thread.id),
      thread.inbox.inInbox,
    ])
  );

  return {
    ...snapshot,
    directories: directories.map((directory) => ({
      ...directory,
      needsAttentionCount: directory.threadKeys.reduce(
        (count, threadKey) => count + (threadInboxByKey.get(threadKey) ? 1 : 0),
        0
      ),
    })),
    inboxThreadKeys: snapshot.inboxThreadKeys.filter((candidate) => candidate !== threadKey),
    threads,
  };
}

function removeThreadFromSnapshot(
  snapshot: NavigationSnapshot | undefined,
  params: {
    backend: AppServerBackendKind;
    threadId: string;
  }
): NavigationSnapshot | undefined {
  if (!snapshot) {
    return snapshot;
  }

  const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
  const threads = snapshot.threads.filter(
    (thread) => buildThreadIdentityKey(thread.source, thread.id) !== threadKey
  );
  if (threads.length === snapshot.threads.length) {
    return snapshot;
  }

  const threadInboxByKey = new Map(
    threads.map((thread) => [
      buildThreadIdentityKey(thread.source, thread.id),
      thread.inbox.inInbox,
    ])
  );

  return {
    ...snapshot,
    directories: snapshot.directories.map((directory) => {
      const threadKeys = directory.threadKeys.filter((candidate) => candidate !== threadKey);
      return {
        ...directory,
        threadKeys,
        needsAttentionCount: threadKeys.reduce(
          (count, candidate) => count + (threadInboxByKey.get(candidate) ? 1 : 0),
          0
        ),
      };
    }),
    inboxThreadKeys: snapshot.inboxThreadKeys.filter((candidate) => candidate !== threadKey),
    threads,
  };
}

function removeThreadKeysFromSnapshot(
  snapshot: NavigationSnapshot,
  threadKeysToRemove: ReadonlySet<string>
): NavigationSnapshot {
  if (threadKeysToRemove.size === 0) {
    return snapshot;
  }

  const threads = snapshot.threads.filter(
    (thread) => !threadKeysToRemove.has(buildThreadIdentityKey(thread.source, thread.id))
  );
  if (threads.length === snapshot.threads.length) {
    return snapshot;
  }

  const threadInboxByKey = new Map(
    threads.map((thread) => [
      buildThreadIdentityKey(thread.source, thread.id),
      thread.inbox.inInbox,
    ])
  );

  return {
    ...snapshot,
    directories: snapshot.directories.map((directory) => {
      const threadKeys = directory.threadKeys.filter(
        (candidate) => !threadKeysToRemove.has(candidate)
      );
      return {
        ...directory,
        threadKeys,
        needsAttentionCount: threadKeys.reduce(
          (count, candidate) => count + (threadInboxByKey.get(candidate) ? 1 : 0),
          0
        ),
      };
    }),
    inboxThreadKeys: snapshot.inboxThreadKeys.filter(
      (candidate) => !threadKeysToRemove.has(candidate)
    ),
    threads,
  };
}

function getFallbackSelectionAfterRemoval(
  snapshot: NavigationSnapshot | undefined,
  params: {
    backend: AppServerBackendKind;
    threadId: string;
    optimisticThreadKey?: string;
  }
): string | undefined {
  const nextSnapshot = removeThreadFromSnapshot(snapshot, params);
  return nextSnapshot
    ? getFallbackSelectionKey(nextSnapshot, params.optimisticThreadKey)
    : undefined;
}

function applyThreadNameUpdate(
  snapshot: NavigationSnapshot | undefined,
  params: { backend: AppServerBackendKind; threadId: string; threadName?: string }
): NavigationSnapshot | undefined {
  const threadName = params.threadName?.trim();
  if (!snapshot || !threadName) {
    return snapshot;
  }

  let changed = false;
  const threads = snapshot.threads.map((thread) => {
    if (thread.source !== params.backend || thread.id !== params.threadId) {
      return thread;
    }

    if (thread.title === threadName && thread.titleSource === "explicit") {
      return thread;
    }

    changed = true;
    return {
      ...thread,
      title: threadName,
      titleSource: "explicit" as const,
    };
  });

  return changed
    ? {
        ...snapshot,
        threads,
      }
      : snapshot;
}

function applyThreadModelSettingsUpdate(
  snapshot: NavigationSnapshot | undefined,
  params: {
    backend: AppServerBackendKind;
    threadId: string;
    model?: string;
    reasoningEffort?: string;
    serviceTier?: string;
    fastMode?: boolean;
  }
): NavigationSnapshot | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = snapshot.threads.map((thread) => {
    if (thread.source !== params.backend || thread.id !== params.threadId) {
      return thread;
    }

    changed = true;
    return {
      ...thread,
      model: params.model,
      reasoningEffort: params.reasoningEffort,
      serviceTier: params.serviceTier,
      fastMode: params.fastMode,
    };
  });

  return changed
    ? {
        ...snapshot,
        threads,
      }
    : snapshot;
}

function applyThreadExecutionModeUpdate(
  snapshot: NavigationSnapshot | undefined,
  params: {
    backend: AppServerBackendKind;
    threadId: string;
    executionMode: "default" | "full-access";
  }
): NavigationSnapshot | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = snapshot.threads.map((thread) => {
    if (thread.source !== params.backend || thread.id !== params.threadId) {
      return thread;
    }

    if (thread.executionMode === params.executionMode) {
      return thread;
    }

    changed = true;
    return {
      ...thread,
      executionMode: params.executionMode,
    };
  });

  return changed
    ? {
        ...snapshot,
        threads,
      }
    : snapshot;
}

function applyThreadExecutionModeQueued(
  snapshot: NavigationSnapshot | undefined,
  params: {
    backend: AppServerBackendKind;
    threadId: string;
    queuedExecutionMode: "default" | "full-access";
    queuedAt: number;
  }
): NavigationSnapshot | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = snapshot.threads.map((thread) => {
    if (thread.source !== params.backend || thread.id !== params.threadId) {
      return thread;
    }
    if (
      thread.queuedExecutionMode === params.queuedExecutionMode &&
      thread.queuedExecutionModeAt === params.queuedAt
    ) {
      return thread;
    }
    changed = true;
    return {
      ...thread,
      queuedExecutionMode: params.queuedExecutionMode,
      queuedExecutionModeAt: params.queuedAt,
    };
  });

  return changed
    ? {
        ...snapshot,
        threads,
      }
    : snapshot;
}

function applyThreadExecutionModeQueueCleared(
  snapshot: NavigationSnapshot | undefined,
  params: {
    backend: AppServerBackendKind;
    threadId: string;
  }
): NavigationSnapshot | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = snapshot.threads.map((thread) => {
    if (thread.source !== params.backend || thread.id !== params.threadId) {
      return thread;
    }
    if (
      thread.queuedExecutionMode === undefined &&
      thread.queuedExecutionModeAt === undefined
    ) {
      return thread;
    }
    changed = true;
    return {
      ...thread,
      queuedExecutionMode: undefined,
      queuedExecutionModeAt: undefined,
    };
  });

  return changed
    ? {
        ...snapshot,
        threads,
      }
    : snapshot;
}

function applyLaunchpadUpdate(
  snapshot: NavigationSnapshot | undefined,
  launchpad: NavigationLaunchpadDraft,
  defaults: NavigationSnapshot["launchpadDefaults"]
): NavigationSnapshot | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let foundDirectory = false;
  const directories = snapshot.directories.map((directory) => {
    if (directory.key !== launchpad.directoryKey) {
      return directory;
    }

    foundDirectory = true;
    return {
      ...directory,
      kind: launchpad.directoryKind,
      label: launchpad.directoryLabel,
      path: launchpad.directoryPath ?? directory.path,
      launchpad,
    };
  });

  return {
    ...snapshot,
    directories: foundDirectory
      ? directories
      : [
          {
            key: launchpad.directoryKey,
            kind: launchpad.directoryKind,
            label: launchpad.directoryLabel,
            path: launchpad.directoryPath,
            threadKeys: [],
            needsAttentionCount: 0,
            launchpad,
          },
          ...directories,
        ],
    launchpadDefaults: defaults,
  };
}

function applyLaunchpadReset(
  snapshot: NavigationSnapshot | undefined,
  directoryKey: string,
  defaults: NavigationSnapshot["launchpadDefaults"]
): NavigationSnapshot | undefined {
  if (!snapshot) {
    return snapshot;
  }

  return {
    ...snapshot,
    directories: snapshot.directories.map((directory) =>
      directory.key === directoryKey ? { ...directory, launchpad: undefined } : directory
    ),
    launchpadDefaults: defaults,
  };
}

function projectOptimisticThreadIntoDirectories(
  directories: NavigationSnapshot["directories"],
  optimisticThread?: NavigationThreadSummary
): NavigationSnapshot["directories"] {
  if (!optimisticThread) {
    return directories;
  }

  const threadKey = buildThreadIdentityKey(optimisticThread.source, optimisticThread.id);
  let changed = false;
  const nextDirectories = [...directories];

  for (const linkedDirectory of optimisticThread.linkedDirectories) {
    const directoryKey = linkedDirectory.id.startsWith("launchpad:")
      ? linkedDirectory.id.slice("launchpad:".length)
      : linkedDirectory.path
        ? `directory:${linkedDirectory.path}`
        : undefined;
    if (!directoryKey) {
      continue;
    }

    const existingIndex = nextDirectories.findIndex(
      (directory) => directory.key === directoryKey
    );
    if (existingIndex >= 0) {
      const existing = nextDirectories[existingIndex]!;
      if (existing.threadKeys.includes(threadKey)) {
        continue;
      }

      nextDirectories[existingIndex] = {
        ...existing,
        threadKeys: [threadKey, ...existing.threadKeys],
        needsAttentionCount:
          existing.needsAttentionCount + (optimisticThread.inbox.inInbox ? 1 : 0),
        latestUpdatedAt: Math.max(
          existing.latestUpdatedAt ?? 0,
          optimisticThread.updatedAt ?? 0
        ),
      };
      changed = true;
      continue;
    }

    nextDirectories.push({
      key: directoryKey,
      kind: directoryKey.startsWith("workspace:") ? "workspace" : "directory",
      label: linkedDirectory.label,
      path: linkedDirectory.path,
      threadKeys: [threadKey],
      needsAttentionCount: optimisticThread.inbox.inInbox ? 1 : 0,
      latestUpdatedAt: optimisticThread.updatedAt,
    });
    changed = true;
  }

  return changed ? nextDirectories : directories;
}

function hasSelectionKey(
  response: NavigationSnapshot,
  selectionKey: string,
  optimisticThreadKey?: string
): boolean {
  const launchpadDirectoryKey = getDirectoryKeyFromLaunchpadSelection(selectionKey);
  if (launchpadDirectoryKey) {
    return response.directories.some(
      (directory) =>
        directory.key === launchpadDirectoryKey && Boolean(directory.launchpad)
    );
  }

  return (
    response.threads.some(
      (thread) => buildThreadIdentityKey(thread.source, thread.id) === selectionKey
    ) || selectionKey === optimisticThreadKey
  );
}

function getFallbackSelectionKey(
  response: NavigationSnapshot,
  optimisticThreadKey?: string
): string | undefined {
  if (optimisticThreadKey) {
    return optimisticThreadKey;
  }

  if (response.threads[0]) {
    return buildThreadIdentityKey(response.threads[0].source, response.threads[0].id);
  }

  const firstLaunchpadDirectory = response.directories.find((directory) => directory.launchpad);
  return firstLaunchpadDirectory
    ? buildLaunchpadSelectionKey(firstLaunchpadDirectory.key)
    : undefined;
}

function resolveRefreshSelectionKey(
  response: NavigationSnapshot,
  currentSelectionKey: string | undefined,
  preferredSelectionKey: string | undefined,
  optimisticThreadKey?: string,
  forcePreferredSelection = false
): string | undefined {
  if (
    preferredSelectionKey &&
    (forcePreferredSelection ||
      currentSelectionKey === preferredSelectionKey ||
      !currentSelectionKey) &&
    hasSelectionKey(response, preferredSelectionKey, optimisticThreadKey)
  ) {
    return preferredSelectionKey;
  }

  if (currentSelectionKey) {
    return currentSelectionKey;
  }

  return getFallbackSelectionKey(response, optimisticThreadKey);
}

function buildOptimisticThreadFromLaunchpad(params: {
  directory?: NavigationDirectorySummary;
  launchpad: NavigationLaunchpadDraft;
  backend: AppServerBackendKind;
  threadId: string;
  executionMode: ThreadExecutionMode;
  workMode: NavigationLaunchpadDraft["workMode"];
  optimisticUserMessage?: NavigationThreadSummary["optimisticUserMessage"];
}): NavigationThreadSummary {
  const titlePrompt =
    params.optimisticUserMessage?.text?.trim() || params.launchpad.prompt.trim();
  const derivedTitle = shortenDerivedThreadTitle(titlePrompt);

  return {
    id: params.threadId,
    title: derivedTitle ?? "Untitled thread",
    titleSource: derivedTitle ? "derived" : "fallback",
    summary: titlePrompt || undefined,
    projectKey: params.launchpad.directoryPath,
    source: params.backend,
    executionMode: params.executionMode,
    model: params.launchpad.model,
    reasoningEffort: params.launchpad.reasoningEffort,
    serviceTier: params.launchpad.serviceTier,
    fastMode: params.launchpad.fastMode,
    optimisticUserMessage: params.optimisticUserMessage,
    linkedDirectories: params.launchpad.directoryPath || params.launchpad.directoryKind === "workspace"
      ? [
          {
            id: `launchpad:${params.launchpad.directoryKey}`,
            label: params.launchpad.directoryLabel,
            path: params.launchpad.directoryPath ?? "",
            kind: params.workMode === "worktree" ? "worktree" : "local",
          },
        ]
      : [],
    gitBranch:
      params.workMode === "worktree"
        ? "HEAD"
        : params.directory?.gitStatus?.currentBranch ?? params.launchpad.branchName,
    observedGitBranch: params.workMode === "worktree" ? "HEAD" : undefined,
    updatedAt: Date.now(),
    inbox: {
      inInbox: true,
      reason: "new-thread",
    },
  };
}

function mergeHydratedThreadWithOptimisticTitle(
  thread: NavigationThreadSummary,
  optimisticThread: NavigationThreadSummary,
): NavigationThreadSummary {
  if (optimisticThread.titleSource !== "derived") {
    return thread;
  }

  if (!hasPlaceholderThreadTitle(thread)) {
    return thread;
  }

  return {
    ...thread,
    summary: thread.summary ?? optimisticThread.summary,
    title: optimisticThread.title,
    titleSource: optimisticThread.titleSource,
  };
}

function buildOptimisticUserMessage(
  input: AppServerTurnInputItem[] | undefined
): NavigationThreadSummary["optimisticUserMessage"] {
  if (!input?.length) {
    return undefined;
  }

  const text = input
    .filter((item): item is Extract<AppServerTurnInputItem, { type: "text" }> =>
      item.type === "text" && typeof item.text === "string"
    )
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const imageParts: AppServerThreadImagePart[] = input
    .filter((item): item is Extract<AppServerTurnInputItem, { type: "image" }> =>
      item.type === "image" && typeof item.url === "string"
    )
    .map((item) => ({
      type: "image",
      url: item.url,
    }));

  if (!text && imageParts.length === 0) {
    return undefined;
  }

  return {
    text,
    ...(imageParts.length > 0 ? { imageParts } : {}),
    createdAt: Date.now(),
  };
}

export function useThreadNavigation(desktopApi?: DesktopApi): {
  browseMode: BrowseMode;
  createThread: (
    backend?: AppServerBackendKind,
    executionMode?: ThreadExecutionMode
  ) => Promise<void>;
  createThreadError?: string;
  creatingThread?: {
    backend: AppServerBackendKind;
    executionMode: ThreadExecutionMode;
  };
  directories: NavigationDirectorySummary[];
  error?: string;
  inboxThreads: NavigationThreadSummary[];
  launchpadError?: string;
  archiveThreadError?: string;
  worktreeArchiveError?: string;
  renameThreadError?: string;
  loading: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
  materializeDirectoryLaunchpad: (
    directoryKey: string,
    input?: AppServerTurnInputItem[],
    collaborationMode?: AppServerCollaborationModeRequest,
    reviewTarget?: AppServerReviewTarget
  ) => Promise<void>;
  openDirectoryLaunchpad: (
    directory: NavigationDirectorySummary,
    preferredBackend?: AppServerBackendKind
  ) => Promise<void>;
  /** Project-directory picker (issue #223): OS dialog → validate → seed launchpad → focus it. */
  pickAndRegisterDirectory: (
    preferredBackend?: AppServerBackendKind,
  ) => Promise<void>;
  pickDirectoryError?: string;
  pickingDirectory: boolean;
  clearPickDirectoryError: () => void;
  resetDirectoryLaunchpad: (directoryKey: string) => Promise<void>;
  selectedDirectory?: NavigationDirectorySummary;
  selectedItemKey?: string;
  selectedLaunchpad?: NavigationLaunchpadDraft;
  selectedThread?: NavigationThreadSummary;
  selectedThreadKey?: string;
  setThreadExecutionMode: (
    thread: NavigationThreadSummary,
    executionMode: ThreadExecutionMode
  ) => Promise<void>;
  setThreadExecutionModeError?: string;
  cancelThreadExecutionModeQueue: (
    thread: NavigationThreadSummary
  ) => Promise<void>;
  setThreadModelSettings: (
    thread: NavigationThreadSummary,
    patch: Partial<
      Pick<
      NavigationThreadSummary,
      "model" | "reasoningEffort" | "serviceTier" | "fastMode"
      >
    >
  ) => Promise<void>;
  setThreadModelSettingsError?: string;
  updatingThreadExecutionMode?: ThreadExecutionMode;
  updateDirectoryLaunchpad: (
    directoryKey: string,
    patch: Parameters<NonNullable<DesktopApi["updateDirectoryLaunchpad"]>>[0]["patch"],
    options?: { stickySettingsChanged?: boolean }
  ) => Promise<void>;
  setBrowseMode: (browseMode: BrowseMode) => void;
  selectThread: (thread: NavigationThreadSummary) => void;
  archiveThread: (thread: NavigationThreadSummary) => Promise<void>;
  archiveWorktree: (
    thread: NavigationThreadSummary,
    directory: LinkedDirectorySummary
  ) => Promise<void>;
  restoreWorktree: (
    thread: NavigationThreadSummary,
    snapshotRef: string,
    worktreePath: string
  ) => Promise<void>;
  handoffThreadWorkspace: (
    thread: NavigationThreadSummary,
    request: Omit<HandoffThreadWorkspaceRequest, "backend" | "threadId">
  ) => Promise<void>;
  renameThread: (thread: NavigationThreadSummary, name: string) => Promise<void>;
  setThreadReaction: (
    thread: NavigationThreadSummary,
    emoji: string,
    present: boolean,
  ) => Promise<void>;
  setThreadPin: (
    thread: NavigationThreadSummary,
    pinned: boolean,
  ) => Promise<void>;
  reorderThreadPins: (
    backend: AppServerBackendKind,
    threadIds: string[],
  ) => Promise<void>;
  snapshot?: NavigationSnapshot;
  threads: NavigationThreadSummary[];
} {
  const markThreadSeen = desktopApi?.markThreadSeen;
  const archiveThreadRequest = desktopApi?.archiveThread;
  const archiveWorktreeRequest = desktopApi?.archiveWorktree;
  const restoreWorktreeRequest = desktopApi?.restoreWorktree;
  const handoffThreadWorkspaceRequest = desktopApi?.handoffThreadWorkspace;
  const renameThreadRequest = desktopApi?.renameThread;
  const setThreadExecutionMode = desktopApi?.setThreadExecutionMode;
  const cancelThreadExecutionModeQueueRequest =
    desktopApi?.cancelThreadExecutionModeQueue;
  const setThreadModelSettings = desktopApi?.setThreadModelSettings;
  const [browseMode, setBrowseMode] = useState<BrowseMode>("recents");
  const [selectedItemKey, setSelectedItemKey] = useState<string>();
  const [pendingSeenThreadKey, setPendingSeenThreadKey] = useState<string>();
  const [retainedUnreadThread, setRetainedUnreadThread] =
    useState<NavigationThreadSummary>();
  const [optimisticThread, setOptimisticThread] = useState<NavigationThreadSummary>();
  const [creatingThread, setCreatingThread] = useState<{
    backend: AppServerBackendKind;
    executionMode: ThreadExecutionMode;
  }>();
  const [createThreadError, setCreateThreadError] = useState<string>();
  const [launchpadError, setLaunchpadError] = useState<string>();
  const [archiveThreadError, setArchiveThreadError] = useState<string>();
  const [worktreeArchiveError, setWorktreeArchiveError] = useState<string>();
  const [renameThreadError, setRenameThreadError] = useState<string>();
  const [updatingThreadExecutionMode, setUpdatingThreadExecutionMode] =
    useState<ThreadExecutionMode>();
  const [setThreadExecutionModeError, setSetThreadExecutionModeError] =
    useState<string>();
  const [setThreadModelSettingsError, setSetThreadModelSettingsError] =
    useState<string>();
  // Project-directory picker (issue #223). `pickAndRegisterDirectory`
  // bridges the OS dialog → register flow; while it's in flight we
  // disable the picker's "Add directory…" row, and any validation
  // failure surfaces inline via `pickDirectoryError`. Both reset on the
  // next attempt rather than persisting between renders.
  const [pickDirectoryError, setPickDirectoryError] = useState<string>();
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [state, setState] = useState<NavigationState>({
    loading: true,
    refreshing: false,
  });

  const optimisticThreadRef = useRef<NavigationThreadSummary | undefined>(undefined);
  const retainedUnreadThreadRef = useRef<NavigationThreadSummary | undefined>(undefined);
  const refreshInFlightRef = useRef(false);
  const queuedRefreshRef = useRef<
    | {
        forcePreferredSelection?: boolean;
        preferredOptimisticThread?: NavigationThreadSummary;
        preferredSelectionKey?: string;
      }
    | undefined
  >(undefined);
  const suppressedArchivedThreadKeysRef = useRef<Set<string>>(new Set());
  const scheduledRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const launchpadUpdateRevisionRef = useRef(new Map<string, number>());

  optimisticThreadRef.current = optimisticThread;
  retainedUnreadThreadRef.current = retainedUnreadThread;

  const releaseRetainedUnreadThread = useCallback((nextSelectionKey?: string): void => {
    const retainedThread = retainedUnreadThreadRef.current;
    if (!retainedThread) {
      return;
    }

    const retainedThreadKey = buildThreadIdentityKey(
      retainedThread.source,
      retainedThread.id
    );
    if (nextSelectionKey === retainedThreadKey) {
      return;
    }

    setState((current) => ({
      ...current,
      response: markThreadSeenInSnapshot(current.response, {
        backend: retainedThread.source,
        threadId: retainedThread.id,
        seenUpdatedAt: retainedThread.updatedAt,
      }),
    }));
    setRetainedUnreadThread(undefined);
  }, []);

  const performRefresh = useCallback(
    async (
      preferredSelectionKey?: string,
      preferredOptimisticThread?: NavigationThreadSummary,
      forcePreferredSelection = false
    ): Promise<void> => {
      if (!desktopApi?.getNavigationSnapshot) {
        setState({
          loading: false,
          refreshing: false,
          error: "Desktop bridge is missing getNavigationSnapshot().",
          response: undefined,
        });
        return;
      }

      setState((current) => ({
        ...current,
        loading: !current.response,
        refreshing: Boolean(current.response),
        error: undefined,
      }));

      try {
        const response = removeThreadKeysFromSnapshot(
          await desktopApi.getNavigationSnapshot(),
          suppressedArchivedThreadKeysRef.current
        );
        const optimisticSelection = preferredOptimisticThread ?? optimisticThreadRef.current;
        const optimisticThreadKey = optimisticSelection
          ? buildThreadIdentityKey(optimisticSelection.source, optimisticSelection.id)
          : undefined;

        setState((current) => {
          if (current.response && response.unchanged && !preferredSelectionKey) {
            return {
              ...current,
              loading: false,
              refreshing: false,
              error: undefined,
            };
          }

          return {
            loading: false,
            refreshing: false,
            error: undefined,
            response: reconcileNavigationSnapshot(current.response, response),
          };
        });

        if (
          optimisticThreadKey &&
          response.threads.some(
            (thread) => buildThreadIdentityKey(thread.source, thread.id) === optimisticThreadKey
          )
        ) {
          const hydratedOptimisticThread = response.threads.find(
            (thread) => buildThreadIdentityKey(thread.source, thread.id) === optimisticThreadKey
          );

          setOptimisticThread((current) => {
            if (current?.optimisticUserMessage) {
              return current;
            }

            if (
              current?.titleSource === "derived" &&
              hydratedOptimisticThread &&
              hasPlaceholderThreadTitle(hydratedOptimisticThread)
            ) {
              return current;
            }

            return undefined;
          });
        }

        setSelectedItemKey((current) => {
          return resolveRefreshSelectionKey(
            response,
            current,
            preferredSelectionKey,
            optimisticThreadKey,
            forcePreferredSelection
          );
        });
      } catch (error) {
        setState((current) => ({
          loading: false,
          refreshing: false,
          response: current.response,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [desktopApi]
  );

  const refresh = useCallback(
    async (
      preferredSelectionKey?: string,
      preferredOptimisticThread?: NavigationThreadSummary,
      forcePreferredSelection = false
    ): Promise<void> => {
      const initialRequest = {
        forcePreferredSelection,
        preferredOptimisticThread,
        preferredSelectionKey,
      };

      if (refreshInFlightRef.current) {
        queuedRefreshRef.current = initialRequest;
        return;
      }

      refreshInFlightRef.current = true;
      let nextRequest: typeof initialRequest | undefined = initialRequest;

      try {
        while (nextRequest) {
          queuedRefreshRef.current = undefined;
          await performRefresh(
            nextRequest.preferredSelectionKey,
            nextRequest.preferredOptimisticThread,
            nextRequest.forcePreferredSelection
          );
          nextRequest = queuedRefreshRef.current;
        }
      } finally {
        refreshInFlightRef.current = false;
      }
    },
    [performRefresh]
  );
  const refreshNavigation = useCallback(async (): Promise<void> => {
    await refresh();
  }, [refresh]);

  const scheduleRefresh = useCallback(
    (
      preferredSelectionKey?: string,
      preferredOptimisticThread?: NavigationThreadSummary,
      forcePreferredSelection = false
    ): void => {
      queuedRefreshRef.current = {
        forcePreferredSelection,
        preferredOptimisticThread,
        preferredSelectionKey,
      };

      if (scheduledRefreshTimerRef.current !== undefined) {
        return;
      }

      scheduledRefreshTimerRef.current = setTimeout(() => {
        scheduledRefreshTimerRef.current = undefined;
        const nextRequest = queuedRefreshRef.current;
        queuedRefreshRef.current = undefined;
        if (!nextRequest) {
          return;
        }

        void refresh(
          nextRequest.preferredSelectionKey,
          nextRequest.preferredOptimisticThread,
          nextRequest.forcePreferredSelection
        );
      }, 0);
    },
    [refresh]
  );

  useEffect(() => {
    return () => {
      if (scheduledRefreshTimerRef.current !== undefined) {
        clearTimeout(scheduledRefreshTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!desktopApi?.getNavigationSnapshot) {
      return;
    }

    const timer = setInterval(() => {
      scheduleRefresh();
    }, NAVIGATION_BACKGROUND_REFRESH_INTERVAL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [desktopApi?.getNavigationSnapshot, scheduleRefresh]);

  useEffect(() => {
    if (!desktopApi?.onWindowFocus) {
      return;
    }

    return desktopApi.onWindowFocus(() => {
      scheduleRefresh();
    });
  }, [desktopApi, scheduleRefresh]);

  useEffect(() => {
    if (!desktopApi?.onAgentEvent) {
      return;
    }

    return desktopApi.onAgentEvent((event) => {
      const method = event.notification.method;
      if (method === "thread/name/updated") {
        const { threadId, threadName } = event.notification.params as {
          threadId: string;
          threadName?: string;
        };
        setState((current) => ({
          ...current,
          response: applyThreadNameUpdate(current.response, {
            backend: event.backend,
            threadId,
            threadName,
          }),
        }));
        setOptimisticThread((current) => {
          if (current?.source !== event.backend || current.id !== threadId) {
            return current;
          }

          const nextThreadName = threadName?.trim();
          if (!nextThreadName) {
            return current;
          }

          return {
            ...current,
            title: nextThreadName,
            titleSource: "explicit",
          };
        });
        return;
      }

      if (method === "thread/archived") {
        const { threadId } = event.notification.params as {
          threadId: string;
        };
        const threadKey = buildThreadIdentityKey(event.backend, threadId);
        suppressedArchivedThreadKeysRef.current.add(threadKey);

        setState((current) => ({
          ...current,
          response: removeThreadFromSnapshot(current.response, {
            backend: event.backend,
            threadId,
          }),
        }));
        setSelectedItemKey((current) =>
          current === threadKey
            ? getFallbackSelectionAfterRemoval(state.response, {
                backend: event.backend,
                threadId,
                optimisticThreadKey: optimisticThreadRef.current
                  ? buildThreadIdentityKey(
                      optimisticThreadRef.current.source,
                      optimisticThreadRef.current.id
                    )
                  : undefined,
              })
            : current
        );
        setRetainedUnreadThread((current) =>
          current?.source === event.backend && current.id === threadId ? undefined : current
        );
        setOptimisticThread((current) =>
          current?.source === event.backend && current.id === threadId ? undefined : current
        );
        return;
      }

      if (method === "thread/executionMode/updated") {
        const { threadId, executionMode } = event.notification.params as {
          threadId: string;
          executionMode: "default" | "full-access";
        };
        setState((current) => ({
          ...current,
          response: applyThreadExecutionModeUpdate(current.response, {
            backend: event.backend,
            threadId,
            executionMode,
          }),
        }));
        setOptimisticThread((current) =>
          current?.source === event.backend && current.id === threadId
            ? { ...current, executionMode }
            : current
        );
        // Refresh so the persisted permissionTransitionLog (which the
        // registry just appended an `applied` entry to) flows back into
        // the snapshot for transcript rendering.
        scheduleRefresh();
        return;
      }

      if (method === "thread/executionMode/queued") {
        const { threadId, queuedExecutionMode, queuedAt } = event.notification
          .params as {
          threadId: string;
          queuedExecutionMode: "default" | "full-access";
          queuedAt: number;
        };
        setState((current) => ({
          ...current,
          response: applyThreadExecutionModeQueued(current.response, {
            backend: event.backend,
            threadId,
            queuedExecutionMode,
            queuedAt,
          }),
        }));
        setOptimisticThread((current) =>
          current?.source === event.backend && current.id === threadId
            ? {
                ...current,
                queuedExecutionMode,
                queuedExecutionModeAt: queuedAt,
              }
            : current
        );
        // The registry already persisted a `queued` audit entry; pull
        // the snapshot so the transcript renders it.
        scheduleRefresh();
        return;
      }

      if (method === "thread/executionMode/queueCleared") {
        const { threadId } = event.notification.params as {
          threadId: string;
          reason: "applied" | "cancelled";
        };
        setState((current) => ({
          ...current,
          response: applyThreadExecutionModeQueueCleared(current.response, {
            backend: event.backend,
            threadId,
          }),
        }));
        setOptimisticThread((current) =>
          current?.source === event.backend && current.id === threadId
            ? {
                ...current,
                queuedExecutionMode: undefined,
                queuedExecutionModeAt: undefined,
              }
            : current
        );
        // Pull the snapshot so the matching `applied` / `cancelled`
        // transition entry shows up in the transcript.
        scheduleRefresh();
        return;
      }

      if (method === "thread/modelSettings/updated") {
        const { threadId, model, reasoningEffort, serviceTier, fastMode } =
          event.notification.params as {
            threadId: string;
            model?: string;
            reasoningEffort?: string;
            serviceTier?: string;
            fastMode?: boolean;
          };
        setState((current) => ({
          ...current,
          response: applyThreadModelSettingsUpdate(current.response, {
            backend: event.backend,
            threadId,
            model,
            reasoningEffort,
            serviceTier,
            fastMode,
          }),
        }));
        setOptimisticThread((current) =>
          current?.source === event.backend && current.id === threadId
            ? { ...current, model, reasoningEffort, serviceTier, fastMode }
            : current
        );
        return;
      }

      if (method === "thread/pin/added") {
        const { threadId, pinnedRank } = event.notification.params as {
          threadId: string;
          pinnedRank: string;
        };
        setState((current) => ({
          ...current,
          response: updateThreadPinInSnapshot(current.response, {
            backend: event.backend,
            threadId,
            pinnedRank,
          }),
        }));
        return;
      }

      if (method === "thread/pin/removed") {
        const { threadId } = event.notification.params as {
          threadId: string;
        };
        setState((current) => ({
          ...current,
          response: updateThreadPinInSnapshot(current.response, {
            backend: event.backend,
            threadId,
            pinnedRank: undefined,
          }),
        }));
        return;
      }

      if (method === "thread/pin/reordered") {
        const { pinnedRanks } = event.notification.params as {
          pinnedRanks: Record<string, string>;
        };
        setState((current) => ({
          ...current,
          response: updateThreadPinsInSnapshot(current.response, {
            backend: event.backend,
            pinnedRanks,
          }),
        }));
        return;
      }

      if (method === "thread/unarchived") {
        const { threadId } = event.notification.params as {
          threadId: string;
        };
        suppressedArchivedThreadKeysRef.current.delete(
          buildThreadIdentityKey(event.backend, threadId)
        );
        scheduleRefresh();
        return;
      }

      if (method === "thread/started") {
        scheduleRefresh();
        return;
      }

      if (
        method === "turn/completed" ||
        method === "turn/failed" ||
        method === "turn/cancelled"
      ) {
        scheduleRefresh();
      }
    });
  }, [desktopApi, scheduleRefresh, state.response]);

  // Bindings live in the navigation snapshot but are mutated outside
  // the agent-event bus (a Telegram callback creates a binding, a
  // /sync name renames it, a /detach revokes it — none of those emit
  // backend notifications). Without this hook the binding chip stays
  // stale until the next backend tick. See issue #191.
  useEffect(() => {
    if (!desktopApi?.onMessagingBindingsChanged) {
      return;
    }
    return desktopApi.onMessagingBindingsChanged(() => {
      scheduleRefresh();
    });
  }, [desktopApi, scheduleRefresh]);

  const threads = useMemo(() => {
    const currentThreads = state.response?.threads ?? [];
    if (!optimisticThread) {
      return currentThreads;
    }

    const optimisticThreadKey = buildThreadIdentityKey(
      optimisticThread.source,
      optimisticThread.id
    );

    const hasHydratedThread = currentThreads.some(
      (thread) => buildThreadIdentityKey(thread.source, thread.id) === optimisticThreadKey
    );
    if (hasHydratedThread) {
      return currentThreads.map((thread) =>
        buildThreadIdentityKey(thread.source, thread.id) === optimisticThreadKey
          ? {
              ...mergeHydratedThreadWithOptimisticTitle(thread, optimisticThread),
              optimisticUserMessage:
                thread.optimisticUserMessage ?? optimisticThread.optimisticUserMessage,
            }
          : thread
      );
    }

    return [optimisticThread, ...currentThreads];
  }, [optimisticThread, state.response?.threads]);

  const directories = useMemo(
    () => {
      if (!optimisticThread) {
        return state.response?.directories ?? [];
      }

      const optimisticThreadKey = buildThreadIdentityKey(
        optimisticThread.source,
        optimisticThread.id
      );
      const hasHydratedThread = state.response?.threads.some(
        (thread) => buildThreadIdentityKey(thread.source, thread.id) === optimisticThreadKey
      );

      return projectOptimisticThreadIntoDirectories(
        state.response?.directories ?? [],
        hasHydratedThread ? undefined : optimisticThread
      );
    },
    [optimisticThread, state.response?.directories, state.response?.threads]
  );

  const inboxThreads = useMemo(() => {
    const unreadThreads = threads.filter(
      (thread) => thread.inbox.inInbox && thread.inbox.reason === "updated-since-seen"
    );
    if (!retainedUnreadThread) {
      return unreadThreads;
    }

    const retainedThreadKey = buildThreadIdentityKey(
      retainedUnreadThread.source,
      retainedUnreadThread.id
    );
    if (
      unreadThreads.some(
        (thread) => buildThreadIdentityKey(thread.source, thread.id) === retainedThreadKey
      )
    ) {
      return unreadThreads;
    }

    return [retainedUnreadThread, ...unreadThreads];
  }, [retainedUnreadThread, threads]);

  const selectedThreadKey = useMemo(() => {
    if (selectedItemKey && !getDirectoryKeyFromLaunchpadSelection(selectedItemKey)) {
      return selectedItemKey;
    }

    return undefined;
  }, [selectedItemKey]);

  const selectedThread = useMemo<NavigationThreadSummary | undefined>(
    () =>
      selectedThreadKey
        ? threads.find(
            (thread) =>
              buildThreadIdentityKey(thread.source, thread.id) === selectedThreadKey
          )
        : undefined,
    [selectedThreadKey, threads]
  );

  const selectedDirectory = useMemo(() => {
    const launchpadDirectoryKey = getDirectoryKeyFromLaunchpadSelection(selectedItemKey);
    if (launchpadDirectoryKey) {
      return directories.find((directory) => directory.key === launchpadDirectoryKey);
    }

    if (!selectedThreadKey) {
      return undefined;
    }

    return directories.find((directory) =>
      directory.threadKeys.includes(selectedThreadKey)
    );
  }, [directories, selectedItemKey, selectedThreadKey]);

  const selectedLaunchpad = useMemo(() => {
    const launchpadDirectoryKey = getDirectoryKeyFromLaunchpadSelection(selectedItemKey);
    if (!launchpadDirectoryKey) {
      return undefined;
    }

    return directories.find((directory) => directory.key === launchpadDirectoryKey)
      ?.launchpad;
  }, [directories, selectedItemKey]);

  useEffect(() => {
    releaseRetainedUnreadThread(selectedItemKey);
  }, [releaseRetainedUnreadThread, retainedUnreadThread, selectedItemKey]);

  useEffect(() => {
    const submitMarkThreadSeen = markThreadSeen;

    if (
      !pendingSeenThreadKey ||
      !selectedThread ||
      pendingSeenThreadKey !==
        buildThreadIdentityKey(selectedThread.source, selectedThread.id) ||
      !submitMarkThreadSeen
    ) {
      return;
    }

    const markThreadSeenRequest = submitMarkThreadSeen;
    const threadToMarkSeen = selectedThread;
    let cancelled = false;

    async function markSeen(): Promise<void> {
      try {
        await markThreadSeenRequest({
          backend: threadToMarkSeen.source,
          threadId: threadToMarkSeen.id,
          seenUpdatedAt: threadToMarkSeen.updatedAt,
        });
        if (!cancelled) {
          const threadKey = buildThreadIdentityKey(
            threadToMarkSeen.source,
            threadToMarkSeen.id
          );
          if (
            !retainedUnreadThread ||
            buildThreadIdentityKey(retainedUnreadThread.source, retainedUnreadThread.id) !==
              threadKey
          ) {
            setState((current) => ({
              ...current,
              response: markThreadSeenInSnapshot(current.response, {
                backend: threadToMarkSeen.source,
                threadId: threadToMarkSeen.id,
                seenUpdatedAt: threadToMarkSeen.updatedAt,
              }),
            }));
          }
        }
      } finally {
        if (!cancelled) {
          setPendingSeenThreadKey(undefined);
        }
      }
    }

    void markSeen();

    return () => {
      cancelled = true;
    };
  }, [markThreadSeen, pendingSeenThreadKey, retainedUnreadThread, selectedThread]);

  const selectThread = useCallback((thread: NavigationThreadSummary): void => {
    const threadKey = buildThreadIdentityKey(thread.source, thread.id);
    releaseRetainedUnreadThread(threadKey);
    setCreateThreadError(undefined);
    setLaunchpadError(undefined);
    setArchiveThreadError(undefined);
    setSetThreadExecutionModeError(undefined);
    setSetThreadModelSettingsError(undefined);
    setSelectedItemKey(threadKey);
    setPendingSeenThreadKey(threadKey);
    if (thread.inbox.inInbox && thread.inbox.reason === "updated-since-seen") {
      setRetainedUnreadThread(thread);
    }
  }, [releaseRetainedUnreadThread]);

  const createThread = useCallback(
    async (
      backend?: AppServerBackendKind,
      executionMode: ThreadExecutionMode = "default"
    ): Promise<void> => {
      if (!desktopApi?.ensureDirectoryLaunchpad) {
        setCreateThreadError("Desktop bridge is missing ensureDirectoryLaunchpad().");
        return;
      }

      setCreatingThread({ backend: backend ?? "codex", executionMode });
      setCreateThreadError(undefined);
      setLaunchpadError(undefined);
      setArchiveThreadError(undefined);
      setSetThreadModelSettingsError(undefined);

      try {
        const workspaceDirectory = directories.find(
          (directory) => directory.kind === "workspace"
        );
        const directoryKey =
          workspaceDirectory?.key ?? ROOT_NEW_THREAD_WORKSPACE_LAUNCHPAD_KEY;
        const response = await desktopApi.ensureDirectoryLaunchpad({
          directoryKey,
          directoryKind: "workspace",
          directoryLabel: workspaceDirectory?.label ?? ROOT_NEW_THREAD_WORKSPACE_LABEL,
          directoryPath: workspaceDirectory?.path,
          preferredBackend: backend,
        });
        let launchpad = response.launchpad;
        let defaults: NavigationLaunchpadDefaults = response.defaults;
        if (
          executionMode !== response.launchpad.executionMode &&
          desktopApi.updateDirectoryLaunchpad
        ) {
          const updated = await desktopApi.updateDirectoryLaunchpad({
            directoryKey,
            patch: { executionMode },
          });
          launchpad = updated.launchpad;
          defaults = updated.defaults;
        }
        setState((current) => ({
          ...current,
          response: applyLaunchpadUpdate(current.response, launchpad, defaults),
        }));
        setSelectedItemKey(buildLaunchpadSelectionKey(directoryKey));
      } catch (error) {
        setCreateThreadError(error instanceof Error ? error.message : String(error));
      } finally {
        setCreatingThread(undefined);
      }
    },
    [desktopApi, directories]
  );

  const openDirectoryLaunchpad = useCallback(
    async (
      directory: NavigationDirectorySummary,
      preferredBackend?: AppServerBackendKind
    ): Promise<void> => {
      if (!desktopApi?.ensureDirectoryLaunchpad) {
        setLaunchpadError("Desktop bridge is missing ensureDirectoryLaunchpad().");
        return;
      }

      setLaunchpadError(undefined);
      setCreateThreadError(undefined);
      setArchiveThreadError(undefined);
      setSetThreadExecutionModeError(undefined);
      setSetThreadModelSettingsError(undefined);

      try {
        const response = await desktopApi.ensureDirectoryLaunchpad({
          directoryKey: directory.key,
          directoryKind: directory.kind,
          directoryLabel: directory.label,
          directoryPath: directory.path,
          currentBranch: directory.gitStatus?.currentBranch,
          preferredBackend,
        });
        setState((current) => ({
          ...current,
          response: applyLaunchpadUpdate(
            current.response,
            response.launchpad,
            response.defaults
          ),
        }));
        setSelectedItemKey(buildLaunchpadSelectionKey(directory.key));
      } catch (error) {
        setLaunchpadError(error instanceof Error ? error.message : String(error));
      }
    },
    [desktopApi]
  );

  const pickAndRegisterDirectory = useCallback(
    async (preferredBackend?: AppServerBackendKind): Promise<void> => {
      // Two-step OS-dialog → register-as-launchpad flow (issue #223).
      // We separate the cancel path (silent — the user closed the
      // dialog) from the validation-failure path (loud — we surface
      // the inline error so the picker can render it). The success
      // path navigates to the new directory's launchpad immediately
      // so the composer focuses the just-added directory without an
      // extra click.
      if (
        !desktopApi?.pickDirectoryFromDisk ||
        !desktopApi?.registerDirectoryFromDisk
      ) {
        setPickDirectoryError(
          "Desktop bridge is missing the directory picker.",
        );
        return;
      }

      setPickDirectoryError(undefined);
      setPickingDirectory(true);

      try {
        const pick = await desktopApi.pickDirectoryFromDisk();
        if (pick.canceled) {
          return;
        }
        const result = await desktopApi.registerDirectoryFromDisk({
          path: pick.path,
          preferredBackend,
        });
        if (!result.ok) {
          setPickDirectoryError(result.message);
          return;
        }
        setState((current) => ({
          ...current,
          response: applyLaunchpadUpdate(
            current.response,
            result.launchpad,
            result.defaults,
          ),
        }));
        setSelectedItemKey(buildLaunchpadSelectionKey(result.directoryKey));
      } catch (error) {
        setPickDirectoryError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setPickingDirectory(false);
      }
    },
    [desktopApi],
  );

  const clearPickDirectoryError = useCallback((): void => {
    setPickDirectoryError(undefined);
  }, []);

  const updateDirectoryLaunchpad = useCallback(
    async (
      directoryKey: string,
      patch: Parameters<NonNullable<DesktopApi["updateDirectoryLaunchpad"]>>[0]["patch"],
      options?: { stickySettingsChanged?: boolean }
    ): Promise<void> => {
      if (!desktopApi?.updateDirectoryLaunchpad) {
        setLaunchpadError("Desktop bridge is missing updateDirectoryLaunchpad().");
        return;
      }

      setLaunchpadError(undefined);
      const revision =
        (launchpadUpdateRevisionRef.current.get(directoryKey) ?? 0) + 1;
      launchpadUpdateRevisionRef.current.set(directoryKey, revision);

      setState((current) => {
        const currentResponse = current.response;
        const currentLaunchpad = currentResponse?.directories.find(
          (directory) => directory.key === directoryKey
        )?.launchpad;
        if (!currentResponse || !currentLaunchpad) {
          return current;
        }

        return {
          ...current,
          response: applyLaunchpadUpdate(
            currentResponse,
            {
              ...currentLaunchpad,
              ...patch,
              directoryKey,
              updatedAt: Date.now(),
            },
            currentResponse.launchpadDefaults
          ),
        };
      });

      try {
        const response = await desktopApi.updateDirectoryLaunchpad({
          directoryKey,
          patch,
          stickySettingsChanged: options?.stickySettingsChanged,
        });
        if (launchpadUpdateRevisionRef.current.get(directoryKey) !== revision) {
          return;
        }
        setState((current) => ({
          ...current,
          response: applyLaunchpadUpdate(
            current.response,
            response.launchpad,
            response.defaults
          ),
        }));
      } catch (error) {
        if (launchpadUpdateRevisionRef.current.get(directoryKey) !== revision) {
          return;
        }
        setLaunchpadError(error instanceof Error ? error.message : String(error));
      }
    },
    [desktopApi]
  );

  const resetDirectoryLaunchpad = useCallback(
    async (directoryKey: string): Promise<void> => {
      if (!desktopApi?.resetDirectoryLaunchpad) {
        setLaunchpadError("Desktop bridge is missing resetDirectoryLaunchpad().");
        return;
      }

      setLaunchpadError(undefined);

      try {
        const response = await desktopApi.resetDirectoryLaunchpad({ directoryKey });
        setState((current) => ({
          ...current,
          response: applyLaunchpadReset(
            current.response,
            response.directoryKey,
            response.defaults
          ),
        }));
        setSelectedItemKey((current) =>
          current === buildLaunchpadSelectionKey(directoryKey)
            ? getFallbackSelectionKey(
                state.response
                  ? applyLaunchpadReset(state.response, response.directoryKey, response.defaults)!
                  : {
                      backend: "all",
                      fetchedAt: Date.now(),
                      unchanged: false,
                      threads,
                      inboxThreadKeys: [],
                      directories,
                      launchpadDefaults: response.defaults,
                    },
                optimisticThread
                  ? buildThreadIdentityKey(optimisticThread.source, optimisticThread.id)
                  : undefined
              )
            : current
        );
      } catch (error) {
        setLaunchpadError(error instanceof Error ? error.message : String(error));
      }
    },
    [desktopApi, directories, optimisticThread, state.response, threads]
  );

  const materializeDirectoryLaunchpad = useCallback(
    async (
      directoryKey: string,
      input?: AppServerTurnInputItem[],
      collaborationMode?: AppServerCollaborationModeRequest,
      reviewTarget?: AppServerReviewTarget
    ): Promise<void> => {
      if (!desktopApi?.materializeDirectoryLaunchpad) {
        setLaunchpadError("Desktop bridge is missing materializeDirectoryLaunchpad().");
        return;
      }

      const directory = directories.find((candidate) => candidate.key === directoryKey);
      const launchpad = directory?.launchpad;
      if (!launchpad) {
        setLaunchpadError(`No launchpad found for ${directoryKey}.`);
        return;
      }

      setLaunchpadError(undefined);

      try {
        const response = await desktopApi.materializeDirectoryLaunchpad({
          directoryKey,
          launchpad,
          input,
          collaborationMode,
          reviewTarget,
        });
        const optimisticMaterializedThread = buildOptimisticThreadFromLaunchpad({
          directory,
          launchpad,
          backend: response.backend,
          threadId: response.threadId,
          executionMode: response.executionMode,
          workMode: response.workMode,
          optimisticUserMessage: buildOptimisticUserMessage(input),
        });
        const nextThreadKey = buildThreadIdentityKey(response.backend, response.threadId);
        setOptimisticThread(optimisticMaterializedThread);
        setSelectedItemKey(nextThreadKey);
        setPendingSeenThreadKey(nextThreadKey);
        setState((current) => ({
          ...current,
          response: current.response
            ? applyLaunchpadReset(
                current.response,
                directoryKey,
                current.response.launchpadDefaults
              )
            : current.response,
        }));
        await refresh(nextThreadKey, optimisticMaterializedThread);
      } catch (error) {
        setLaunchpadError(error instanceof Error ? error.message : String(error));
      }
    },
    [desktopApi, directories, refresh]
  );

  const archiveThread = useCallback(
    async (thread: NavigationThreadSummary): Promise<void> => {
      if (!archiveThreadRequest) {
        setArchiveThreadError("Desktop bridge is missing archiveThread().");
        return;
      }

      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
      const optimisticThreadKey = optimisticThread
        ? buildThreadIdentityKey(optimisticThread.source, optimisticThread.id)
        : undefined;

      suppressedArchivedThreadKeysRef.current.add(threadKey);
      setArchiveThreadError(undefined);
      setCreateThreadError(undefined);
      setLaunchpadError(undefined);
      setSetThreadExecutionModeError(undefined);
      setSetThreadModelSettingsError(undefined);
      setState((current) => ({
        ...current,
        response: removeThreadFromSnapshot(current.response, {
          backend: thread.source,
          threadId: thread.id,
        }),
      }));
      setSelectedItemKey((current) =>
        current === threadKey
          ? getFallbackSelectionAfterRemoval(state.response, {
              backend: thread.source,
              threadId: thread.id,
              optimisticThreadKey,
            })
          : current
      );
      setRetainedUnreadThread((current) =>
        current?.source === thread.source && current.id === thread.id ? undefined : current
      );
      setOptimisticThread((current) =>
        current?.source === thread.source && current.id === thread.id ? undefined : current
      );

      try {
        const response = await archiveThreadRequest({
          backend: thread.source,
          threadId: thread.id,
        });
        const cleanupFailure = formatArchiveCleanupFailure(response.cleanup);
        if (cleanupFailure) {
          setArchiveThreadError(cleanupFailure);
        }
        await refresh();
      } catch (error) {
        suppressedArchivedThreadKeysRef.current.delete(threadKey);
        setArchiveThreadError(error instanceof Error ? error.message : String(error));
        await refresh(threadKey, undefined, true);
      }
    },
    [archiveThreadRequest, optimisticThread, refresh, state.response]
  );

  const archiveWorktree = useCallback(
    async (
      thread: NavigationThreadSummary,
      directory: LinkedDirectorySummary
    ): Promise<void> => {
      if (!archiveWorktreeRequest) {
        setWorktreeArchiveError("Desktop bridge is missing archiveWorktree().");
        return;
      }

      const worktreePath = directory.worktreePath ?? directory.path;
      setWorktreeArchiveError(undefined);
      setArchiveThreadError(undefined);

      try {
        await archiveWorktreeRequest({
          backend: thread.source,
          threadId: thread.id,
          repositoryPath: directory.path,
          worktreePath,
        });
        await refresh(buildThreadIdentityKey(thread.source, thread.id));
      } catch (error) {
        setWorktreeArchiveError(error instanceof Error ? error.message : String(error));
      }
    },
    [archiveWorktreeRequest, refresh]
  );

  const restoreWorktree = useCallback(
    async (
      thread: NavigationThreadSummary,
      snapshotRef: string,
      worktreePath: string
    ): Promise<void> => {
      if (!restoreWorktreeRequest) {
        setWorktreeArchiveError("Desktop bridge is missing restoreWorktree().");
        return;
      }

      setWorktreeArchiveError(undefined);
      setArchiveThreadError(undefined);

      try {
        await restoreWorktreeRequest({
          backend: thread.source,
          threadId: thread.id,
          snapshotRef,
          worktreePath,
        });
        await refresh(buildThreadIdentityKey(thread.source, thread.id));
      } catch (error) {
        setWorktreeArchiveError(error instanceof Error ? error.message : String(error));
      }
    },
    [refresh, restoreWorktreeRequest]
  );

  const handoffThreadWorkspace = useCallback(
    async (
      thread: NavigationThreadSummary,
      request: Omit<HandoffThreadWorkspaceRequest, "backend" | "threadId">
    ): Promise<void> => {
      if (!handoffThreadWorkspaceRequest) {
        const error = new Error("Desktop bridge is missing handoffThreadWorkspace().");
        setWorktreeArchiveError(error.message);
        throw error;
      }

      setWorktreeArchiveError(undefined);
      setArchiveThreadError(undefined);

      try {
        await handoffThreadWorkspaceRequest({
          ...request,
          backend: thread.source,
          threadId: thread.id,
        });
        await refresh(buildThreadIdentityKey(thread.source, thread.id));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setWorktreeArchiveError(message);
        throw error;
      }
    },
    [handoffThreadWorkspaceRequest, refresh]
  );

  const renameThread = useCallback(
    async (thread: NavigationThreadSummary, name: string): Promise<void> => {
      const nextName = name.trim();
      const threadKey = buildThreadIdentityKey(thread.source, thread.id);

      if (!nextName) {
        setRenameThreadError("Thread name cannot be blank.");
        return;
      }

      if (!renameThreadRequest) {
        setRenameThreadError("Desktop bridge is missing renameThread().");
        return;
      }

      setRenameThreadError(undefined);
      setArchiveThreadError(undefined);
      setCreateThreadError(undefined);
      setLaunchpadError(undefined);
      setSetThreadExecutionModeError(undefined);
      setSetThreadModelSettingsError(undefined);
      setState((current) => ({
        ...current,
        response: applyThreadNameUpdate(current.response, {
          backend: thread.source,
          threadId: thread.id,
          threadName: nextName,
        }),
      }));
      setRetainedUnreadThread((current) =>
        current?.source === thread.source && current.id === thread.id
          ? {
              ...current,
              title: nextName,
              titleSource: "explicit",
            }
          : current
      );
      setOptimisticThread((current) =>
        current?.source === thread.source && current.id === thread.id
          ? {
              ...current,
              title: nextName,
              titleSource: "explicit",
            }
          : current
      );

      try {
        await renameThreadRequest({
          backend: thread.source,
          threadId: thread.id,
          name: nextName,
        });
        await refresh(threadKey);
      } catch (error) {
        setRenameThreadError(error instanceof Error ? error.message : String(error));
        await refresh(threadKey);
      }
    },
    [refresh, renameThreadRequest]
  );

  const setThreadReactionRequest = desktopApi?.setThreadReaction;
  const setThreadPinRequest = desktopApi?.setThreadPin;
  const reorderThreadPinsRequest = desktopApi?.reorderThreadPins;
  const setThreadReaction = useCallback(
    async (
      thread: NavigationThreadSummary,
      emoji: string,
      present: boolean,
    ): Promise<void> => {
      if (!setThreadReactionRequest) {
        return;
      }

      // Optimistic update so the chip appears/disappears instantly.
      const currentReactions = thread.reactions ?? [];
      const optimisticReactions = present
        ? [...currentReactions.filter((existing) => existing !== emoji), emoji]
        : currentReactions.filter((existing) => existing !== emoji);
      setState((current) => ({
        ...current,
        response: updateThreadReactionsInSnapshot(current.response, {
          backend: thread.source,
          threadId: thread.id,
          reactions: optimisticReactions,
        }),
      }));

      try {
        const result = await setThreadReactionRequest({
          backend: thread.source,
          threadId: thread.id,
          emoji,
          present,
        });
        // Reconcile with the authoritative server response (handles races).
        setState((current) => ({
          ...current,
          response: updateThreadReactionsInSnapshot(current.response, {
            backend: thread.source,
            threadId: thread.id,
            reactions: result.reactions,
          }),
        }));
      } catch {
        // On failure, fall back to the next snapshot poll.
      }
    },
    [setThreadReactionRequest],
  );

  const setThreadPin = useCallback(
    async (
      thread: NavigationThreadSummary,
      pinned: boolean,
    ): Promise<void> => {
      if (!setThreadPinRequest) {
        return;
      }

      const pinnedRank = pinned
        ? thread.pinnedRank ?? buildAppendPinRank(
            (state.response?.threads ?? [])
              .filter((candidate) => candidate.source === thread.source)
              .map((candidate) => candidate.pinnedRank),
          )
        : undefined;

      setState((current) => ({
        ...current,
        response: updateThreadPinInSnapshot(current.response, {
          backend: thread.source,
          threadId: thread.id,
          pinnedRank,
        }),
      }));

      try {
        const result = await setThreadPinRequest({
          backend: thread.source,
          threadId: thread.id,
          pinnedRank,
        });
        setState((current) => ({
          ...current,
          response: updateThreadPinInSnapshot(current.response, {
            backend: result.backend,
            threadId: result.threadId,
            pinnedRank: result.pinnedRank,
          }),
        }));
      } catch {
        await refresh(buildThreadIdentityKey(thread.source, thread.id));
      }
    },
    [refresh, setThreadPinRequest, state.response?.threads],
  );

  const reorderThreadPins = useCallback(
    async (
      backend: AppServerBackendKind,
      threadIds: string[],
    ): Promise<void> => {
      if (!reorderThreadPinsRequest) {
        return;
      }

      const pinnedRanks = buildPinnedRanks(threadIds);
      setState((current) => ({
        ...current,
        response: updateThreadPinsInSnapshot(current.response, {
          backend,
          pinnedRanks,
        }),
      }));

      try {
        const result = await reorderThreadPinsRequest({
          backend,
          threadIds,
        });
        setState((current) => ({
          ...current,
          response: updateThreadPinsInSnapshot(current.response, {
            backend: result.backend,
            pinnedRanks: result.pinnedRanks,
          }),
        }));
      } catch {
        await refresh();
      }
    },
    [refresh, reorderThreadPinsRequest],
  );

  const updateThreadExecutionMode = useCallback(
    async (
      thread: NavigationThreadSummary,
      executionMode: ThreadExecutionMode
    ): Promise<void> => {
      if (!setThreadExecutionMode) {
        setSetThreadExecutionModeError(
          "Desktop bridge is missing setThreadExecutionMode()."
        );
        return;
      }

      setUpdatingThreadExecutionMode(executionMode);
      setSetThreadExecutionModeError(undefined);
      // No optimistic flip of `executionMode` here. Two cases:
      //
      // 1. Thread is idle → registry applies immediately. The
      //    `thread/executionMode/updated` bus event arrives within a
      //    network round-trip (~50ms locally) and drives the visible
      //    state via `applyThreadExecutionModeUpdate`.
      //
      // 2. Thread has an active turn → registry queues the change.
      //    The `thread/executionMode/queued` bus event arrives and
      //    sets `queuedExecutionMode` on the snapshot, leaving
      //    `executionMode` at its applied value. The Composer
      //    queue-indicator block renders because
      //    `queuedExecutionMode !== executionMode`.
      //
      // An optimistic flip of `executionMode` here would break case
      // (2): the queue would arrive with `queuedExecutionMode` equal
      // to the optimistic value (and equal to `executionMode`), so
      // the indicator would never render — the user would see the
      // chip flip and assume the change took effect immediately.
      // The `setUpdatingThreadExecutionMode(executionMode)` indicator
      // above gives users a "click registered" signal during the
      // round-trip without lying about applied state.

      try {
        await setThreadExecutionMode({
          backend: thread.source,
          threadId: thread.id,
          executionMode,
        });
        await refresh(buildThreadIdentityKey(thread.source, thread.id));
      } catch (error) {
        setSetThreadExecutionModeError(error instanceof Error ? error.message : String(error));
        await refresh(buildThreadIdentityKey(thread.source, thread.id));
      } finally {
        setUpdatingThreadExecutionMode(undefined);
      }
    },
    [refresh, setThreadExecutionMode]
  );

  const cancelThreadExecutionModeQueue = useCallback(
    async (thread: NavigationThreadSummary): Promise<void> => {
      if (!cancelThreadExecutionModeQueueRequest) {
        setSetThreadExecutionModeError(
          "Desktop bridge is missing cancelThreadExecutionModeQueue()."
        );
        return;
      }
      setSetThreadExecutionModeError(undefined);
      try {
        await cancelThreadExecutionModeQueueRequest({
          backend: thread.source,
          threadId: thread.id,
        });
        await refresh(buildThreadIdentityKey(thread.source, thread.id));
      } catch (error) {
        setSetThreadExecutionModeError(
          error instanceof Error ? error.message : String(error)
        );
        await refresh(buildThreadIdentityKey(thread.source, thread.id));
      }
    },
    [cancelThreadExecutionModeQueueRequest, refresh]
  );

  const updateThreadModelSettings = useCallback(
    async (
      thread: NavigationThreadSummary,
      patch: Partial<
        Pick<
          NavigationThreadSummary,
          "model" | "reasoningEffort" | "serviceTier" | "fastMode"
        >
      >
    ): Promise<void> => {
      if (!setThreadModelSettings) {
        setSetThreadModelSettingsError(
          "Desktop bridge is missing setThreadModelSettings()."
        );
        return;
      }

      const nextSettings = {
        model: "model" in patch ? patch.model : thread.model,
        reasoningEffort:
          "reasoningEffort" in patch
            ? patch.reasoningEffort
            : thread.reasoningEffort,
        serviceTier: "serviceTier" in patch ? patch.serviceTier : thread.serviceTier,
        fastMode:
          thread.source === "codex"
            ? "fastMode" in patch
              ? patch.fastMode
              : thread.fastMode
            : undefined,
      };

      setSetThreadModelSettingsError(undefined);
      setOptimisticThread((current) =>
        current && current.id === thread.id && current.source === thread.source
          ? { ...current, ...nextSettings }
          : current
      );
      setState((current) => ({
        ...current,
        response: applyThreadModelSettingsUpdate(current.response, {
          backend: thread.source,
          threadId: thread.id,
          ...nextSettings,
        }),
      }));

      try {
        await setThreadModelSettings({
          backend: thread.source,
          threadId: thread.id,
          ...nextSettings,
        });
      } catch (error) {
        setSetThreadModelSettingsError(
          error instanceof Error ? error.message : String(error)
        );
        await refresh(buildThreadIdentityKey(thread.source, thread.id));
      }
    },
    [refresh, setThreadModelSettings]
  );

  return {
    browseMode,
    createThread,
    createThreadError,
    creatingThread,
    directories,
    error: state.error,
    inboxThreads,
    launchpadError,
    archiveThreadError,
    worktreeArchiveError,
    renameThreadError,
    loading: state.loading,
    refreshing: state.refreshing,
    refresh: refreshNavigation,
    materializeDirectoryLaunchpad,
    openDirectoryLaunchpad,
    pickAndRegisterDirectory,
    pickDirectoryError,
    pickingDirectory,
    clearPickDirectoryError,
    resetDirectoryLaunchpad,
    selectedDirectory,
    selectedItemKey,
    selectedLaunchpad,
    selectedThread,
    selectedThreadKey,
    setThreadExecutionMode: updateThreadExecutionMode,
    setThreadExecutionModeError,
    cancelThreadExecutionModeQueue,
    setThreadModelSettings: updateThreadModelSettings,
    setThreadModelSettingsError,
    updatingThreadExecutionMode,
    updateDirectoryLaunchpad,
    setBrowseMode,
    selectThread,
    archiveThread,
    archiveWorktree,
    restoreWorktree,
    handoffThreadWorkspace,
    renameThread,
    setThreadReaction,
    setThreadPin,
    reorderThreadPins,
    snapshot: state.response,
    threads,
  };
}
