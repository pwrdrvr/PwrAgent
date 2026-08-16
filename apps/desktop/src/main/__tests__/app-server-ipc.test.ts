import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ArchiveWorktreeRequest,
  ArchiveThreadRequest,
  AppServerListThreadsRequest,
  AppServerReadThreadResponse,
  AppServerThreadSummary,
  GetNavigationSnapshotRequest,
  HandoffThreadWorkspaceRequest,
  MarkThreadSeenRequest,
  PrSummary,
  RefreshThreadPullRequestsRequest,
  RenameThreadRequest,
  RestoreWorktreeRequest,
  RestoreThreadRequest,
  SetThreadParentRequest,
  ThreadGitWorkingState,
} from "@pwragent/shared";

const mockAppServerLog = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));
const backendRegistryLifecycle = vi.hoisted(() => ({
  existing: true,
  get: vi.fn(),
}));
const federationMock = vi.hoisted(() => {
  const remoteBackend = {
    archiveThread: vi.fn(async (request: ArchiveThreadRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      archivedAt: 6_000,
      cleanup: [],
    })),
    markThreadSeen: vi.fn(async (request: MarkThreadSeenRequest) => ({
      backend: request.backend ?? "codex",
      threadId: request.threadId,
      seenAt: request.seenAt ?? 6_000,
      seenUpdatedAt: request.seenUpdatedAt,
    })),
    setThreadReaction: vi.fn(async (request: {
      backend?: "codex" | "acp:grok";
      threadId: string;
    }) => ({
      backend: request.backend ?? "codex",
      threadId: request.threadId,
      reactions: ["✋", "👀"],
    })),
    setThreadParent: vi.fn(async (request: SetThreadParentRequest) => ({
      backend: request.backend ?? "codex",
      threadId: request.threadId,
      parentThreadId: request.parentThreadId ?? undefined,
      parentThreadBackend: request.parentThreadBackend ?? undefined,
      parentThreadInstanceId: request.parentThreadInstanceId ?? undefined,
    })),
    renameThread: vi.fn(async (request: RenameThreadRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      renamedAt: 6_000,
    })),
    refreshDirectoryGitStatuses: vi.fn(async () => ({ scheduledCount: 1 })),
    ensureDirectoryLaunchpad: vi.fn(),
    listRecentFileReferences: vi.fn(async () => ({
      files: [] as Array<{ label: string; path: string }>,
    })),
    recordRecentFileReferences: vi.fn(async () => undefined),
    attachDirectoryToThread: vi.fn(),
    listWorktreeUnpublishedCommits: vi.fn(async () => ({
      commits: [],
      totalCommits: 0,
      truncated: false,
      maxCommits: 20,
      maxFilesPerCommit: 50,
    })),
    getWorktreeUnpublishedCommitDiff: vi.fn(async () => ({})),
  };
  const remoteThreadSummaries = {
    resolvePinnedThreads: vi.fn(
      async (): Promise<{
        threads: unknown[];
        refreshed: unknown[];
        archived: unknown[];
      }> => ({
        threads: [],
        refreshed: [],
        archived: [],
      }),
    ),
    searchForJump: vi.fn(async () => ({ results: [] })),
    threadFromPeer: vi.fn(async (): Promise<unknown> => undefined),
    rememberThreadNames: vi.fn(),
    invalidate: vi.fn(),
  };
  return {
    remoteBackend,
    remoteThreadSummaries,
    runtime: {
      health: vi.fn(async () => ({ instanceId: "pwr_local" })),
      hydrateThreadMessageOrigins: vi.fn(async (response) => response),
      remoteBackend: vi.fn(() => remoteBackend),
      remoteTargetSupportsCapability: vi.fn(() => true),
      remoteNavigationSnapshot: vi.fn(),
      remoteThreadSummaries: vi.fn(() => remoteThreadSummaries),
      ungroupRemoteChildrenOfArchivedThread: vi.fn(async () => undefined),
    },
  };
});

const prAutoDispatchBudgetStatusSend = vi.hoisted(() => vi.fn());

const prAutomationSettings = vi.hoisted(() => {
  const state = {
    backgroundPrPollingEnabled: true,
    budgetPaused: false,
    budgetPausedAt: 1_000,
    pauseWhenBudgetEmpty: true,
    prAutoDispatchAllowed: true,
    budgetCapacity: 30,
    budgetRefillPerMinute: 1,
  };
  const configWrittenListeners = new Set<() => void>();
  return {
    state,
    onConfigWritten: vi.fn((listener: () => void) => {
      configWrittenListeners.add(listener);
      return () => configWrittenListeners.delete(listener);
    }),
    emitConfigWritten: () => {
      for (const listener of configWrittenListeners) {
        listener();
      }
    },
    resetConfigWrittenListeners: () => configWrittenListeners.clear(),
    readSettings: vi.fn(async () => ({
      git: {
        backgroundPrPolling: {
          value: state.backgroundPrPollingEnabled,
        },
        prAutoDispatchAllowed: {
          value: state.prAutoDispatchAllowed,
        },
        prAutoDispatchBudgetCapacity: {
          value: state.budgetCapacity,
        },
        prAutoDispatchBudgetRefillPerMinute: {
          value: state.budgetRefillPerMinute,
        },
        pausePrAutoDispatchWhenBudgetEmpty: {
          value: state.pauseWhenBudgetEmpty,
        },
      },
    })),
  };
});

const resolveGitHubRepoForDirectory = vi.hoisted(() =>
  vi.fn(
    async (): Promise<
      { host: string; owner: string; repo: string } | undefined
    > => undefined,
  ),
);
const resolveGitHubReposForDirectory = vi.hoisted(() =>
  vi.fn(
    async (): Promise<
      Array<{ host: string; owner: string; repo: string }>
    > => [],
  ),
);

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const listThreads = vi.fn(async (request?: {
  archived?: boolean;
  backend?: "codex" | "acp:grok";
  filter?: string;
  forceRefresh?: boolean;
  limit?: number;
  maxPages?: number;
  skipArchivedMetadataRefresh?: boolean;
}) =>
  request?.archived
    ? [
        {
          id: "thread-archived",
          title: "Archived thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          updatedAt: 500,
        },
      ]
    : [
        {
          id: "thread-1",
          title: "Thread one",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          updatedAt: 2000,
        },
        {
          id: "thread-1",
          title: "Thread one (Grok)",
          titleSource: "explicit" as const,
          source: "acp:grok" as const,
          linkedDirectories: [],
          updatedAt: 1000,
        },
      ]
);
const readThread = vi.fn(async ({ threadId }: { threadId: string }) => ({
  messages: [{ id: `${threadId}-message`, role: "assistant" as const, text: "Loaded" }],
  pagination: {
    supportsPagination: false,
    hasPreviousPage: false,
  },
}));
const getThreadTranscriptImageRoots = vi.fn(async () => [] as string[]);
const archiveThread = vi.fn(async (request: ArchiveThreadRequest) => ({
  backend: request.backend ?? "codex",
  threadId: request.threadId,
  archivedAt: 3000,
  cleanup: [],
}));
const restoreThread = vi.fn(async (request: RestoreThreadRequest) => ({
  backend: request.backend ?? "codex",
  threadId: request.threadId,
  restoredAt: 3000,
}));
const archiveWorktree = vi.fn(async (request: ArchiveWorktreeRequest) => ({
  backend: request.backend,
  threadId: request.threadId,
  archivedAt: 3000,
  snapshot: {
    id: "snapshot-1",
    backend: request.backend,
    threadId: request.threadId,
    worktreePath: request.worktreePath,
    repositoryPath: request.repositoryPath ?? "/repo",
    snapshotRef: "refs/codex/snapshots/snapshot-1",
    snapshotCommit: "abc123",
    createdAt: 3000,
    archivedAt: 3000,
    state: "archived" as const,
    ignoredFilesExcluded: true,
  },
}));
const restoreWorktree = vi.fn(async (request: RestoreWorktreeRequest) => ({
  backend: request.backend,
  threadId: request.threadId,
  restoredAt: 4000,
  snapshot: {
    id: "snapshot-1",
    backend: request.backend,
    threadId: request.threadId,
    worktreePath: request.worktreePath,
    repositoryPath: request.repositoryPath ?? "/repo",
    snapshotRef: request.snapshotRef ?? "refs/codex/snapshots/snapshot-1",
    snapshotCommit: "abc123",
    createdAt: 3000,
    archivedAt: 3000,
    restoredAt: 4000,
    state: "restored" as const,
    ignoredFilesExcluded: true,
  },
}));
const handoffThreadWorkspace = vi.fn(async (request: HandoffThreadWorkspaceRequest) => ({
  backend: request.backend,
  threadId: request.threadId,
  direction: request.direction,
  workMode: request.direction === "local-to-worktree" ? "worktree" as const : "local" as const,
  branch: request.sourceBranch ?? "feature/handoff",
  repositoryPath: request.repositoryPath ?? "/repo",
  targetPath: "/repo/.worktrees/app-feature-handoff",
  linkedDirectory: {
    id: "pwragent-handoff:codex:thread-1",
    label: "app",
    path: request.repositoryPath ?? "/repo",
    worktreePath: "/repo/.worktrees/app-feature-handoff",
    kind: "worktree" as const,
  },
  warnings: [],
  completedAt: 5000,
}));
const renameThread = vi.fn(async (request: RenameThreadRequest) => ({
  backend: request.backend ?? "codex",
  threadId: request.threadId,
  renamedAt: 3000,
}));
const reconcileNavigationSnapshot = vi.fn(async (params: unknown) => ({
  backend: (params as { backend: "all" | "codex" | "acp:grok" }).backend,
  fetchedAt: 1234,
  unchanged: false,
  // Mirror the real reconcile: every materialized row carries a derived
  // inbox state, consistent with the inboxThreadKeys below. The remote-pin
  // merge re-ranks the combined local + remote rows from these states.
  threads: (params as { threads: Array<{ source: string; id: string }> }).threads.map(
    (thread) => ({
      inbox:
        `${thread.source}:${thread.id}` === "acp:grok:thread-1"
          ? { inInbox: true, reason: "updated-since-seen" as const }
          : { inInbox: false },
      ...thread,
    }),
  ) as unknown[],
  inboxThreadKeys: ["acp:grok:thread-1"],
  directories: [
    {
      key: "directory:/repo/app",
      kind: "directory" as const,
      label: "app",
      path: "/repo/app",
      threadKeys: ["codex:thread-1"],
      needsAttentionCount: 1,
      latestUpdatedAt: 2000,
    },
  ],
  launchpadDefaults: {
    backend: "codex" as const,
    executionMode: "default" as const,
  },
}));
const rememberCompleteNavigationSnapshot = vi.fn();
const listRemoteThreadPins = vi.fn(async (): Promise<unknown[]> => []);
const updateRemoteThreadPinSnapshots = vi.fn(async () => {});
const removeRemoteThreadPinStore = vi.fn(async () => true);
const addRemoteThreadPinStore = vi.fn(
  async (params: { ref: unknown; instanceLabel: string }) => ({
    ref: params.ref,
    addedAt: 1_000,
    instanceLabel: params.instanceLabel,
  }),
);
const hasRemoteThreadPin = vi.fn(async () => false);
const setRemoteThreadLocalPin = vi.fn(
  async (params: { pinnedRank?: string | null }) => ({
    ...(params.pinnedRank ? { pinnedRank: params.pinnedRank } : {}),
  }),
);
const setThreadPinOverlay = vi.fn(
  async (params: { backend: string; threadId: string; pinnedRank?: string | null }) => ({
    backend: params.backend,
    threadId: params.threadId,
    executionMode: "default" as const,
    extraLinkedDirectories: [],
    pinnedRank: params.pinnedRank ?? undefined,
  }),
);
const setDirectoryThreadsCollapsedOverlay = vi.fn(async (params: {
  directoryKey: string;
  collapsed: boolean;
}) => ({
  directoryKey: params.directoryKey,
  directoryThreadsCollapsed: params.collapsed,
}));
const setRemoteDirectoryThreadsCollapsedOverlay = vi.fn(async (params: {
  instanceId: string;
  directoryKey: string;
  collapsed: boolean;
}) => ({
  directoryKey: params.directoryKey,
  directoryThreadsCollapsed: params.collapsed,
}));
const readRemoteDirectoryOverlays = vi.fn(async (): Promise<
  Record<string, { directoryKey: string; directoryThreadsCollapsed?: boolean }>
> => ({}));
const listPinnedThreadOverlayRanks = vi.fn(
  async (): Promise<Array<{ pinnedRank: string; parentThreadId?: string }>> => [],
);
const reorderThreadPinsStore = vi.fn(
  async (params: { threadKeys: string[] }): Promise<Record<string, string>> =>
    Object.fromEntries(
      params.threadKeys.map((threadKey, index) => [
        threadKey,
        String((index + 1) * 1024),
      ]),
    ),
);
const readDirectoryStatuses = vi.fn(async () => ({
  "directory:/repo/app": {
    currentBranch: "main",
    upstreamBranch: "origin/main",
    ahead: 0,
    behind: 0,
    syncState: "in-sync" as const,
    branches: ["main"],
  },
}));
const directoryGitStatus = {
  currentBranch: "main",
  upstreamBranch: "origin/main",
  ahead: 0,
  behind: 0,
  syncState: "in-sync" as const,
  branches: ["main"],
};
const readDirectoryStatusEntries = vi.fn((directories: Array<{ key: string }>) =>
  (async function* () {
    for (const directory of directories) {
      yield {
        directoryKey: directory.key,
        gitStatus: directoryGitStatus,
      };
    }
  })(),
);
const readDirectoryGitStatusCache = vi.fn(async () => ({}));
const writeDirectoryGitStatusCacheEntry = vi.fn(async () => undefined);
const invalidateDirectoryStatus = vi.fn((_directoryPath?: string) => undefined);
const readThreadGitWorkingStateCache = vi.fn(async () => ({}));
const writeThreadGitWorkingStateCacheEntry = vi.fn(async (_entry?: {
  worktreePath: string;
  fetchedAt: number;
  gitWorkingState?: ThreadGitWorkingState;
}) => undefined);
const hydrateThreadGitWorkingStates = vi.fn(
  async (threads: AppServerThreadSummary[]) => threads,
);
const rememberThreadGitWorkingStateCacheEntry = vi.fn(async (entry: {
  worktreePath: string;
  fetchedAt: number;
  gitWorkingState?: ThreadGitWorkingState;
}) => {
  await writeThreadGitWorkingStateCacheEntry(entry);
});
type WorkingStateEntry = {
  worktreePath: string;
  gitWorkingState?: {
    dirtyFiles: number;
    dirtyAdditions: number;
    dirtyDeletions: number;
    untrackedFiles: number;
    unpushedCommits: number;
    baseBranch?: string;
  };
};
const readWorktreeWorkingStateEntries = vi.fn(
  (
    worktreePaths: string[],
    _options?: {
      acceptedPushedCommitShasByWorktreePath?: Record<string, string[] | undefined>;
    },
  ): AsyncGenerator<WorkingStateEntry> =>
    (async function* () {
      for (const worktreePath of worktreePaths) {
        yield { worktreePath } satisfies WorkingStateEntry;
      }
    })(),
);
const invalidateWorktreeWorkingState = vi.fn((_worktreePath?: string) => undefined);
// Hold the result until the test releases it, so two concurrent IPC requests
// overlap and exercise the in-flight dedup.
let releaseEditCommitResolve: (() => void) | undefined;
const resolveEditCommitStates = vi.fn(
  async (): Promise<Record<string, unknown>> => {
    await new Promise<void>((resolve) => {
      releaseEditCommitResolve = resolve;
    });
    return { "g-1": { committed: false } };
  },
);
const registryEventListeners: Array<(event: unknown) => void> = [];
const onEvent = vi.fn((listener: (event: unknown) => void) => {
  registryEventListeners.push(listener);
  return () => {
    const index = registryEventListeners.indexOf(listener);
    if (index >= 0) {
      registryEventListeners.splice(index, 1);
    }
  };
});
function emitRegistryEvent(event: unknown): void {
  for (const listener of [...registryEventListeners]) {
    listener(event);
  }
}
const publishLocalEvent = vi.fn(async () => undefined);
const setThreadPullRequestStatusToolHandler = vi.fn();
const setThreadPullRequestCanonicalizer = vi.fn();
const setLocalPullRequestAuthorityResolver = vi.fn();
const setThreadPullRequestWatchToolHandler = vi.fn();
const setThreadPrAutoDispatchHandler = vi.fn();
const setThreadPullRequestDetachHandler = vi.fn();
const setDirectoryGitStatusWriter = vi.fn();
const setThreadPrAutoDispatchBatch = vi.fn(async () => undefined);
const ensureDirectoryLaunchpad = vi.fn(async (request: {
  directoryKey: string;
  directoryKind: string;
  directoryLabel: string;
  directoryPath?: string;
  currentBranch?: string;
}) => ({
  launchpad: {
    directoryKey: request.directoryKey,
    directoryKind: request.directoryKind,
    directoryLabel: request.directoryLabel,
    directoryPath: request.directoryPath,
    backend: "codex",
    executionMode: "default",
    prompt: "",
    branchName: request.currentBranch,
    createdAt: 1000,
    updatedAt: 1000,
  },
  defaults: {
    backend: "codex",
    executionMode: "default",
  },
}));
const updateDirectoryLaunchpad = vi.fn(async (request: {
  directoryKey: string;
  patch: { branchName?: string };
}) => ({
  launchpad: {
    directoryKey: request.directoryKey,
    directoryKind: "directory" as const,
    directoryLabel: "app",
    directoryPath: "/repo/app",
    backend: "codex" as const,
    executionMode: "default" as const,
    prompt: "viewer draft",
    branchName: request.patch.branchName,
    createdAt: 1000,
    updatedAt: 1001,
  },
  defaults: {
    backend: "codex" as const,
    executionMode: "default" as const,
  },
}));
const markThreadSeen = vi.fn(async (request: MarkThreadSeenRequest) => ({
  backend: request.backend ?? "codex",
  threadId: request.threadId,
  seenAt: request.seenAt ?? 2000,
  seenUpdatedAt: request.seenUpdatedAt,
}));
const setThreadReactionOverlay = vi.fn(async (request: {
  backend: "codex" | "acp:grok";
  threadId: string;
  emoji: string;
}) => ({
  backend: request.backend,
  threadId: request.threadId,
  executionMode: "default" as const,
  extraLinkedDirectories: [],
  reactions: [request.emoji],
}));
const registerDirectoryFromDiskService = vi.fn(async (request: { path: string }) => {
  const directoryPath = path.resolve(request.path);
  return {
    ok: true as const,
    directoryKey: `directory:${directoryPath}`,
    directoryPath,
    directoryLabel: path.basename(directoryPath) || directoryPath,
    currentBranch: "main",
    launchpad: {
      directoryKey: `directory:${directoryPath}`,
      directoryKind: "directory" as const,
      directoryLabel: path.basename(directoryPath) || directoryPath,
      directoryPath,
      backend: "codex" as const,
      executionMode: "default" as const,
      prompt: "",
      branchName: "main",
      workMode: "local" as const,
      createdAt: 1000,
      updatedAt: 1000,
    },
    defaults: {
      backend: "codex" as const,
      executionMode: "default" as const,
    },
  };
});
const getThreadOverlayState = vi.fn();
const getThreadOverlayStates = vi.fn(async () => ({}));
const addLinkedDirectory = vi.fn(async (request: {
  backend: "codex" | "acp:grok";
  threadId: string;
  directory: unknown;
}) => ({
  backend: request.backend,
  threadId: request.threadId,
  executionMode: "default" as const,
  extraLinkedDirectories: [request.directory],
}));
const removeLinkedDirectory = vi.fn(async (request: {
  backend: "codex" | "acp:grok";
  threadId: string;
  directory: unknown;
}) => ({
  backend: request.backend,
  threadId: request.threadId,
  executionMode: "default" as const,
  extraLinkedDirectories: [],
}));
const setThreadPullRequests = vi.fn(async (request: {
  backend: "codex" | "acp:grok";
  threadId: string;
  prs: PrSummary[];
  fetchedAt?: number;
  refreshKey?: string;
}) => ({
  backend: request.backend,
  threadId: request.threadId,
  executionMode: "default" as const,
  extraLinkedDirectories: [],
  prs: request.prs,
  prsFetchedAt: request.fetchedAt ?? Date.now(),
  prsRefreshKey: request.refreshKey,
}));
const addThreadPullRequestReference = vi.fn(async (request: {
  backend: "codex" | "acp:grok";
  threadId: string;
  pr: PrSummary;
}) => ({
  backend: request.backend,
  threadId: request.threadId,
  executionMode: "default" as const,
  extraLinkedDirectories: [],
  prs: [request.pr],
}));
const readPrStatusCache = vi.fn(async () => ({}));
const writePrStatusCacheEntries = vi.fn(async () => undefined);
const readPrLookupCache = vi.fn(async () => ({}));
const writePrLookupCacheEntry = vi.fn(async () => undefined);
const syncThreadPrAutoDispatchCandidates = vi.fn(async () => undefined);
const getPrAutoDispatchCandidateWinner = vi.fn(async () => undefined);
const resetThreadPrAutoDispatchForOperator = vi.fn(async () => false);
const getPrAutoDispatchBudgetStatus = vi.fn(async (params: {
  config: {
    capacity: number;
    refillPerMinute: number;
    pauseWhenEmpty: boolean;
  };
}) => ({
  availableTokens: prAutomationSettings.state.budgetPaused ? 0 : params.config.capacity,
  capacity: params.config.capacity,
  refillPerMinute: params.config.refillPerMinute,
  paused: prAutomationSettings.state.budgetPaused,
  ...(prAutomationSettings.state.budgetPaused
    ? { pausedAt: prAutomationSettings.state.budgetPausedAt }
    : {}),
}));
const resumePrAutoDispatchBudget = vi.fn(async (params: {
  config: {
    capacity: number;
    refillPerMinute: number;
    pauseWhenEmpty: boolean;
  };
}) => {
  prAutomationSettings.state.budgetPaused = false;
  return {
    availableTokens: 0,
    capacity: params.config.capacity,
    refillPerMinute: params.config.refillPerMinute,
    paused: false,
  };
});
const scheduleThreadPrAutoDispatch = vi.fn(async () => ({
  status: "disabled" as const,
}));
const beginThreadPrAutoDispatch = vi.fn(async () => ({
  status: "disabled" as const,
}));
const restoreThreadPrAutoDispatchAfterBusy = vi.fn(async () => undefined);
const renewThreadPrAutoDispatchLease = vi.fn(async () => false);
const finishThreadPrAutoDispatch = vi.fn(async () => undefined);
const cancelThreadPrAutoDispatch = vi.fn(async () => false);
const cancelPendingThreadPrAutoDispatchForPr = vi.fn(async () => false);
const resolveThreadPrAutoDispatchIncident = vi.fn(async () => undefined);
const getThreadPrAutoDispatchPending = vi.fn(async () => undefined);
const listPendingThreadPrAutoDispatches = vi.fn(async () => []);
const recoverOrphanedThreadPrAutoDispatches = vi.fn(async () => ({
  recoveredCount: 0,
}));
const registerThreadPrStatusWatch = vi.fn(async ({ watch }) => ({
  status: "watching" as const,
  watch,
}));
const claimThreadPrStatusWatches = vi.fn(async () => []);
const releaseThreadPrStatusWatch = vi.fn(async () => undefined);
const renewThreadPrStatusWatchLease = vi.fn(async () => false);
const finishThreadPrStatusWatch = vi.fn(async () => undefined);
const supersedeThreadPrStatusWatches = vi.fn(async () => 0);
const listActiveThreadPrStatusWatches = vi.fn(async () => []);
const cancelThreadPrStatusWatchesForPr = vi.fn(async () => 0);
const isGhAvailable = vi.fn(async () => true);
const invalidateGhCaches = vi.fn();
const getAuthStatus = vi.fn(async () => ({
  installed: true,
  loggedIn: true,
  scopes: ["repo"],
  hasRepoScope: true,
}));
const fetchPullRequestByUrl = vi.fn(
  async (_request: { cwd: string; url: string }): Promise<PrSummary | undefined> =>
    undefined,
);
const detectPullRequestsForThread = vi.fn(async (): Promise<PrSummary[]> => []);

function githubPr(
  pr: Omit<PrSummary, "provider" | "checkState" | "lifecycleState" | "reviewState" | "mergeState">
    & Partial<Pick<PrSummary, "checkState" | "lifecycleState" | "reviewState" | "mergeState">>,
): PrSummary {
  const checkState = pr.checkState ?? normalizeTestCheckState(pr.state);
  return {
    provider: "github.com",
    ...pr,
    state: checkState,
    checkState,
    lifecycleState: pr.lifecycleState ?? legacyTestLifecycleState(pr.state),
    reviewState: pr.reviewState ?? legacyTestReviewState(pr.state),
    mergeState: pr.mergeState ?? "unknown",
  };
}

function normalizeTestCheckState(state: PrSummary["state"]): NonNullable<PrSummary["checkState"]> {
  if (
    state === "passing"
    || state === "failing"
    || state === "pending"
    || state === "unknown"
  ) {
    return state;
  }
  return "unknown";
}

function legacyTestLifecycleState(state: PrSummary["state"]): NonNullable<PrSummary["lifecycleState"]> {
  if (state === "merged" || state === "closed") {
    return state;
  }
  return "open";
}

function legacyTestReviewState(state: PrSummary["state"]): NonNullable<PrSummary["reviewState"]> {
  return state === "draft" ? "draft" : "ready_for_review";
}

function buildThreadPrRequestKey(params: {
  backend: string;
  threadId: string;
  branch: string;
  directoryPaths: string[];
  provider?: string;
}): string {
  return JSON.stringify({
    lookupVersion: 3,
    backend: params.backend,
    threadId: params.threadId,
    provider: params.provider ?? "github.com",
    branch: params.branch,
    directoryPaths: params.directoryPaths,
  });
}

function buildPrLookupKey(params: {
  branch: string;
  directoryPaths: string[];
  provider?: string;
}): string {
  return JSON.stringify({
    lookupVersion: 2,
    provider: params.provider ?? "github.com",
    branch: params.branch,
    directoryPaths: params.directoryPaths,
  });
}

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/pwragent-userdata"),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
}));

vi.mock("../window-channels", () => ({
  subscribersForChannel: vi.fn(() => [
    {
      isDestroyed: () => false,
      send: prAutoDispatchBudgetStatusSend,
    },
  ]),
}));

vi.mock("../window", () => ({
  isFederationWindowWebContents: (
    webContents: { id?: number } | undefined,
  ) => webContents?.id === 999,
}));

vi.mock("../log", () => ({
  getMainLogger: vi.fn(() => mockAppServerLog),
}));

vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopSettingsService: () => ({
    onConfigWritten: prAutomationSettings.onConfigWritten,
    readSettings: prAutomationSettings.readSettings,
  }),
}));

vi.mock("../app-server/desktop-overlay-store", () => ({
  getDesktopOverlayStore: () => ({
    reconcileNavigationSnapshot,
    markThreadSeen,
    getThreadOverlayState,
    getThreadOverlayStates,
    addLinkedDirectory,
    removeLinkedDirectory,
    setThreadPullRequests,
    addThreadPullRequestReference,
    readPrStatusCache,
    writePrStatusCacheEntries,
    readPrLookupCache,
    writePrLookupCacheEntry,
    syncThreadPrAutoDispatchCandidates,
    getPrAutoDispatchCandidateWinner,
    resetThreadPrAutoDispatchForOperator,
    getPrAutoDispatchBudgetStatus,
    resumePrAutoDispatchBudget,
    scheduleThreadPrAutoDispatch,
    beginThreadPrAutoDispatch,
    restoreThreadPrAutoDispatchAfterBusy,
    renewThreadPrAutoDispatchLease,
    finishThreadPrAutoDispatch,
    cancelThreadPrAutoDispatch,
    cancelPendingThreadPrAutoDispatchForPr,
    resolveThreadPrAutoDispatchIncident,
    getThreadPrAutoDispatchPending,
    listPendingThreadPrAutoDispatches,
    recoverOrphanedThreadPrAutoDispatches,
    registerThreadPrStatusWatch,
    claimThreadPrStatusWatches,
    releaseThreadPrStatusWatch,
    renewThreadPrStatusWatchLease,
    finishThreadPrStatusWatch,
    supersedeThreadPrStatusWatches,
    listActiveThreadPrStatusWatches,
    cancelThreadPrStatusWatchesForPr,
    readDirectoryGitStatusCache,
    writeDirectoryGitStatusCacheEntry,
    readThreadGitWorkingStateCache,
    writeThreadGitWorkingStateCacheEntry,
    listRemoteThreadPins,
    updateRemoteThreadPinSnapshots,
    removeRemoteThreadPin: removeRemoteThreadPinStore,
    addRemoteThreadPin: addRemoteThreadPinStore,
    hasRemoteThreadPin,
    setRemoteThreadLocalPin,
    setThreadReaction: setThreadReactionOverlay,
    setThreadPin: setThreadPinOverlay,
    setDirectoryThreadsCollapsed: setDirectoryThreadsCollapsedOverlay,
    setRemoteDirectoryThreadsCollapsed:
      setRemoteDirectoryThreadsCollapsedOverlay,
    readRemoteDirectoryOverlays,
    listPinnedThreadOverlayRanks,
    reorderThreadPins: reorderThreadPinsStore,
  }),
}));

vi.mock("../app-server/directory-registration-service", () => ({
  registerDirectoryFromDisk: registerDirectoryFromDiskService,
}));

vi.mock("../app-server/backend-registry", () => {
  const registry = {
    archiveThread,
    restoreThread,
    archiveWorktree,
    restoreWorktree,
    handoffThreadWorkspace,
    renameThread,
    listThreads,
    readThread,
    getThreadTranscriptImageRoots,
    readDirectoryStatuses,
    readDirectoryStatusEntries,
    invalidateDirectoryStatus,
    readWorktreeWorkingStateEntries,
    hydrateThreadGitWorkingStates,
    rememberThreadGitWorkingStateCacheEntry,
    invalidateWorktreeWorkingState,
    resolveEditCommitStates,
    onEvent,
    publishLocalEvent,
    setThreadPullRequestStatusToolHandler,
    setThreadPullRequestCanonicalizer,
    setLocalPullRequestAuthorityResolver,
    setThreadPullRequestWatchToolHandler,
    setThreadPrAutoDispatchHandler,
    setThreadPullRequestDetachHandler,
    setDirectoryGitStatusWriter,
    setThreadPrAutoDispatchBatch,
    ensureDirectoryLaunchpad,
    updateDirectoryLaunchpad,
    getQueuedExecutionModesSnapshot: () => ({}),
    getQueuedTurnsSnapshot: () => ({}),
    rememberCompleteNavigationSnapshot,
  };
  backendRegistryLifecycle.get.mockImplementation(() => registry);
  return {
    WORKTREE_WORKING_STATE_CACHE_MAX_AGE_MS: 30_000,
    disposeDesktopBackendRegistry: vi.fn(async () => undefined),
    getDesktopBackendRegistry: backendRegistryLifecycle.get,
    getExistingDesktopBackendRegistry: () =>
      backendRegistryLifecycle.existing ? registry : null,
  };
});

vi.mock("../federation/federation-runtime", () => ({
  getDesktopFederationRuntime: () => federationMock.runtime,
}));

vi.mock("../pr-status/github-pr-fetcher", () => ({
  GithubPrFetcher: vi.fn(function GithubPrFetcher() {
    return {
      isGhAvailable,
      invalidateGhCaches,
      getAuthStatus,
      fetchPullRequestByUrl,
    };
  }),
}));

vi.mock("../pr-status/pr-detection", () => ({
  detectPullRequestsForThread,
}));

vi.mock("../pr-status/git-remote", async () => {
  const actual = await vi.importActual<typeof import("../pr-status/git-remote")>(
    "../pr-status/git-remote",
  );
  return {
    ...actual,
    resolveGitHubRepoForDirectory,
    resolveGitHubReposForDirectory,
  };
});

describe("app server ipc", () => {
  type AppServerIpcModule = typeof import("../ipc/app-server");
  let disposeAppServerIpcHandlers: AppServerIpcModule["disposeAppServerIpcHandlers"];
  let registerAppServerIpcHandlers: AppServerIpcModule["registerAppServerIpcHandlers"];

  beforeAll(async () => {
    // Import after the hoisted mocks exist, but before an individual test can
    // pay the cold module-graph evaluation cost.
    const appServerIpc = await import("../ipc/app-server");
    disposeAppServerIpcHandlers = appServerIpc.disposeAppServerIpcHandlers;
    registerAppServerIpcHandlers = appServerIpc.registerAppServerIpcHandlers;
  });

  beforeEach(() => {
    backendRegistryLifecycle.existing = true;
    backendRegistryLifecycle.get.mockClear();
    prAutomationSettings.state.backgroundPrPollingEnabled = true;
    prAutomationSettings.state.budgetPaused = false;
    prAutomationSettings.state.budgetPausedAt = 1_000;
    prAutomationSettings.state.pauseWhenBudgetEmpty = true;
    prAutomationSettings.state.prAutoDispatchAllowed = true;
    prAutomationSettings.state.budgetCapacity = 30;
    prAutomationSettings.state.budgetRefillPerMinute = 1;
    prAutomationSettings.resetConfigWrittenListeners();
    prAutomationSettings.onConfigWritten.mockClear();
    prAutomationSettings.readSettings.mockClear();
    handlers.clear();
    archiveThread.mockClear();
    restoreThread.mockClear();
    archiveWorktree.mockClear();
    restoreWorktree.mockClear();
    handoffThreadWorkspace.mockClear();
    renameThread.mockClear();
    federationMock.remoteBackend.renameThread.mockClear();
    federationMock.remoteBackend.archiveThread.mockClear();
    federationMock.remoteBackend.markThreadSeen.mockClear();
    federationMock.remoteBackend.setThreadReaction.mockClear();
    federationMock.remoteBackend.setThreadParent.mockClear();
    federationMock.remoteBackend.refreshDirectoryGitStatuses.mockClear();
    federationMock.remoteBackend.ensureDirectoryLaunchpad.mockReset();
    federationMock.remoteBackend.listRecentFileReferences.mockReset();
    federationMock.remoteBackend.recordRecentFileReferences.mockReset();
    federationMock.remoteBackend.attachDirectoryToThread.mockReset();
    federationMock.remoteBackend.listWorktreeUnpublishedCommits.mockClear();
    federationMock.remoteBackend.getWorktreeUnpublishedCommitDiff.mockClear();
    federationMock.runtime.remoteBackend.mockClear();
    federationMock.runtime.remoteTargetSupportsCapability.mockReset();
    federationMock.runtime.remoteTargetSupportsCapability.mockReturnValue(true);
    federationMock.runtime.hydrateThreadMessageOrigins.mockClear();
    federationMock.runtime.remoteNavigationSnapshot.mockReset();
    federationMock.runtime.ungroupRemoteChildrenOfArchivedThread.mockClear();
    federationMock.remoteThreadSummaries.invalidate.mockClear();
    listRemoteThreadPins.mockReset();
    listRemoteThreadPins.mockResolvedValue([]);
    updateRemoteThreadPinSnapshots.mockClear();
    listThreads.mockClear();
    readThread.mockClear();
    getThreadTranscriptImageRoots.mockClear();
    reconcileNavigationSnapshot.mockClear();
    rememberCompleteNavigationSnapshot.mockClear();
    readDirectoryStatuses.mockClear();
    readDirectoryStatusEntries.mockClear();
    invalidateDirectoryStatus.mockClear();
    readDirectoryGitStatusCache.mockClear();
    readDirectoryGitStatusCache.mockResolvedValue({});
    writeDirectoryGitStatusCacheEntry.mockClear();
    readThreadGitWorkingStateCache.mockClear();
    readThreadGitWorkingStateCache.mockResolvedValue({});
    writeThreadGitWorkingStateCacheEntry.mockClear();
    hydrateThreadGitWorkingStates.mockClear();
    hydrateThreadGitWorkingStates.mockImplementation(
      async (threads: AppServerThreadSummary[]) => threads,
    );
    rememberThreadGitWorkingStateCacheEntry.mockClear();
    readWorktreeWorkingStateEntries.mockClear();
    resolveEditCommitStates.mockClear();
    releaseEditCommitResolve = undefined;
    invalidateWorktreeWorkingState.mockClear();
    onEvent.mockClear();
    registryEventListeners.length = 0;
    publishLocalEvent.mockClear();
    setThreadPullRequestStatusToolHandler.mockClear();
    setThreadPullRequestCanonicalizer.mockClear();
    setLocalPullRequestAuthorityResolver.mockClear();
    setThreadPullRequestWatchToolHandler.mockClear();
    setThreadPrAutoDispatchHandler.mockClear();
    setThreadPullRequestDetachHandler.mockClear();
    setDirectoryGitStatusWriter.mockClear();
    setThreadPrAutoDispatchBatch.mockClear();
    ensureDirectoryLaunchpad.mockClear();
    updateDirectoryLaunchpad.mockClear();
    markThreadSeen.mockClear();
    setThreadReactionOverlay.mockClear();
    setDirectoryThreadsCollapsedOverlay.mockClear();
    setRemoteDirectoryThreadsCollapsedOverlay.mockClear();
    readRemoteDirectoryOverlays.mockReset();
    readRemoteDirectoryOverlays.mockResolvedValue({});
    registerDirectoryFromDiskService.mockClear();
    addLinkedDirectory.mockClear();
    removeLinkedDirectory.mockClear();
    getThreadOverlayState.mockReset();
    getThreadOverlayState.mockResolvedValue(undefined);
    getThreadOverlayStates.mockReset();
    getThreadOverlayStates.mockResolvedValue({});
    setThreadPullRequests.mockClear();
    addThreadPullRequestReference.mockClear();
    readPrStatusCache.mockReset();
    readPrStatusCache.mockResolvedValue({});
    writePrStatusCacheEntries.mockClear();
    readPrLookupCache.mockReset();
    readPrLookupCache.mockResolvedValue({});
    writePrLookupCacheEntry.mockClear();
    resetThreadPrAutoDispatchForOperator.mockClear();
    getPrAutoDispatchBudgetStatus.mockClear();
    resumePrAutoDispatchBudget.mockClear();
    scheduleThreadPrAutoDispatch.mockClear();
    beginThreadPrAutoDispatch.mockClear();
    restoreThreadPrAutoDispatchAfterBusy.mockClear();
    renewThreadPrAutoDispatchLease.mockClear();
    finishThreadPrAutoDispatch.mockClear();
    cancelThreadPrAutoDispatch.mockClear();
    cancelPendingThreadPrAutoDispatchForPr.mockClear();
    resolveThreadPrAutoDispatchIncident.mockClear();
    getThreadPrAutoDispatchPending.mockClear();
    listPendingThreadPrAutoDispatches.mockClear();
    recoverOrphanedThreadPrAutoDispatches.mockClear();
    registerThreadPrStatusWatch.mockClear();
    claimThreadPrStatusWatches.mockClear();
    releaseThreadPrStatusWatch.mockClear();
    renewThreadPrStatusWatchLease.mockClear();
    finishThreadPrStatusWatch.mockClear();
    supersedeThreadPrStatusWatches.mockClear();
    listActiveThreadPrStatusWatches.mockClear();
    cancelThreadPrStatusWatchesForPr.mockClear();
    isGhAvailable.mockClear();
    isGhAvailable.mockResolvedValue(true);
    invalidateGhCaches.mockClear();
    getAuthStatus.mockClear();
    fetchPullRequestByUrl.mockReset();
    fetchPullRequestByUrl.mockResolvedValue(undefined);
    detectPullRequestsForThread.mockReset();
    detectPullRequestsForThread.mockResolvedValue([]);
    resolveGitHubRepoForDirectory.mockReset();
    resolveGitHubRepoForDirectory.mockResolvedValue(undefined);
    resolveGitHubReposForDirectory.mockReset();
    resolveGitHubReposForDirectory.mockResolvedValue([]);
    mockAppServerLog.debug.mockClear();
    mockAppServerLog.error.mockClear();
    mockAppServerLog.info.mockClear();
    mockAppServerLog.warn.mockClear();
    prAutoDispatchBudgetStatusSend.mockClear();
  });

  afterEach(async () => {
    await disposeAppServerIpcHandlers();
  });

  it("does not construct a backend registry during disposal", async () => {
    backendRegistryLifecycle.existing = false;

    await disposeAppServerIpcHandlers();

    expect(backendRegistryLifecycle.get).not.toHaveBeenCalled();
  });

  it("invalidates the GraphQL token during an auth recheck", async () => {
    const { GithubGraphqlPrClient } = await import(
      "../pr-status/github-graphql-client"
    );
    const invalidateToken = vi.spyOn(
      GithubGraphqlPrClient.prototype,
      "invalidateToken",
    );
    const { NAVIGATION_GET_GH_STATUS_CHANNEL } = await import("../../shared/ipc");
    registerAppServerIpcHandlers();

    try {
      await handlers.get(NAVIGATION_GET_GH_STATUS_CHANNEL)?.({}, {
        recheck: true,
      });

      expect(invalidateGhCaches).toHaveBeenCalledTimes(1);
      expect(invalidateToken).toHaveBeenCalledTimes(1);
      expect(getAuthStatus).toHaveBeenCalledTimes(1);
    } finally {
      invalidateToken.mockRestore();
    }
  });

  it("identifies explicitly selected extensionless PDFs by their magic bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-pdf-ipc-"));
    const pdfPath = path.join(root, "Jeep");
    const nonPdfPath = path.join(root, "notes.pdf");
    await writeFile(pdfPath, "%PDF-1.7\n");
    await writeFile(nonPdfPath, "not a PDF");
    try {
      const { NAVIGATION_INSPECT_PDF_REFERENCE_PATHS_CHANNEL } = await import(
        "../../shared/ipc"
      );
      registerAppServerIpcHandlers();

      await expect(
        handlers.get(NAVIGATION_INSPECT_PDF_REFERENCE_PATHS_CHANNEL)?.({}, {
          paths: [pdfPath, nonPdfPath],
        }),
      ).resolves.toEqual({
        filePaths: [pdfPath, nonPdfPath],
        pdfPaths: [pdfPath],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("renders and revalidates an explicit Composer PDF preview without caching it main-side", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-pdf-preview-ipc-"));
    const pdfPath = path.join(root, "Jeep");
    const nonPdfPath = path.join(root, "notes.pdf");
    const fixture = await readFile(
      fileURLToPath(
        new URL("./fixtures/pdf/jeep-sticker-page-size.pdf", import.meta.url),
      ),
    );
    await writeFile(pdfPath, fixture);
    await writeFile(nonPdfPath, "not a PDF");
    try {
      const { NAVIGATION_RENDER_COMPOSER_PDF_PREVIEW_CHANNEL } = await import(
        "../../shared/ipc"
      );
      registerAppServerIpcHandlers();

      const handler = handlers.get(NAVIGATION_RENDER_COMPOSER_PDF_PREVIEW_CHANNEL);
      expect(handler).toBeDefined();
      const initial = await handler!({}, { path: pdfPath });
      expect(initial).toMatchObject({
        dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
        fileIdentity: expect.any(String),
        pageCount: 1,
        unchanged: false,
      });
      const initialIdentity = (initial as { fileIdentity: string }).fileIdentity;

      await expect(
        handler!({}, { knownFileIdentity: initialIdentity, path: pdfPath }),
      ).resolves.toEqual({
        fileIdentity: initialIdentity,
        unchanged: true,
      });

      await writeFile(pdfPath, Buffer.concat([fixture, Buffer.from("\n% preview mutation\n")]));
      const changed = await handler!({}, {
        knownFileIdentity: initialIdentity,
        path: pdfPath,
      });
      expect(changed).toMatchObject({
        dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
        unchanged: false,
      });
      expect((changed as { fileIdentity: string }).fileIdentity).not.toBe(initialIdentity);
      await expect(handler!({}, { path: nonPdfPath })).rejects.toThrow(
        "no longer a PDF",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("registers main-process PR auto-dispatch handlers", async () => {

    registerAppServerIpcHandlers();

    expect(setThreadPrAutoDispatchHandler).toHaveBeenCalledWith({
      preferenceChanged: expect.any(Function),
      preferencesChanged: expect.any(Function),
      cancelPending: expect.any(Function),
      sendPendingNow: expect.any(Function),
      inspect: expect.any(Function),
    });
    expect(setThreadPullRequestWatchToolHandler).toHaveBeenCalledWith(
      expect.any(Function),
    );
    expect(setThreadPullRequestCanonicalizer).toHaveBeenCalledWith(
      expect.any(Function),
    );
  });

  it("persists owner-refreshed directory Git status before publishing it", async () => {

    registerAppServerIpcHandlers();

    const writer = setDirectoryGitStatusWriter.mock.calls.at(-1)?.[0];
    await writer?.({
      directory: {
        key: "directory:/owner/repo",
        kind: "directory",
        label: "repo",
        path: "/owner/repo",
        threadKeys: [],
        needsAttentionCount: 0,
      },
      directoryKey: "directory:/owner/repo",
      fetchedAt: 2_000,
      gitStatus: {
        currentBranch: "main",
        syncState: "in-sync",
      },
    });

    expect(writeDirectoryGitStatusCacheEntry).toHaveBeenCalledExactlyOnceWith({
      directoryKey: "directory:/owner/repo",
      directoryPath: "/owner/repo",
      fetchedAt: 2_000,
      gitStatus: {
        currentBranch: "main",
        syncState: "in-sync",
      },
    });
    expect(publishLocalEvent).toHaveBeenCalledExactlyOnceWith({
      backend: "codex",
      notification: {
        method: "navigation/directoryGitStatus/updated",
        params: {
          directoryKey: "directory:/owner/repo",
          fetchedAt: 2_000,
          gitStatus: {
            currentBranch: "main",
            syncState: "in-sync",
          },
        },
      },
    });
  });

  it("hydrates the thread inspection PR canonicalizer from durable cache", async () => {
    const stalePr = githubPr({
      number: 1132,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "passing",
      lifecycleState: "open",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/1132",
    });
    const mergedPr = githubPr({
      ...stalePr,
      lifecycleState: "merged",
    });
    readPrStatusCache.mockResolvedValueOnce({
      "github.com/pwrdrvr/pwragent#1132": {
        provider: "github.com",
        prKey: "github.com/pwrdrvr/pwragent#1132",
        fetchedAt: Date.now(),
        pr: mergedPr,
      },
    });

    registerAppServerIpcHandlers();

    const canonicalize =
      setThreadPullRequestCanonicalizer.mock.calls.at(-1)?.[0];
    const [first, second] = await Promise.all([
      canonicalize?.([stalePr]),
      canonicalize?.([stalePr]),
    ]);
    expect(first).toEqual([mergedPr]);
    expect(second).toEqual([mergedPr]);
    expect(readPrStatusCache).toHaveBeenCalledTimes(1);
    expect(publishLocalEvent).not.toHaveBeenCalled();
  });

  it("targets only existing threads with an open primary attached PR", async () => {
    const {
      NAVIGATION_SET_ELIGIBLE_THREADS_PR_AUTO_DISPATCH_CHANNEL,
    } = await import("../../shared/ipc");
    const primaryPr = githubPr({
      number: 42,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "passing",
      title: "Primary PR",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/42",
    });
    const informationalPr = githubPr({
      number: 43,
      org: "other",
      repo: "repo",
      state: "failing",
      title: "Informational PR",
      url: "https://github.com/other/repo/pull/43",
    });
    const closedPr = githubPr({
      number: 44,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "closed",
      title: "Closed PR",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/44",
    });
    const threads = [
      {
        id: "thread-primary-disabled",
        title: "Primary disabled",
        titleSource: "explicit" as const,
        source: "codex" as const,
        gitOriginUrl: "git@github.com:pwrdrvr/PwrAgent.git",
        linkedDirectories: [],
        prs: [primaryPr],
        prAutoDispatchEnabled: false,
        updatedAt: 2_000,
      },
      {
        id: "thread-primary-enabled",
        title: "Primary enabled",
        titleSource: "explicit" as const,
        source: "codex" as const,
        gitOriginUrl: "git@github.com:pwrdrvr/PwrAgent.git",
        linkedDirectories: [],
        prs: [primaryPr],
        prAutoDispatchEnabled: true,
        updatedAt: 1_900,
      },
      {
        id: "thread-informational",
        title: "Informational",
        titleSource: "explicit" as const,
        source: "codex" as const,
        gitOriginUrl: "git@github.com:pwrdrvr/PwrAgent.git",
        linkedDirectories: [],
        prs: [informationalPr],
        prAutoDispatchEnabled: false,
        updatedAt: 1_800,
      },
      {
        id: "thread-closed",
        title: "Closed",
        titleSource: "explicit" as const,
        source: "codex" as const,
        gitOriginUrl: "git@github.com:pwrdrvr/PwrAgent.git",
        linkedDirectories: [],
        prs: [closedPr],
        prAutoDispatchEnabled: false,
        updatedAt: 1_700,
      },
    ];
    listThreads.mockResolvedValueOnce(threads as never);
    listThreads.mockResolvedValueOnce(threads as never);

    registerAppServerIpcHandlers();

    await expect(
      handlers.get(NAVIGATION_SET_ELIGIBLE_THREADS_PR_AUTO_DISPATCH_CHANNEL)?.(
        {},
        { enabled: true, dryRun: true },
      ),
    ).resolves.toEqual({
      enabled: true,
      eligibleThreadCount: 2,
      updatedThreadCount: 1,
    });
    expect(setThreadPrAutoDispatchBatch).not.toHaveBeenCalled();

    await expect(
      handlers.get(NAVIGATION_SET_ELIGIBLE_THREADS_PR_AUTO_DISPATCH_CHANNEL)?.(
        {},
        { enabled: true },
      ),
    ).resolves.toEqual({
      enabled: true,
      eligibleThreadCount: 2,
      updatedThreadCount: 1,
    });
    expect(setThreadPrAutoDispatchBatch).toHaveBeenCalledWith([
      {
        backend: "codex",
        threadId: "thread-primary-disabled",
        enabled: true,
      },
    ]);
  });

  it("does not advertise Auto-fix as active without a primary Git repository", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    listThreads.mockResolvedValueOnce([
      {
        id: "thread-1",
        title: "Local scratch directory",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [
          {
            id: "directory:/projects/scratch",
            kind: "local",
            label: "Scratch",
            path: "/projects/scratch",
          },
        ],
        updatedAt: 2000,
      },
    ] as never);
    getThreadOverlayState.mockResolvedValue({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prAutoDispatchEnabled: true,
    });

    registerAppServerIpcHandlers();
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    const autoDispatchHandlers = setThreadPrAutoDispatchHandler.mock.calls.at(-1)?.[0];
    expect(autoDispatchHandlers).toBeDefined();
    await vi.waitFor(async () => {
      const status = await autoDispatchHandlers?.inspect({
        backend: "codex",
        threadId: "thread-1",
      });
      expect(status).toMatchObject({
        backgroundPollingEnabled: true,
        autoFixAllowed: true,
        autoFixEnabled: true,
        autoFixActive: false,
        guidance: expect.stringContaining("no GitHub primary workspace"),
      });
    });
  });

  it("tells an active Auto-fix turn that it owns the repair", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const primaryPr = githubPr({
      number: 1695,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "failing",
      title: "Grok 4.6 pricing mismatch",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/1695",
    });
    listThreads.mockResolvedValueOnce([
      {
        id: "thread-1",
        title: "Grok 4.6 pricing mismatch",
        titleSource: "explicit",
        source: "codex",
        gitOriginUrl: "git@github.com:pwrdrvr/PwrAgent.git",
        linkedDirectories: [],
        prs: [primaryPr],
        updatedAt: 2_000,
      },
    ] as never);
    getThreadOverlayState.mockResolvedValue({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prs: [primaryPr],
      prAutoDispatchEnabled: true,
    });
    getPrAutoDispatchCandidateWinner.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
    } as never);

    registerAppServerIpcHandlers();
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    const autoDispatchHandlers = setThreadPrAutoDispatchHandler.mock.calls.at(-1)?.[0];
    await vi.waitFor(async () => {
      const status = await autoDispatchHandlers?.inspect({
        backend: "codex",
        threadId: "thread-1",
      });
      expect(status).toMatchObject({
        autoFixActive: true,
        guidance: expect.stringContaining(
          "this does not mean another agent is repairing the PR",
        ),
      });
      expect(status?.guidance).toContain(
        "you are the repair turn: investigate and fix the reported failure",
      );
      expect(status?.guidance).toContain(
        "validate, commit, and push the fix to the PR branch",
      );
      expect(status?.guidance).toContain(
        "Do not stop merely because autoFixActive is true",
      );
    });
  });

  it("keeps Auto-fix PR disabled globally without overwriting its thread setting", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    prAutomationSettings.state.prAutoDispatchAllowed = false;
    getThreadOverlayState.mockResolvedValue({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prAutoDispatchEnabled: true,
    });

    registerAppServerIpcHandlers();
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    const autoDispatchHandlers = setThreadPrAutoDispatchHandler.mock.calls.at(-1)?.[0];
    expect(autoDispatchHandlers).toBeDefined();
    await vi.waitFor(async () => {
      const status = await autoDispatchHandlers?.inspect({
        backend: "codex",
        threadId: "thread-1",
      });
      expect(status).toMatchObject({
        backgroundPollingEnabled: true,
        autoFixAllowed: false,
        autoFixEnabled: true,
        autoFixActive: false,
        guidance: expect.stringContaining("disabled globally"),
      });
    });

    await autoDispatchHandlers?.preferenceChanged({
      backend: "codex",
      threadId: "thread-1",
      enabled: true,
    });
    expect(scheduleThreadPrAutoDispatch).not.toHaveBeenCalled();
  });

  it("loads configured budget limits before serving a startup status request", async () => {
    const { APP_SERVER_GET_PR_AUTO_DISPATCH_BUDGET_STATUS_CHANNEL } =
      await import("../../shared/ipc");
    prAutomationSettings.state.budgetCapacity = 1_000;
    prAutomationSettings.state.budgetRefillPerMinute = 60;
    prAutomationSettings.state.pauseWhenBudgetEmpty = false;

    registerAppServerIpcHandlers();

    expect(await handlers.get(
      APP_SERVER_GET_PR_AUTO_DISPATCH_BUDGET_STATUS_CHANNEL,
    )?.()).toMatchObject({
      capacity: 1_000,
      refillPerMinute: 60,
    });
    expect(prAutomationSettings.readSettings).toHaveBeenCalledTimes(1);
    expect(getPrAutoDispatchBudgetStatus).toHaveBeenCalledWith({
      config: {
        capacity: 1_000,
        refillPerMinute: 60,
        pauseWhenEmpty: false,
      },
      now: expect.any(Number),
    });
  });

  it("broadcasts each durable budget pause only once", async () => {
    const {
      APP_SERVER_GET_PR_AUTO_DISPATCH_BUDGET_STATUS_CHANNEL,
      PR_AUTO_DISPATCH_BUDGET_CHANGED_EVENT_CHANNEL,
    } = await import("../../shared/ipc");
    prAutomationSettings.state.budgetPaused = true;

    registerAppServerIpcHandlers();
    const readStatus = handlers.get(
      APP_SERVER_GET_PR_AUTO_DISPATCH_BUDGET_STATUS_CHANNEL,
    );

    await readStatus?.();
    await readStatus?.();

    expect(prAutoDispatchBudgetStatusSend).toHaveBeenCalledTimes(1);
    expect(prAutoDispatchBudgetStatusSend).toHaveBeenLastCalledWith(
      PR_AUTO_DISPATCH_BUDGET_CHANGED_EVENT_CHANNEL,
      expect.objectContaining({ paused: true, pausedAt: 1_000 }),
    );

    prAutomationSettings.state.budgetPausedAt = 2_000;
    await readStatus?.();

    expect(prAutoDispatchBudgetStatusSend).toHaveBeenCalledTimes(2);
    expect(prAutoDispatchBudgetStatusSend).toHaveBeenLastCalledWith(
      PR_AUTO_DISPATCH_BUDGET_CHANGED_EVENT_CHANNEL,
      expect.objectContaining({ paused: true, pausedAt: 2_000 }),
    );
  });

  it("keeps thread preferences intact while a durable budget safety stop pauses Auto-fix PR", async () => {
    const {
      APP_SERVER_GET_PR_AUTO_DISPATCH_BUDGET_STATUS_CHANNEL,
      APP_SERVER_RESUME_PR_AUTO_DISPATCH_BUDGET_CHANNEL,
      NAVIGATION_SNAPSHOT_CHANNEL,
    } = await import("../../shared/ipc");
    prAutomationSettings.state.budgetPaused = true;
    getThreadOverlayState.mockResolvedValue({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prAutoDispatchEnabled: true,
    });

    registerAppServerIpcHandlers();
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    const autoDispatchHandlers = setThreadPrAutoDispatchHandler.mock.calls.at(-1)?.[0];
    await vi.waitFor(async () => {
      const status = await autoDispatchHandlers?.inspect({
        backend: "codex",
        threadId: "thread-1",
      });
      expect(status).toMatchObject({
        autoFixAllowed: true,
        autoFixEnabled: true,
        autoFixActive: false,
        guidance: expect.stringContaining("automatic repair budget is empty"),
      });
    });

    expect(await handlers.get(
      APP_SERVER_GET_PR_AUTO_DISPATCH_BUDGET_STATUS_CHANNEL,
    )?.()).toMatchObject({ paused: true });
    expect(await handlers.get(
      APP_SERVER_RESUME_PR_AUTO_DISPATCH_BUDGET_CHANNEL,
    )?.()).toMatchObject({ paused: false });
    expect(resumePrAutoDispatchBudget).toHaveBeenCalledTimes(1);
    expect(await autoDispatchHandlers?.inspect({
      backend: "codex",
      threadId: "thread-1",
    })).toMatchObject({ autoFixEnabled: true });
  });

  it("does not let a stale settings read re-enable Auto-fix PR", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    let resolveStaleRead:
      | ((settings: {
          git: {
            backgroundPrPolling: { value: boolean };
            prAutoDispatchAllowed: { value: boolean };
            prAutoDispatchBudgetCapacity: { value: number };
            prAutoDispatchBudgetRefillPerMinute: { value: number };
            pausePrAutoDispatchWhenBudgetEmpty: { value: boolean };
          };
        }) => void)
      | undefined;
    prAutomationSettings.readSettings.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveStaleRead = resolve;
      }),
    );
    getThreadOverlayState.mockResolvedValue({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prAutoDispatchEnabled: true,
    });

    registerAppServerIpcHandlers();
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    await vi.waitFor(() => {
      expect(prAutomationSettings.readSettings).toHaveBeenCalledTimes(1);
    });
    expect(resolveStaleRead).toEqual(expect.any(Function));

    prAutomationSettings.state.prAutoDispatchAllowed = false;
    prAutomationSettings.emitConfigWritten();
    await vi.waitFor(() => {
      expect(prAutomationSettings.readSettings).toHaveBeenCalledTimes(2);
    });

    const autoDispatchHandlers = setThreadPrAutoDispatchHandler.mock.calls.at(-1)?.[0];
    expect(autoDispatchHandlers).toBeDefined();
    await vi.waitFor(async () => {
      const status = await autoDispatchHandlers?.inspect({
        backend: "codex",
        threadId: "thread-1",
      });
      expect(status).toMatchObject({
        backgroundPollingEnabled: true,
        autoFixAllowed: false,
      });
    });

    resolveStaleRead?.({
      git: {
        backgroundPrPolling: { value: true },
        prAutoDispatchAllowed: { value: true },
        prAutoDispatchBudgetCapacity: { value: 30 },
        prAutoDispatchBudgetRefillPerMinute: { value: 1 },
        pausePrAutoDispatchWhenBudgetEmpty: { value: true },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const status = await autoDispatchHandlers?.inspect({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(status).toMatchObject({
      backgroundPollingEnabled: true,
      autoFixAllowed: false,
    });
    expect(scheduleThreadPrAutoDispatch).not.toHaveBeenCalled();
  });

  it("keeps a new PR watch pending when the cached outcome is stale", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const stalePr = githubPr({
      number: 1128,
      org: "pwrdrvr",
      repo: "PwrAgent",
      title: "PR automation",
      state: "failing",
      headSha: "a".repeat(40),
      url: "https://github.com/pwrdrvr/PwrAgent/pull/1128",
    });
    readPrStatusCache.mockResolvedValueOnce({
      "github.com/pwrdrvr/pwragent#1128": {
        provider: "github.com",
        prKey: "github.com/pwrdrvr/pwragent#1128",
        fetchedAt: Date.now() - 60_000,
        pr: stalePr,
      },
    });
    listThreads.mockResolvedValueOnce([
      {
        id: "thread-1",
        title: "PR automation",
        titleSource: "explicit",
        source: "codex",
        gitOriginUrl: "git@github.com:pwrdrvr/PwrAgent.git",
        linkedDirectories: [
          {
            id: "directory:/repo/PwrAgent",
            kind: "local",
            label: "PwrAgent",
            path: "/repo/PwrAgent",
          },
        ],
        prs: [stalePr],
        updatedAt: 2000,
      },
    ] as never);
    getThreadOverlayState.mockResolvedValue({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prs: [stalePr],
    });

    registerAppServerIpcHandlers();
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    const autoDispatchHandlers = setThreadPrAutoDispatchHandler.mock.calls.at(-1)?.[0];
    await vi.waitFor(async () => {
      const status = await autoDispatchHandlers?.inspect({
        backend: "codex",
        threadId: "thread-1",
      });
      expect(status?.backgroundPollingEnabled).toBe(true);
    });
    const watchHandler = setThreadPullRequestWatchToolHandler.mock.calls.at(-1)?.[0];
    const response = await watchHandler?.({
      backend: "codex",
      threadId: "thread-1",
      notifyOn: ["failure"],
    });

    expect(response).toMatchObject({
      ok: true,
      data: {
        pullRequestWatch: {
          watch: {
            prKey: "github.com/pwrdrvr/pwragent#1128",
            notifyOn: ["failure"],
          },
        },
      },
    });
    expect(registerThreadPrStatusWatch).toHaveBeenCalledOnce();
    expect(claimThreadPrStatusWatches).not.toHaveBeenCalled();
  });

  it("serves the last remote navigation snapshot during an expected disconnect", async () => {
    const { FederationPeerUnavailableError } = await import(
      "../federation/federation-peer-unavailable-error"
    );
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "peer_navigation_stale",
    };
    const fresh = {
      backend: "all" as const,
      fetchedAt: 1_000,
      federationTarget,
      unchanged: false,
      threads: [{
        id: "remote-thread",
        title: "Remote thread",
        titleSource: "explicit" as const,
        source: "codex" as const,
        linkedDirectories: [],
        inbox: { inInbox: true },
        federation: {
          ref: {
            backend: "codex" as const,
            target: federationTarget,
            threadId: "remote-thread",
          },
          instanceLabel: "Remote fixture",
          peerStatus: "connected" as const,
        },
      }],
      inboxThreadKeys: ["codex:remote-thread"],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    };
    federationMock.runtime.remoteNavigationSnapshot
      .mockResolvedValueOnce(fresh)
      .mockRejectedValueOnce(
        new FederationPeerUnavailableError("peer_navigation_stale"),
      );

    registerAppServerIpcHandlers();
    const handler = handlers.get(NAVIGATION_SNAPSHOT_CHANNEL);

    await expect(handler?.({}, { federationTarget })).resolves.toBe(fresh);
    const stale = await handler?.({}, {
      federationTarget,
      forceRefresh: true,
      refreshMode: "full",
    }) as typeof fresh;
    expect(stale).toMatchObject({
      federationTarget,
      unchanged: false,
      threads: [{
        id: "remote-thread",
        federation: { peerStatus: "disconnected" },
      }],
    });
  });

  // Remote thread names are remembered here because a federation window's
  // navigation never reaches RemoteThreadSummaryCache. That is a side errand:
  // the operator asked for a snapshot, and losing a name costs a thread id in
  // a quit dialog somewhere, not this window's contents.
  it("remembers remote thread names without letting that break the snapshot", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "peer_remembers_names",
    };
    const snapshot = {
      backend: "all" as const,
      fetchedAt: 1_000,
      federationTarget,
      unchanged: false,
      threads: [],
      inboxThreadKeys: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    };
    federationMock.runtime.remoteNavigationSnapshot
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(snapshot);

    registerAppServerIpcHandlers();
    const handler = handlers.get(NAVIGATION_SNAPSHOT_CHANNEL);

    await expect(handler?.({}, { federationTarget })).resolves.toBe(snapshot);
    expect(
      federationMock.remoteThreadSummaries.rememberThreadNames,
    ).toHaveBeenCalledWith("peer_remembers_names", snapshot.threads);

    federationMock.remoteThreadSummaries.rememberThreadNames.mockImplementationOnce(
      () => {
        throw new Error("federation runtime unavailable");
      },
    );
    await expect(
      handler?.({}, { federationTarget, forceRefresh: true, refreshMode: "full" }),
    ).resolves.toBe(snapshot);
  });

  it("overlays viewer-owned directory disclosure state on remote snapshots", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "peer_navigation_preferences",
    };
    const directoryKey = "directory:/Users/remote/repos/PwrAgent";
    readRemoteDirectoryOverlays.mockResolvedValueOnce({
      [directoryKey]: {
        directoryKey,
        directoryThreadsCollapsed: true,
      },
    });
    federationMock.runtime.remoteNavigationSnapshot.mockResolvedValueOnce({
      backend: "all",
      fetchedAt: 1_000,
      federationTarget,
      unchanged: true,
      threads: [],
      inboxThreadKeys: [],
      directories: [{
        key: directoryKey,
        kind: "directory",
        label: "PwrAgent",
        path: "/Users/remote/repos/PwrAgent",
        threadKeys: [],
        needsAttentionCount: 0,
        directoryThreadsCollapsed: false,
      }],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    });

    registerAppServerIpcHandlers();
    const snapshot = await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {
      federationTarget,
    }) as {
      unchanged: boolean;
      directories: Array<{ directoryThreadsCollapsed?: boolean }>;
    };

    expect(readRemoteDirectoryOverlays).toHaveBeenCalledWith({
      instanceId: federationTarget.instanceId,
    });
    expect(snapshot.directories[0]?.directoryThreadsCollapsed).toBe(true);
    expect(snapshot.unchanged).toBe(false);
  });

  it("stores a remote directory disclosure on the viewer without publishing it", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { NAVIGATION_SET_DIRECTORY_THREADS_COLLAPSED_CHANNEL } = await import(
      "../../shared/ipc"
    );
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "peer_navigation_preferences",
    };
    const directoryKey = "directory:/Users/remote/repos/PwrAgent";

    registerAppServerIpcHandlers();
    const response = await handlers.get(
      NAVIGATION_SET_DIRECTORY_THREADS_COLLAPSED_CHANNEL,
    )?.({}, {
      directoryKey,
      collapsed: true,
      federationTarget,
    });

    expect(setRemoteDirectoryThreadsCollapsedOverlay).toHaveBeenCalledWith({
      instanceId: federationTarget.instanceId,
      directoryKey,
      collapsed: true,
    });
    expect(setDirectoryThreadsCollapsedOverlay).not.toHaveBeenCalled();
    expect(publishLocalEvent).not.toHaveBeenCalled();
    expect(response).toEqual({ directoryKey, collapsed: true });
  });

  it("keeps unexpected remote navigation failures actionable", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    federationMock.runtime.remoteNavigationSnapshot.mockRejectedValueOnce(
      new Error("invalid remote navigation payload"),
    );

    registerAppServerIpcHandlers();

    await expect(handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {
      federationTarget: {
        scope: "remote",
        instanceId: "peer_navigation_broken",
      },
    })).rejects.toThrow("invalid remote navigation payload");
  });

  it("aggregates navigation snapshots across backends by default", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.(
      {},
      {} satisfies GetNavigationSnapshotRequest,
    );

    expect(listThreads).toHaveBeenCalledWith({
      backend: undefined,
      callerReason: "navigation-snapshot",
      filter: undefined,
      forceRefresh: undefined,
      limit: undefined,
      maxPages: undefined,
      skipArchivedMetadataRefresh: false,
    });
    expect(reconcileNavigationSnapshot).toHaveBeenCalledWith({
      backend: "all",
      fetchedAt: expect.any(Number),
      messagingBindingsByThreadKey: undefined,
      queuedExecutionModesByThreadKey: {},
      queuedTurnsByThreadKey: {},
      threads: [
        expect.objectContaining({ source: "codex", id: "thread-1" }),
        expect.objectContaining({ source: "acp:grok", id: "thread-1" }),
      ],
      workspaceRoots: [
        path.join(os.homedir(), ".pwragent", "profiles", "default", "projects"),
        path.join(os.homedir(), ".pwragent", "projects"),
        path.join(os.homedir(), ".pwragnt", "projects"),
      ],
    });
    expect(rememberCompleteNavigationSnapshot).toHaveBeenCalledWith(response);
    expect(response).toEqual({
      backend: "all",
      fetchedAt: 1234,
      unchanged: false,
      threads: [
        expect.objectContaining({ source: "codex", id: "thread-1" }),
        expect.objectContaining({ source: "acp:grok", id: "thread-1" }),
      ],
      inboxThreadKeys: ["acp:grok:thread-1"],
      directories: [
        {
          key: "directory:/repo/app",
          kind: "directory",
          label: "app",
          path: "/repo/app",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 1,
          latestUpdatedAt: 2000,
        },
      ],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    });
  });

  it("merges pinned remote threads into the main-window navigation snapshot", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const { buildFederatedThreadRef } = await import("@pwragent/shared");

    const ref = buildFederatedThreadRef({
      backend: "codex",
      instanceId: "peer-laptop",
      threadId: "remote-1",
    });
    const pin = {
      ref,
      addedAt: 1_000,
      instanceLabel: "Laptop",
    };
    const remoteRow = {
      source: "codex" as const,
      id: "remote-1",
      title: "Remote fix",
      titleSource: "derived" as const,
      // Pinned on the OWNER's list; must not leak into the viewer's
      // pinned section or wire the pin chip to an owner-side unpin.
      pinnedRank: "1024",
      // Peer path differs from any local checkout; consolidation into the
      // local project group matches by label / path basename.
      linkedDirectories: [
        {
          id: "dir-remote",
          label: "app",
          path: "/peer/dev/app",
          kind: "local" as const,
        },
      ],
      inbox: { inInbox: true, reason: "updated-since-seen" as const },
      updatedAt: 9_000,
      federation: {
        ref,
        instanceLabel: "Laptop",
        peerStatus: "connected" as const,
        capabilities: [],
      },
    };
    listRemoteThreadPins.mockResolvedValueOnce([pin]);
    federationMock.remoteThreadSummaries.resolvePinnedThreads.mockResolvedValueOnce({
      threads: [remoteRow],
      refreshed: [{ ref, summary: remoteRow, instanceLabel: "Laptop" }],
      archived: [],
    });

    registerAppServerIpcHandlers();

    const response = (await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.(
      {},
      {} satisfies GetNavigationSnapshotRequest,
    )) as {
      threads: Array<{ id: string }>;
      inboxThreadKeys: string[];
      unchanged: boolean;
      directories: Array<{
        key: string;
        threadKeys: string[];
        needsAttentionCount: number;
      }>;
    };

    expect(
      federationMock.remoteThreadSummaries.resolvePinnedThreads,
    ).toHaveBeenCalledWith([pin]);
    expect(updateRemoteThreadPinSnapshots).toHaveBeenCalledWith([
      { ref, summary: remoteRow, instanceLabel: "Laptop" },
    ]);
    expect(response.threads).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "remote-1" })]),
    );
    const mergedRemoteRow = response.threads.find(
      (thread) => thread.id === "remote-1",
    ) as { pinnedRank?: string } | undefined;
    expect(mergedRemoteRow?.pinnedRank).toBeUndefined();
    // Unified inbox ranking over local + remote rows: the fresher remote
    // unread (updatedAt 9000) outranks the stale local unread (1000)
    // instead of always trailing every local key.
    expect(response.inboxThreadKeys).toEqual([
      "codex:remote-1",
      "acp:grok:thread-1",
    ]);
    // A newly appearing remote row must defeat the unchanged optimization.
    expect(response.unchanged).toBe(false);
    // Consolidated into the matching LOCAL project group (label "app"), so
    // the Directories lens shows it and the breadcrumb resolves the project.
    const appDirectory = response.directories.find(
      (directory) => directory.key === "directory:/repo/app",
    );
    expect(appDirectory?.threadKeys).toContain("codex:remote-1");
    // The unread remote row bumps the group's "N to review" badge past the
    // reconcile-computed local count.
    expect(appDirectory?.needsAttentionCount).toBe(2);
    expect(rememberCompleteNavigationSnapshot).toHaveBeenCalledWith(response);
  });

  it("shows an unconfigured project for a mounted remote thread until Add Directory matches it", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const { buildFederatedThreadRef } = await import("@pwragent/shared");
    const ref = buildFederatedThreadRef({
      backend: "codex",
      instanceId: "peer-laptop",
      threadId: "remote-grok-build",
    });
    const pin = { ref, addedAt: 1_000, instanceLabel: "Laptop" };
    const remoteRow = {
      source: "codex" as const,
      id: "remote-grok-build",
      title: "grok-build fork and ACP review",
      titleSource: "explicit" as const,
      projectKey: "/peer/.codex/worktrees/abc/grok-build",
      linkedDirectories: [
        {
          id: "/peer/repos/grok-build",
          label: "grok-build",
          path: "/peer/repos/grok-build",
          worktreePath: "/peer/.codex/worktrees/abc/grok-build",
          kind: "worktree" as const,
        },
        {
          id: "/peer/repos/PwrAgent",
          label: "PwrAgent",
          path: "/peer/repos/PwrAgent",
          kind: "local" as const,
        },
      ],
      inbox: { inInbox: true, reason: "updated-since-seen" as const },
      federation: {
        ref,
        instanceLabel: "Laptop",
        peerStatus: "connected" as const,
        capabilities: [],
      },
    };
    const localSnapshot = (directories: Array<{
      key: string;
      kind: "directory";
      label: string;
      path: string;
      threadKeys: string[];
      needsAttentionCount: number;
      latestUpdatedAt: number;
    }>) => ({
      backend: "all" as const,
      fetchedAt: 1_234,
      unchanged: false,
      threads: [],
      inboxThreadKeys: [],
      directories,
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    });
    reconcileNavigationSnapshot
      .mockResolvedValueOnce(localSnapshot([]))
      .mockResolvedValueOnce(localSnapshot([
        {
          key: "directory:/viewer/repos/grok-build",
          kind: "directory" as const,
          label: "grok-build",
          path: "/viewer/repos/grok-build",
          threadKeys: [],
          needsAttentionCount: 0,
          latestUpdatedAt: 2_000,
        },
      ]));
    listRemoteThreadPins.mockResolvedValue([pin]);
    federationMock.remoteThreadSummaries.resolvePinnedThreads.mockResolvedValue({
      threads: [remoteRow],
      refreshed: [],
      archived: [],
    });
    registerAppServerIpcHandlers();

    const first = (await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.(
      {},
      {} satisfies GetNavigationSnapshotRequest,
    )) as { directories: Array<{
      key: string;
      label: string;
      localAvailability?: string;
      threadKeys: string[];
      needsAttentionCount: number;
    }> };
    expect(first.directories).toContainEqual({
      key: "unconfigured-directory:grok-build",
      kind: "directory",
      label: "grok-build",
      localAvailability: "unconfigured",
      threadKeys: ["codex:remote-grok-build"],
      needsAttentionCount: 1,
    });

    // Registering the same project locally gives the next snapshot a real
    // directory row. The mounted thread converges into it by project identity;
    // the temporary owner-path-free placeholder does not survive beside it.
    const second = (await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.(
      {},
      {} satisfies GetNavigationSnapshotRequest,
    )) as typeof first;
    expect(second.directories).toContainEqual(expect.objectContaining({
      key: "directory:/viewer/repos/grok-build",
      label: "grok-build",
      threadKeys: ["codex:remote-grok-build"],
    }));
    expect(second.directories).not.toContainEqual(expect.objectContaining({
      localAvailability: "unconfigured",
    }));
  });

  it("marks a pinned remote snapshot changed when only reactions change", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const { buildFederatedThreadRef } = await import("@pwragent/shared");
    const ref = buildFederatedThreadRef({
      backend: "codex",
      instanceId: "peer-laptop",
      threadId: "remote-reactions",
    });
    const pin = { ref, addedAt: 1_000, instanceLabel: "Laptop" };
    const localSnapshot = (unchanged: boolean) => ({
      backend: "all" as const,
      fetchedAt: 1_000,
      unchanged,
      threads: [],
      inboxThreadKeys: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    });
    const remoteRow = (reactions: string[]) => ({
      source: "codex" as const,
      id: "remote-reactions",
      title: "Remote reactions",
      titleSource: "explicit" as const,
      linkedDirectories: [],
      inbox: { inInbox: false },
      reactions,
      federation: {
        ref,
        instanceLabel: "Laptop",
        peerStatus: "connected" as const,
        capabilities: [],
      },
    });
    reconcileNavigationSnapshot
      .mockResolvedValueOnce(localSnapshot(false))
      .mockResolvedValueOnce(localSnapshot(true));
    listRemoteThreadPins
      .mockResolvedValueOnce([pin])
      .mockResolvedValueOnce([pin]);
    federationMock.remoteThreadSummaries.resolvePinnedThreads
      .mockResolvedValueOnce({
        threads: [remoteRow(["✋"])],
        refreshed: [],
        archived: [],
      })
      .mockResolvedValueOnce({
        threads: [remoteRow(["✋", "👀"])],
        refreshed: [],
        archived: [],
      });
    registerAppServerIpcHandlers();

    const first = await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    const second = await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});

    expect(first).toMatchObject({ unchanged: false });
    expect(second).toMatchObject({
      unchanged: false,
      threads: [expect.objectContaining({ reactions: ["✋", "👀"] })],
    });
  });

  it("keeps delta transport opt-in with shared renderer revisions", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const firstRenderer = { sender: { id: 42 } };
    const secondRenderer = { sender: { id: 43 } };
    registerAppServerIpcHandlers();
    const handler = handlers.get(NAVIGATION_SNAPSHOT_CHANNEL);

    const first = await handler?.(firstRenderer, {
      transport: { protocol: 1 },
    }) as { kind: string; revision: string };
    const second = await handler?.(secondRenderer, {
      transport: {
        protocol: 1,
        baseRevision: first.revision,
      },
    }) as { kind: string; revision: string };
    const third = await handler?.(firstRenderer, {
      transport: {
        protocol: 1,
        baseRevision: second.revision,
      },
    });

    expect(first.kind).toBe("full");
    expect(second).toMatchObject({
      kind: "delta",
      upsertedThreads: [],
    });
    expect(third).toEqual({
      kind: "unchanged",
      revision: second.revision,
    });
  });

  it("removes a viewer-side remote pin when the owner proves it is archived", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const { buildFederatedThreadRef } = await import("@pwragent/shared");

    const ref = buildFederatedThreadRef({
      backend: "codex",
      instanceId: "peer-laptop",
      threadId: "remote-archived",
    });
    const pin = { ref, addedAt: 1_000, instanceLabel: "Laptop" };
    removeRemoteThreadPinStore.mockClear();
    listRemoteThreadPins.mockResolvedValueOnce([pin]);
    federationMock.remoteThreadSummaries.resolvePinnedThreads.mockResolvedValueOnce({
      threads: [],
      refreshed: [],
      archived: [ref],
    });

    registerAppServerIpcHandlers();

    const response = (await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.(
      {},
      {} satisfies GetNavigationSnapshotRequest,
    )) as { threads: Array<{ id: string }> };

    expect(removeRemoteThreadPinStore).toHaveBeenCalledWith({ ref });
    expect(response.threads).not.toContainEqual(
      expect.objectContaining({ id: "remote-archived" }),
    );
  });

  it("groups a multi-directory remote thread into exactly one local project", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const { buildFederatedThreadRef } = await import("@pwragent/shared");

    // Two local project groups; "agent-kit" sorts before "PwrAgent", which is
    // what made the duplicated row "jump" groups on selection.
    reconcileNavigationSnapshot.mockImplementationOnce(async (params: unknown) => ({
      backend: (params as { backend: "all" | "codex" | "acp:grok" }).backend,
      fetchedAt: 1234,
      unchanged: false,
      threads: (params as { threads: object[] }).threads.map((thread) => ({
        inbox: { inInbox: false },
        ...thread,
      })),
      inboxThreadKeys: [],
      directories: [
        {
          key: "directory:/repo/agent-kit",
          kind: "directory" as const,
          label: "agent-kit",
          path: "/repo/agent-kit",
          threadKeys: [],
          needsAttentionCount: 0,
          latestUpdatedAt: 2000,
        },
        {
          key: "directory:/repo/PwrAgent",
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/repo/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          latestUpdatedAt: 2000,
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const ref = buildFederatedThreadRef({
      backend: "codex",
      instanceId: "peer-laptop",
      threadId: "remote-multi",
    });
    listRemoteThreadPins.mockResolvedValueOnce([
      { ref, addedAt: 1_000, instanceLabel: "Laptop" },
    ]);
    federationMock.remoteThreadSummaries.resolvePinnedThreads.mockResolvedValueOnce({
      threads: [
        {
          source: "codex" as const,
          id: "remote-multi",
          title: "MCP registration",
          titleSource: "derived" as const,
          // Home directory on the owner prefers the repo checkout over the
          // worktree entry, then linked order — so PwrAgent, even though the
          // worktree link for agent-kit comes first. The extra links must not
          // duplicate the row into other local groups — one row per thread,
          // like local threads.
          linkedDirectories: [
            {
              id: "dir-b",
              label: "agent-kit",
              path: "/peer/dev/agent-kit",
              kind: "worktree" as const,
              worktreePath: "/peer/worktrees/x/agent-kit",
            },
            {
              id: "dir-a",
              label: "PwrAgent",
              path: "/peer/dev/PwrAgent",
              kind: "local" as const,
            },
          ],
          inbox: { inInbox: false },
          federation: {
            ref,
            instanceLabel: "Laptop",
            peerStatus: "connected" as const,
            capabilities: [],
          },
        },
      ],
      refreshed: [],
      archived: [],
    });

    registerAppServerIpcHandlers();

    const response = (await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.(
      {},
      {} satisfies GetNavigationSnapshotRequest,
    )) as {
      directories: Array<{ key: string; threadKeys: string[] }>;
    };

    const byKey = new Map(
      response.directories.map((directory) => [directory.key, directory]),
    );
    expect(byKey.get("directory:/repo/PwrAgent")?.threadKeys).toContain(
      "codex:remote-multi",
    );
    expect(byKey.get("directory:/repo/agent-kit")?.threadKeys).not.toContain(
      "codex:remote-multi",
    );
  });

  it("keeps a pinned remote thread in its owner's primary project", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const { buildFederatedThreadRef } = await import("@pwragent/shared");

    reconcileNavigationSnapshot.mockImplementationOnce(async (params: unknown) => ({
      backend: (params as { backend: "all" | "codex" | "acp:grok" }).backend,
      fetchedAt: 1234,
      unchanged: false,
      threads: (params as { threads: object[] }).threads.map((thread) => ({
        inbox: { inInbox: false },
        ...thread,
      })),
      inboxThreadKeys: [],
      directories: [
        {
          key: "directory:/repo/PwrAgent",
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/repo/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          latestUpdatedAt: 2000,
        },
        {
          key: "directory:/repo/PwrSuiteLab",
          kind: "directory" as const,
          label: "PwrSuiteLab",
          path: "/repo/PwrSuiteLab",
          threadKeys: [],
          needsAttentionCount: 0,
          latestUpdatedAt: 2000,
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const ref = buildFederatedThreadRef({
      backend: "codex",
      instanceId: "peer-laptop",
      threadId: "remote-primary-project",
    });
    listRemoteThreadPins.mockResolvedValueOnce([
      { ref, addedAt: 1_000, instanceLabel: "Laptop" },
    ]);
    federationMock.remoteThreadSummaries.resolvePinnedThreads.mockResolvedValueOnce({
      threads: [
        {
          source: "codex" as const,
          id: "remote-primary-project",
          title: "Review #1317: bind remote threads",
          titleSource: "explicit" as const,
          // This is the owner's authoritative project. The PwrSuiteLab link
          // was added later by a composer @-reference and must not re-home
          // the pinned row in this viewer's Directories lens.
          projectKey: "C:\\peer\\.codex\\worktrees\\federated-bind\\PwrAgent",
          linkedDirectories: [
            {
              id: "pwragent",
              label: "PwrAgent",
              path: "/peer/pwrdrvr/PwrAgent",
              worktreePath: "C:/peer/.codex/worktrees/federated-bind/PwrAgent",
              kind: "worktree" as const,
            },
            {
              id: "pwrsuitelab",
              label: "PwrSuiteLab",
              path: "/peer/pwrdrvr/PwrSuiteLab",
              kind: "local" as const,
            },
          ],
          inbox: { inInbox: false },
          federation: {
            ref,
            instanceLabel: "Laptop",
            peerStatus: "connected" as const,
            capabilities: [],
          },
        },
      ],
      refreshed: [],
      archived: [],
    });

    registerAppServerIpcHandlers();

    const response = (await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.(
      {},
      {} satisfies GetNavigationSnapshotRequest,
    )) as {
      directories: Array<{ key: string; threadKeys: string[] }>;
    };

    const byKey = new Map(
      response.directories.map((directory) => [directory.key, directory]),
    );
    expect(byKey.get("directory:/repo/PwrAgent")?.threadKeys).toContain(
      "codex:remote-primary-project",
    );
    expect(byKey.get("directory:/repo/PwrSuiteLab")?.threadKeys).not.toContain(
      "codex:remote-primary-project",
    );
  });

  it("keeps a partial remote pin summary ungrouped", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const { buildFederatedThreadRef } = await import("@pwragent/shared");

    const ref = buildFederatedThreadRef({
      backend: "codex",
      instanceId: "peer-laptop",
      threadId: "remote-partial-summary",
    });
    listRemoteThreadPins.mockResolvedValueOnce([
      { ref, addedAt: 1_000, instanceLabel: "Laptop" },
    ]);
    federationMock.remoteThreadSummaries.resolvePinnedThreads.mockResolvedValueOnce({
      // Cached pin payloads are untrusted JSON. A partial record must stay
      // visible in Updated / Created rather than throwing during projection.
      threads: [{
        source: "codex" as const,
        id: "remote-partial-summary",
        title: "Partial remote summary",
        titleSource: "explicit" as const,
        projectKey: "/peer/.codex/worktrees/partial/PwrAgent",
        inbox: { inInbox: false },
        federation: {
          ref,
          instanceLabel: "Laptop",
          peerStatus: "disconnected" as const,
          capabilities: [],
        },
      }],
      refreshed: [],
      archived: [],
    });

    registerAppServerIpcHandlers();

    const response = (await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.(
      {},
      {} satisfies GetNavigationSnapshotRequest,
    )) as { threads: Array<{ id: string }> };

    expect(response.threads).toContainEqual(
      expect.objectContaining({ id: "remote-partial-summary" }),
    );
  });

  it("stamps the viewer-owned local rank onto merged remote rows", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const { buildFederatedThreadRef } = await import("@pwragent/shared");

    const ref = buildFederatedThreadRef({
      backend: "codex",
      instanceId: "peer-laptop",
      threadId: "remote-ranked",
    });
    listRemoteThreadPins.mockResolvedValueOnce([
      { ref, addedAt: 1_000, instanceLabel: "Laptop", localPinnedRank: "3072" },
    ]);
    federationMock.remoteThreadSummaries.resolvePinnedThreads.mockResolvedValueOnce({
      threads: [
        {
          source: "codex" as const,
          id: "remote-ranked",
          title: "Ranked remote",
          titleSource: "derived" as const,
          // Owner-side rank must still be discarded; the VIEWER rank wins.
          pinnedRank: "9999",
          linkedDirectories: [],
          inbox: { inInbox: false },
          federation: {
            ref,
            instanceLabel: "Laptop",
            peerStatus: "connected" as const,
            capabilities: [],
          },
        },
      ],
      refreshed: [],
      archived: [],
    });

    registerAppServerIpcHandlers();

    const response = (await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.(
      {},
      {} satisfies GetNavigationSnapshotRequest,
    )) as { threads: Array<{ id: string; pinnedRank?: string }> };

    const row = response.threads.find((thread) => thread.id === "remote-ranked");
    expect(row?.pinnedRank).toBe("3072");
  });

  it("routes pin reorders per key: viewer rank for remote pins, overlay for local", async () => {
    const { NAVIGATION_REORDER_THREAD_PINS_CHANNEL } = await import(
      "../../shared/ipc"
    );
    const { buildFederatedThreadRef } = await import("@pwragent/shared");

    const remoteRef = buildFederatedThreadRef({
      backend: "codex",
      instanceId: "peer-laptop",
      threadId: "remote-pin",
    });
    reorderThreadPinsStore.mockClear();
    listRemoteThreadPins.mockResolvedValueOnce([
      { ref: remoteRef, addedAt: 1_000, instanceLabel: "Laptop" },
    ]);

    registerAppServerIpcHandlers();

    const response = (await handlers.get(NAVIGATION_REORDER_THREAD_PINS_CHANNEL)?.(
      {},
      { threadKeys: ["codex:remote-pin", "codex:local-pin"] },
    )) as { pinnedRanks: Record<string, string> };

    // The store gets the FULL order plus the remote-key routing map so both
    // kinds interleave in one atomic write.
    expect(reorderThreadPinsStore).toHaveBeenCalledWith({
      threadKeys: ["codex:remote-pin", "codex:local-pin"],
      remoteRefsByKey: { "codex:remote-pin": remoteRef },
    });
    expect(response.pinnedRanks).toEqual({
      "codex:remote-pin": "1024",
      "codex:local-pin": "2048",
    });
  });

  it("auto-ranks a remote pin whose home directory group is collapsed", async () => {
    const { NAVIGATION_ADD_REMOTE_THREAD_PIN_CHANNEL } = await import(
      "../../shared/ipc"
    );
    const { buildFederatedThreadRef } = await import("@pwragent/shared");

    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const ref = buildFederatedThreadRef({
      backend: "codex",
      instanceId: "peer-laptop",
      threadId: "remote-hidden",
    });
    setRemoteThreadLocalPin.mockClear();
    // The visibility check reads the CACHED directory summaries from the
    // last snapshot build (never a fresh snapshot) — warm the cache with a
    // snapshot whose "app" group reports Directory Threads collapsed.
    reconcileNavigationSnapshot.mockImplementationOnce(async (params: unknown) => ({
      backend: (params as { backend: "all" | "codex" | "acp:grok" }).backend,
      fetchedAt: 1234,
      unchanged: false,
      threads: (params as { threads: unknown[] }).threads,
      inboxThreadKeys: [],
      directories: [
        {
          key: "directory:/repo/app",
          kind: "directory" as const,
          label: "app",
          path: "/repo/app",
          threadKeys: [],
          needsAttentionCount: 0,
          latestUpdatedAt: 2000,
          directoryThreadsCollapsed: true,
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    registerAppServerIpcHandlers();
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.(
      {},
      {} satisfies GetNavigationSnapshotRequest,
    );

    // The pinned section is in use locally, and the freshly added pin's
    // payload carries the home-directory link.
    listPinnedThreadOverlayRanks.mockResolvedValueOnce([{ pinnedRank: "0" }]);
    listRemoteThreadPins.mockResolvedValueOnce([
      {
        ref,
        addedAt: 1_000,
        instanceLabel: "Laptop",
        summary: {
          source: "codex" as const,
          id: "remote-hidden",
          title: "Hidden remote",
          titleSource: "derived" as const,
          linkedDirectories: [
            {
              id: "dir-app",
              label: "app",
              path: "/peer/dev/app",
              kind: "local" as const,
            },
          ],
          inbox: { inInbox: false },
        },
      },
    ]);

    await handlers.get(NAVIGATION_ADD_REMOTE_THREAD_PIN_CHANNEL)?.({}, {
      ref,
      instanceLabel: "Laptop",
      summary: {
        source: "codex" as const,
        id: "remote-hidden",
        title: "Hidden remote",
        titleSource: "derived" as const,
        linkedDirectories: [],
        inbox: { inInbox: false },
      },
    });

    expect(setRemoteThreadLocalPin).toHaveBeenCalledTimes(1);
    expect(setRemoteThreadLocalPin.mock.calls[0][0]).toMatchObject({ ref });
    expect(
      typeof (setRemoteThreadLocalPin.mock.calls[0][0] as { pinnedRank?: string })
        .pinnedRank,
    ).toBe("string");
  });

  it("pins a remote sub-thread's reachable parent as a companion", async () => {
    const { NAVIGATION_ADD_REMOTE_THREAD_PIN_CHANNEL } = await import(
      "../../shared/ipc"
    );
    const { buildFederatedThreadRef } = await import("@pwragent/shared");

    addRemoteThreadPinStore.mockClear();
    hasRemoteThreadPin.mockClear();
    hasRemoteThreadPin.mockResolvedValueOnce(false);
    const parentSummary = {
      source: "codex" as const,
      id: "parent-1",
      title: "MCP registration",
      titleSource: "explicit" as const,
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    federationMock.remoteThreadSummaries.threadFromPeer.mockResolvedValueOnce(
      parentSummary,
    );

    registerAppServerIpcHandlers();

    const childRef = buildFederatedThreadRef({
      backend: "codex",
      instanceId: "peer-laptop",
      threadId: "child-1",
    });
    await handlers.get(NAVIGATION_ADD_REMOTE_THREAD_PIN_CHANNEL)?.({}, {
      ref: childRef,
      instanceLabel: "Laptop",
      summary: {
        source: "codex" as const,
        id: "child-1",
        title: "Fix PwrSnap controls",
        titleSource: "explicit" as const,
        parentThreadId: "parent-1",
        parentThreadInstanceId: "peer-parent",
        linkedDirectories: [],
        inbox: { inInbox: false },
      },
    });

    expect(addRemoteThreadPinStore).toHaveBeenCalledTimes(2);
    expect(addRemoteThreadPinStore.mock.calls[0][0]).toMatchObject({
      ref: childRef,
      pinnedVia: "explicit",
    });
    expect(addRemoteThreadPinStore.mock.calls[1][0]).toMatchObject({
      ref: buildFederatedThreadRef({
        backend: "codex",
        instanceId: "peer-parent",
        threadId: "parent-1",
      }),
      summary: parentSummary,
      pinnedVia: "companion",
    });
    expect(
      federationMock.remoteThreadSummaries.threadFromPeer,
    ).toHaveBeenCalledWith({
      target: { scope: "remote", instanceId: "peer-parent" },
      backend: "codex",
      threadId: "parent-1",
    });
  });

  it("does not companion-pin an already-pinned or unreachable parent", async () => {
    const { NAVIGATION_ADD_REMOTE_THREAD_PIN_CHANNEL } = await import(
      "../../shared/ipc"
    );
    const { buildFederatedThreadRef } = await import("@pwragent/shared");

    registerAppServerIpcHandlers();
    const handler = handlers.get(NAVIGATION_ADD_REMOTE_THREAD_PIN_CHANNEL);
    const childRequest = (threadId: string) => ({
      ref: buildFederatedThreadRef({
        backend: "codex" as const,
        instanceId: "peer-laptop",
        threadId,
      }),
      instanceLabel: "Laptop",
      summary: {
        source: "codex" as const,
        id: threadId,
        title: "Child",
        titleSource: "explicit" as const,
        parentThreadId: "parent-1",
        linkedDirectories: [],
        inbox: { inInbox: false },
      },
    });

    // Parent already pinned (e.g. explicitly, earlier): keep that pin as-is.
    addRemoteThreadPinStore.mockClear();
    hasRemoteThreadPin.mockResolvedValueOnce(true);
    await handler?.({}, childRequest("child-1"));
    expect(addRemoteThreadPinStore).toHaveBeenCalledTimes(1);

    // Parent missing from the peer snapshot (archived / peer gone): no
    // phantom row.
    addRemoteThreadPinStore.mockClear();
    hasRemoteThreadPin.mockResolvedValueOnce(false);
    federationMock.remoteThreadSummaries.threadFromPeer.mockResolvedValueOnce(
      undefined,
    );
    await handler?.({}, childRequest("child-2"));
    expect(addRemoteThreadPinStore).toHaveBeenCalledTimes(1);
    expect(addRemoteThreadPinStore.mock.calls[0][0]).toMatchObject({
      pinnedVia: "explicit",
    });
  });

  it("rejects malformed pin refs at the service boundary", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const {
      NAVIGATION_ADD_REMOTE_THREAD_PIN_CHANNEL,
      NAVIGATION_REMOVE_REMOTE_THREAD_PIN_CHANNEL,
      NAVIGATION_SET_REMOTE_THREAD_LOCAL_PIN_CHANNEL,
    } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();
    addRemoteThreadPinStore.mockClear();
    setRemoteThreadLocalPin.mockClear();

    // A malformed instance id (spaces, punctuation) must never reach the
    // store — the sqlite key would persist a row that dims forever.
    const badInstanceRef = {
      backend: "codex" as const,
      target: { scope: "remote" as const, instanceId: "peer laptop!" },
      threadId: "thread-1",
    };
    // An unknown backend kind is equally unresolvable later.
    const badBackendRef = {
      backend: "not-a-backend",
      target: { scope: "remote" as const, instanceId: "peer-laptop" },
      threadId: "thread-1",
    };
    await expect(
      handlers.get(NAVIGATION_ADD_REMOTE_THREAD_PIN_CHANNEL)?.({}, {
        ref: badInstanceRef,
        instanceLabel: "Laptop",
      }),
    ).rejects.toThrow(/remote federation target/i);
    await expect(
      handlers.get(NAVIGATION_ADD_REMOTE_THREAD_PIN_CHANNEL)?.({}, {
        ref: badBackendRef,
        instanceLabel: "Laptop",
      }),
    ).rejects.toThrow(/backend/i);
    await expect(
      handlers.get(NAVIGATION_REMOVE_REMOTE_THREAD_PIN_CHANNEL)?.({}, {
        ref: badInstanceRef,
      }),
    ).rejects.toThrow(/remote federation target/i);
    await expect(
      handlers.get(NAVIGATION_SET_REMOTE_THREAD_LOCAL_PIN_CHANNEL)?.({}, {
        ref: badInstanceRef,
        pinnedRank: "1024",
      }),
    ).rejects.toThrow(/remote federation target/i);
    expect(addRemoteThreadPinStore).not.toHaveBeenCalled();
    expect(setRemoteThreadLocalPin).not.toHaveBeenCalled();
  });

  it("keeps pinned remote rows, dimmed, when the owner is unreachable", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const { buildFederatedThreadRef } = await import("@pwragent/shared");

    const ref = buildFederatedThreadRef({
      backend: "codex",
      instanceId: "peer-laptop",
      threadId: "remote-1",
    });
    updateRemoteThreadPinSnapshots.mockClear();
    listRemoteThreadPins.mockResolvedValueOnce([
      { ref, addedAt: 1_000, instanceLabel: "Laptop" },
    ]);
    federationMock.remoteThreadSummaries.resolvePinnedThreads.mockResolvedValueOnce({
      threads: [
        {
          source: "codex" as const,
          id: "remote-1",
          title: "Cached remote title",
          titleSource: "derived" as const,
          linkedDirectories: [],
          inbox: { inInbox: false },
          federation: {
            ref,
            instanceLabel: "Laptop",
            peerStatus: "disconnected" as const,
            capabilities: [],
          },
        },
      ],
      refreshed: [],
      archived: [],
    });

    registerAppServerIpcHandlers();

    const response = (await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.(
      {},
      {} satisfies GetNavigationSnapshotRequest,
    )) as {
      threads: Array<{
        id: string;
        title: string;
        federation?: { peerStatus?: string };
      }>;
      inboxThreadKeys: string[];
    };

    const remoteRow = response.threads.find(
      (thread) => thread.id === "remote-1",
    );
    expect(remoteRow?.federation?.peerStatus).toBe("disconnected");
    expect(remoteRow?.title).toBe("Cached remote title");
    expect(updateRemoteThreadPinSnapshots).not.toHaveBeenCalled();
    expect(response.inboxThreadKeys).not.toContain("codex:remote-1");
  });

  it("publishes the primary repository resolved from a worktree to the composer", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const thread = {
      id: "thread-1",
      title: "Clipboard fallback",
      titleSource: "explicit" as const,
      source: "codex" as const,
      linkedDirectories: [
        {
          id: "directory:/repo/PwrAgent",
          kind: "worktree" as const,
          label: "PwrAgent",
          path: "/repo/PwrAgent",
          worktreePath: "/repo/.worktrees/clipboard-fallback",
        },
      ],
      updatedAt: 2000,
    };
    listThreads.mockResolvedValueOnce([thread] as never);
    resolveGitHubRepoForDirectory.mockResolvedValueOnce({
      host: "github.com",
      owner: "pwrdrvr",
      repo: "PwrAgent",
    });

    registerAppServerIpcHandlers();
    const response = await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});

    expect(resolveGitHubRepoForDirectory).toHaveBeenCalledWith(
      "/repo/.worktrees/clipboard-fallback",
    );
    expect(response).toMatchObject({
      threads: [
        {
          id: "thread-1",
          primaryGitRepository: "github.com/pwrdrvr/pwragent",
        },
      ],
    });
  });

  it("invalidates unchanged snapshots when primary repository resolution recovers", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const thread = {
      id: "thread-1",
      title: "Clipboard fallback",
      titleSource: "explicit" as const,
      source: "codex" as const,
      linkedDirectories: [
        {
          id: "directory:/repo/PwrAgent",
          kind: "worktree" as const,
          label: "PwrAgent",
          path: "/repo/PwrAgent",
          worktreePath: "/repo/.worktrees/clipboard-fallback",
        },
      ],
      updatedAt: 2_000,
    };
    const snapshot = (fetchedAt: number, unchanged: boolean) => ({
      backend: "all" as const,
      fetchedAt,
      unchanged,
      threads: [thread],
      inboxThreadKeys: ["codex:thread-1"],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    });
    listThreads
      .mockResolvedValueOnce([thread] as never)
      .mockResolvedValueOnce([thread] as never)
      .mockResolvedValueOnce([thread] as never);
    reconcileNavigationSnapshot
      .mockResolvedValueOnce(snapshot(1_234, false))
      .mockResolvedValueOnce(snapshot(5_678, true))
      .mockResolvedValueOnce(snapshot(9_012, true));
    resolveGitHubRepoForDirectory
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        host: "github.com",
        owner: "pwrdrvr",
        repo: "PwrAgent",
      })
      .mockResolvedValueOnce({
        host: "github.com",
        owner: "pwrdrvr",
        repo: "PwrAgent",
      });

    registerAppServerIpcHandlers();
    const first = await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    const recovered = await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    const stable = await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});

    expect(first).toMatchObject({
      unchanged: false,
      threads: [{ id: "thread-1" }],
    });
    expect(recovered).toMatchObject({
      unchanged: false,
      threads: [{
        id: "thread-1",
        primaryGitRepository: "github.com/pwrdrvr/pwragent",
      }],
    });
    expect(stable).toMatchObject({
      unchanged: true,
      threads: [{
        id: "thread-1",
        primaryGitRepository: "github.com/pwrdrvr/pwragent",
      }],
    });
  });

  it("uses one active recent page for lightweight navigation refreshes", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();

    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.(
      {},
      {
        forceRefresh: true,
        refreshMode: "active-recent",
      } satisfies GetNavigationSnapshotRequest,
    );

    expect(listThreads).toHaveBeenCalledWith({
      backend: undefined,
      callerReason: "navigation-snapshot:active-recent",
      filter: undefined,
      forceRefresh: true,
      limit: 50,
      maxPages: 1,
      skipArchivedMetadataRefresh: true,
    });
    expect(rememberCompleteNavigationSnapshot).not.toHaveBeenCalled();
  });

  it("merges lightweight navigation refreshes into the last full thread list", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");

    const staleThread = {
      id: "thread-stale",
      title: "Stale thread",
      titleSource: "explicit" as const,
      source: "codex" as const,
      linkedDirectories: [],
      updatedAt: 1_000,
    };
    const recentThread = {
      id: "thread-recent",
      title: "Recent thread",
      titleSource: "explicit" as const,
      source: "codex" as const,
      linkedDirectories: [],
      updatedAt: 2_000,
    };
    const updatedRecentThread = {
      ...recentThread,
      title: "Updated recent thread",
      updatedAt: 3_000,
    };
    listThreads
      .mockResolvedValueOnce([recentThread, staleThread])
      .mockResolvedValueOnce([updatedRecentThread]);

    registerAppServerIpcHandlers();

    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.(
      {},
      {} satisfies GetNavigationSnapshotRequest,
    );
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.(
      {},
      {
        forceRefresh: true,
        refreshMode: "active-recent",
      } satisfies GetNavigationSnapshotRequest,
    );

    expect(reconcileNavigationSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        threads: [
          expect.objectContaining({
            id: "thread-recent",
            title: "Updated recent thread",
          }),
          expect.objectContaining({ id: "thread-stale" }),
        ],
      }),
    );
  });

  it("returns backend scope all when listing threads without a backend filter", async () => {
    const { APP_SERVER_LIST_THREADS_CHANNEL } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();

    const response = await handlers.get(APP_SERVER_LIST_THREADS_CHANNEL)?.(
      {},
      {} satisfies AppServerListThreadsRequest,
    );

    expect(response).toEqual({
      backend: "all",
      fetchedAt: expect.any(Number),
      threads: [
        expect.objectContaining({ source: "codex", id: "thread-1" }),
        expect.objectContaining({ source: "acp:grok", id: "thread-1" }),
      ],
      workspaceRoots: [
        path.join(os.homedir(), ".pwragent", "profiles", "default", "projects"),
        path.join(os.homedir(), ".pwragent", "projects"),
        path.join(os.homedir(), ".pwragnt", "projects"),
      ],
    });
  });

  it("caps oversized transcript payload strings before readThread crosses IPC", async () => {
    const { APP_SERVER_READ_THREAD_CHANNEL } = await import("../../shared/ipc");
    const oversizedOutput =
      `{"backend":"codex","captureId":"2026-04-19T01-40-27-292Z-codex"}` +
      "x".repeat(80_000) +
      "protocol-tail";

    const oversizedReadThreadResponse: AppServerReadThreadResponse = {
      backend: "codex",
      fetchedAt: 1234,
      threadId: "thread-large",
      replay: {
        entries: [
          {
            type: "activity",
            id: "activity-1",
            summary: "Ran command",
            status: "completed",
            details: [
              {
                id: "cmd-1",
                kind: "command",
                label: "cat protocol-capture.json",
                command: {
                  displayCommand: "cat protocol-capture.json",
                  output: oversizedOutput,
                },
              },
            ],
          },
        ],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
      threadStatus: "idle",
    };
    readThread.mockResolvedValueOnce(oversizedReadThreadResponse as never);

    registerAppServerIpcHandlers();

    const response = await handlers.get(APP_SERVER_READ_THREAD_CHANNEL)?.(
      {},
      { backend: "codex", threadId: "thread-large" },
    ) as AppServerReadThreadResponse | undefined;
    const entry = response?.replay.entries[0];
    const output =
      entry?.type === "activity"
        ? entry.details[0]?.command?.output ?? ""
        : "";

    expect(readThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-large",
      includeAllToolInvocations: undefined,
      includeTurns: undefined,
      before: undefined,
      limit: undefined,
      viewOnly: undefined,
    });
    expect(
      federationMock.runtime.hydrateThreadMessageOrigins,
    ).toHaveBeenCalledWith(oversizedReadThreadResponse);
    expect(output.length).toBeLessThan(36_000);
    expect(output).toContain("PwrAgent renderer boundary: truncated");
    expect(output).toContain("$.replay.entries[0].details[0].command.output");
    expect(output).toContain("protocol-tail");
    expect(output).not.toContain("x".repeat(60_000));
  });

  it("forwards inspection-only full-accounting reads to the backend registry", async () => {
    const { APP_SERVER_READ_THREAD_CHANNEL } = await import("../../shared/ipc");
    readThread.mockResolvedValueOnce({
      backend: "codex",
      fetchedAt: 1234,
      threadId: "sub-agent-1",
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
      threadStatus: "idle",
    } as never);

    registerAppServerIpcHandlers();

    await handlers.get(APP_SERVER_READ_THREAD_CHANNEL)?.(
      {},
      {
        backend: "codex",
        includeAllToolInvocations: true,
        threadId: "sub-agent-1",
        viewOnly: true,
      },
    );

    expect(readThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "sub-agent-1",
      includeAllToolInvocations: true,
      includeTurns: undefined,
      before: undefined,
      limit: undefined,
      viewOnly: true,
    });
    expect(getThreadTranscriptImageRoots).not.toHaveBeenCalled();
  });

  it("strips readThread file diffs behind fetchable refs before crossing IPC", async () => {
    const {
      APP_SERVER_GET_THREAD_FILE_DIFF_CHANNEL,
      APP_SERVER_READ_THREAD_CHANNEL,
    } = await import("../../shared/ipc");
    const diff = [
      "@@ -1,2 +1,4 @@",
      " existing",
      "+added one",
      "+added two",
    ].join("\n");
    const readThreadResponse: AppServerReadThreadResponse = {
      backend: "codex",
      fetchedAt: 1234,
      threadId: "thread-diff-ref",
      replay: {
        entries: [
          {
            type: "activity",
            id: "activity-1",
            summary: "Edited 1 file",
            details: [
              {
                id: "detail-1",
                kind: "write",
                label: "Update file.ts",
                path: "/repo/file.ts",
                fileDiff: {
                  kind: "update",
                  diff,
                  additions: 2,
                  removals: 0,
                },
              },
            ],
          },
        ],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
      threadStatus: "idle",
    };
    readThread.mockResolvedValueOnce(readThreadResponse as never);

    registerAppServerIpcHandlers();

    const response = await handlers.get(APP_SERVER_READ_THREAD_CHANNEL)?.(
      {},
      { backend: "codex", threadId: "thread-diff-ref" },
    ) as AppServerReadThreadResponse | undefined;
    const entry = response?.replay.entries[0];
    const detail = entry?.type === "activity" ? entry.details[0] : undefined;

    expect(detail?.fileDiff).toMatchObject({
      diff: "",
      additions: 2,
      removals: 0,
      diffRef: {
        source: "thread",
        backend: "codex",
        threadId: "thread-diff-ref",
        entryId: "activity-1",
        detailId: "detail-1",
      },
    });
    expect(JSON.stringify(response)).not.toContain("+added one");

    const fetched = await handlers.get(APP_SERVER_GET_THREAD_FILE_DIFF_CHANNEL)?.(
      {},
      { ref: detail!.fileDiff!.diffRef! },
    );

    expect(fetched).toEqual({ diff });
  });

  it("hydrates retained worktree snapshots when listing archived threads", async () => {
    const { APP_SERVER_LIST_THREADS_CHANNEL } = await import("../../shared/ipc");
    getThreadOverlayStates.mockResolvedValue({
      "thread-archived": {
        backend: "codex",
        threadId: "thread-archived",
        executionMode: "default",
        extraLinkedDirectories: [],
        worktreeSnapshots: [
          {
            id: "snapshot-1",
            backend: "codex",
            threadId: "thread-archived",
            worktreePath: "/Users/test/.codex/worktrees/mp7efuda/PwrSnap",
            repositoryPath: "/Users/test/github/PwrSnap",
            snapshotRef: "refs/codex/snapshots/snapshot-1",
            snapshotCommit: "abc123",
            createdAt: 1000,
            archivedAt: 3000,
            state: "archived",
            ignoredFilesExcluded: true,
          },
        ],
      },
    });

    registerAppServerIpcHandlers();

    const response = await handlers.get(APP_SERVER_LIST_THREADS_CHANNEL)?.(
      {},
      { archived: true } satisfies AppServerListThreadsRequest,
    );

    expect(getThreadOverlayStates).toHaveBeenCalledWith({
      backend: "codex",
      threadIds: ["thread-archived"],
    });
    expect(response).toEqual({
      backend: "all",
      fetchedAt: expect.any(Number),
      threads: [
        expect.objectContaining({
          id: "thread-archived",
          worktreeSnapshots: [
            expect.objectContaining({
              repositoryPath: "/Users/test/github/PwrSnap",
              worktreePath: "/Users/test/.codex/worktrees/mp7efuda/PwrSnap",
            }),
          ],
        }),
      ],
      workspaceRoots: [
        path.join(os.homedir(), ".pwragent", "profiles", "default", "projects"),
        path.join(os.homedir(), ".pwragent", "projects"),
        path.join(os.homedir(), ".pwragnt", "projects"),
      ],
    });
  });

  it("archives threads through the app-server IPC handler", async () => {
    const { APP_SERVER_ARCHIVE_THREAD_CHANNEL } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();

    const response = await handlers.get(APP_SERVER_ARCHIVE_THREAD_CHANNEL)?.({}, {
      backend: "codex",
      threadId: "thread-1",
    } satisfies ArchiveThreadRequest);

    expect(archiveThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(
      federationMock.runtime.ungroupRemoteChildrenOfArchivedThread,
    ).toHaveBeenCalledWith({
      backend: "codex",
      parentThreadId: "thread-1",
    });
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      archivedAt: 3000,
      cleanup: [],
    });
  });

  it("archives remote threads on the selected federation peer", async () => {
    const { APP_SERVER_ARCHIVE_THREAD_CHANNEL } = await import("../../shared/ipc");
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    registerAppServerIpcHandlers();

    const response = await handlers.get(APP_SERVER_ARCHIVE_THREAD_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-remote",
    } satisfies ArchiveThreadRequest);

    expect(federationMock.runtime.remoteBackend).toHaveBeenCalledWith(
      federationTarget,
    );
    expect(federationMock.remoteBackend.archiveThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-remote",
    });
    expect(archiveThread).not.toHaveBeenCalled();
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-remote",
      archivedAt: 6_000,
      cleanup: [],
    });
  });

  it("restores threads through the app-server IPC handler", async () => {
    const { APP_SERVER_RESTORE_THREAD_CHANNEL } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();

    const response = await handlers.get(APP_SERVER_RESTORE_THREAD_CHANNEL)?.({}, {
      backend: "acp:grok",
      threadId: "thread-1",
    } satisfies RestoreThreadRequest);

    expect(restoreThread).toHaveBeenCalledWith({
      backend: "acp:grok",
      threadId: "thread-1",
    });
    expect(response).toEqual({
      backend: "acp:grok",
      threadId: "thread-1",
      restoredAt: 3000,
    });
  });

  it("archives worktrees through the app-server IPC handler", async () => {
    const { APP_SERVER_ARCHIVE_WORKTREE_CHANNEL } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();

    const response = await handlers.get(APP_SERVER_ARCHIVE_WORKTREE_CHANNEL)?.({}, {
      backend: "codex",
      threadId: "thread-1",
      repositoryPath: "/repo",
      worktreePath: "/worktrees/thread-1",
    } satisfies ArchiveWorktreeRequest);

    expect(archiveWorktree).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      repositoryPath: "/repo",
      worktreePath: "/worktrees/thread-1",
    });
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      archivedAt: 3000,
      snapshot: expect.objectContaining({
        snapshotRef: "refs/codex/snapshots/snapshot-1",
        state: "archived",
      }),
    });
  });

  it("restores worktrees through the app-server IPC handler", async () => {
    const { APP_SERVER_RESTORE_WORKTREE_CHANNEL } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();

    const response = await handlers.get(APP_SERVER_RESTORE_WORKTREE_CHANNEL)?.({}, {
      backend: "codex",
      threadId: "thread-1",
      snapshotRef: "refs/codex/snapshots/snapshot-1",
      worktreePath: "/worktrees/thread-1",
    } satisfies RestoreWorktreeRequest);

    expect(restoreWorktree).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      snapshotRef: "refs/codex/snapshots/snapshot-1",
      worktreePath: "/worktrees/thread-1",
    });
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      restoredAt: 4000,
      snapshot: expect.objectContaining({
        snapshotRef: "refs/codex/snapshots/snapshot-1",
        state: "restored",
      }),
    });
  });

  it("hands off thread workspaces through the app-server IPC handler", async () => {
    const { APP_SERVER_HANDOFF_THREAD_WORKSPACE_CHANNEL } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();

    const response = await handlers.get(APP_SERVER_HANDOFF_THREAD_WORKSPACE_CHANNEL)?.({}, {
      backend: "codex",
      threadId: "thread-1",
      direction: "local-to-worktree",
      repositoryPath: "/repo",
      sourcePath: "/repo",
      sourceBranch: "feature/handoff",
      leaveLocalBranch: "main",
    } satisfies HandoffThreadWorkspaceRequest);

    expect(handoffThreadWorkspace).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      direction: "local-to-worktree",
      repositoryPath: "/repo",
      sourcePath: "/repo",
      sourceBranch: "feature/handoff",
      leaveLocalBranch: "main",
    });
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      direction: "local-to-worktree",
      workMode: "worktree",
      branch: "feature/handoff",
      repositoryPath: "/repo",
      targetPath: "/repo/.worktrees/app-feature-handoff",
      linkedDirectory: expect.objectContaining({
        kind: "worktree",
      }),
      warnings: [],
      completedAt: 5000,
    });
  });

  it("renames threads through the app-server IPC handler", async () => {
    const { APP_SERVER_RENAME_THREAD_CHANNEL } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();

    const response = await handlers.get(APP_SERVER_RENAME_THREAD_CHANNEL)?.({}, {
      backend: "acp:grok",
      threadId: "thread-1",
      name: "Renamed thread",
    } satisfies RenameThreadRequest);

    expect(renameThread).toHaveBeenCalledWith({
      backend: "acp:grok",
      threadId: "thread-1",
      name: "Renamed thread",
    });
    expect(response).toEqual({
      backend: "acp:grok",
      threadId: "thread-1",
      renamedAt: 3000,
    });
  });

  it("renames remote threads on the selected federation peer", async () => {
    const { APP_SERVER_RENAME_THREAD_CHANNEL } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();

    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    const response = await handlers.get(APP_SERVER_RENAME_THREAD_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-remote",
      name: "Remote title",
    } satisfies RenameThreadRequest);

    expect(federationMock.runtime.remoteBackend).toHaveBeenCalledWith(
      federationTarget,
    );
    expect(federationMock.remoteBackend.renameThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-remote",
      name: "Remote title",
    });
    expect(renameThread).not.toHaveBeenCalled();
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-remote",
      renamedAt: 6_000,
    });
  });

  it("routes remote unlinking to the owner and refreshes the mounted pin", async () => {
    const { NAVIGATION_SET_THREAD_PARENT_CHANNEL } = await import(
      "../../shared/ipc"
    );
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "child-owner",
    };
    const ref = {
      backend: "codex" as const,
      target: federationTarget,
      threadId: "thread-child",
    };
    listRemoteThreadPins.mockResolvedValueOnce([{
      ref,
      instanceLabel: "Child Mac",
      pinnedVia: "child",
      addedAt: 1_000,
      summary: {
        source: "codex",
        id: "thread-child",
        title: "Remote child",
        titleSource: "explicit",
        linkedDirectories: [],
        inbox: { inInbox: false },
        parentThreadId: "thread-parent",
        parentThreadBackend: "codex",
        parentThreadInstanceId: "parent-owner",
      },
    }]);

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_SET_THREAD_PARENT_CHANNEL)?.(
      {},
      {
        backend: "codex",
        federationTarget,
        threadId: "thread-child",
      } satisfies SetThreadParentRequest,
    );

    expect(federationMock.remoteBackend.setThreadParent).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-child",
    });
    expect(updateRemoteThreadPinSnapshots).toHaveBeenCalledWith([{
      ref,
      instanceLabel: "Child Mac",
      summary: expect.not.objectContaining({
        parentThreadId: expect.anything(),
        parentThreadBackend: expect.anything(),
        parentThreadInstanceId: expect.anything(),
      }),
    }]);
    expect(federationMock.remoteThreadSummaries.invalidate).toHaveBeenCalledWith(
      "child-owner",
    );
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-child",
      parentThreadId: undefined,
      parentThreadBackend: undefined,
      parentThreadInstanceId: undefined,
    });
  });

  it("marks Grok threads seen without rejecting the backend", async () => {
    const { NAVIGATION_MARK_THREAD_SEEN_CHANNEL } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_MARK_THREAD_SEEN_CHANNEL)?.({}, {
      backend: "acp:grok",
      threadId: "thread-1",
      seenUpdatedAt: 3000,
    } satisfies MarkThreadSeenRequest);

    expect(markThreadSeen).toHaveBeenCalledWith({
      backend: "acp:grok",
      threadId: "thread-1",
      seenAt: undefined,
      seenUpdatedAt: 3000,
    });
    expect(response).toEqual({
      backend: "acp:grok",
      threadId: "thread-1",
      seenAt: 2000,
      seenUpdatedAt: 3000,
    });
  });

  it("marks remote threads seen on the owning federation peer", async () => {
    const { NAVIGATION_MARK_THREAD_SEEN_CHANNEL } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();

    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    const response = await handlers.get(NAVIGATION_MARK_THREAD_SEEN_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-remote",
      seenUpdatedAt: 3_000,
    } satisfies MarkThreadSeenRequest);

    expect(federationMock.runtime.remoteBackend).toHaveBeenCalledWith(
      federationTarget,
    );
    expect(federationMock.remoteBackend.markThreadSeen).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-remote",
      seenUpdatedAt: 3_000,
    });
    expect(markThreadSeen).not.toHaveBeenCalled();
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-remote",
      seenAt: 6_000,
      seenUpdatedAt: 3_000,
    });
  });

  it("adds remote thread reactions on the owner without replacing its ordered reactions", async () => {
    const { NAVIGATION_SET_THREAD_REACTION_CHANNEL } = await import(
      "../../shared/ipc"
    );
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    registerAppServerIpcHandlers();

    const response = await handlers.get(
      NAVIGATION_SET_THREAD_REACTION_CHANNEL,
    )?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-remote",
      emoji: "👀",
      present: true,
    });

    expect(federationMock.runtime.remoteBackend).toHaveBeenCalledWith(
      federationTarget,
    );
    expect(federationMock.remoteBackend.setThreadReaction).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-remote",
      emoji: "👀",
      present: true,
    });
    expect(setThreadReactionOverlay).not.toHaveBeenCalled();
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-remote",
      reactions: ["✋", "👀"],
    });
  });

  it("publishes local reaction mutations to navigation subscribers", async () => {
    const { NAVIGATION_SET_THREAD_REACTION_CHANNEL } = await import(
      "../../shared/ipc"
    );
    registerAppServerIpcHandlers();

    await handlers.get(NAVIGATION_SET_THREAD_REACTION_CHANNEL)?.({}, {
      backend: "codex",
      threadId: "thread-local",
      emoji: "👀",
      present: true,
    });

    expect(publishLocalEvent).toHaveBeenCalledWith({
      backend: "codex",
      notification: {
        method: "thread/reactions/updated",
        params: {
          threadId: "thread-local",
          reactions: ["👀"],
        },
      },
    });
  });

  it("returns known PR chips immediately and refreshes mixed terminal/non-terminal state in the background", async () => {
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const request = {
      backend: "codex",
      threadId: "thread-1",
      trigger: "user",
      branch: "fix/desktop-source-link-goto",
      directoryPaths: ["/repo"],
    } satisfies RefreshThreadPullRequestsRequest;
    const requestKey = buildThreadPrRequestKey({
      backend: "codex",
      threadId: "thread-1",
      branch: "fix/desktop-source-link-goto",
      directoryPaths: ["/repo"],
    });
    const stalePassingPr = githubPr({
      number: 433,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "passing",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/433",
    });
    const mergedPr = githubPr({
      number: 430,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "merged",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/430",
    });
    const refreshedPrs: PrSummary[] = [
      githubPr({
        number: stalePassingPr.number,
        org: stalePassingPr.org,
        repo: stalePassingPr.repo,
        state: "merged",
        url: stalePassingPr.url,
      }),
      mergedPr,
    ];
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prs: [stalePassingPr, mergedPr],
      prsFetchedAt: Date.now() - 120_000,
      prsRefreshKey: requestKey,
    });
    detectPullRequestsForThread.mockResolvedValueOnce(refreshedPrs);

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.(
      {},
      request,
    );

    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      provider: "github.com",
      ghAvailable: true,
      prs: [stalePassingPr, mergedPr],
    });

    await vi.waitFor(() => {
      expect(detectPullRequestsForThread).toHaveBeenCalledWith({
        fetcher: expect.any(Object),
        branch: "fix/desktop-source-link-goto",
        directoryPaths: ["/repo"],
        allowPrimedBranchLookup: false,
      });
    });
    await vi.waitFor(() => {
      expect(setThreadPullRequests).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        prs: refreshedPrs,
        fetchedAt: expect.any(Number),
        refreshKey: requestKey,
      });
    });
    expect(publishLocalEvent).toHaveBeenCalledWith({
      backend: "codex",
      notification: {
        method: "thread/pullRequests/updated",
        params: {
          threadId: "thread-1",
          prs: refreshedPrs,
        },
      },
    });
    expect(writePrStatusCacheEntries).toHaveBeenCalledWith([
      {
        provider: "github.com",
        prKey: "github.com/pwrdrvr/pwragent#433",
        fetchedAt: expect.any(Number),
        pr: refreshedPrs[0],
      },
      {
        provider: "github.com",
        prKey: "github.com/pwrdrvr/pwragent#430",
        fetchedAt: expect.any(Number),
        pr: refreshedPrs[1],
      },
    ]);
  });

  it("logs user-triggered PR refresh decisions and background completion with PR ids", async () => {
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const request = {
      backend: "codex",
      threadId: "019ed359-0b92-7ca2-ae05-a5837cc80df8",
      trigger: "user",
      branch: "fix/live-diff-activity-normalization",
      directoryPaths: ["/repo"],
    } satisfies RefreshThreadPullRequestsRequest;
    const requestKey = buildThreadPrRequestKey({
      backend: "codex",
      threadId: request.threadId,
      branch: request.branch,
      directoryPaths: request.directoryPaths,
    });
    const stalePr = githubPr({
      number: 845,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "pending",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/845",
    });
    const passingPr = githubPr({
      number: 845,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "passing",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/845",
    });
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: request.threadId,
      executionMode: "default",
      extraLinkedDirectories: [],
      prs: [stalePr],
      prsFetchedAt: Date.now() - 120_000,
      prsRefreshKey: requestKey,
    });
    detectPullRequestsForThread.mockResolvedValueOnce([passingPr]);

    registerAppServerIpcHandlers();

    await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.({}, request);

    expect(mockAppServerLog.debug).toHaveBeenCalledWith(
      "threadPullRequestsRefresh:requested",
      expect.objectContaining({
        branch: "fix/live-diff-activity-normalization",
        previousPrIds: ["github.com/pwrdrvr/pwragent#845"],
        threadId: "019ed359-0b92-7ca2-ae05-a5837cc80df8",
        trigger: "user",
      }),
    );
    expect(mockAppServerLog.debug).toHaveBeenCalledWith(
      "threadPullRequestsRefresh:background-start",
      expect.objectContaining({
        previousPrIds: ["github.com/pwrdrvr/pwragent#845"],
        threadId: "019ed359-0b92-7ca2-ae05-a5837cc80df8",
        trigger: "user",
      }),
    );
    await vi.waitFor(() => {
      expect(detectPullRequestsForThread).toHaveBeenCalledWith({
        fetcher: expect.any(Object),
        branch: "fix/live-diff-activity-normalization",
        directoryPaths: ["/repo"],
        allowPrimedBranchLookup: false,
      });
    });
    await vi.waitFor(() => {
      expect(mockAppServerLog.debug).toHaveBeenCalledWith(
        "threadPullRequestsRefresh:background-complete",
        expect.objectContaining({
          changedThreadCount: 1,
          fetchedPrIds: ["github.com/pwrdrvr/pwragent#845"],
          previousPrIds: ["github.com/pwrdrvr/pwragent#845"],
          fetchedPrStatuses: [
            {
              prKey: "github.com/pwrdrvr/pwragent#845",
              checkState: "passing",
              checksStillRunning: false,
              lifecycleState: "open",
              mergeState: "unknown",
              reviewState: "ready_for_review",
              commitCount: 0,
            },
          ],
          subscriberCount: 1,
          threadId: "019ed359-0b92-7ca2-ae05-a5837cc80df8",
          trigger: "user",
        }),
      );
    });
    expect(mockAppServerLog.info).toHaveBeenCalledWith(
      "pr status transition",
      expect.objectContaining({
        changes: { checkState: "pending→passing" },
        observedAt: expect.any(Number),
        prKey: "github.com/pwrdrvr/pwragent#845",
        source: "thread-lookup:user",
      }),
    );
  });

  it("orders thread lookup observations by request start time", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(3_000_000);
      const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
      const request = {
        backend: "codex",
        threadId: "thread-request-order",
        trigger: "user",
        branch: "fix/request-order",
        directoryPaths: ["/repo"],
      } satisfies RefreshThreadPullRequestsRequest;
      const requestKey = buildThreadPrRequestKey({
        backend: "codex",
        threadId: request.threadId,
        branch: request.branch,
        directoryPaths: request.directoryPaths,
      });
      const stalePr = githubPr({
        number: 846,
        org: "pwrdrvr",
        repo: "PwrAgent",
        state: "passing",
        mergeState: "mergeable",
        url: "https://github.com/pwrdrvr/PwrAgent/pull/846",
      });
      const freshPr = { ...stalePr, mergeState: "conflicting" as const };
      let resolveFetch: ((prs: PrSummary[]) => void) | undefined;

      getThreadOverlayState.mockResolvedValueOnce({
        backend: "codex",
        threadId: request.threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
        prs: [stalePr],
        prsFetchedAt: 2_000_000,
        prsRefreshKey: requestKey,
      });
      detectPullRequestsForThread.mockImplementationOnce(
        async () => await new Promise<PrSummary[]>((resolve) => {
          resolveFetch = resolve;
        }),
      );

      registerAppServerIpcHandlers();
      await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.({}, request);
      await vi.waitFor(() => {
        expect(detectPullRequestsForThread).toHaveBeenCalledOnce();
      });

      vi.setSystemTime(3_005_000);
      resolveFetch?.([freshPr]);

      await vi.waitFor(() => {
        expect(setThreadPullRequests).toHaveBeenCalledWith(
          expect.objectContaining({
            threadId: request.threadId,
            fetchedAt: 3_000_000,
          }),
        );
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an older PR lookup that finishes after a newer lookup", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(4_000_000);
      const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
      const stalePr = githubPr({
        number: 847,
        org: "pwrdrvr",
        repo: "PwrAgent",
        state: "passing",
        mergeState: "mergeable",
        url: "https://github.com/pwrdrvr/PwrAgent/pull/847",
      });
      const freshPr = { ...stalePr, mergeState: "conflicting" as const };
      const requests = ["/repo/older", "/repo/newer"].map((directoryPath, index) => ({
        backend: "codex" as const,
        threadId: `thread-request-order-${index}`,
        trigger: "user" as const,
        branch: "fix/request-order",
        directoryPaths: [directoryPath],
      }));
      const resolveFetches: Array<(prs: PrSummary[]) => void> = [];

      getThreadOverlayState.mockImplementation(async ({ threadId }) => {
        const request = requests.find((candidate) => candidate.threadId === threadId);
        if (!request) {
          return null;
        }
        return {
          backend: "codex",
          threadId,
          executionMode: "default",
          extraLinkedDirectories: [],
          prs: [stalePr],
          prsFetchedAt: 3_000_000,
          prsRefreshKey: buildThreadPrRequestKey(request),
        };
      });
      detectPullRequestsForThread.mockImplementation(
        async () => await new Promise<PrSummary[]>((resolve) => {
          resolveFetches.push(resolve);
        }),
      );

      registerAppServerIpcHandlers();
      await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.({}, requests[0]);
      await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.({}, requests[1]);
      expect(detectPullRequestsForThread).toHaveBeenCalledTimes(2);

      resolveFetches[1]?.([freshPr]);
      await vi.waitFor(() => {
        expect(mockAppServerLog.info).toHaveBeenCalledWith(
          "pr status transition",
          expect.objectContaining({
            changes: { mergeState: "mergeable→conflicting" },
            observedAt: 4_000_001,
            source: "thread-lookup:user",
          }),
        );
      });

      resolveFetches[0]?.([stalePr]);
      await vi.waitFor(() => {
        expect(mockAppServerLog.info).toHaveBeenCalledWith(
          "pr status observation ignored",
          expect.objectContaining({
            currentObservedAt: 4_000_001,
            observedAt: 4_000_000,
            prKey: "github.com/pwrdrvr/pwragent#847",
            source: "thread-lookup:user",
          }),
        );
      });
      expect(setThreadPullRequests).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-request-order-0",
          prs: [freshPr],
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves the same canonical PR state across different thread overlays", async () => {
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const stalePr = githubPr({
      number: 727,
      org: "OpenAI",
      repo: "codex",
      state: "pending",
      url: "https://github.com/OpenAI/codex/pull/727",
    });
    const passingPr = githubPr({
      number: stalePr.number,
      org: stalePr.org,
      repo: stalePr.repo,
      state: "passing",
      url: stalePr.url,
    });
    const baseRequest = {
      backend: "codex",
      branch: "hot-cpu-capture-presets",
      directoryPaths: ["/repo"],
    } satisfies Omit<RefreshThreadPullRequestsRequest, "threadId">;
    const threadOneRequest = {
      ...baseRequest,
      trigger: "user",
      threadId: "019eb2a0-734b-7503-b0b8-9d3fa56203ba",
    } satisfies RefreshThreadPullRequestsRequest;
    const threadTwoRequest = {
      ...baseRequest,
      threadId: "019eb2e4-840b-7fb1-979c-af66091712c0",
    } satisfies RefreshThreadPullRequestsRequest;
    const threadOneRequestKey = buildThreadPrRequestKey({
      backend: "codex",
      threadId: threadOneRequest.threadId,
      branch: baseRequest.branch,
      directoryPaths: baseRequest.directoryPaths,
    });
    const threadTwoRequestKey = buildThreadPrRequestKey({
      backend: "codex",
      threadId: threadTwoRequest.threadId,
      branch: baseRequest.branch,
      directoryPaths: baseRequest.directoryPaths,
    });
    getThreadOverlayState
      .mockResolvedValueOnce({
        backend: "codex",
        threadId: threadOneRequest.threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
        prs: [stalePr],
        prsFetchedAt: Date.now() - 120_000,
        prsRefreshKey: threadOneRequestKey,
      })
      .mockResolvedValueOnce({
        backend: "codex",
        threadId: threadTwoRequest.threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
        prs: [stalePr],
        prsFetchedAt: Date.now() - 120_000,
        prsRefreshKey: threadTwoRequestKey,
      });
    detectPullRequestsForThread.mockResolvedValueOnce([passingPr]);

    registerAppServerIpcHandlers();

    await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.(
      {},
      threadOneRequest,
    );
    await vi.waitFor(() => {
      expect(setThreadPullRequests).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: threadOneRequest.threadId,
          prs: [passingPr],
        }),
      );
    });

    const response = await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.(
      {},
      threadTwoRequest,
    );

    expect(response).toEqual({
      backend: "codex",
      threadId: threadTwoRequest.threadId,
      provider: "github.com",
      ghAvailable: true,
      prs: [passingPr],
    });
    expect(detectPullRequestsForThread).toHaveBeenCalledOnce();
  });

  it("hydrates canonical PR state from persisted cache without scheduled GitHub refresh", async () => {
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const stalePr = githubPr({
      number: 727,
      org: "OpenAI",
      repo: "codex",
      state: "pending",
      url: "https://github.com/OpenAI/codex/pull/727",
    });
    const cachedPr = githubPr({
      number: stalePr.number,
      org: stalePr.org,
      repo: stalePr.repo,
      state: "passing",
      url: stalePr.url,
    });
    const request = {
      backend: "codex",
      threadId: "thread-1",
      trigger: "scheduled",
      branch: "hot-cpu-capture-presets",
      directoryPaths: ["/repo"],
    } satisfies RefreshThreadPullRequestsRequest;
    const requestKey = buildThreadPrRequestKey({
      backend: "codex",
      threadId: "thread-1",
      branch: "hot-cpu-capture-presets",
      directoryPaths: ["/repo"],
    });
    const lookupKey = buildPrLookupKey({
      branch: "hot-cpu-capture-presets",
      directoryPaths: ["/repo"],
    });
    readPrStatusCache.mockResolvedValueOnce({
      "github.com/openai/codex#727": {
        provider: "github.com",
        prKey: "github.com/openai/codex#727",
        fetchedAt: Date.now() - 120_000,
        pr: cachedPr,
      },
    });
    readPrLookupCache.mockResolvedValueOnce({
      [lookupKey]: {
        lookupKey,
        provider: "github.com",
        branch: "hot-cpu-capture-presets",
        directoryPaths: ["/repo"],
        fetchedAt: Date.now(),
        prs: [cachedPr],
      },
    });
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prs: [stalePr],
      prsFetchedAt: Date.now() - 300_000,
      prsRefreshKey: requestKey,
    });

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.(
      {},
      request,
    );

    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      provider: "github.com",
      ghAvailable: true,
      prs: [cachedPr],
    });
    expect(detectPullRequestsForThread).not.toHaveBeenCalled();
  });

  it("skips user-triggered PR refresh when the persisted cache was fetched recently", async () => {
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const cachedPr = githubPr({
      number: 727,
      org: "OpenAI",
      repo: "codex",
      state: "passing",
      url: "https://github.com/OpenAI/codex/pull/727",
    });
    const request = {
      backend: "codex",
      threadId: "thread-1",
      trigger: "user",
      branch: "hot-cpu-capture-presets",
      directoryPaths: ["/repo"],
    } satisfies RefreshThreadPullRequestsRequest;
    const requestKey = buildThreadPrRequestKey({
      backend: "codex",
      threadId: "thread-1",
      branch: "hot-cpu-capture-presets",
      directoryPaths: ["/repo"],
    });
    const lookupKey = buildPrLookupKey({
      branch: "hot-cpu-capture-presets",
      directoryPaths: ["/repo"],
    });
    readPrStatusCache.mockResolvedValueOnce({
      "github.com/openai/codex#727": {
        provider: "github.com",
        prKey: "github.com/openai/codex#727",
        fetchedAt: Date.now(),
        pr: cachedPr,
      },
    });
    readPrLookupCache.mockResolvedValueOnce({
      [lookupKey]: {
        lookupKey,
        provider: "github.com",
        branch: "hot-cpu-capture-presets",
        directoryPaths: ["/repo"],
        fetchedAt: Date.now(),
        prs: [cachedPr],
      },
    });
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prs: [cachedPr],
      prsFetchedAt: Date.now(),
      prsRefreshKey: requestKey,
    });

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.(
      {},
      request,
    );

    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      provider: "github.com",
      ghAvailable: true,
      prs: [cachedPr],
    });
    expect(detectPullRequestsForThread).not.toHaveBeenCalled();
  });

  it("persists fresh lookup-cache hits to the requesting thread overlay", async () => {
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const cachedPr = githubPr({
      number: 727,
      org: "OpenAI",
      repo: "codex",
      state: "passing",
      url: "https://github.com/OpenAI/codex/pull/727",
    });
    const request = {
      backend: "codex",
      threadId: "thread-1",
      trigger: "scheduled",
      branch: "hot-cpu-capture-presets",
      directoryPaths: ["/repo"],
    } satisfies RefreshThreadPullRequestsRequest;
    const requestKey = buildThreadPrRequestKey({
      backend: "codex",
      threadId: "thread-1",
      branch: "hot-cpu-capture-presets",
      directoryPaths: ["/repo"],
    });
    const fetchedAt = Date.now();
    const lookupKey = buildPrLookupKey({
      branch: "hot-cpu-capture-presets",
      directoryPaths: ["/repo"],
    });
    readPrLookupCache.mockResolvedValueOnce({
      [lookupKey]: {
        lookupKey,
        provider: "github.com",
        branch: "hot-cpu-capture-presets",
        directoryPaths: ["/repo"],
        fetchedAt,
        prs: [cachedPr],
      },
    });
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prs: [],
      prsFetchedAt: Date.now() - 300_000,
      prsRefreshKey: JSON.stringify({
        lookupVersion: 3,
        backend: "codex",
        threadId: "thread-1",
        provider: "github.com",
        branch: "old-branch",
        directoryPaths: ["/repo"],
      }),
    });

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.(
      {},
      request,
    );

    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      provider: "github.com",
      ghAvailable: true,
      prs: [cachedPr],
    });
    expect(detectPullRequestsForThread).not.toHaveBeenCalled();
    expect(setThreadPullRequests).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      prs: [cachedPr],
      fetchedAt,
      refreshKey: requestKey,
    });
  });

  it("coalesces concurrent first-time PR lookups for the same branch and directories", async () => {
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const firstRequest = {
      backend: "codex",
      threadId: "thread-1",
      branch: "feat/pr-chip",
      directoryPaths: ["/repo"],
    } satisfies RefreshThreadPullRequestsRequest;
    const secondRequest = {
      ...firstRequest,
      threadId: "thread-2",
    } satisfies RefreshThreadPullRequestsRequest;
    const fetchedPrs: PrSummary[] = [
      githubPr({
        number: 249,
        org: "pwrdrvr",
        repo: "PwrAgent",
        state: "passing",
        url: "https://github.com/pwrdrvr/PwrAgent/pull/249",
      }),
    ];
    let resolveFetch: ((prs: PrSummary[]) => void) | undefined;
    detectPullRequestsForThread.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    registerAppServerIpcHandlers();

    const handler = handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)!;
    const first = handler({}, firstRequest);
    const second = handler({}, secondRequest);
    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        backend: "codex",
        threadId: "thread-1",
        provider: "github.com",
        ghAvailable: true,
        prs: [],
      },
      {
        backend: "codex",
        threadId: "thread-2",
        provider: "github.com",
        ghAvailable: true,
        prs: [],
      },
    ]);
    await vi.waitFor(() => {
      expect(detectPullRequestsForThread).toHaveBeenCalledOnce();
    });
    resolveFetch?.(fetchedPrs);

    await vi.waitFor(() => {
      expect(setThreadPullRequests).toHaveBeenCalledTimes(2);
    });
    expect(setThreadPullRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        prs: fetchedPrs,
      }),
    );
    expect(setThreadPullRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-2",
        prs: fetchedPrs,
      }),
    );
  });

  it("queues an authoritative refresh behind a pending scheduled lookup", async () => {
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const scheduledRequest = {
      backend: "codex",
      threadId: "thread-scheduled",
      trigger: "scheduled",
      branch: "feat/pr-chip",
      directoryPaths: ["/repo"],
    } satisfies RefreshThreadPullRequestsRequest;
    const userRequest = {
      ...scheduledRequest,
      threadId: "thread-user",
      trigger: "user",
    } satisfies RefreshThreadPullRequestsRequest;
    const primedPr = githubPr({
      number: 250,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "passing",
      mergeState: "mergeable",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/250",
    });
    const authoritativePr = {
      ...primedPr,
      mergeState: "conflicting" as const,
    };
    const resolveFetches: Array<(prs: PrSummary[]) => void> = [];
    detectPullRequestsForThread.mockImplementation(
      async () => await new Promise<PrSummary[]>((resolve) => {
        resolveFetches.push(resolve);
      }),
    );

    registerAppServerIpcHandlers();
    const handler = handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)!;
    await handler({}, scheduledRequest);
    await handler({}, userRequest);

    expect(detectPullRequestsForThread).toHaveBeenCalledOnce();
    resolveFetches[0]?.([primedPr]);

    await vi.waitFor(() => {
      expect(detectPullRequestsForThread).toHaveBeenCalledTimes(2);
    });
    expect(detectPullRequestsForThread).toHaveBeenLastCalledWith({
      fetcher: expect.any(Object),
      branch: "feat/pr-chip",
      directoryPaths: ["/repo"],
      allowPrimedBranchLookup: false,
    });
    expect(setThreadPullRequests).not.toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-user",
        prs: [primedPr],
      }),
    );

    resolveFetches[1]?.([authoritativePr]);
    await vi.waitFor(() => {
      expect(setThreadPullRequests).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-user",
          prs: [authoritativePr],
        }),
      );
    });
  });

  it("refreshes retained PRs from all subscribers on a coalesced lookup", async () => {
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const baseRequest = {
      backend: "codex",
      branch: "codex/reused-branch",
      directoryPaths: ["/repo"],
    } satisfies Omit<RefreshThreadPullRequestsRequest, "threadId">;
    const firstRequest = {
      ...baseRequest,
      threadId: "thread-1",
    } satisfies RefreshThreadPullRequestsRequest;
    const secondRequest = {
      ...baseRequest,
      threadId: "thread-2",
    } satisfies RefreshThreadPullRequestsRequest;
    const firstRequestKey = buildThreadPrRequestKey({
      backend: "codex",
      threadId: firstRequest.threadId,
      branch: baseRequest.branch,
      directoryPaths: baseRequest.directoryPaths,
    });
    const secondRequestKey = buildThreadPrRequestKey({
      backend: "codex",
      threadId: secondRequest.threadId,
      branch: baseRequest.branch,
      directoryPaths: baseRequest.directoryPaths,
    });
    const firstStalePr = githubPr({
      number: 255,
      org: "ExampleOrg",
      repo: "ExampleApp",
      state: "passing",
      url: "https://github.com/ExampleOrg/ExampleApp/pull/255",
    });
    const secondStalePr = githubPr({
      number: 256,
      org: "ExampleOrg",
      repo: "ExampleApp",
      state: "pending",
      url: "https://github.com/ExampleOrg/ExampleApp/pull/256",
    });
    const firstMergedPr = githubPr({
      ...firstStalePr,
      state: "passing",
      lifecycleState: "merged",
    });
    const secondMergedPr = githubPr({
      ...secondStalePr,
      state: "passing",
      lifecycleState: "merged",
    });
    const firstStaleFetchedAt = Date.now() - 120_001;
    const secondStaleFetchedAt = firstStaleFetchedAt + 1;
    let releasePrLookupCache: (() => void) | undefined;
    readPrLookupCache.mockImplementationOnce(
      () => new Promise((resolve) => {
        releasePrLookupCache = () => resolve({});
      }),
    );
    getThreadOverlayState
      .mockResolvedValueOnce({
        backend: "codex",
        threadId: firstRequest.threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
        prs: [firstStalePr],
        prsFetchedAt: firstStaleFetchedAt,
        prsRefreshKey: firstRequestKey,
      })
      .mockResolvedValueOnce({
        backend: "codex",
        threadId: secondRequest.threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
        prs: [secondStalePr],
        prsFetchedAt: secondStaleFetchedAt,
        prsRefreshKey: secondRequestKey,
      });
    let resolveFetch: ((prs: PrSummary[]) => void) | undefined;
    detectPullRequestsForThread.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    fetchPullRequestByUrl.mockImplementation(async ({ url }: { url: string }) => {
      if (url.endsWith("/255")) return firstMergedPr;
      if (url.endsWith("/256")) return secondMergedPr;
      return undefined;
    });

    registerAppServerIpcHandlers();

    const handler = handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)!;
    const first = handler({}, firstRequest);
    await vi.waitFor(() => {
      expect(readPrLookupCache).toHaveBeenCalledOnce();
    });
    const second = handler({}, secondRequest);
    await vi.waitFor(() => {
      expect(getThreadOverlayState).toHaveBeenCalledTimes(2);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(isGhAvailable).not.toHaveBeenCalled();
    releasePrLookupCache?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        backend: "codex",
        threadId: "thread-1",
        provider: "github.com",
        ghAvailable: true,
        prs: [firstStalePr],
      },
      {
        backend: "codex",
        threadId: "thread-2",
        provider: "github.com",
        ghAvailable: true,
        prs: [secondStalePr],
      },
    ]);
    await vi.waitFor(() => {
      expect(detectPullRequestsForThread).toHaveBeenCalledOnce();
    });
    resolveFetch?.([]);

    await vi.waitFor(() => {
      expect(fetchPullRequestByUrl).toHaveBeenCalledWith({
        cwd: "/repo",
        url: "https://github.com/ExampleOrg/ExampleApp/pull/255",
      });
      expect(fetchPullRequestByUrl).toHaveBeenCalledWith({
        cwd: "/repo",
        url: "https://github.com/ExampleOrg/ExampleApp/pull/256",
      });
    });
    await vi.waitFor(() => {
      expect(setThreadPullRequests).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        prs: [firstMergedPr],
        fetchedAt: expect.any(Number),
        refreshKey: firstRequestKey,
      });
      expect(setThreadPullRequests).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-2",
        prs: [secondMergedPr],
        fetchedAt: expect.any(Number),
        refreshKey: secondRequestKey,
      });
    });
  });

  it("returns recent cached empty PR lookups without hitting GitHub", async () => {
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const request = {
      backend: "codex",
      threadId: "thread-1",
      branch: "feat/no-pr-yet",
      directoryPaths: ["/repo"],
    } satisfies RefreshThreadPullRequestsRequest;
    const requestKey = buildThreadPrRequestKey({
      backend: "codex",
      threadId: "thread-1",
      branch: "feat/no-pr-yet",
      directoryPaths: ["/repo"],
    });
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prs: [],
      prsFetchedAt: Date.now(),
      prsRefreshKey: requestKey,
    });

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.(
      {},
      request,
    );

    expect(detectPullRequestsForThread).not.toHaveBeenCalled();
    expect(setThreadPullRequests).not.toHaveBeenCalled();
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      provider: "github.com",
      ghAvailable: true,
      prs: [],
    });
  });

  it("returns stale cached empty PR lookups immediately and refreshes them in the background", async () => {
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const request = {
      backend: "codex",
      threadId: "thread-1",
      branch: "feat/no-pr-yet",
      directoryPaths: ["/repo"],
    } satisfies RefreshThreadPullRequestsRequest;
    const requestKey = buildThreadPrRequestKey({
      backend: "codex",
      threadId: "thread-1",
      branch: "feat/no-pr-yet",
      directoryPaths: ["/repo"],
    });
    const fetchedPrs: PrSummary[] = [
      githubPr({
        number: 438,
        org: "pwrdrvr",
        repo: "PwrAgent",
        state: "pending",
        url: "https://github.com/pwrdrvr/PwrAgent/pull/438",
      }),
    ];
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prs: [],
      prsFetchedAt: Date.now() - 120_000,
      prsRefreshKey: requestKey,
    });
    detectPullRequestsForThread.mockResolvedValueOnce(fetchedPrs);

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.(
      {},
      request,
    );

    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      provider: "github.com",
      ghAvailable: true,
      prs: [],
    });
    await vi.waitFor(() => {
      expect(setThreadPullRequests).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-1",
          prs: fetchedPrs,
        }),
      );
    });
    expect(publishLocalEvent).toHaveBeenCalledWith({
      backend: "codex",
      notification: {
        method: "thread/pullRequests/updated",
        params: {
          threadId: "thread-1",
          prs: fetchedPrs,
        },
      },
    });
  });

  it("appends newly discovered PRs to the thread PR history", async () => {
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const request = {
      backend: "codex",
      threadId: "thread-1",
      trigger: "user",
      branch: "feat/reused-branch",
      directoryPaths: ["/repo"],
    } satisfies RefreshThreadPullRequestsRequest;
    const requestKey = buildThreadPrRequestKey({
      backend: "codex",
      threadId: "thread-1",
      branch: "feat/reused-branch",
      directoryPaths: ["/repo"],
    });
    const previousPr = githubPr({
      number: 720,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "merged",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/720",
    });
    const discoveredPr = githubPr({
      number: 737,
      org: "pwrdrvr",
      repo: "PwrAgent",
      title: "Retain thread pull request history",
      state: "passing",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/737",
    });
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prs: [previousPr],
      prsFetchedAt: Date.now() - 120_000,
      prsRefreshKey: requestKey,
    });
    detectPullRequestsForThread.mockResolvedValueOnce([discoveredPr]);

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.(
      {},
      request,
    );

    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      provider: "github.com",
      ghAvailable: true,
      prs: [previousPr],
    });
    await vi.waitFor(() => {
      expect(setThreadPullRequests).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        prs: [previousPr, discoveredPr],
        fetchedAt: expect.any(Number),
        refreshKey: requestKey,
      });
    });
    expect(publishLocalEvent).toHaveBeenCalledWith({
      backend: "codex",
      notification: {
        method: "thread/pullRequests/updated",
        params: {
          threadId: "thread-1",
          prs: [previousPr, discoveredPr],
        },
      },
    });
  });

  it("publishes the store-filtered PR list after background refreshes", async () => {
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const request = {
      backend: "codex",
      threadId: "thread-1",
      trigger: "user",
      branch: "feat/detached-pr",
      directoryPaths: ["/repo"],
    } satisfies RefreshThreadPullRequestsRequest;
    const requestKey = buildThreadPrRequestKey({
      backend: "codex",
      threadId: "thread-1",
      branch: "feat/detached-pr",
      directoryPaths: ["/repo"],
    });
    const previousPr = githubPr({
      number: 910,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "passing",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/910",
    });
    const detachedPr = githubPr({
      number: 911,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "passing",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/911",
    });
    const discoveredPr = githubPr({
      number: 912,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "passing",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/912",
    });
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      detachedPrKeys: ["github.com/pwrdrvr/pwragent#911"],
      prs: [previousPr],
      prsFetchedAt: Date.now() - 120_000,
      prsRefreshKey: requestKey,
    });
    detectPullRequestsForThread.mockResolvedValueOnce([detachedPr, discoveredPr]);
    setThreadPullRequests.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prs: [previousPr, discoveredPr],
      prsFetchedAt: Date.now(),
      prsRefreshKey: requestKey,
    });

    registerAppServerIpcHandlers();

    await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.({}, request);

    await vi.waitFor(() => {
      expect(setThreadPullRequests).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        prs: [previousPr, detachedPr, discoveredPr],
        fetchedAt: expect.any(Number),
        refreshKey: requestKey,
      });
    });
    expect(publishLocalEvent).toHaveBeenCalledWith({
      backend: "codex",
      notification: {
        method: "thread/pullRequests/updated",
        params: {
          threadId: "thread-1",
          prs: [previousPr, discoveredPr],
        },
      },
    });
  });

  it("returns and publishes the store-filtered PR list for lookup-cache hits", async () => {
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const request = {
      backend: "codex",
      threadId: "thread-1",
      trigger: "user",
      branch: "feat/cached-detached-pr",
      directoryPaths: ["/repo"],
    } satisfies RefreshThreadPullRequestsRequest;
    const requestKey = buildThreadPrRequestKey({
      backend: "codex",
      threadId: "thread-1",
      branch: "feat/cached-detached-pr",
      directoryPaths: ["/repo"],
    });
    const lookupKey = buildPrLookupKey({
      branch: "feat/cached-detached-pr",
      directoryPaths: ["/repo"],
    });
    const previousPr = githubPr({
      number: 920,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "passing",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/920",
    });
    const detachedPr = githubPr({
      number: 921,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "passing",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/921",
    });
    const cachedPr = githubPr({
      number: 922,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "passing",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/922",
    });
    const fetchedAt = Date.now();
    readPrLookupCache.mockResolvedValueOnce({
      [lookupKey]: {
        lookupKey,
        provider: "github.com",
        branch: "feat/cached-detached-pr",
        directoryPaths: ["/repo"],
        fetchedAt,
        prs: [detachedPr, cachedPr],
      },
    });
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      detachedPrKeys: ["github.com/pwrdrvr/pwragent#921"],
      prs: [previousPr],
      prsFetchedAt: fetchedAt - 120_000,
      prsRefreshKey: "old-refresh-key",
    });
    setThreadPullRequests.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prs: [previousPr, cachedPr],
      prsFetchedAt: fetchedAt,
      prsRefreshKey: requestKey,
    });

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.(
      {},
      request,
    );

    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      provider: "github.com",
      ghAvailable: true,
      prs: [previousPr, cachedPr],
    });
    expect(publishLocalEvent).toHaveBeenCalledWith({
      backend: "codex",
      notification: {
        method: "thread/pullRequests/updated",
        params: {
          threadId: "thread-1",
          prs: [previousPr, cachedPr],
        },
      },
    });
  });

  it("keeps detached PRs hidden when gh is unavailable and lookup cache still has them", async () => {
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const request = {
      backend: "codex",
      threadId: "thread-1",
      trigger: "user",
      branch: "feat/cached-detached-pr",
      directoryPaths: ["/repo"],
    } satisfies RefreshThreadPullRequestsRequest;
    const lookupKey = buildPrLookupKey({
      branch: "feat/cached-detached-pr",
      directoryPaths: ["/repo"],
    });
    const previousPr = githubPr({
      number: 920,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "passing",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/920",
    });
    const detachedPr = githubPr({
      number: 921,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "passing",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/921",
    });
    const cachedPr = githubPr({
      number: 922,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "passing",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/922",
    });
    readPrLookupCache.mockResolvedValueOnce({
      [lookupKey]: {
        lookupKey,
        provider: "github.com",
        branch: "feat/cached-detached-pr",
        directoryPaths: ["/repo"],
        fetchedAt: Date.now(),
        prs: [detachedPr, cachedPr],
      },
    });
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      detachedPrKeys: ["github.com/pwrdrvr/pwragent#921"],
      prs: [previousPr],
      prsFetchedAt: Date.now() - 120_000,
      prsRefreshKey: "old-refresh-key",
    });
    isGhAvailable.mockResolvedValueOnce(false);

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.(
      {},
      request,
    );

    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      provider: "github.com",
      ghAvailable: false,
      prs: [previousPr, cachedPr],
    });
    expect(setThreadPullRequests).not.toHaveBeenCalled();
    expect(publishLocalEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        notification: expect.objectContaining({
          method: "thread/pullRequests/updated",
        }),
      }),
    );
  });

  it("persists and publishes title-only PR updates", async () => {
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const request = {
      backend: "codex",
      threadId: "thread-1",
      trigger: "user",
      branch: "feat/title-update",
      directoryPaths: ["/repo"],
    } satisfies RefreshThreadPullRequestsRequest;
    const requestKey = buildThreadPrRequestKey({
      backend: "codex",
      threadId: "thread-1",
      branch: "feat/title-update",
      directoryPaths: ["/repo"],
    });
    const previousPr = githubPr({
      number: 737,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "passing",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/737",
    });
    const titledPr = {
      ...previousPr,
      title: "Retain thread pull request history",
    };
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prs: [previousPr],
      prsFetchedAt: Date.now() - 120_000,
      prsRefreshKey: requestKey,
    });
    detectPullRequestsForThread.mockResolvedValueOnce([titledPr]);

    registerAppServerIpcHandlers();

    await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.({}, request);

    await vi.waitFor(() => {
      expect(setThreadPullRequests).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        prs: [titledPr],
        fetchedAt: expect.any(Number),
        refreshKey: requestKey,
      });
    });
    expect(publishLocalEvent).toHaveBeenCalledWith({
      backend: "codex",
      notification: {
        method: "thread/pullRequests/updated",
        params: {
          threadId: "thread-1",
          prs: [titledPr],
        },
      },
    });
  });

  it("rechecks PRs when cached PRs belong to a different lookup key", async () => {
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const request = {
      backend: "codex",
      threadId: "thread-1",
      branch: "fix/new-branch",
      directoryPaths: ["/repo"],
    } satisfies RefreshThreadPullRequestsRequest;
    const requestKey = buildThreadPrRequestKey({
      backend: "codex",
      threadId: "thread-1",
      branch: "fix/new-branch",
      directoryPaths: ["/repo"],
    });
    const terminalPrs: PrSummary[] = [
      githubPr({
        number: 433,
        org: "pwrdrvr",
        repo: "PwrAgent",
        state: "merged",
        url: "https://github.com/pwrdrvr/PwrAgent/pull/433",
      }),
    ];
    const newBranchPrs: PrSummary[] = [
      githubPr({
        number: 438,
        org: "pwrdrvr",
        repo: "PwrAgent",
        state: "pending",
        url: "https://github.com/pwrdrvr/PwrAgent/pull/438",
      }),
    ];
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prs: terminalPrs,
      prsFetchedAt: Date.now() - 120_000,
      prsRefreshKey: buildThreadPrRequestKey({
        backend: "codex",
        threadId: "thread-1",
        branch: "fix/old-branch",
        directoryPaths: ["/repo"],
      }),
    });
    detectPullRequestsForThread.mockResolvedValueOnce(newBranchPrs);

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.(
      {},
      request,
    );

    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      provider: "github.com",
      ghAvailable: true,
      prs: terminalPrs,
    });
    await vi.waitFor(() => {
      expect(detectPullRequestsForThread).toHaveBeenCalledWith({
        fetcher: expect.any(Object),
        branch: "fix/new-branch",
        directoryPaths: ["/repo"],
      });
    });
    await vi.waitFor(() => {
      expect(setThreadPullRequests).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        prs: [...terminalPrs, ...newBranchPrs],
        fetchedAt: expect.any(Number),
        refreshKey: requestKey,
      });
    });
  });

  it("refreshes retained non-terminal PRs by URL when the current branch lookup is empty", async () => {
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const request = {
      backend: "codex",
      threadId: "thread-1",
      branch: "codex/fix-reel-upload-button-swift",
      directoryPaths: ["/repo"],
    } satisfies RefreshThreadPullRequestsRequest;
    const requestKey = buildThreadPrRequestKey({
      backend: "codex",
      threadId: "thread-1",
      branch: "codex/fix-reel-upload-button-swift",
      directoryPaths: ["/repo"],
    });
    const lookupKey = buildPrLookupKey({
      branch: "codex/fix-reel-upload-button-swift",
      directoryPaths: ["/repo"],
    });
    const stalePr = githubPr({
      number: 255,
      org: "ExampleOrg",
      repo: "ExampleApp",
      title: "[codex] Fix upload button after reel switching",
      state: "passing",
      url: "https://github.com/ExampleOrg/ExampleApp/pull/255",
    });
    const mergedPr = githubPr({
      ...stalePr,
      state: "passing",
      lifecycleState: "merged",
      reviewState: "ready_for_review",
      mergeState: "unknown",
    });
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prs: [stalePr],
      prsFetchedAt: Date.now() - 120_000,
      prsRefreshKey: requestKey,
    });
    detectPullRequestsForThread.mockResolvedValueOnce([]);
    fetchPullRequestByUrl.mockResolvedValueOnce(mergedPr);

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.(
      {},
      request,
    );

    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      provider: "github.com",
      ghAvailable: true,
      prs: [stalePr],
    });
    await vi.waitFor(() => {
      expect(detectPullRequestsForThread).toHaveBeenCalledWith({
        fetcher: expect.any(Object),
        branch: "codex/fix-reel-upload-button-swift",
        directoryPaths: ["/repo"],
      });
    });
    await vi.waitFor(() => {
      expect(fetchPullRequestByUrl).toHaveBeenCalledWith({
        cwd: "/repo",
        url: "https://github.com/ExampleOrg/ExampleApp/pull/255",
      });
    });
    await vi.waitFor(() => {
      expect(setThreadPullRequests).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        prs: [mergedPr],
        fetchedAt: expect.any(Number),
        refreshKey: requestKey,
      });
    });
    expect(writePrStatusCacheEntries).toHaveBeenCalledWith([
      {
        provider: "github.com",
        prKey: "github.com/exampleorg/exampleapp#255",
        fetchedAt: expect.any(Number),
        pr: mergedPr,
      },
    ]);
    expect(publishLocalEvent).toHaveBeenCalledWith({
      backend: "codex",
      notification: {
        method: "pullRequest/status/updated",
        params: {
          prKey: "github.com/exampleorg/exampleapp#255",
          pr: mergedPr,
        },
      },
    });
    expect(writePrLookupCacheEntry).toHaveBeenCalledWith({
      lookupKey,
      provider: "github.com",
      branch: "codex/fix-reel-upload-button-swift",
      directoryPaths: ["/repo"],
      fetchedAt: expect.any(Number),
      prs: [],
    });
    expect(publishLocalEvent).toHaveBeenCalledWith({
      backend: "codex",
      notification: {
        method: "thread/pullRequests/updated",
        params: {
          threadId: "thread-1",
          prs: [mergedPr],
        },
      },
    });
  });

  it("refreshes retained detached PRs by URL when the current branch lookup is empty", async () => {
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const request = {
      backend: "codex",
      threadId: "thread-1",
      branch: "codex/fix-reel-upload-button-swift",
      directoryPaths: ["/repo"],
    } satisfies RefreshThreadPullRequestsRequest;
    const requestKey = buildThreadPrRequestKey({
      backend: "codex",
      threadId: "thread-1",
      branch: "codex/fix-reel-upload-button-swift",
      directoryPaths: ["/repo"],
    });
    const detachedPr = githubPr({
      number: 255,
      org: "ExampleOrg",
      repo: "ExampleApp",
      title: "[codex] Fix upload button after reel switching",
      state: "passing",
      url: "https://github.com/ExampleOrg/ExampleApp/pull/255",
    });
    const mergedDetachedPr = githubPr({
      ...detachedPr,
      state: "passing",
      lifecycleState: "merged",
      commitShas: ["c".repeat(40)],
    });
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      detachedPrKeys: ["github.com/exampleorg/exampleapp#255"],
      detachedPrs: [detachedPr],
      prs: [],
      prsFetchedAt: Date.now() - 120_000,
      prsRefreshKey: requestKey,
    });
    detectPullRequestsForThread.mockResolvedValueOnce([]);
    fetchPullRequestByUrl.mockResolvedValueOnce(mergedDetachedPr);

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.(
      {},
      request,
    );

    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      provider: "github.com",
      ghAvailable: true,
      prs: [],
    });
    await vi.waitFor(() => {
      expect(fetchPullRequestByUrl).toHaveBeenCalledWith({
        cwd: "/repo",
        url: "https://github.com/ExampleOrg/ExampleApp/pull/255",
      });
    });
    await vi.waitFor(() => {
      expect(setThreadPullRequests).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        prs: [mergedDetachedPr],
        fetchedAt: expect.any(Number),
        refreshKey: requestKey,
      });
    });
  });

  it("does not publish PR update events when retained PR status is unchanged", async () => {
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const request = {
      backend: "codex",
      threadId: "thread-1",
      branch: "codex/fix-reel-upload-button-swift",
      directoryPaths: ["/repo"],
    } satisfies RefreshThreadPullRequestsRequest;
    const requestKey = buildThreadPrRequestKey({
      backend: "codex",
      threadId: "thread-1",
      branch: "codex/fix-reel-upload-button-swift",
      directoryPaths: ["/repo"],
    });
    const unchangedPr = githubPr({
      number: 255,
      org: "ExampleOrg",
      repo: "ExampleApp",
      title: "[codex] Fix upload button after reel switching",
      state: "passing",
      url: "https://github.com/ExampleOrg/ExampleApp/pull/255",
    });
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prs: [unchangedPr],
      prsFetchedAt: Date.now() - 120_000,
      prsRefreshKey: requestKey,
    });
    detectPullRequestsForThread.mockResolvedValueOnce([]);
    fetchPullRequestByUrl.mockResolvedValueOnce(unchangedPr);

    registerAppServerIpcHandlers();

    await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.({}, request);

    await vi.waitFor(() => {
      expect(fetchPullRequestByUrl).toHaveBeenCalledWith({
        cwd: "/repo",
        url: "https://github.com/ExampleOrg/ExampleApp/pull/255",
      });
    });
    expect(writePrStatusCacheEntries).toHaveBeenCalledWith([
      {
        provider: "github.com",
        prKey: "github.com/exampleorg/exampleapp#255",
        fetchedAt: expect.any(Number),
        pr: unchangedPr,
      },
    ]);
    expect(publishLocalEvent).not.toHaveBeenCalledWith({
      backend: "codex",
      notification: {
        method: "pullRequest/status/updated",
        params: {
          prKey: "github.com/exampleorg/exampleapp#255",
          pr: unchangedPr,
        },
      },
    });
    expect(publishLocalEvent).not.toHaveBeenCalledWith({
      backend: "codex",
      notification: {
        method: "thread/pullRequests/updated",
        params: {
          threadId: "thread-1",
          prs: [unchangedPr],
        },
      },
    });
  });

  it("short-circuits PR refresh when all cached PRs are terminal for the same lookup", async () => {
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const request = {
      backend: "codex",
      threadId: "thread-1",
      branch: "fix/done",
      directoryPaths: ["/repo"],
    } satisfies RefreshThreadPullRequestsRequest;
    const requestKey = buildThreadPrRequestKey({
      backend: "codex",
      threadId: "thread-1",
      branch: "fix/done",
      directoryPaths: ["/repo"],
    });
    const terminalPrs: PrSummary[] = [
      githubPr({
        number: 433,
        org: "pwrdrvr",
        repo: "PwrAgent",
        state: "merged",
        url: "https://github.com/pwrdrvr/PwrAgent/pull/433",
      }),
      githubPr({
        number: 430,
        org: "pwrdrvr",
        repo: "PwrAgent",
        state: "closed",
        url: "https://github.com/pwrdrvr/PwrAgent/pull/430",
      }),
    ];
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prs: terminalPrs,
      prsFetchedAt: Date.now() - 120_000,
      prsRefreshKey: requestKey,
    });

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.(
      {},
      request,
    );

    expect(detectPullRequestsForThread).not.toHaveBeenCalled();
    expect(setThreadPullRequests).not.toHaveBeenCalled();
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      provider: "github.com",
      ghAvailable: true,
      prs: terminalPrs,
      shortCircuited: true,
    });
  });

  it("rate-limits user-triggered terminal PR lookups to once per minute", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
      const request = {
        backend: "codex",
        threadId: "thread-1",
        trigger: "user",
        branch: "fix/done",
        directoryPaths: ["/repo"],
      } satisfies RefreshThreadPullRequestsRequest;
      const requestKey = buildThreadPrRequestKey({
        backend: "codex",
        threadId: "thread-1",
        branch: "fix/done",
        directoryPaths: ["/repo"],
      });
      const terminalPrs: PrSummary[] = [
        githubPr({
          number: 433,
          org: "pwrdrvr",
          repo: "PwrAgent",
          state: "merged",
          url: "https://github.com/pwrdrvr/PwrAgent/pull/433",
        }),
      ];

      getThreadOverlayState.mockResolvedValue({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "default",
        extraLinkedDirectories: [],
        prs: terminalPrs,
        prsFetchedAt: 1_000_000 - 120_000,
        prsRefreshKey: requestKey,
      });
      detectPullRequestsForThread.mockResolvedValue(terminalPrs);

      registerAppServerIpcHandlers();

      await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.({}, request);
      await vi.waitFor(() => {
        expect(detectPullRequestsForThread).toHaveBeenCalledTimes(1);
      });

      vi.setSystemTime(1_000_000 + 30_000);
      await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.({}, request);
      await Promise.resolve();
      expect(detectPullRequestsForThread).toHaveBeenCalledTimes(1);

      vi.setSystemTime(1_000_000 + 60_000);
      await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.({}, request);
      await vi.waitFor(() => {
        expect(detectPullRequestsForThread).toHaveBeenCalledTimes(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the shorter user cooldown for non-terminal PR lookups", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2_000_000);
      const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
      const request = {
        backend: "codex",
        threadId: "thread-1",
        trigger: "user",
        branch: "fix/open",
        directoryPaths: ["/repo"],
        includeStatusFreshness: true,
      } satisfies RefreshThreadPullRequestsRequest;
      const requestKey = buildThreadPrRequestKey({
        backend: "codex",
        threadId: "thread-1",
        branch: "fix/open",
        directoryPaths: ["/repo"],
      });
      const pendingPrs: PrSummary[] = [
        githubPr({
          number: 434,
          org: "pwrdrvr",
          repo: "PwrAgent",
          state: "pending",
          url: "https://github.com/pwrdrvr/PwrAgent/pull/434",
        }),
      ];

      getThreadOverlayState.mockResolvedValue({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "default",
        extraLinkedDirectories: [],
        prs: pendingPrs,
        prsFetchedAt: 2_000_000 - 120_000,
        prsRefreshKey: requestKey,
      });
      detectPullRequestsForThread.mockResolvedValue(pendingPrs);

      registerAppServerIpcHandlers();

      const firstResponse = await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.(
        {},
        request,
      );
      expect(firstResponse).toMatchObject({
        backend: "codex",
        threadId: "thread-1",
        refreshStarted: true,
        lastStatusCheckAt: 2_000_000 - 120_000,
        lastStatusCheckAgeMs: 120_000,
      });
      await vi.waitFor(() => {
        expect(detectPullRequestsForThread).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(() => {
        expect(mockAppServerLog.debug).toHaveBeenCalledWith(
          "threadPullRequestsRefresh:background-complete",
          expect.objectContaining({
            fetchedPrIds: ["github.com/pwrdrvr/pwragent#434"],
            threadId: "thread-1",
            trigger: "user",
          }),
        );
      });
      mockAppServerLog.debug.mockClear();

      vi.setSystemTime(2_000_000 + 9_000);
      const cooldownResponse = await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.(
        {},
        request,
      );
      expect(cooldownResponse).toMatchObject({
        backend: "codex",
        threadId: "thread-1",
        refreshStarted: false,
        lastStatusCheckAt: 2_000_000,
        lastStatusCheckAgeMs: 9_000,
      });
      await Promise.resolve();
      expect(detectPullRequestsForThread).toHaveBeenCalledTimes(1);
      expect(mockAppServerLog.debug).toHaveBeenCalledWith(
        "threadPullRequestsRefresh:skipped",
        expect.objectContaining({
          minIntervalMs: 10_000,
          nextAllowedInMs: 1_000,
          previousPrIds: ["github.com/pwrdrvr/pwragent#434"],
          reason: "cooldown",
          threadId: "thread-1",
          trigger: "user",
        }),
      );

      vi.setSystemTime(2_000_000 + 10_000);
      await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.({}, request);
      await vi.waitFor(() => {
        expect(detectPullRequestsForThread).toHaveBeenCalledTimes(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves unchanged snapshots when directory statuses are unchanged", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");

    reconcileNavigationSnapshot
      .mockResolvedValueOnce({
        backend: "all",
        fetchedAt: 1234,
        unchanged: false,
        threads: [
          {
            id: "thread-1",
            title: "Thread one",
            titleSource: "explicit" as const,
            source: "codex" as const,
            linkedDirectories: [],
            updatedAt: 2000,
          },
        ],
        inboxThreadKeys: ["codex:thread-1"],
        directories: [
          {
            key: "directory:/repo/app",
            kind: "directory" as const,
            label: "app",
            path: "/repo/app",
            threadKeys: ["codex:thread-1"],
            needsAttentionCount: 1,
            latestUpdatedAt: 2000,
          },
        ],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      })
      .mockResolvedValueOnce({
        backend: "all",
        fetchedAt: 5678,
        unchanged: true,
        threads: [
          {
            id: "thread-1",
            title: "Thread one",
            titleSource: "explicit" as const,
            source: "codex" as const,
            linkedDirectories: [],
            updatedAt: 2000,
          },
        ],
        inboxThreadKeys: ["codex:thread-1"],
        directories: [
          {
            key: "directory:/repo/app",
            kind: "directory" as const,
            label: "app",
            path: "/repo/app",
            threadKeys: ["codex:thread-1"],
            needsAttentionCount: 1,
            latestUpdatedAt: 2000,
          },
        ],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      })
      .mockResolvedValueOnce({
        backend: "all",
        fetchedAt: 9012,
        unchanged: true,
        threads: [
          {
            id: "thread-1",
            title: "Thread one",
            titleSource: "explicit" as const,
            source: "codex" as const,
            linkedDirectories: [],
            updatedAt: 2000,
          },
        ],
        inboxThreadKeys: ["codex:thread-1"],
        directories: [
          {
            key: "directory:/repo/app",
            kind: "directory" as const,
            label: "app",
            path: "/repo/app",
            threadKeys: ["codex:thread-1"],
            needsAttentionCount: 1,
            latestUpdatedAt: 2000,
          },
        ],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      });

    registerAppServerIpcHandlers();

    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    await vi.waitFor(() => {
      expect(publishLocalEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          notification: expect.objectContaining({
            method: "navigation/directoryGitStatus/updated",
          }),
        }),
      );
    });
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    const response = await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});

    expect(readDirectoryStatuses).not.toHaveBeenCalled();
    expect(response).toEqual({
      backend: "all",
      fetchedAt: 9012,
      unchanged: true,
      threads: [
        expect.objectContaining({ source: "codex", id: "thread-1" }),
      ],
      inboxThreadKeys: ["codex:thread-1"],
      directories: [
        {
          key: "directory:/repo/app",
          kind: "directory",
          label: "app",
          path: "/repo/app",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 1,
          latestUpdatedAt: 2000,
          gitStatus: directoryGitStatus,
        },
      ],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    });
  });

  it("marks snapshots changed when canonical PR statuses update thread PRs", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const stalePr = githubPr({
      number: 727,
      org: "OpenAI",
      repo: "codex",
      state: "pending",
      url: "https://github.com/OpenAI/codex/pull/727",
    });
    const cachedPr = githubPr({
      number: stalePr.number,
      org: stalePr.org,
      repo: stalePr.repo,
      state: "passing",
      url: stalePr.url,
    });
    readPrStatusCache.mockResolvedValueOnce({
      "github.com/openai/codex#727": {
        provider: "github.com",
        prKey: "github.com/openai/codex#727",
        fetchedAt: Date.now(),
        pr: cachedPr,
      },
    });
    reconcileNavigationSnapshot
      .mockResolvedValueOnce({
        backend: "all",
        fetchedAt: 1234,
        unchanged: false,
        threads: [
          {
            id: "thread-1",
            title: "Thread one",
            titleSource: "explicit" as const,
            source: "codex" as const,
            linkedDirectories: [],
            updatedAt: 2000,
            prs: [stalePr],
          },
        ],
        inboxThreadKeys: ["codex:thread-1"],
        directories: [],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      })
      .mockResolvedValueOnce({
        backend: "all",
        fetchedAt: 5678,
        unchanged: true,
        threads: [
          {
            id: "thread-1",
            title: "Thread one",
            titleSource: "explicit" as const,
            source: "codex" as const,
            linkedDirectories: [],
            updatedAt: 2000,
            prs: [stalePr],
          },
        ],
        inboxThreadKeys: ["codex:thread-1"],
        directories: [],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      });

    registerAppServerIpcHandlers();

    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    const response = await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});

    expect(response).toMatchObject({
      unchanged: false,
      threads: [
        {
          id: "thread-1",
          prs: [cachedPr],
        },
      ],
    });
  });

  it("marks snapshots changed when hydrated launchpad environment options change", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");

    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-nav-env-"));
    const environmentsDir = path.join(root, ".codex", "environments");
    await mkdir(environmentsDir, { recursive: true });
    await writeFile(
      path.join(environmentsDir, "environment.toml"),
      'name = "Existing environment"\n',
      "utf8",
    );

    const launchpad = {
      directoryKey: "directory:/repo/app",
      directoryKind: "directory" as const,
      directoryLabel: "app",
      directoryPath: root,
      backend: "codex" as const,
      executionMode: "default" as const,
      prompt: "",
      workMode: "local" as const,
      createdAt: 1000,
      updatedAt: 1000,
    };

    reconcileNavigationSnapshot
      .mockResolvedValueOnce({
        backend: "all",
        fetchedAt: 1234,
        unchanged: false,
        threads: [],
        inboxThreadKeys: [],
        directories: [
          {
            key: "directory:/repo/app",
            kind: "directory" as const,
            label: "app",
            path: "/repo/app",
            threadKeys: [],
            needsAttentionCount: 0,
            latestUpdatedAt: 2000,
            launchpad,
          },
        ],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      } as unknown as Awaited<ReturnType<typeof reconcileNavigationSnapshot>>)
      .mockResolvedValueOnce({
        backend: "all",
        fetchedAt: 5678,
        unchanged: true,
        threads: [],
        inboxThreadKeys: [],
        directories: [
          {
            key: "directory:/repo/app",
            kind: "directory" as const,
            label: "app",
            path: "/repo/app",
            threadKeys: [],
            needsAttentionCount: 0,
            latestUpdatedAt: 2000,
            launchpad,
          },
        ],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      } as unknown as Awaited<ReturnType<typeof reconcileNavigationSnapshot>>);

    try {
      registerAppServerIpcHandlers();

      await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
      await writeFile(
        path.join(environmentsDir, "new-environment.toml"),
        'name = "New environment"\n',
        "utf8",
      );
      const response = await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});

      expect(response).toMatchObject({
        unchanged: false,
        directories: [
          {
            launchpad: {
              codexEnvironmentOptions: [
                { id: "environment" },
                { id: "new-environment" },
              ],
            },
          },
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses cached directory git status without refreshing unchanged directories", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");

    readDirectoryGitStatusCache.mockResolvedValueOnce({
      "directory:/repo/app": {
        directoryKey: "directory:/repo/app",
        directoryPath: "/repo/app",
        directoryUpdatedAt: 2000,
        fetchedAt: Date.now(),
        gitStatus: directoryGitStatus,
      },
    });

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});

    expect(readDirectoryStatusEntries).not.toHaveBeenCalled();
    expect(response).toEqual(
      expect.objectContaining({
        directories: [
          expect.objectContaining({
            key: "directory:/repo/app",
            gitStatus: directoryGitStatus,
          }),
        ],
      }),
    );
  });

  it("refreshes stale cached directory git status in the background", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");

    readDirectoryGitStatusCache.mockResolvedValueOnce({
      "directory:/repo/app": {
        directoryKey: "directory:/repo/app",
        directoryPath: "/repo/app",
        directoryUpdatedAt: 2000,
        fetchedAt: Date.now() - 60 * 60 * 1000,
        gitStatus: directoryGitStatus,
      },
    });

    registerAppServerIpcHandlers();

    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});

    await vi.waitFor(() => {
      expect(readDirectoryStatusEntries).toHaveBeenCalled();
    });
    expect(readDirectoryStatusEntries.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ key: "directory:/repo/app" }),
    ]);
  });

  it("refreshes cached directory git status when explicitly requested", async () => {
    const {
      NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL,
      NAVIGATION_SNAPSHOT_CHANNEL,
    } = await import("../../shared/ipc");

    readDirectoryGitStatusCache.mockResolvedValueOnce({
      "directory:/repo/app": {
        directoryKey: "directory:/repo/app",
        directoryPath: "/repo/app",
        directoryUpdatedAt: 2000,
        // Fresh for the 5-minute automatic-refresh window, but older than
        // the short force-coalesce window so the explicit refresh below
        // still overrides freshness and schedules a probe.
        fetchedAt: Date.now() - 10_000,
        gitStatus: directoryGitStatus,
      },
    });

    registerAppServerIpcHandlers();

    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    expect(readDirectoryStatusEntries).not.toHaveBeenCalled();

    await expect(
      handlers.get(NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL)?.(
        {},
        {
          directoryKeys: ["directory:/repo/app"],
        },
      ),
    ).resolves.toEqual({ scheduledCount: 1 });

    await vi.waitFor(() => {
      expect(readDirectoryStatusEntries).toHaveBeenCalled();
    });
    expect(invalidateDirectoryStatus).toHaveBeenCalledExactlyOnceWith(
      "/repo/app",
    );
    expect(readDirectoryStatusEntries.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ key: "directory:/repo/app" }),
    ]);
  });

  it("routes remote directory git status refreshes to the owning federation peer", async () => {
    const { NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL } = await import("../../shared/ipc");
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };

    registerAppServerIpcHandlers();

    await expect(
      handlers.get(NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL)?.(
        {},
        {
          directoryKeys: ["directory:/remote/repo"],
          federationTarget,
          force: true,
        },
      ),
    ).resolves.toEqual({ scheduledCount: 1 });

    expect(federationMock.runtime.remoteBackend).toHaveBeenCalledWith(
      federationTarget,
    );
    expect(
      federationMock.remoteBackend.refreshDirectoryGitStatuses,
    ).toHaveBeenCalledExactlyOnceWith({
      directoryKeys: ["directory:/remote/repo"],
      force: true,
    });
    expect(readDirectoryStatusEntries).not.toHaveBeenCalled();
    expect(invalidateDirectoryStatus).not.toHaveBeenCalled();
  });

  it("routes remote unpublished commit reads to the owning federation peer", async () => {
    const {
      NAVIGATION_GET_WORKTREE_UNPUBLISHED_COMMIT_DIFF_CHANNEL,
      NAVIGATION_LIST_WORKTREE_UNPUBLISHED_COMMITS_CHANNEL,
    } = await import("../../shared/ipc");
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    const baseRequest = {
      backend: "codex" as const,
      threadId: "thread-1",
      worktreePath: "/remote/repo",
      federationTarget,
    };

    registerAppServerIpcHandlers();

    await handlers.get(NAVIGATION_LIST_WORKTREE_UNPUBLISHED_COMMITS_CHANNEL)?.(
      {},
      { ...baseRequest, maxCommits: 20, maxFilesPerCommit: 50 },
    );
    await handlers.get(NAVIGATION_GET_WORKTREE_UNPUBLISHED_COMMIT_DIFF_CHANNEL)?.(
      {},
      {
        ...baseRequest,
        commitSha: "a".repeat(40),
        path: "/remote/repo/file.ts",
        maxBytes: 200_000,
      },
    );

    expect(federationMock.runtime.remoteBackend).toHaveBeenCalledWith(
      federationTarget,
    );
    expect(
      federationMock.remoteBackend.listWorktreeUnpublishedCommits,
    ).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      worktreePath: "/remote/repo",
      maxCommits: 20,
      maxFilesPerCommit: 50,
    });
    expect(
      federationMock.remoteBackend.getWorktreeUnpublishedCommitDiff,
    ).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      worktreePath: "/remote/repo",
      commitSha: "a".repeat(40),
      path: "/remote/repo/file.ts",
      maxBytes: 200_000,
    });
  });

  it("coalesces rapid forced directory git status re-enqueues for the same key", async () => {
    const {
      NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL,
      NAVIGATION_SNAPSHOT_CHANNEL,
    } = await import("../../shared/ipc");

    // Stale seed so the snapshot's automatic refresh probes once and writes a
    // now-fresh cache entry (populates `lastDirectoriesByKey` too).
    readDirectoryGitStatusCache.mockResolvedValueOnce({
      "directory:/repo/app": {
        directoryKey: "directory:/repo/app",
        directoryPath: "/repo/app",
        directoryUpdatedAt: 2000,
        fetchedAt: Date.now() - 60 * 60 * 1000,
        gitStatus: directoryGitStatus,
      },
    });

    registerAppServerIpcHandlers();

    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    await vi.waitFor(() => {
      expect(readDirectoryStatusEntries).toHaveBeenCalled();
    });
    const callsAfterSnapshot = readDirectoryStatusEntries.mock.calls.length;

    // The probe just completed, so back-to-back forced re-enqueues land
    // inside the coalesce window and are skipped — the "747, 747, 747"
    // tail collapses to nothing.
    const first = await handlers.get(
      NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL,
    )?.({}, { directoryKeys: ["directory:/repo/app"] });
    const second = await handlers.get(
      NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL,
    )?.({}, { directoryKeys: ["directory:/repo/app"] });

    expect(first).toEqual({ scheduledCount: 0 });
    expect(second).toEqual({ scheduledCount: 0 });
    // No probe beyond the snapshot's ran.
    expect(readDirectoryStatusEntries.mock.calls.length).toBe(callsAfterSnapshot);
  });

  it("publishes a working-state chip update when a snapshot probe lands", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");

    listThreads.mockResolvedValueOnce([
      {
        id: "thread-1",
        title: "Thread one",
        titleSource: "explicit",
        source: "codex",
        projectKey: "/repo/wt",
        linkedDirectories: [],
        updatedAt: 2000,
      },
    ] as never);
    const gitWorkingState = {
      dirtyFiles: 3,
      dirtyAdditions: 10,
      dirtyDeletions: 2,
      untrackedFiles: 1,
      unpushedCommits: 4,
    };
    readWorktreeWorkingStateEntries.mockImplementationOnce(() =>
      (async function* () {
        yield { worktreePath: "/repo/wt", gitWorkingState };
      })(),
    );

    registerAppServerIpcHandlers();
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});

    await vi.waitFor(() => {
      expect(writeThreadGitWorkingStateCacheEntry).toHaveBeenCalledWith(
        expect.objectContaining({ worktreePath: "/repo/wt", gitWorkingState }),
      );
    });
    expect(publishLocalEvent).toHaveBeenCalledWith({
      backend: "codex",
      notification: {
        method: "navigation/threadGitWorkingState/updated",
        params: expect.objectContaining({
          worktreePath: "/repo/wt",
          gitWorkingState,
        }),
      },
    });
  });

  it("reprobes stale working state after the automatic startup batch", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const now = 10_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const threads = Array.from({ length: 8 }, (_, index) => ({
      id: `thread-${index}`,
      title: `Thread ${index}`,
      titleSource: "explicit" as const,
      source: "codex" as const,
      projectKey: `/repo/wt-${index}`,
      linkedDirectories: [],
      updatedAt: 2_000 - index,
    }));
    listThreads.mockResolvedValue(threads as never);

    try {
      registerAppServerIpcHandlers();
      await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
      await vi.waitFor(() => {
        expect(readWorktreeWorkingStateEntries).toHaveBeenCalledTimes(1);
        expect(writeThreadGitWorkingStateCacheEntry).toHaveBeenCalledTimes(8);
      });

      nowSpy.mockReturnValue(now + 31_000);
      await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});

      await vi.waitFor(() => {
        expect(readWorktreeWorkingStateEntries).toHaveBeenCalledTimes(2);
        expect(writeThreadGitWorkingStateCacheEntry).toHaveBeenCalledTimes(16);
      });
      expect(readWorktreeWorkingStateEntries.mock.calls[1]?.[0]).toEqual(
        threads.map((thread) => thread.projectKey),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("rotates bounded automatic working-state refreshes past the first batch", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const now = 20_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const threads = Array.from({ length: 9 }, (_, index) => ({
      id: `thread-${index}`,
      title: `Thread ${index}`,
      titleSource: "explicit" as const,
      source: "codex" as const,
      projectKey: `/repo/wt-${index}`,
      linkedDirectories: [],
      updatedAt: 2_000 - index,
    }));
    listThreads.mockResolvedValue(threads as never);

    try {
      registerAppServerIpcHandlers();
      await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});

      await vi.waitFor(() => {
        expect(readWorktreeWorkingStateEntries).toHaveBeenCalledTimes(1);
        expect(writeThreadGitWorkingStateCacheEntry).toHaveBeenCalledTimes(8);
      });
      const firstBatch = readWorktreeWorkingStateEntries.mock.calls[0]?.[0];
      expect(firstBatch).toEqual(
        threads.slice(0, 8).map((thread) => thread.projectKey),
      );

      nowSpy.mockReturnValue(now + 31_000);
      await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});

      await vi.waitFor(() => {
        expect(readWorktreeWorkingStateEntries).toHaveBeenCalledTimes(2);
        expect(writeThreadGitWorkingStateCacheEntry).toHaveBeenCalledTimes(16);
      });
      const secondBatch = readWorktreeWorkingStateEntries.mock.calls[1]?.[0];
      expect(secondBatch).toHaveLength(8);
      expect(secondBatch).toContain(threads[8]!.projectKey);
      expect(new Set([...firstBatch!, ...secondBatch!])).toEqual(
        new Set(threads.map((thread) => thread.projectKey)),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("lets a user-triggered working-state refresh bypass fresh cache", async () => {
    const {
      NAVIGATION_REFRESH_THREAD_GIT_WORKING_STATE_CHANNEL,
      NAVIGATION_SNAPSHOT_CHANNEL,
    } = await import("../../shared/ipc");
    const worktreePath = "/repo/wt";
    const gitWorkingState = {
      dirtyFiles: 0,
      dirtyAdditions: 0,
      dirtyDeletions: 0,
      untrackedFiles: 0,
      unpushedCommits: 0,
      baseBranch: "main",
    };
    const cachedFetchedAt = Date.now();
    listThreads.mockResolvedValue([
      {
        id: "thread-1",
        title: "Thread one",
        titleSource: "explicit",
        source: "codex",
        projectKey: worktreePath,
        linkedDirectories: [],
        updatedAt: 2_000,
      },
    ] as never);
    readThreadGitWorkingStateCache.mockResolvedValueOnce({
      [worktreePath]: {
        worktreePath,
        fetchedAt: cachedFetchedAt,
        gitWorkingState,
      },
    });

    registerAppServerIpcHandlers();
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    expect(readWorktreeWorkingStateEntries).not.toHaveBeenCalled();

    await expect(
      handlers.get(NAVIGATION_REFRESH_THREAD_GIT_WORKING_STATE_CHANNEL)?.(
        {},
        { backend: "codex", threadId: "thread-1", trigger: "scheduled" },
      ),
    ).resolves.toEqual({ scheduled: false });
    expect(invalidateWorktreeWorkingState).not.toHaveBeenCalled();

    readWorktreeWorkingStateEntries.mockImplementationOnce((worktreePaths) =>
      (async function* () {
        for (const path of worktreePaths) {
          yield { worktreePath: path, gitWorkingState };
        }
      })(),
    );
    publishLocalEvent.mockClear();
    await expect(
      handlers.get(NAVIGATION_REFRESH_THREAD_GIT_WORKING_STATE_CHANNEL)?.(
        {},
        { backend: "codex", threadId: "thread-1", trigger: "user" },
      ),
    ).resolves.toEqual({ scheduled: true });
    expect(invalidateWorktreeWorkingState).toHaveBeenCalledExactlyOnceWith(
      worktreePath,
    );
    await vi.waitFor(() => {
      expect(readWorktreeWorkingStateEntries).toHaveBeenCalledWith(
        [worktreePath],
        expect.any(Object),
      );
      expect(writeThreadGitWorkingStateCacheEntry).toHaveBeenCalledWith(
        expect.objectContaining({ worktreePath }),
      );
      expect(publishLocalEvent).toHaveBeenCalledWith({
        backend: "codex",
        notification: {
          method: "navigation/threadGitWorkingState/updated",
          params: expect.objectContaining({
            worktreePath,
            gitWorkingState,
            fetchedAt: expect.any(Number),
          }),
        },
      });
    });
    const refreshedCacheEntry = writeThreadGitWorkingStateCacheEntry.mock.calls
      .at(-1)?.[0];
    expect(refreshedCacheEntry?.fetchedAt).toBeGreaterThan(cachedFetchedAt);
  });

  it("hydrates working state from linked worktrees when the thread has no project key", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");

    const worktreePath =
      "/Users/example/.codex/profiles/sample/worktrees/tree-alpha/catalog-service";
    const gitWorkingState = {
      dirtyFiles: 0,
      dirtyAdditions: 0,
      dirtyDeletions: 0,
      untrackedFiles: 0,
      unpushedCommits: 0,
      baseBranch: "develop",
    };
    listThreads.mockResolvedValueOnce([
      {
        id: "thread-1",
        title: "Thread one",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [
          {
            id: worktreePath,
            label: "catalog-service",
            path: "/Users/example/Projects/catalog-service",
            worktreePath,
            kind: "worktree",
          },
        ],
        updatedAt: 2000,
      },
    ] as never);
    readThreadGitWorkingStateCache.mockResolvedValueOnce({
      [worktreePath]: {
        worktreePath,
        fetchedAt: 1000,
        gitWorkingState,
      },
    });

    registerAppServerIpcHandlers();
    const snapshot = await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});

    expect(snapshot).toMatchObject({
      threads: [
        expect.objectContaining({
          id: "thread-1",
          gitWorkingState,
          gitWorkingStateFetchedAt: 1000,
        }),
      ],
    });
    await vi.waitFor(() => {
      expect(readWorktreeWorkingStateEntries).toHaveBeenCalledWith(
        [worktreePath],
        expect.any(Object),
      );
    });
  });

  it("passes merged PR commit SHAs into working-state probes", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const mergedPrSha = "a".repeat(40);

    listThreads.mockResolvedValueOnce([
      {
        id: "thread-1",
        title: "Thread one",
        titleSource: "explicit",
        source: "codex",
        projectKey: "/repo/wt",
        linkedDirectories: [],
        updatedAt: 2000,
        prs: [
          githubPr({
            number: 806,
            org: "pwrdrvr",
            repo: "PwrAgent",
            title: "PR canonical info store",
            state: "passing",
            lifecycleState: "merged",
            url: "https://github.com/pwrdrvr/PwrAgent/pull/806",
            commitShas: [mergedPrSha],
          }),
        ],
      },
    ] as never);

    registerAppServerIpcHandlers();
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});

    await vi.waitFor(() => {
      expect(readWorktreeWorkingStateEntries).toHaveBeenCalledWith(
        ["/repo/wt"],
        {
          acceptedPushedCommitShasByWorktreePath: {
            "/repo/wt": [mergedPrSha],
          },
        },
      );
    });
  });

  it("passes detached merged PR commit SHAs into working-state probes", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const mergedPrSha = "b".repeat(40);
    const detachedPr = githubPr({
      number: 807,
      org: "pwrdrvr",
      repo: "PwrAgent",
      title: "Detached merged PR",
      state: "passing",
      lifecycleState: "merged",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/807",
      commitShas: [mergedPrSha],
    });

    getThreadOverlayStates.mockResolvedValue({
      "thread-1": {
        backend: "codex",
        threadId: "thread-1",
        executionMode: "default",
        extraLinkedDirectories: [],
        detachedPrKeys: ["github.com/pwrdrvr/pwragent#807"],
        detachedPrs: [detachedPr],
      },
    });
    listThreads.mockResolvedValueOnce([
      {
        id: "thread-1",
        title: "Thread one",
        titleSource: "explicit",
        source: "codex",
        projectKey: "/repo/wt",
        linkedDirectories: [],
        updatedAt: 2000,
        prs: [],
      },
    ] as never);

    registerAppServerIpcHandlers();
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});

    await vi.waitFor(() => {
      expect(readWorktreeWorkingStateEntries).toHaveBeenCalledWith(
        ["/repo/wt"],
        {
          acceptedPushedCommitShasByWorktreePath: {
            "/repo/wt": [mergedPrSha],
          },
        },
      );
    });
  });

  it("registers a user-invoked PR status tool handler with freshness metadata", async () => {
    const fetchedAt = Date.now() - 45_000;
    const cachedPr = githubPr({
      number: 944,
      org: "pwrdrvr",
      repo: "PwrAgent",
      title: "Cached PR",
      state: "passing",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/944",
    });

    listThreads.mockResolvedValue([
      {
        id: "thread-1",
        title: "Thread one",
        titleSource: "explicit",
        source: "codex",
        gitBranch: "feat/status-tool",
        linkedDirectories: [
          {
            id: "directory:/repo",
            kind: "worktree",
            label: "Repo",
            path: "/repo",
            worktreePath: "/repo/wt",
          },
        ],
        updatedAt: 2000,
      },
    ] as never);
    getThreadOverlayState.mockResolvedValue({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prs: [cachedPr],
      prsFetchedAt: fetchedAt,
    });

    registerAppServerIpcHandlers();
    const handler = setThreadPullRequestStatusToolHandler.mock.calls.at(-1)?.[0];
    expect(handler).toBeTypeOf("function");

    const response = await handler?.({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(response).toMatchObject({
      ok: true,
      data: {
        pullRequestStatus: {
          backend: "codex",
          threadId: "thread-1",
          provider: "github.com",
          prs: [cachedPr],
          ghAvailable: true,
          refreshStarted: true,
          lastStatusCheckAt: fetchedAt,
          branch: "feat/status-tool",
          directoryPaths: ["/repo/wt"],
          prAutomation: {
            backgroundPollingEnabled: false,
            autoFixAllowed: false,
            autoFixEnabled: false,
            autoFixActive: false,
          },
        },
      },
    });
    if (response?.ok && "pullRequestStatus" in response.data) {
      expect(response.data.pullRequestStatus.lastStatusCheckAgeMs).toBeGreaterThanOrEqual(
        45_000,
      );
      expect(response.data.pullRequestStatus.requestedAt).toBeGreaterThanOrEqual(
        fetchedAt,
      );
    }
  });

  it("includes overlay attached directories in PR status tool default paths", async () => {
    const cachedPr = githubPr({
      number: 945,
      org: "pwrdrvr",
      repo: "agent-kit",
      title: "Attached repo PR",
      state: "passing",
      url: "https://github.com/pwrdrvr/agent-kit/pull/945",
    });

    listThreads.mockResolvedValue([
      {
        id: "thread-1",
        title: "Thread one",
        titleSource: "explicit",
        source: "codex",
        gitBranch: "feat/status-tool",
        linkedDirectories: [],
        updatedAt: 2000,
      },
    ] as never);
    getThreadOverlayState.mockResolvedValue({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [
        {
          id: "directory:/repo/agent-kit",
          kind: "worktree",
          label: "agent-kit",
          path: "/repo/agent-kit",
          worktreePath: "/repo/agent-kit-wt",
        },
      ],
      prs: [cachedPr],
      prsFetchedAt: Date.now() - 45_000,
    });

    registerAppServerIpcHandlers();
    const handler = setThreadPullRequestStatusToolHandler.mock.calls.at(-1)?.[0];
    expect(handler).toBeTypeOf("function");

    const response = await handler?.({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(response).toMatchObject({
      ok: true,
      data: {
        pullRequestStatus: {
          backend: "codex",
          threadId: "thread-1",
          prs: [cachedPr],
          branch: "feat/status-tool",
          directoryPaths: ["/repo/agent-kit-wt"],
        },
      },
    });
  });

  it("refreshes a thread's working state after the agent finishes a turn", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");

    listThreads.mockResolvedValueOnce([
      {
        id: "thread-1",
        title: "Thread one",
        titleSource: "explicit",
        source: "codex",
        projectKey: "/repo/wt",
        linkedDirectories: [],
        updatedAt: 2000,
      },
    ] as never);

    registerAppServerIpcHandlers();
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    await vi.waitFor(() => {
      expect(writeThreadGitWorkingStateCacheEntry).toHaveBeenCalled();
    });
    const callsAfterSnapshot = readWorktreeWorkingStateEntries.mock.calls.length;

    emitRegistryEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "t1",
          turn: { id: "t1", status: "completed" },
        },
      },
    });

    expect(invalidateWorktreeWorkingState).toHaveBeenCalledWith("/repo/wt");
    await vi.waitFor(() => {
      expect(readWorktreeWorkingStateEntries.mock.calls.length).toBe(
        callsAfterSnapshot + 1,
      );
    });
    expect(readWorktreeWorkingStateEntries.mock.calls.at(-1)?.[0]).toEqual([
      "/repo/wt",
    ]);
  });

  it("refreshes a thread's working state after its expected branch changes", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");

    listThreads.mockResolvedValueOnce([
      {
        id: "thread-1",
        title: "Thread one",
        titleSource: "explicit",
        source: "codex",
        projectKey: "/repo/wt",
        linkedDirectories: [],
        updatedAt: 2000,
      },
    ] as never);

    registerAppServerIpcHandlers();
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    await vi.waitFor(() => {
      expect(writeThreadGitWorkingStateCacheEntry).toHaveBeenCalled();
    });
    const callsAfterSnapshot = readWorktreeWorkingStateEntries.mock.calls.length;

    emitRegistryEvent({
      backend: "codex",
      notification: {
        method: "thread/branch/updated",
        params: {
          threadId: "thread-1",
          branch: "fix/new-branch",
        },
      },
    });

    expect(invalidateWorktreeWorkingState).toHaveBeenCalledWith("/repo/wt");
    await vi.waitFor(() => {
      expect(readWorktreeWorkingStateEntries.mock.calls.length).toBe(
        callsAfterSnapshot + 1,
      );
    });
    expect(readWorktreeWorkingStateEntries.mock.calls.at(-1)?.[0]).toEqual([
      "/repo/wt",
    ]);
  });

  it("refreshes pull requests for the rendered branch when a turn completes", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const discoveredPr = githubPr({
      number: 813,
      org: "pwrdrvr",
      repo: "PwrAgent",
      title: "Count merged PR commits as pushed",
      state: "pending",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/813",
    });

    listThreads.mockResolvedValueOnce([
      {
        id: "thread-1",
        title: "Thread one",
        titleSource: "explicit",
        source: "codex",
        projectKey: "/repo/wt",
        linkedDirectories: [
          {
            id: "directory:/repo/app",
            label: "app",
            path: "/repo/app",
            kind: "worktree",
            worktreePath: "/repo/wt",
          },
        ],
        gitBranch: "fix/merged-pr-commits-pushed",
        observedGitBranch: "fix/merged-pr-commits-pushed",
        updatedAt: 2000,
      },
    ] as never);
    detectPullRequestsForThread.mockResolvedValueOnce([discoveredPr]);

    registerAppServerIpcHandlers();
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    await vi.waitFor(() => {
      expect(writeThreadGitWorkingStateCacheEntry).toHaveBeenCalled();
    });
    detectPullRequestsForThread.mockClear();

    emitRegistryEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "t1",
          turn: { id: "t1", status: "completed" },
        },
      },
    });

    await vi.waitFor(() => {
      expect(detectPullRequestsForThread).toHaveBeenCalledWith({
        fetcher: expect.any(Object),
        branch: "fix/merged-pr-commits-pushed",
        directoryPaths: ["/repo/wt"],
        allowPrimedBranchLookup: false,
      });
    });
    await vi.waitFor(() => {
      expect(setThreadPullRequests).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        prs: [discoveredPr],
        fetchedAt: expect.any(Number),
        refreshKey: buildThreadPrRequestKey({
          backend: "codex",
          threadId: "thread-1",
          branch: "fix/merged-pr-commits-pushed",
          directoryPaths: ["/repo/wt"],
        }),
      });
    });
  });

  it("refreshes post-turn pull requests for an adopted branch instead of stale snapshot context", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const discoveredPr = githubPr({
      number: 814,
      org: "pwrdrvr",
      repo: "PwrAgent",
      title: "Refresh adopted branch PRs",
      state: "pending",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/814",
    });

    listThreads.mockResolvedValueOnce([
      {
        id: "thread-1",
        title: "Thread one",
        titleSource: "explicit",
        source: "codex",
        projectKey: "/repo/wt",
        linkedDirectories: [
          {
            id: "directory:/repo/app",
            label: "app",
            path: "/repo/app",
            kind: "worktree",
            worktreePath: "/repo/wt",
          },
        ],
        gitBranch: "fix/old-branch",
        observedGitBranch: "fix/old-branch",
        updatedAt: 2000,
      },
    ] as never);
    detectPullRequestsForThread.mockResolvedValueOnce([discoveredPr]);

    registerAppServerIpcHandlers();
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    await vi.waitFor(() => {
      expect(writeThreadGitWorkingStateCacheEntry).toHaveBeenCalled();
    });
    detectPullRequestsForThread.mockClear();

    emitRegistryEvent({
      backend: "codex",
      notification: {
        method: "thread/branch/updated",
        params: {
          threadId: "thread-1",
          branch: "fix/adopted-branch",
        },
      },
    });
    emitRegistryEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "t1",
          turn: { id: "t1", status: "completed" },
        },
      },
    });

    await vi.waitFor(() => {
      expect(detectPullRequestsForThread).toHaveBeenCalledWith({
        fetcher: expect.any(Object),
        branch: "fix/adopted-branch",
        directoryPaths: ["/repo/wt"],
        allowPrimedBranchLookup: false,
      });
    });
    expect(detectPullRequestsForThread).not.toHaveBeenCalledWith({
      fetcher: expect.any(Object),
      branch: "fix/old-branch",
      directoryPaths: ["/repo/wt"],
    });
  });

  it("refreshes pull requests when branch adoption finishes after turn completion", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const discoveredPr = githubPr({
      number: 815,
      org: "pwrdrvr",
      repo: "PwrAgent",
      title: "Refresh late-adopted branch PRs",
      state: "pending",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/815",
    });

    listThreads.mockResolvedValueOnce([
      {
        id: "thread-1",
        title: "Thread one",
        titleSource: "explicit",
        source: "codex",
        projectKey: "/repo/wt",
        linkedDirectories: [
          {
            id: "directory:/repo/app",
            label: "app",
            path: "/repo/app",
            kind: "worktree",
            worktreePath: "/repo/wt",
          },
        ],
        gitBranch: "HEAD",
        observedGitBranch: "HEAD",
        updatedAt: 2000,
      },
    ] as never);
    detectPullRequestsForThread
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([discoveredPr]);

    registerAppServerIpcHandlers();
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    await vi.waitFor(() => {
      expect(writeThreadGitWorkingStateCacheEntry).toHaveBeenCalled();
    });
    detectPullRequestsForThread.mockClear();

    emitRegistryEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "t1",
          turn: { id: "t1", status: "completed" },
        },
      },
    });
    await vi.waitFor(() => {
      expect(detectPullRequestsForThread).toHaveBeenCalledWith({
        fetcher: expect.any(Object),
        branch: "HEAD",
        directoryPaths: ["/repo/wt"],
        allowPrimedBranchLookup: false,
      });
    });

    emitRegistryEvent({
      backend: "codex",
      notification: {
        method: "thread/branch/updated",
        params: {
          threadId: "thread-1",
          branch: "fix/adopted-after-completion",
        },
      },
    });

    await vi.waitFor(() => {
      expect(setThreadPullRequests).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        prs: [discoveredPr],
        fetchedAt: expect.any(Number),
        refreshKey: buildThreadPrRequestKey({
          backend: "codex",
          threadId: "thread-1",
          branch: "fix/adopted-after-completion",
          directoryPaths: ["/repo/wt"],
        }),
      });
    });
  });

  it("preserves PR history when late branch adoption overlaps the post-turn lookup", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const oldBranchPr = githubPr({
      number: 816,
      org: "pwrdrvr",
      repo: "PwrAgent",
      title: "PR discovered from the pre-adoption branch",
      state: "passing",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/816",
    });
    const adoptedBranchPr = githubPr({
      number: 817,
      org: "pwrdrvr",
      repo: "PwrAgent",
      title: "PR discovered from the adopted branch",
      state: "pending",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/817",
    });
    let overlayState: Awaited<ReturnType<typeof setThreadPullRequests>> | undefined;
    const resolveFetches: Array<(prs: PrSummary[]) => void> = [];
    const persistOverlay = async (
      request: Parameters<typeof setThreadPullRequests>[0],
    ): Promise<NonNullable<typeof overlayState>> => {
      overlayState = {
        backend: request.backend,
        threadId: request.threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
        prs: request.prs,
        prsFetchedAt: request.fetchedAt ?? Date.now(),
        prsRefreshKey: request.refreshKey,
      };
      return overlayState;
    };

    listThreads.mockResolvedValueOnce([
      {
        id: "thread-1",
        title: "Thread one",
        titleSource: "explicit",
        source: "codex",
        projectKey: "/repo/wt",
        linkedDirectories: [
          {
            id: "directory:/repo/app",
            label: "app",
            path: "/repo/app",
            kind: "worktree",
            worktreePath: "/repo/wt",
          },
        ],
        gitBranch: "HEAD",
        observedGitBranch: "HEAD",
        updatedAt: 2000,
      },
    ] as never);
    getThreadOverlayState.mockImplementation(async () => overlayState);
    setThreadPullRequests
      .mockImplementationOnce(persistOverlay)
      .mockImplementationOnce(persistOverlay);
    detectPullRequestsForThread.mockImplementation(
      async () => await new Promise<PrSummary[]>((resolve) => {
        resolveFetches.push(resolve);
      }),
    );

    registerAppServerIpcHandlers();
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    await vi.waitFor(() => {
      expect(writeThreadGitWorkingStateCacheEntry).toHaveBeenCalled();
    });

    emitRegistryEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "t1",
          turn: { id: "t1", status: "completed" },
        },
      },
    });
    await vi.waitFor(() => {
      expect(resolveFetches).toHaveLength(1);
    });

    emitRegistryEvent({
      backend: "codex",
      notification: {
        method: "thread/branch/updated",
        params: {
          threadId: "thread-1",
          branch: "fix/adopted-after-completion",
        },
      },
    });
    await vi.waitFor(() => {
      expect(resolveFetches).toHaveLength(2);
    });

    resolveFetches[0]?.([oldBranchPr]);
    resolveFetches[1]?.([adoptedBranchPr]);

    await vi.waitFor(() => {
      expect(overlayState?.prs?.map((pr) => pr.number)).toEqual([816, 817]);
    });
  });

  it("refreshes post-turn pull requests for a scoped linked worktree branch", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");

    listThreads.mockResolvedValueOnce([
      {
        id: "thread-1",
        title: "Thread one",
        titleSource: "explicit",
        source: "codex",
        projectKey: "/repo/primary",
        linkedDirectories: [
          {
            id: "directory:/repo/primary",
            label: "primary",
            path: "/repo/primary",
            kind: "local",
          },
          {
            id: "directory:/repo/kube-manifests",
            label: "kube-manifests",
            path: "/repo/kube-manifests",
            kind: "worktree",
            worktreePath: "/worktrees/kube-manifests",
            gitBranch: "fix/channelsv2-live-pods",
          },
        ],
        gitBranch: "main",
        observedGitBranch: "main",
        updatedAt: 2000,
      },
    ] as never);
    detectPullRequestsForThread.mockResolvedValue([]);

    registerAppServerIpcHandlers();
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    await vi.waitFor(() => {
      expect(writeThreadGitWorkingStateCacheEntry).toHaveBeenCalled();
    });
    detectPullRequestsForThread.mockClear();

    emitRegistryEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "t1",
          turn: { id: "t1", status: "completed" },
        },
      },
    });

    await vi.waitFor(() => {
      expect(detectPullRequestsForThread).toHaveBeenCalledWith({
        fetcher: expect.any(Object),
        branch: "main",
        directoryPaths: ["/repo/primary"],
        allowPrimedBranchLookup: false,
      });
      expect(detectPullRequestsForThread).toHaveBeenCalledWith({
        fetcher: expect.any(Object),
        branch: "fix/channelsv2-live-pods",
        directoryPaths: ["/worktrees/kube-manifests"],
        allowPrimedBranchLookup: false,
      });
    });
  });

  it("routes post-turn retained PR refreshes back to HEAD worktree threads", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");
    const stalePr = githubPr({
      number: 981,
      org: "pwrdrvr",
      repo: "PwrAgent",
      title: "Restore queued steer",
      state: "pending",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/981",
    });
    const passingPr = githubPr({
      number: stalePr.number,
      org: stalePr.org,
      repo: stalePr.repo,
      title: stalePr.title,
      state: "passing",
      url: stalePr.url,
    });
    const requestKey = buildThreadPrRequestKey({
      backend: "codex",
      threadId: "thread-1",
      branch: "HEAD",
      directoryPaths: ["/worktrees/PwrAgnt"],
    });

    listThreads.mockResolvedValueOnce([
      {
        id: "thread-1",
        title: "Thread one",
        titleSource: "explicit",
        source: "codex",
        projectKey: "/scratch/project",
        linkedDirectories: [
          {
            id: "/repo/PwrAgnt",
            label: "PwrAgnt",
            path: "/repo/PwrAgnt",
            kind: "worktree",
            worktreePath: "/worktrees/PwrAgnt",
            gitBranch: "HEAD",
          },
          {
            id: "/scratch/project",
            label: "project",
            path: "/scratch/project",
            kind: "local",
          },
        ],
        prs: [stalePr],
        updatedAt: 2000,
      },
    ] as never);
    getThreadOverlayState.mockResolvedValue({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prs: [stalePr],
      prsFetchedAt: Date.now() - 120_000,
      prsRefreshKey: requestKey,
    });
    fetchPullRequestByUrl.mockResolvedValueOnce(passingPr);

    registerAppServerIpcHandlers();
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    await vi.waitFor(() => {
      expect(writeThreadGitWorkingStateCacheEntry).toHaveBeenCalled();
    });
    detectPullRequestsForThread.mockClear();

    emitRegistryEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "t1",
          turn: { id: "t1", status: "completed" },
        },
      },
    });

    await vi.waitFor(() => {
      expect(detectPullRequestsForThread).toHaveBeenCalledWith({
        fetcher: expect.any(Object),
        branch: "HEAD",
        directoryPaths: ["/worktrees/PwrAgnt"],
        allowPrimedBranchLookup: false,
      });
    });
    await vi.waitFor(() => {
      expect(fetchPullRequestByUrl).toHaveBeenCalledWith({
        cwd: "/worktrees/PwrAgnt",
        url: "https://github.com/pwrdrvr/PwrAgent/pull/981",
      });
    });
    await vi.waitFor(() => {
      expect(setThreadPullRequests).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        prs: [passingPr],
        fetchedAt: expect.any(Number),
        refreshKey: requestKey,
      });
    });
    await vi.waitFor(() => {
      expect(publishLocalEvent).toHaveBeenCalledWith({
        backend: "codex",
        notification: {
          method: "thread/pullRequests/updated",
          params: {
            threadId: "thread-1",
            prs: [passingPr],
          },
        },
      });
    });
  });

  it("ignores a completed non-git command for working-state refresh", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");

    listThreads.mockResolvedValueOnce([
      {
        id: "thread-1",
        title: "Thread one",
        titleSource: "explicit",
        source: "codex",
        projectKey: "/repo/wt",
        linkedDirectories: [],
        updatedAt: 2000,
      },
    ] as never);

    registerAppServerIpcHandlers();
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    await vi.waitFor(() => {
      expect(writeThreadGitWorkingStateCacheEntry).toHaveBeenCalled();
    });
    const callsAfterSnapshot = readWorktreeWorkingStateEntries.mock.calls.length;
    invalidateWorktreeWorkingState.mockClear();

    emitRegistryEvent({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          item: { id: "i1", type: "command", command: "npm run build" },
        },
      },
    });

    expect(invalidateWorktreeWorkingState).not.toHaveBeenCalled();
    expect(readWorktreeWorkingStateEntries.mock.calls.length).toBe(
      callsAfterSnapshot,
    );
  });

  it("coalesces concurrent identical resolveEditCommitStates requests", async () => {
    const { NAVIGATION_RESOLVE_EDIT_COMMIT_STATES_CHANNEL } = await import(
      "../../shared/ipc"
    );

    registerAppServerIpcHandlers();

    const request = {
      worktreePath: "/repo/wt",
      groups: [{ key: "g-1", paths: ["/repo/wt/a.ts"] }],
    };
    const handler = handlers.get(NAVIGATION_RESOLVE_EDIT_COMMIT_STATES_CHANNEL);
    const first = handler?.({}, request);
    const second = handler?.({}, request);

    // Both requests are in flight; release the single shared registry call.
    await vi.waitFor(() => {
      expect(releaseEditCommitResolve).toBeDefined();
    });
    releaseEditCommitResolve?.();

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ states: { "g-1": { committed: false } } });
    expect(b).toEqual({ states: { "g-1": { committed: false } } });
    expect(resolveEditCommitStates).toHaveBeenCalledTimes(1);
  });

  it("caps automatic startup directory git status refreshes", async () => {
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");

    const directories = Array.from({ length: 6 }, (_, index) => ({
      key: `directory:/repo/app-${index}`,
      kind: "directory" as const,
      label: `app-${index}`,
      path: `/repo/app-${index}`,
      threadKeys: ["codex:thread-1"],
      needsAttentionCount: 0,
      latestUpdatedAt: 1000 + index,
    }));
    reconcileNavigationSnapshot.mockResolvedValueOnce({
      backend: "all",
      fetchedAt: 1234,
      unchanged: false,
      threads: [
        {
          id: "thread-1",
          title: "Thread one",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          updatedAt: 2000,
        },
      ],
      inboxThreadKeys: [],
      directories,
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    });

    registerAppServerIpcHandlers();

    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    await vi.waitFor(() => {
      expect(readDirectoryStatusEntries).toHaveBeenCalled();
    });

    expect(readDirectoryStatusEntries.mock.calls[0]?.[0]).toHaveLength(4);
    expect(
      (readDirectoryStatusEntries.mock.calls[0]?.[0] as Array<{ key: string }>)
        .map((directory) => directory.key),
    ).toEqual([
      "directory:/repo/app-5",
      "directory:/repo/app-4",
      "directory:/repo/app-3",
      "directory:/repo/app-2",
    ]);
  });

  it("refreshes launchpad directory git status before selecting the default branch", async () => {
    const { NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL } = await import("../../shared/ipc");

    readDirectoryStatusEntries.mockImplementationOnce((directories: Array<{ key: string }>) =>
      (async function* () {
        yield {
          directoryKey: directories[0]!.key,
          gitStatus: {
            ...directoryGitStatus,
            currentBranch: "fresh-branch",
          },
        };
      })(),
    );

    registerAppServerIpcHandlers();

    const response = await handlers.get(
      NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL,
    )?.({}, {
      directoryKey: "directory:/repo/app",
      directoryKind: "directory",
      directoryLabel: "app",
      directoryPath: "/repo/missing-worktree",
      gitStatusSourcePath: "/repo/app",
      currentBranch: "stale-branch",
    });

    expect(readDirectoryStatusEntries).toHaveBeenCalledWith([
      expect.objectContaining({
        key: "directory:/repo/app",
        path: "/repo/app",
      }),
    ]);
    expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({
        directoryKey: "directory:/repo/app",
        currentBranch: "fresh-branch",
      }),
    );
    expect(writeDirectoryGitStatusCacheEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        directoryKey: "directory:/repo/app",
        directoryPath: "/repo/missing-worktree",
        gitStatus: expect.objectContaining({ currentBranch: "fresh-branch" }),
      }),
    );
    expect(response).toEqual(
      expect.objectContaining({
        gitStatus: expect.objectContaining({
          currentBranch: "fresh-branch",
        }),
      }),
    );
  });

  it("keeps owner branch inventory authoritative when viewer and owner paths match", async () => {
    const { NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL } = await import("../../shared/ipc");
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "owner_one",
    };
    const ownerGitStatus = {
      currentBranch: "owner/main",
      branches: ["owner/main", "owner/release"],
      branchDetails: [
        { name: "owner/main", lastCommitAt: 200 },
        { name: "owner/release", lastCommitAt: 100 },
      ],
      syncState: "in-sync" as const,
    };
    federationMock.remoteBackend.ensureDirectoryLaunchpad.mockResolvedValueOnce({
      launchpad: {
        directoryKey: "directory:/repo/app",
        directoryKind: "directory",
        directoryLabel: "app",
        directoryPath: "/repo/app",
        backend: "codex",
        executionMode: "default",
        prompt: "",
        branchName: "owner/main",
        createdAt: 100,
        updatedAt: 100,
      },
      defaults: {
        backend: "codex",
        executionMode: "default",
      },
      gitStatus: ownerGitStatus,
    });
    ensureDirectoryLaunchpad.mockResolvedValueOnce({
      launchpad: {
        directoryKey: "directory:/repo/app",
        directoryKind: "directory",
        directoryLabel: "app",
        directoryPath: "/repo/app",
        backend: "codex",
        executionMode: "default",
        prompt: "viewer draft",
        branchName: "viewer/local-only",
        createdAt: 1000,
        updatedAt: 1000,
      },
      defaults: {
        backend: "codex",
        executionMode: "default",
      },
    });

    registerAppServerIpcHandlers();
    const response = await handlers.get(
      NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL,
    )?.({}, {
      federationTarget,
      directoryKey: "directory:/repo/app",
      directoryKind: "directory",
      directoryLabel: "app",
      directoryPath: "/repo/app",
      currentBranch: "owner/main",
    });

    expect(federationMock.runtime.remoteBackend).toHaveBeenCalledWith(
      federationTarget,
    );
    expect(
      federationMock.remoteBackend.ensureDirectoryLaunchpad,
    ).toHaveBeenCalledWith({
      directoryKey: "directory:/repo/app",
      directoryKind: "directory",
      directoryLabel: "app",
      directoryPath: "/repo/app",
      currentBranch: "owner/main",
    });
    expect(readDirectoryStatusEntries).not.toHaveBeenCalled();
    expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({
        directoryPath: "/repo/app",
        currentBranch: undefined,
      }),
      { skipFilesystemInspection: true },
    );
    expect(updateDirectoryLaunchpad).not.toHaveBeenCalled();
    expect(response).toEqual(
      expect.objectContaining({
        gitStatus: ownerGitStatus,
        launchpad: expect.objectContaining({
          prompt: "viewer draft",
          branchName: "owner/main",
        }),
      }),
    );
  });

  it("falls back to owner snapshot metadata when the peer lacks launchpad metadata RPC support", async () => {
    const { NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL } = await import("../../shared/ipc");
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "older_owner",
    };
    const ownerGitStatus = {
      currentBranch: "owner/main",
      branches: ["owner/main", "owner/release"],
      syncState: "in-sync" as const,
    };
    federationMock.runtime.remoteTargetSupportsCapability.mockReturnValueOnce(
      false,
    );
    ensureDirectoryLaunchpad.mockResolvedValueOnce({
      launchpad: {
        directoryKey: "directory:/repo/app",
        directoryKind: "directory",
        directoryLabel: "app",
        directoryPath: "/repo/app",
        backend: "codex",
        executionMode: "default",
        prompt: "viewer draft",
        branchName: "viewer/local-only",
        createdAt: 1000,
        updatedAt: 1000,
      },
      defaults: {
        backend: "codex",
        executionMode: "default",
      },
    });

    registerAppServerIpcHandlers();
    const response = await handlers.get(
      NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL,
    )?.({}, {
      federationTarget,
      directoryKey: "directory:/repo/app",
      directoryKind: "directory",
      directoryLabel: "Owner app",
      directoryPath: "/owner/repo/app",
      gitStatus: ownerGitStatus,
      currentBranch: "owner/main",
    });

    expect(
      federationMock.remoteBackend.ensureDirectoryLaunchpad,
    ).not.toHaveBeenCalled();
    expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({
        directoryLabel: "Owner app",
        directoryPath: "/owner/repo/app",
        currentBranch: undefined,
      }),
      { skipFilesystemInspection: true },
    );
    expect(response).toEqual(
      expect.objectContaining({
        gitStatus: ownerGitStatus,
        launchpad: expect.objectContaining({
          directoryLabel: "Owner app",
          directoryPath: "/owner/repo/app",
          prompt: "viewer draft",
          branchName: "owner/main",
        }),
      }),
    );
  });

  it("preserves owner remote-tracking worktree base branches", async () => {
    const { NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL } = await import("../../shared/ipc");
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "owner_one",
    };
    const ownerGitStatus = {
      currentBranch: "main",
      branches: ["main", "release"],
      baseBranches: ["main", "release", "origin/release"],
      baseBranchDetails: [
        { name: "origin/release", lastCommitAt: 200 },
      ],
    };
    federationMock.remoteBackend.ensureDirectoryLaunchpad.mockResolvedValueOnce({
      launchpad: {
        directoryKey: "directory:/repo/app",
        directoryKind: "directory",
        directoryLabel: "app",
        directoryPath: "/repo/app",
        backend: "codex",
        executionMode: "default",
        prompt: "",
        branchName: "main",
        createdAt: 100,
        updatedAt: 100,
      },
      defaults: {
        backend: "codex",
        executionMode: "default",
      },
      gitStatus: ownerGitStatus,
    });
    ensureDirectoryLaunchpad.mockResolvedValueOnce({
      launchpad: {
        directoryKey: "directory:/repo/app",
        directoryKind: "directory",
        directoryLabel: "app",
        directoryPath: "/repo/app",
        backend: "codex",
        executionMode: "default",
        prompt: "viewer draft",
        branchName: "origin/release",
        createdAt: 1000,
        updatedAt: 1000,
      },
      defaults: {
        backend: "codex",
        executionMode: "default",
      },
    });

    registerAppServerIpcHandlers();
    const response = await handlers.get(
      NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL,
    )?.({}, {
      federationTarget,
      directoryKey: "directory:/repo/app",
      directoryKind: "directory",
      directoryLabel: "app",
      directoryPath: "/repo/app",
      gitStatus: ownerGitStatus,
    });

    expect(response).toEqual(
      expect.objectContaining({
        launchpad: expect.objectContaining({
          branchName: "origin/release",
        }),
      }),
    );
    expect(updateDirectoryLaunchpad).not.toHaveBeenCalled();
  });

  it("routes remote recent file reads and writes to the owning instance", async () => {
    const {
      NAVIGATION_LIST_RECENT_FILE_REFERENCES_CHANNEL,
      NAVIGATION_RECORD_RECENT_FILE_REFERENCES_CHANNEL,
    } = await import("../../shared/ipc");
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "owner_one",
    };
    federationMock.remoteBackend.listRecentFileReferences.mockResolvedValueOnce({
      files: [{ label: "owner.md", path: "/owner/notes/owner.md" }],
    });
    federationMock.remoteBackend.recordRecentFileReferences.mockResolvedValueOnce(
      undefined,
    );
    registerAppServerIpcHandlers();

    const response = await handlers.get(
      NAVIGATION_LIST_RECENT_FILE_REFERENCES_CHANNEL,
    )?.({}, { federationTarget });
    await handlers.get(
      NAVIGATION_RECORD_RECENT_FILE_REFERENCES_CHANNEL,
    )?.({}, {
      federationTarget,
      paths: ["/owner/notes/owner.md"],
    });

    expect(response).toEqual({
      files: [{ label: "owner.md", path: "/owner/notes/owner.md" }],
    });
    expect(
      federationMock.remoteBackend.recordRecentFileReferences,
    ).toHaveBeenCalledWith({ paths: ["/owner/notes/owner.md"] });
  });

  it("never opens native filesystem pickers for a federation window", async () => {
    const {
      NAVIGATION_PICK_DIRECTORY_FROM_DISK_CHANNEL,
      NAVIGATION_PICK_FILE_FROM_DISK_CHANNEL,
      NAVIGATION_PICK_REFERENCE_FROM_DISK_CHANNEL,
      NAVIGATION_REGISTER_DIRECTORY_FROM_DISK_CHANNEL,
    } = await import("../../shared/ipc");
    registerAppServerIpcHandlers();
    const event = { sender: { id: 999 } };

    await expect(
      handlers.get(NAVIGATION_PICK_DIRECTORY_FROM_DISK_CHANNEL)?.(event),
    ).resolves.toEqual({ canceled: true });
    await expect(
      handlers.get(NAVIGATION_PICK_FILE_FROM_DISK_CHANNEL)?.(event),
    ).resolves.toEqual({ canceled: true });
    await expect(
      handlers.get(NAVIGATION_PICK_REFERENCE_FROM_DISK_CHANNEL)?.(event),
    ).resolves.toEqual({ canceled: true });
    await expect(
      handlers.get(NAVIGATION_REGISTER_DIRECTORY_FROM_DISK_CHANNEL)?.(
        event,
        { path: "/viewer/project" },
      ),
    ).rejects.toThrow(
      "Remote windows cannot register directories from the viewing instance.",
    );
    expect(registerDirectoryFromDiskService).not.toHaveBeenCalled();
  });

  it("attaches directories with path-shaped linked directory ids", async () => {
    const { NAVIGATION_ATTACH_DIRECTORY_TO_THREAD_CHANNEL } = await import("../../shared/ipc");
    const directoryPath = path.resolve("/repo/app");
    const directoryPathId = directoryPath.replace(/\\/g, "/");

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_ATTACH_DIRECTORY_TO_THREAD_CHANNEL)?.(
      {},
      {
        backend: "codex",
        threadId: "thread-1",
        path: "/repo/app",
      },
    );

    expect(addLinkedDirectory).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      directory: {
        id: directoryPathId,
        kind: "local",
        label: path.basename(directoryPath),
        path: directoryPathId,
      },
    });
    expect(response).toEqual({
      ok: true,
      backend: "codex",
      threadId: "thread-1",
      directory: {
        id: directoryPathId,
        kind: "local",
        label: path.basename(directoryPath),
        path: directoryPathId,
      },
    });
  });

  it("detaches a secondary directory while preserving the primary linked directory", async () => {
    const { NAVIGATION_DETACH_DIRECTORY_FROM_THREAD_CHANNEL } =
      await import("../../shared/ipc");
    const primaryDirectory = {
      id: "/repo/pwragent",
      kind: "worktree" as const,
      label: "PwrAgent",
      path: "/repo/pwragent",
      worktreePath: "/repo/pwragent-wt",
    };
    const secondaryDirectory = {
      id: "/repo/agent-kit",
      kind: "local" as const,
      label: "agent-kit",
      path: "/repo/agent-kit",
    };
    listThreads.mockResolvedValueOnce([
      {
        id: "thread-1",
        title: "Thread one",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [primaryDirectory, secondaryDirectory],
        updatedAt: 2000,
      },
    ] as never);
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [secondaryDirectory],
    });

    registerAppServerIpcHandlers();

    const response = await handlers.get(
      NAVIGATION_DETACH_DIRECTORY_FROM_THREAD_CHANNEL,
    )?.(
      {},
      {
        backend: "codex",
        threadId: "thread-1",
        directory: secondaryDirectory,
      },
    );

    expect(removeLinkedDirectory).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      directory: secondaryDirectory,
    });
    expect(response).toEqual({
      ok: true,
      backend: "codex",
      threadId: "thread-1",
      directories: [],
    });
  });

  it("rejects detaching the last linked directory", async () => {
    const { NAVIGATION_DETACH_DIRECTORY_FROM_THREAD_CHANNEL } =
      await import("../../shared/ipc");
    const onlyDirectory = {
      id: "/repo/agent-kit",
      kind: "local" as const,
      label: "agent-kit",
      path: "/repo/agent-kit",
    };
    listThreads.mockResolvedValueOnce([
      {
        id: "thread-1",
        title: "Thread one",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [onlyDirectory],
        updatedAt: 2000,
      },
    ] as never);
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [onlyDirectory],
    });

    registerAppServerIpcHandlers();

    const response = await handlers.get(
      NAVIGATION_DETACH_DIRECTORY_FROM_THREAD_CHANNEL,
    )?.(
      {},
      {
        backend: "codex",
        threadId: "thread-1",
        directory: onlyDirectory,
      },
    );

    expect(removeLinkedDirectory).not.toHaveBeenCalled();
    expect(response).toEqual({
      ok: false,
      backend: "codex",
      threadId: "thread-1",
      reason: "last-directory",
      message: "Cannot detach the last linked directory from a thread.",
    });
  });
});
