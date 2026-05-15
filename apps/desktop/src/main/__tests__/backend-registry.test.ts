import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  AppServerNotification,
  AppServerPendingRequestNotification,
  AppServerSkillSummary,
  AppServerThreadReplay,
  AppServerThreadSummary,
  AppServerReviewTarget,
  AppServerTurnInputItem,
  BackendAccountSummary,
  BackendRateLimitSummary,
  NavigationLaunchpadDefaults,
  NavigationLaunchpadDraft,
  ThreadOverlayState,
  WorktreeSnapshotSummary,
} from "@pwragent/shared";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import { buildNavigationSnapshot } from "@pwragent/agent-core";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import type { WorktreeArchiveService } from "../app-server/worktree-archive-service";

const execFileAsync = promisify(execFileCallback);

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
  });
  return stdout.trim();
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) {
      return;
    }
    await flushAsync();
  }
}

async function expectEventually<T>(
  read: () => Promise<T>,
  expected: T,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  let lastValue: T | undefined;
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastValue = await read();
      if (lastValue === expected) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (lastError && lastValue === undefined) {
    throw lastError;
  }
  expect(lastValue).toBe(expected);
}

function createOverlayStoreMock(params?: {
  executionMode?: "default" | "full-access";
  launchpadDefaults?: NavigationLaunchpadDefaults;
  overlays?: Record<string, ThreadOverlayState>;
}) {
  const initialOverlay = params?.executionMode
    ? {
        backend: "codex" as const,
        threadId: "thread-1",
        executionMode: params.executionMode,
        extraLinkedDirectories: [],
      }
    : undefined;
  const overlays = new Map<string, ThreadOverlayState>(
    Object.entries(params?.overlays ?? {})
  );
  let launchpadDefaults: NavigationLaunchpadDefaults = {
    backend: "codex",
    executionMode: "default",
    workMode: "local",
    ...params?.launchpadDefaults,
  };
  const launchpads = new Map<string, NavigationLaunchpadDraft>();
  if (initialOverlay) {
    overlays.set("codex:thread-1", initialOverlay);
  }

  return {
    getThreadOverlayState: async ({
      backend,
      threadId,
    }: {
      backend: "codex" | "grok";
      threadId: string;
    }) => overlays.get(`${backend}:${threadId}`),
    getThreadOverlayStates: async ({ threadIds }: { threadIds: string[] }) =>
      Object.fromEntries(threadIds.map((threadId) => [threadId, overlays.get(`codex:${threadId}`)])),
    setThreadExecutionMode: async ({
      backend,
      threadId,
      executionMode,
    }: {
      backend: "codex" | "grok";
      threadId: string;
      executionMode: "default" | "full-access";
    }) => {
      const key = `${backend}:${threadId}`;
      const next = {
        ...overlays.get(key),
        backend,
        threadId,
        executionMode,
        extraLinkedDirectories: overlays.get(key)?.extraLinkedDirectories ?? [],
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    setThreadModelSettings: async (settings: {
      backend: "codex" | "grok";
      threadId: string;
      model?: string;
      reasoningEffort?: string;
      serviceTier?: string;
      fastMode?: boolean;
    }) => {
      const key = `${settings.backend}:${settings.threadId}`;
      const next = {
        ...overlays.get(key),
        ...settings,
        extraLinkedDirectories: overlays.get(key)?.extraLinkedDirectories ?? [],
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    setThreadCodexEnvironmentRuntime: async (settings: {
      backend: "codex" | "grok";
      threadId: string;
      codexEnvironmentRuntime?: ThreadOverlayState["codexEnvironmentRuntime"];
    }) => {
      const key = `${settings.backend}:${settings.threadId}`;
      const next = {
        ...overlays.get(key),
        backend: settings.backend,
        threadId: settings.threadId,
        codexEnvironmentRuntime: settings.codexEnvironmentRuntime,
        extraLinkedDirectories: overlays.get(key)?.extraLinkedDirectories ?? [],
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    setThreadExpectedBranch: async ({
      backend,
      threadId,
      branch,
    }: {
      backend: "codex" | "grok";
      threadId: string;
      branch: string;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        gitBranch: branch,
        observedGitBranch: branch,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    setThreadObservedBranch: async ({
      backend,
      threadId,
      branch,
      expectedBranch,
    }: {
      backend: "codex" | "grok";
      threadId: string;
      branch?: string;
      expectedBranch?: string;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
      };
      const previousObservedBranch = current.observedGitBranch?.trim();
      const nextObservedBranch = branch?.trim();
      const fallbackExpectedBranch =
        !current.gitBranch?.trim() &&
        previousObservedBranch &&
        nextObservedBranch &&
        previousObservedBranch !== nextObservedBranch
          ? previousObservedBranch
          : undefined;
      const requestedExpectedBranch =
        expectedBranch?.trim() && expectedBranch.trim() !== nextObservedBranch
          ? expectedBranch.trim()
          : undefined;
      const next = {
        ...current,
        gitBranch: current.gitBranch?.trim()
          ? current.gitBranch
          : requestedExpectedBranch ?? fallbackExpectedBranch,
        observedGitBranch: branch,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    retainThreadBranchDrift: async ({
      backend,
      threadId,
      expectedBranch,
      observedBranch,
    }: {
      backend: "codex" | "grok";
      threadId: string;
      expectedBranch: string;
      observedBranch: string;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        retainedBranchDriftPairs: [
          ...(current.retainedBranchDriftPairs ?? []),
          {
            expectedBranch,
            observedBranch,
            retainedAt: Date.now(),
          },
        ],
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    getLaunchpadDefaults: async () => launchpadDefaults,
    setLaunchpadDefaults: async (patch: Partial<NavigationLaunchpadDefaults>) => {
      launchpadDefaults = {
        ...launchpadDefaults,
        ...patch,
      };
      return launchpadDefaults;
    },
    getDirectoryLaunchpad: async ({ directoryKey }: { directoryKey: string }) =>
      launchpads.get(directoryKey),
    upsertDirectoryLaunchpad: async (launchpad: NavigationLaunchpadDraft) => {
      const nextLaunchpad = {
        ...launchpads.get(launchpad.directoryKey),
        ...launchpad,
      };
      launchpads.set(launchpad.directoryKey, nextLaunchpad);
      return nextLaunchpad;
    },
    resetDirectoryLaunchpad: async ({ directoryKey }: { directoryKey: string }) => {
      launchpads.delete(directoryKey);
    },
    replaceWorkspaceLinkedDirectory: async ({
      backend,
      threadId,
      directory,
      gitBranch,
    }: {
      backend: "codex" | "grok";
      threadId: string;
      directory: ThreadOverlayState["extraLinkedDirectories"][number];
      gitBranch?: string;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        gitBranch: gitBranch ?? current.gitBranch,
        observedGitBranch: gitBranch ?? current.observedGitBranch,
        extraLinkedDirectories: [directory],
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    addLinkedDirectory: async ({
      backend,
      threadId,
      directory,
    }: {
      backend: "codex" | "grok";
      threadId: string;
      directory: ThreadOverlayState["extraLinkedDirectories"][number];
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        extraLinkedDirectories: [
          ...current.extraLinkedDirectories.filter(
            (candidate) => candidate.id !== directory.id,
          ),
          directory,
        ],
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    upsertWorktreeSnapshot: async ({
      backend,
      threadId,
      snapshot,
    }: {
      backend: "codex" | "grok";
      threadId: string;
      snapshot: WorktreeSnapshotSummary;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        worktreeSnapshots: [
          ...(current.worktreeSnapshots ?? []).filter(
            (candidate) => candidate.id !== snapshot.id
          ),
          snapshot,
        ],
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    appendPermissionTransition: async ({
      backend,
      threadId,
      transition,
    }: {
      backend: "codex" | "grok";
      threadId: string;
      transition: import("@pwragent/shared").ThreadPermissionTransition;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      const nextLog = [
        ...(current.permissionTransitionLog ?? []),
        transition,
      ];
      const trimmed =
        nextLog.length > 100 ? nextLog.slice(nextLog.length - 100) : nextLog;
      const next = {
        ...current,
        permissionTransitionLog: trimmed,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    appendMessagingBindingTransition: async ({
      backend,
      threadId,
      transition,
    }: {
      backend: "codex" | "grok";
      threadId: string;
      transition: import("@pwragent/shared").ThreadMessagingBindingTransition;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      const nextLog = [
        ...(current.messagingBindingTransitionLog ?? []),
        transition,
      ];
      const trimmed =
        nextLog.length > 100 ? nextLog.slice(nextLog.length - 100) : nextLog;
      const next = {
        ...current,
        messagingBindingTransitionLog: trimmed,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
  } as unknown as InstanceType<typeof import("@pwragent/agent-core").OverlayStore>;
}

class MockBackendClient {
  private readonly listeners = new Set<
    (notification: AppServerNotification) => void | Promise<void>
  >();
  private readonly requestListeners = new Set<
    (request: AppServerPendingRequestNotification) => Promise<unknown> | unknown
  >();
  lastReadThreadParams?: {
    threadId: string;
    before?: string;
    limit?: number;
  };
  lastStartThreadParams?: {
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  };
  lastStartTurnParams?: {
    backend?: "codex" | "grok";
    threadId: string;
    input: AppServerTurnInputItem[];
    executionMode?: "default" | "full-access";
    approvalPolicy?: string;
    sandbox?: string;
    model?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  };
  lastSteerTurnParams?: {
    threadId: string;
    input: AppServerTurnInputItem[];
    expectedTurnId: string;
  };
  lastStartReviewParams?: {
    threadId: string;
    target: AppServerReviewTarget;
    delivery?: "inline" | "detached";
  };
  lastCompactThreadParams?: {
    threadId: string;
  };
  lastArchiveThreadParams?: {
    threadId: string;
  };
  lastRestoreThreadParams?: {
    threadId: string;
  };
  lastRenameThreadParams?: {
    threadId: string;
    name: string;
  };
  lastUpdateThreadMetadataParams?: {
    threadId: string;
    gitInfo?: {
      branch?: string | null;
      originUrl?: string | null;
      sha?: string | null;
    } | null;
  };
  lastSetThreadPermissionsParams?: {
    threadId: string;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  };
  listThreadsCallCount = 0;
  listModelsCallCount = 0;
  steerTurnCallCount = 0;
  setThreadPermissionsCallCount = 0;
  lastListModelsDiagnostics?: {
    callerReason?: string;
    ownerId?: string;
  };
  lastListThreadsDiagnostics?: {
    callerReason?: string;
    ownerId?: string;
  };
  lastListThreadsParams?: {
    archived?: boolean;
    enrichDirectories?: boolean;
    filter?: string;
  };

  constructor(
    private readonly options: {
      initializeResult?: {
        serverInfo?: {
          name?: string;
          version?: string;
        };
        methods?: string[];
      };
      initializeError?: Error;
      threads?: AppServerThreadSummary[];
      replay?: AppServerThreadReplay;
      skills?: Array<{ cwd?: string; skills: AppServerSkillSummary[] }>;
      models?: Array<{
        id: string;
        label?: string;
        current?: boolean;
        supportsReasoning?: boolean;
        supportsFast?: boolean;
      }>;
      modelListErrors?: Error[];
      account?: BackendAccountSummary;
      rateLimits?: BackendRateLimitSummary[];
      listThreadsError?: Error;
      archivedThreads?: AppServerThreadSummary[];
      startTurnError?: Error;
      steerTurnError?: Error;
      setThreadPermissionsError?: Error;
      setThreadPermissionsDelay?: Promise<unknown>;
    }
  ) {}

  async close(): Promise<void> {
    return;
  }

  async getInitializeResult() {
    if (this.options.initializeError) {
      throw this.options.initializeError;
    }

    return this.options.initializeResult ?? {};
  }

  async listThreads(params?: {
    archived?: boolean;
    enrichDirectories?: boolean;
    filter?: string;
  }, diagnostics?: { callerReason?: string; ownerId?: string }): Promise<AppServerThreadSummary[]> {
    this.listThreadsCallCount += 1;
    this.lastListThreadsDiagnostics = diagnostics;
    this.lastListThreadsParams = params;
    if (this.options.listThreadsError) {
      throw this.options.listThreadsError;
    }
    if (params?.archived === true && this.options.archivedThreads) {
      return this.options.archivedThreads;
    }
    return this.options.threads ?? [];
  }

  setThreads(threads: AppServerThreadSummary[]): void {
    this.options.threads = threads;
  }

  async archiveThread(params: { threadId: string }): Promise<{ threadId: string }> {
    this.lastArchiveThreadParams = params;
    return { threadId: params.threadId };
  }

  async restoreThread(params: { threadId: string }): Promise<{ threadId: string }> {
    this.lastRestoreThreadParams = params;
    return { threadId: params.threadId };
  }

  async renameThread(params: { threadId: string; name: string }): Promise<{ threadId: string }> {
    this.lastRenameThreadParams = params;
    return { threadId: params.threadId };
  }

  async updateThreadMetadata(params: {
    threadId: string;
    gitInfo?: {
      branch?: string | null;
      originUrl?: string | null;
      sha?: string | null;
    } | null;
  }): Promise<{ threadId: string }> {
    this.lastUpdateThreadMetadataParams = params;
    return { threadId: params.threadId };
  }

  async listSkills(): Promise<Array<{ cwd?: string; skills: AppServerSkillSummary[] }>> {
    return this.options.skills ?? [];
  }

  async listModels(diagnostics?: { callerReason?: string; ownerId?: string }) {
    this.listModelsCallCount += 1;
    this.lastListModelsDiagnostics = diagnostics;
    const error = this.options.modelListErrors?.shift();
    if (error) {
      throw error;
    }
    return this.options.models ?? [];
  }

  async readAccount(): Promise<BackendAccountSummary> {
    return this.options.account ?? {};
  }

  async readRateLimits(): Promise<BackendRateLimitSummary[]> {
    return this.options.rateLimits ?? [];
  }

  onNotification(
    listener: (notification: AppServerNotification) => void | Promise<void>
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onRequest(
    listener: (request: AppServerPendingRequestNotification) => Promise<unknown> | unknown
  ): () => void {
    this.requestListeners.add(listener);
    return () => {
      this.requestListeners.delete(listener);
    };
  }

  async readThread(_params?: {
    threadId: string;
    before?: string;
    limit?: number;
  }): Promise<AppServerThreadReplay> {
    this.lastReadThreadParams = _params;
    return this.options.replay ?? {
      entries: [],
      messages: [],
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
    };
  }

  async startThread(params?: {
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ threadId: string }> {
    this.lastStartThreadParams = params;
    return { threadId: "thread-1" };
  }

  async startTurn(params: {
    backend?: "codex" | "grok";
    threadId: string;
    input: AppServerTurnInputItem[];
    executionMode?: "default" | "full-access";
    cwd?: string;
    approvalPolicy?: string;
    sandbox?: string;
    model?: string;
    collaborationMode?: unknown;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ threadId: string; turnId: string }> {
    if (this.options.startTurnError) {
      throw this.options.startTurnError;
    }
    this.lastStartTurnParams = params;
    return { threadId: params.threadId, turnId: "turn-1" };
  }

  async startReview(params: {
    threadId: string;
    target: AppServerReviewTarget;
    delivery?: "inline" | "detached";
  }): Promise<{ threadId: string; reviewThreadId: string; turnId: string }> {
    this.lastStartReviewParams = params;
    return {
      threadId: params.threadId,
      reviewThreadId: params.threadId,
      turnId: "turn-review-1",
    };
  }

  async setThreadPermissions(params: {
    threadId: string;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
  }): Promise<{ threadId: string }> {
    this.lastSetThreadPermissionsParams = params;
    this.setThreadPermissionsCallCount += 1;
    await this.options.setThreadPermissionsDelay;
    if (this.options.setThreadPermissionsError) {
      throw this.options.setThreadPermissionsError;
    }

    return {
      threadId: params.threadId,
    };
  }

  async interruptTurn(): Promise<{ threadId: string; turnId: string }> {
    return { threadId: "thread-1", turnId: "turn-1" };
  }

  async steerTurn(params: {
    threadId: string;
    input: AppServerTurnInputItem[];
    expectedTurnId: string;
  }): Promise<{ threadId: string; turnId: string }> {
    this.steerTurnCallCount += 1;
    this.lastSteerTurnParams = params;
    if (this.options.steerTurnError) {
      throw this.options.steerTurnError;
    }

    return { threadId: params.threadId, turnId: params.expectedTurnId };
  }

  async compactThread(params: {
    threadId: string;
  }): Promise<{ threadId: string; turnId: string; itemId: string }> {
    this.lastCompactThreadParams = params;
    return {
      threadId: params.threadId,
      turnId: "compact-turn-1",
      itemId: "compact-item-1",
    };
  }

  async emit(notification: AppServerNotification): Promise<void> {
    for (const listener of this.listeners) {
      await listener(notification);
    }
  }

  async emitRequest(request: AppServerPendingRequestNotification): Promise<unknown> {
    const listener = this.requestListeners.values().next().value;
    if (!listener) {
      throw new Error("No request listener registered");
    }
    return await listener(request);
  }
}

function createMessagingArchiveCleanupStoreMock(options?: {
  bindings?: Array<{
    backend?: "codex" | "grok";
    channel?: "telegram" | "discord";
    id: string;
    threadId: string;
  }>;
  pendingIntentIds?: string[];
}) {
  const revokedBindingIds: string[] = [];
  const deletedPendingThreads: Array<{ backend: "codex" | "grok"; threadId: string }> = [];
  const bindings = new Map<string, MessagingBindingRecord>(
    (options?.bindings ?? []).map((binding) => [
      binding.id,
      {
        id: binding.id,
        backend: binding.backend ?? "codex",
        threadId: binding.threadId,
        channel: {
          channel: binding.channel ?? "telegram",
          conversation: {
            kind: "dm",
            id: `${binding.id}:conversation`,
            title: `${binding.id} conversation`,
          },
        },
        authorizedActorIds: [`${binding.id}:actor`],
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
  );

  return {
    revokedBindingIds,
    deletedPendingThreads,
    async findActiveBindingsForThread(params: {
      backend: "codex" | "grok";
      threadId: string;
    }) {
      return [...bindings.values()].filter(
        (binding) =>
          !binding.revokedAt &&
          binding.threadId === params.threadId &&
          (!binding.backend || binding.backend === params.backend),
      );
    },
    async findActiveBindingsForBackend(params: {
      backend: "codex" | "grok";
    }) {
      return [...bindings.values()].filter(
        (binding) =>
          !binding.revokedAt &&
          (!binding.backend || binding.backend === params.backend),
      );
    },
    async revokeBinding(params: { bindingId: string; revokedAt?: number }) {
      const binding = bindings.get(params.bindingId);
      if (!binding) return undefined;
      const revokedAt = params.revokedAt ?? Date.now();
      const revoked = {
        ...binding,
        revokedAt,
        updatedAt: revokedAt,
      };
      bindings.set(params.bindingId, revoked);
      revokedBindingIds.push(params.bindingId);
      return revoked;
    },
    async deletePendingIntentsForThread(params: {
      backend: "codex" | "grok";
      threadId: string;
    }) {
      deletedPendingThreads.push(params);
      return params.threadId === "thread-1" ? options?.pendingIntentIds ?? [] : [];
    },
  };
}

function createMessagingArchiveCleanerMock(
  result:
    | Promise<{ notifiedCount: number; revokedCount: number }>
    | { notifiedCount: number; revokedCount: number } = {
    notifiedCount: 1,
    revokedCount: 1,
  },
) {
  const requests: Array<{
    backend: "codex" | "grok";
    threadId: string;
    origin: "thread-archive";
  }> = [];

  return {
    requests,
    async requestBindingRevokeAllForThread(request: {
      backend: "codex" | "grok";
      threadId: string;
      origin: "thread-archive";
    }) {
      requests.push(request);
      return result;
    },
  };
}

describe("DesktopBackendRegistry", () => {
  it("reports backend availability and capabilities", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
      },
      account: {
        type: "chatgpt",
        email: "user@example.com",
        planType: "pro",
        requiresOpenaiAuth: false,
      },
      rateLimits: [
        {
          name: "5h limit",
          usedPercent: 15,
          remaining: 85,
          resetAt: new Date("2026-04-29T14:00:00-04:00").getTime(),
          windowSeconds: 18_000,
          windowMinutes: 300,
        },
        {
          name: "Weekly limit",
          usedPercent: 9,
          remaining: 91,
          resetAt: new Date("2026-05-01T14:00:00-04:00").getTime(),
          windowSeconds: 604_800,
          windowMinutes: 10_080,
        },
      ],
    });
    const overlayStore = createOverlayStoreMock();
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    const response = await registry.listBackends({ includeUnavailable: true });

    expect(codexClient.listModelsCallCount).toBe(1);

    expect(response.backends).toMatchObject([
      {
        kind: "codex",
        label: "OpenAI",
        available: true,
        account: {
          type: "chatgpt",
          email: "user@example.com",
          planType: "pro",
          requiresOpenaiAuth: false,
        },
        rateLimits: [
          {
            name: "5h limit",
            usedPercent: 15,
            remaining: 85,
          },
          {
            name: "Weekly limit",
            usedPercent: 9,
            remaining: 91,
          },
        ],
        serverName: "Codex App Server",
        serverVersion: "1.0.0",
        methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
        capabilities: {
          listThreads: true,
          createThread: true,
          resumeThread: false,
          renameThread: false,
          readThread: true,
          startTurn: true,
          interruptTurn: false,
          steerTurn: true,
          transcriptPagination: false,
          toolUse: false,
          approvalRequests: true,
          multiDirectoryThreads: true,
        },
        executionModes: [
          {
            mode: "default",
            label: "Default Access",
            available: true,
            isDefault: true,
          },
          {
            mode: "full-access",
            label: "Full Access",
            available: true,
          },
        ],
        launchpadOptions: {
          models: [
            {
              id: "gpt-5.5",
              label: "GPT-5.5",
              current: true,
              supportsReasoning: true,
              supportsFast: true,
            },
            {
              id: "gpt-5.4",
              label: "GPT-5.4",
              supportsReasoning: true,
              supportsFast: true,
            },
            {
              id: "gpt-5.4-mini",
              label: "GPT-5.4-Mini",
              supportsReasoning: true,
            },
            {
              id: "gpt-5.3-codex",
              label: "GPT-5.3-Codex",
              supportsReasoning: true,
            },
            {
              id: "gpt-5.2",
              label: "GPT-5.2",
              supportsReasoning: true,
            },
          ],
          reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
          supportsFastMode: true,
        },
      },
      {
        kind: "grok",
        label: "Grok",
        available: false,
        methods: [],
        capabilities: {
          listThreads: false,
          createThread: false,
          resumeThread: false,
          renameThread: false,
          readThread: false,
          startTurn: false,
          interruptTurn: false,
          steerTurn: false,
          transcriptPagination: false,
          toolUse: false,
          approvalRequests: true,
          multiDirectoryThreads: false,
        },
        executionModes: [
          {
            mode: "default",
            label: "Default Access",
            available: false,
            isDefault: true,
            unavailableReason: "grok app server unavailable: XAI_API_KEY is not set",
          },
        ],
        unavailableReason: "grok app server unavailable: XAI_API_KEY is not set",
      },
    ]);

    await registry.close();
  });

  it("reads Codex models once from the default client and reuses them", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
      models: [
        {
          id: "gpt-5.4",
          label: "GPT-5.4",
          supportsReasoning: true,
        },
      ],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      createScratchProjectDirectory: async () => "/tmp/pwragent-scratch",
    });

    const firstResponse = await registry.listBackends({ includeUnavailable: true });
    const secondResponse = await registry.listBackends({ includeUnavailable: true });
    await registry.startThread({ backend: "codex" });

    expect(codexClient.listModelsCallCount).toBe(1);
    expect(codexClient.lastListModelsDiagnostics).toMatchObject({
      callerReason: "backend-summary",
    });
    expect(codexClient.lastListModelsDiagnostics?.ownerId).toMatch(
      /^backend-model-catalog-/,
    );
    expect(firstResponse.backends[0]?.launchpadOptions?.models).toMatchObject([
      {
        id: "gpt-5.4",
        label: "GPT-5.4",
      },
    ]);
    expect(secondResponse.backends[0]?.launchpadOptions?.models).toMatchObject([
      {
        id: "gpt-5.4",
        label: "GPT-5.4",
      },
    ]);
    expect(codexClient.lastStartThreadParams?.model).toBe("gpt-5.4");

    await registry.close();
  });

  it("reads Grok models once from the default client and reuses them", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
    });
    const grokClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Grok App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
      models: [
        {
          id: "grok-custom-reasoning",
          label: "Grok Custom Reasoning",
          supportsReasoning: true,
        },
      ],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient,
      overlayStore: createOverlayStoreMock({
        launchpadDefaults: {
          backend: "grok",
          executionMode: "default",
          workMode: "local",
        },
      }),
      createScratchProjectDirectory: async () => "/tmp/pwragent-scratch",
    });

    const firstResponse = await registry.listBackends({ includeUnavailable: true });
    const secondResponse = await registry.listBackends({ includeUnavailable: true });
    await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      preferredBackend: "grok",
    });
    await registry.startThread({ backend: "grok" });

    expect(grokClient.listModelsCallCount).toBe(1);
    expect(grokClient.lastListModelsDiagnostics).toMatchObject({
      callerReason: "backend-summary",
    });
    expect(grokClient.lastListModelsDiagnostics?.ownerId).toMatch(
      /^backend-model-catalog-/,
    );
    expect(firstResponse.backends[1]?.launchpadOptions?.models).toMatchObject([
      {
        id: "grok-custom-reasoning",
        label: "Grok Custom Reasoning",
      },
    ]);
    expect(secondResponse.backends[1]?.launchpadOptions?.models).toMatchObject([
      {
        id: "grok-custom-reasoning",
        label: "Grok Custom Reasoning",
      },
    ]);
    expect(grokClient.lastStartThreadParams?.model).toBe("grok-custom-reasoning");

    await registry.close();
  });

  it("does not warm model lists during registry construction", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
    });
    const grokClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Grok App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
    });

    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient,
      overlayStore: createOverlayStoreMock(),
    });

    expect(codexClient.listModelsCallCount).toBe(0);
    expect(grokClient.listModelsCallCount).toBe(0);

    await registry.startThread({ backend: "grok" });

    expect(codexClient.listModelsCallCount).toBe(0);
    expect(grokClient.listModelsCallCount).toBe(1);
    expect(grokClient.lastListModelsDiagnostics).toMatchObject({
      callerReason: "thread-start-defaults",
    });

    await registry.close();
  });

  it("coalesces repeated Grok thread list requests in the startup refresh window", async () => {
    const grokClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Grok App Server", version: "1.0.0" },
        methods: ["thread/list"],
      },
      threads: [
        {
          id: "thread-grok",
          title: "Grok thread",
          titleSource: "explicit",
          source: "grok",
          linkedDirectories: [],
        },
      ],
    });
    const codexClient = new MockBackendClient({});
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient,
      overlayStore: createOverlayStoreMock(),
    });

    await registry.listThreads({
      callerReason: "navigation-snapshot",
    });
    await registry.listThreads({
      backend: "grok",
      callerReason: "branch-drift",
    });

    expect(codexClient.listThreadsCallCount).toBe(1);
    expect(codexClient.lastListThreadsParams).toMatchObject({
      enrichDirectories: false,
    });
    expect(grokClient.listThreadsCallCount).toBe(1);
    expect(grokClient.lastListThreadsDiagnostics).toMatchObject({
      callerReason: "navigation-snapshot",
    });
    expect(grokClient.lastListThreadsDiagnostics?.ownerId).toMatch(
      /^backend-thread-list-cache-/,
    );

    await registry.close();
  });

  it("keeps cheap navigation lists separate from directory-enriched thread lists", async () => {
    const codexClient = new MockBackendClient({
      threads: [
        {
          id: "thread-1",
          title: "Codex thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
        },
      ],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({}),
      overlayStore: createOverlayStoreMock(),
    });

    await registry.listThreads({
      backend: "codex",
      callerReason: "startup-prewarm",
    });
    expect(codexClient.lastListThreadsParams).toMatchObject({
      enrichDirectories: false,
    });

    await registry.listThreads({
      backend: "codex",
      callerReason: "workspace-handoff",
    });

    expect(codexClient.listThreadsCallCount).toBe(2);
    expect(codexClient.lastListThreadsParams).toMatchObject({
      enrichDirectories: true,
    });

    await registry.close();
  });

  it("backfills Codex worktree parent directories so directory view shows one project", async () => {
    const projectA = "/Users/huntharo/projects/ProjectA";
    const worktree1 = "/Users/huntharo/.codex/worktrees/wt1/ProjectA";
    const worktree2 = "/Users/huntharo/.codex/worktrees/wt2/ProjectA";
    const nestedWorktreeCwd = `${worktree2}/apps`;
    const cheapThreads: AppServerThreadSummary[] = [
      {
        id: "project-a-local",
        title: "ProjectA local",
        titleSource: "explicit",
        source: "codex",
        projectKey: projectA,
        createdAt: 3_000,
        updatedAt: 3_000,
        linkedDirectories: [
          {
            id: projectA,
            label: "ProjectA",
            path: projectA,
            kind: "local",
          },
        ],
      },
      {
        id: "project-a-worktree-1",
        title: "ProjectA worktree 1",
        titleSource: "explicit",
        source: "codex",
        projectKey: worktree1,
        createdAt: 2_000,
        updatedAt: 2_000,
        linkedDirectories: [
          {
            id: worktree1,
            label: "ProjectA",
            path: worktree1,
            kind: "local",
          },
        ],
      },
      {
        id: "project-a-worktree-2",
        title: "ProjectA worktree 2",
        titleSource: "explicit",
        source: "codex",
        projectKey: nestedWorktreeCwd,
        createdAt: 1_000,
        updatedAt: 1_000,
        linkedDirectories: [
          {
            id: nestedWorktreeCwd,
            label: "ProjectA",
            path: nestedWorktreeCwd,
            kind: "local",
          },
        ],
      },
    ];
    const enrichedByThreadId = new Map<string, AppServerThreadSummary>(
      cheapThreads.map((thread) => [
        thread.id,
        thread.projectKey === projectA
          ? thread
          : {
              ...thread,
              linkedDirectories: [
                {
                  id: projectA,
                  label: "ProjectA",
                  path: projectA,
                  worktreePath:
                    thread.id === "project-a-worktree-2"
                      ? worktree2
                      : thread.projectKey,
                  kind: "worktree" as const,
                },
              ],
            },
      ]),
    );
    const codexClient = new MockBackendClient({
      threads: cheapThreads,
    });
    const enrichmentStarted = createDeferred<void>();
    const enrichmentRelease = createDeferred<void>();
    const enrichThreadDirectories = vi.fn(
      async (threads: AppServerThreadSummary[]) => {
        enrichmentStarted.resolve();
        await enrichmentRelease.promise;
        return threads.map((thread) => enrichedByThreadId.get(thread.id) ?? thread);
      },
    );
    Object.assign(codexClient, { enrichThreadDirectories });
    const overlayStore = createOverlayStoreMock();
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({}),
      overlayStore,
    });

    let listResolved = false;
    const listPromise = registry.listThreads({
      backend: "codex",
      callerReason: "startup-prewarm",
    });
    void listPromise.then(() => {
      listResolved = true;
    });

    await enrichmentStarted.promise;
    await flushAsync();
    expect(listResolved).toBe(false);
    enrichmentRelease.resolve();
    await listPromise;

    const overlaysByThreadId = await overlayStore.getThreadOverlayStates({
      backend: "codex",
      threadIds: cheapThreads.map((thread) => thread.id),
    });
    const overlayByThreadKey = Object.fromEntries(
      Object.entries(overlaysByThreadId).map(([threadId, overlay]) => [
        `codex:${threadId}`,
        overlay,
      ]),
    );
    const snapshot = buildNavigationSnapshot({
      backend: "codex",
      fetchedAt: 4_000,
      firstSnapshot: false,
      overlayByThreadKey,
      previousKnownThreadKeys: [],
      threads: cheapThreads,
      unchanged: false,
    });

    expect(enrichThreadDirectories).toHaveBeenCalledTimes(1);
    expect(
      overlaysByThreadId["project-a-worktree-2"]?.extraLinkedDirectories[0],
    ).toMatchObject({
      id: nestedWorktreeCwd,
      path: projectA,
      worktreePath: worktree2,
      kind: "worktree",
    });
    expect(snapshot.directories).toEqual([
      expect.objectContaining({
        key: `directory:${projectA}`,
        label: "ProjectA",
        path: projectA,
        threadKeys: [
          "codex:project-a-local",
          "codex:project-a-worktree-1",
          "codex:project-a-worktree-2",
        ],
      }),
    ]);

    await registry.listThreads({
      backend: "codex",
      callerReason: "startup-prewarm",
      filter: "force-new-cache-key",
    });

    expect(enrichThreadDirectories).toHaveBeenCalledTimes(1);

    await registry.close();
  });

  it("uses cheap thread summaries for selected-thread branch drift checks", async () => {
    const codexClient = new MockBackendClient({
      threads: [
        {
          id: "thread-1",
          title: "Codex thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          projectKey: "/repo/app",
        },
      ],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({}),
      overlayStore: createOverlayStoreMock(),
    });

    await registry.listThreads({
      backend: "codex",
      callerReason: "branch-drift",
    });

    expect(codexClient.lastListThreadsParams).toMatchObject({
      enrichDirectories: false,
    });

    await registry.close();
  });

  it("invalidates cached backend thread lists after starting a thread", async () => {
    const grokClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Grok App Server", version: "1.0.0" },
        methods: ["thread/list", "thread/start"],
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      grokClient,
      overlayStore: createOverlayStoreMock(),
    });

    await registry.listThreads({ backend: "grok" });
    await registry.startThread({ backend: "grok" });
    await registry.listThreads({ backend: "grok" });

    expect(grokClient.listThreadsCallCount).toBe(2);

    await registry.close();
  });

  it("retries Codex model discovery after a transient model-list failure", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
      modelListErrors: [new Error("Codex is still starting")],
      models: [
        {
          id: "gpt-5.4",
          label: "GPT-5.4",
          supportsReasoning: true,
        },
      ],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      createScratchProjectDirectory: async () => "/tmp/pwragent-scratch",
    });

    const response = await registry.listBackends({ includeUnavailable: true });
    await registry.startThread({ backend: "codex" });

    expect(codexClient.listModelsCallCount).toBe(2);
    expect(response.backends[0]?.launchpadOptions?.models?.[0]).toMatchObject({
      id: "gpt-5.5",
      label: "GPT-5.5",
    });
    expect(codexClient.lastStartThreadParams?.model).toBe("gpt-5.4");

    await registry.close();
  });

  it("assumes Codex can create threads when initialize omits methods", async () => {
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: {
          serverInfo: { name: "Codex App Server", version: "0.120.0" },
        },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    const response = await registry.listBackends({ includeUnavailable: true });

    expect(response.backends[0]).toMatchObject({
      kind: "codex",
      available: true,
      methods: [],
      capabilities: {
        createThread: true,
        renameThread: true,
        startTurn: true,
      },
    });

    await registry.close();
  });

  it("remembers launchpad work mode for future directory drafts", async () => {
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
    });
    const updated = await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      patch: { workMode: "worktree" },
      stickySettingsChanged: true,
    });
    const next = await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-b",
      directoryKind: "directory",
      directoryLabel: "Repo B",
      directoryPath: "/repo-b",
    });

    expect(updated.defaults.workMode).toBe("worktree");
    expect(next.launchpad.workMode).toBe("worktree");

    await registry.close();
  });

  it("refreshes empty saved directory drafts from current launchpad work mode defaults", async () => {
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      currentBranch: "main",
    });
    await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-b",
      patch: { workMode: "worktree" },
      stickySettingsChanged: true,
    });

    const reopened = await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      currentBranch: "main",
    });

    expect(reopened.defaults.workMode).toBe("worktree");
    expect(reopened.launchpad.workMode).toBe("worktree");
    expect(reopened.launchpad.branchName).toBe("main");

    await registry.close();
  });

  it("keeps workspace launchpads in workspace mode even when directory drafts prefer worktrees", async () => {
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      patch: { workMode: "worktree" },
      stickySettingsChanged: true,
    });

    const workspace = await registry.ensureDirectoryLaunchpad({
      directoryKey: "workspace:/Users/test/.pwragent/projects",
      directoryKind: "workspace",
      directoryLabel: "Workspaces",
      directoryPath: "/Users/test/.pwragent/projects",
    });

    expect(workspace.defaults.workMode).toBe("worktree");
    expect(workspace.launchpad.directoryKind).toBe("workspace");
    expect(workspace.launchpad.directoryLabel).toBe("Workspaces");
    expect(workspace.launchpad.workMode).toBe("local");
    expect(workspace.launchpad.branchName).toBeUndefined();

    await registry.close();
  });

  it("persists directory launchpad identity when opening it", async () => {
    const overlayStore = createOverlayStoreMock();
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    const opened = await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
    });

    expect(opened.launchpad.prompt).toBe("");
    await expect(
      overlayStore.getDirectoryLaunchpad({ directoryKey: "directory:/repo-a" }),
    ).resolves.toMatchObject({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      prompt: "",
    });

    await registry.close();
  });

  it("marks picked project directories as registered launchpads", async () => {
    const overlayStore = createOverlayStoreMock();
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    const opened = await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      registeredAt: 12_345,
    });

    expect(opened.launchpad.registeredAt).toBe(12_345);
    await expect(
      overlayStore.getDirectoryLaunchpad({ directoryKey: "directory:/repo-a" }),
    ).resolves.toMatchObject({
      directoryKey: "directory:/repo-a",
      registeredAt: 12_345,
      prompt: "",
    });

    await registry.close();
  });

  it("keeps launchpad directory metadata when the first draft update arrives", async () => {
    const overlayStore = createOverlayStoreMock();
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      currentBranch: "main",
    });

    const updated = await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      patch: { prompt: "Fix the app" },
    });

    expect(updated.launchpad.directoryLabel).toBe("Repo A");
    expect(updated.launchpad.directoryPath).toBe("/repo-a");
    expect(updated.launchpad.branchName).toBe("main");

    await registry.close();
  });

  it("repairs stale non-empty launchpad directory metadata when reopened", async () => {
    const overlayStore = createOverlayStoreMock();
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      patch: { prompt: "Already drafted" },
    });

    const reopened = await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      currentBranch: "main",
    });

    expect(reopened.launchpad).toMatchObject({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      prompt: "Already drafted",
    });
    await expect(
      overlayStore.getDirectoryLaunchpad({ directoryKey: "directory:/repo-a" }),
    ).resolves.toMatchObject({
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
    });

    await registry.close();
  });

  it("does not rewrite sticky defaults when only pending prompt data is saved", async () => {
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock({
        launchpadDefaults: {
          backend: "codex",
          executionMode: "full-access",
          workMode: "local",
        },
      }),
    });

    const updated = await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      patch: {
        prompt: "Draft work",
        executionMode: "default",
      },
    });

    expect(updated.launchpad.executionMode).toBe("default");
    expect(updated.defaults.executionMode).toBe("full-access");

    await registry.close();
  });

  it("falls back to OpenAI launchpad state when sticky Grok defaults are unavailable", async () => {
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
        models: [
          {
            id: "gpt-5.4",
            label: "GPT-5.4",
            supportsReasoning: true,
          },
        ],
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock({
        launchpadDefaults: {
          backend: "grok",
          executionMode: "default",
          model: "grok-4.20-reasoning",
          reasoningEffort: "medium",
          workMode: "local",
        },
      }),
    });

    const launchpad = await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
    });

    expect(launchpad.defaults).toMatchObject({
      backend: "codex",
      executionMode: "default",
      model: "gpt-5.4",
      reasoningEffort: "medium",
    });
    expect(launchpad.launchpad).toMatchObject({
      backend: "codex",
      executionMode: "default",
      model: "gpt-5.4",
      reasoningEffort: "medium",
    });

    await registry.close();
  });

  it("creates a scratch workspace for Codex thread creation when cwd is omitted", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      createScratchProjectDirectory: async () => "/Users/test/.pwragent/projects/2026-04-16-a1b2c3",
    });

    const response = await registry.startThread({
      backend: "codex",
    });

    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
    });
    expect(codexClient.lastStartThreadParams).toEqual({
      cwd: "/Users/test/.pwragent/projects/2026-04-16-a1b2c3",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      serviceTier: undefined,
      fastMode: undefined,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });

    await registry.close();
  });

  it("keeps an idle newly started thread visible until the backend list includes it", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/start"] },
      threads: [],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    await registry.startThread({
      backend: "codex",
      cwd: "/repo-a",
    });

    await expect(registry.listThreads({ backend: "codex" })).resolves.toEqual([
      expect.objectContaining({
        id: "thread-1",
        title: "Untitled thread",
        titleSource: "fallback",
        projectKey: "/repo-a",
        linkedDirectories: [
          {
            id: "/repo-a",
            kind: "local",
            label: "repo-a",
            path: "/repo-a",
          },
        ],
      }),
    ]);

    await registry.close();
  });

  it("starts requested worktree threads as local when the cwd is not a git repository", async () => {
    const recordCodexWorktreeOwnerThread = vi.fn(async () => {});
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/start"] },
      threads: [],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      gitDirectoryService: {
        prepareLaunchpadWorkspace: vi.fn(async () => ({
          cwd: "/Users/test/.pwragent/projects",
          workMode: "local" as const,
        })),
        recordCodexWorktreeOwnerThread,
      } as never,
    });

    await registry.startThread({
      backend: "codex",
      cwd: "/Users/test/.pwragent/projects",
      workMode: "worktree",
      branchName: "main",
    });

    expect(codexClient.lastStartThreadParams?.cwd).toBe(
      "/Users/test/.pwragent/projects",
    );
    expect(recordCodexWorktreeOwnerThread).not.toHaveBeenCalled();
    await expect(registry.listThreads({ backend: "codex" })).resolves.toEqual([
      expect.objectContaining({
        id: "thread-1",
        projectKey: "/Users/test/.pwragent/projects",
        linkedDirectories: [
          {
            id: "/Users/test/.pwragent/projects",
            kind: "local",
            label: "projects",
            path: "/Users/test/.pwragent/projects",
          },
        ],
      }),
    ]);

    await registry.close();
  });

  it("materializes workspace launchpads into a scratch directory instead of the workspace root", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      createScratchProjectDirectory: async () => "/Users/test/.pwragent/projects/2026-05-02-a1b2c3",
    });

    await registry.materializeDirectoryLaunchpad({
      directoryKey: "workspace:/Users/test/.pwragent/projects",
      launchpad: {
        directoryKey: "workspace:/Users/test/.pwragent/projects",
        directoryKind: "workspace",
        directoryLabel: "Workspaces",
        directoryPath: "/Users/test/.pwragent/projects",
        backend: "codex",
        executionMode: "default",
        prompt: "",
        workMode: "local",
        model: "gpt-5.5",
        reasoningEffort: "high",
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    });

    expect(codexClient.lastStartThreadParams?.cwd).toBe(
      "/Users/test/.pwragent/projects/2026-05-02-a1b2c3",
    );

    await registry.close();
  });

  it("keeps selected Codex environments sticky after materializing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-launchpad-env-"));
    const environmentsDir = path.join(root, ".codex", "environments");
    await mkdir(environmentsDir, { recursive: true });
    await writeFile(
      path.join(environmentsDir, "environment.toml"),
      `
version = 1
name = "Repo Environment"
`,
      "utf8",
    );

    const overlayStore = createOverlayStoreMock();
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    try {
      await registry.materializeDirectoryLaunchpad({
        directoryKey: `directory:${root}`,
        launchpad: {
          directoryKey: `directory:${root}`,
          directoryKind: "directory",
          directoryLabel: "repo",
          directoryPath: root,
          backend: "codex",
          executionMode: "default",
          prompt: "hello",
          workMode: "local",
          model: "gpt-5.5",
          reasoningEffort: "high",
          codexEnvironmentId: "environment",
          codexEnvironmentExecutionTarget: "local",
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      });

      await expect(
        overlayStore.getDirectoryLaunchpad({ directoryKey: `directory:${root}` }),
      ).resolves.toMatchObject({
        prompt: "",
        codexEnvironmentId: "environment",
        codexEnvironmentExecutionTarget: "local",
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces Codex environment options on existing threads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-env-options-"));
    await mkdir(path.join(root, ".codex", "environments"), { recursive: true });
    await writeFile(
      path.join(root, ".codex", "environments", "environment.toml"),
      `
version = 1
name = "PwrAgnt"

[[actions]]
name = "Dev - Messaging"
command = "pnpm dev:messaging"
`,
      "utf8",
    );

    const overlayStore = createOverlayStoreMock();
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [
          {
            id: "thread-1",
            title: "Thread",
            titleSource: "explicit",
            source: "codex",
            updatedAt: 1,
            projectKey: root,
            linkedDirectories: [
              {
                id: root,
                kind: "local",
                label: "repo",
                path: root,
              },
            ],
          },
        ],
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    try {
      await expect(registry.listThreads({ backend: "codex" })).resolves.toEqual([
        expect.objectContaining({
          id: "thread-1",
          codexEnvironmentOptions: [
            expect.objectContaining({
              id: "environment",
              name: "PwrAgnt",
              actions: [
                expect.objectContaining({
                  id: "dev-messaging",
                  name: "Dev - Messaging",
                  command: "pnpm dev:messaging",
                }),
              ],
            }),
          ],
        }),
      ]);
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets existing Codex threads select a local environment for command actions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-env-select-"));
    await mkdir(path.join(root, ".codex", "environments"), { recursive: true });
    await writeFile(
      path.join(root, ".codex", "environments", "environment.toml"),
      `
version = 1
name = "PwrAgnt"

[setup]
script = "pnpm install"

[[actions]]
name = "Dev - Messaging"
command = "pnpm dev:messaging"
`,
      "utf8",
    );

    const overlayStore = createOverlayStoreMock();
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [
          {
            id: "thread-1",
            title: "Thread",
            titleSource: "explicit",
            source: "codex",
            updatedAt: 1,
            projectKey: root,
            linkedDirectories: [
              {
                id: root,
                kind: "local",
                label: "repo",
                path: root,
              },
            ],
          },
        ],
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    try {
      await expect(
        registry.setCodexThreadEnvironment({
          backend: "codex",
          threadId: "thread-1",
          environmentId: "environment",
        }),
      ).resolves.toMatchObject({
        backend: "codex",
        threadId: "thread-1",
        codexEnvironmentRuntime: {
          environmentId: "environment",
          environmentName: "PwrAgnt",
          executionTarget: "local",
          cwd: root,
          setupEnabled: false,
          setupCommand: "pnpm install",
          actions: [
            {
              id: "dev-messaging",
              name: "Dev - Messaging",
              command: "pnpm dev:messaging",
            },
          ],
        },
      });

      await expect(
        overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        }),
      ).resolves.toMatchObject({
        codexEnvironmentRuntime: {
          environmentName: "PwrAgnt",
          actions: [
            expect.objectContaining({
              name: "Dev - Messaging",
            }),
          ],
        },
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refreshes stale thread environment actions before running a command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-env-run-"));
    const outputPath = path.join(root, "action.txt");
    await mkdir(path.join(root, ".codex", "environments"), { recursive: true });
    await writeFile(
      path.join(root, ".codex", "environments", "environment.toml"),
      `
version = 1
name = "PwrAgnt"

[[actions]]
name = "Dev - Messaging"
command = '''printf action-ran > ${outputPath}'''
`,
      "utf8",
    );

    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgnt",
            executionTarget: "local",
            cwd: root,
            setupEnabled: false,
            actions: [],
          },
        },
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [],
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    try {
      await expect(
        registry.runCodexEnvironmentAction({
          backend: "codex",
          threadId: "thread-1",
          actionId: "dev-messaging",
        }),
      ).resolves.toMatchObject({
        codexEnvironmentRuntime: {
          actionName: "Dev - Messaging",
          actionStatus: "started",
        },
      });
      await expectEventually(async () => await readFile(outputPath, "utf8"), "action-ran");
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists failed existing-thread environment actions before rejecting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-env-fail-"));
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgnt",
            executionTarget: "local",
            cwd: path.join(root, "missing"),
            setupEnabled: false,
            actions: [
              {
                id: "dev-messaging",
                name: "Dev - Messaging",
                command: "pnpm dev",
              },
            ],
          },
        },
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [],
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    try {
      await expect(
        registry.runCodexEnvironmentAction({
          backend: "codex",
          threadId: "thread-1",
          actionId: "dev-messaging",
        }),
      ).rejects.toThrow();
      await expect(
        overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        }),
      ).resolves.toMatchObject({
        codexEnvironmentRuntime: {
          actionId: "dev-messaging",
          actionName: "Dev - Messaging",
          actionCommand: "pnpm dev",
          actionStatus: "failed",
        },
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures Codex environment setup output in the thread replay", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-launchpad-env-"));
    const environmentsDir = path.join(root, ".codex", "environments");
    await mkdir(environmentsDir, { recursive: true });
    await writeFile(
      path.join(environmentsDir, "environment.toml"),
      `
version = 1
name = "Repo Environment"

[setup]
script = "printf setup-output"
`,
      "utf8",
    );

    const overlayStore = createOverlayStoreMock();
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    try {
      await registry.materializeDirectoryLaunchpad({
        directoryKey: `directory:${root}`,
        launchpad: {
          directoryKey: `directory:${root}`,
          directoryKind: "directory",
          directoryLabel: "repo",
          directoryPath: root,
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          model: "gpt-5.5",
          reasoningEffort: "high",
          codexEnvironmentId: "environment",
          codexEnvironmentExecutionTarget: "local",
          codexEnvironmentSetupEnabled: true,
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      });

      const read = await registry.readThread({
        backend: "codex",
        threadId: "thread-1",
      });
      expect(read.replay.entries[0]).toMatchObject({
        type: "activity",
        summary: "Environment setup completed: Repo Environment",
        details: [
          {
            command: {
              output: "setup-output",
              exitCode: 0,
            },
          },
        ],
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("updates Codex git metadata when materializing a git-backed launchpad", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-launchpad-metadata-"));
    const repo = path.join(root, "app");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "-b", "feature/metadata"]);
    await git(repo, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "--allow-empty",
      "-m",
      "init",
    ]);

    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "thread/metadata/update"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    try {
      await registry.materializeDirectoryLaunchpad({
        directoryKey: `directory:${repo}`,
        launchpad: {
          directoryKey: `directory:${repo}`,
          directoryKind: "directory",
          directoryLabel: "app",
          directoryPath: repo,
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          model: "gpt-5.5",
          reasoningEffort: "high",
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      });

      expect(codexClient.lastUpdateThreadMetadataParams).toEqual({
        threadId: "thread-1",
        gitInfo: {
          branch: "feature/metadata",
        },
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records Codex owner metadata when materializing a worktree launchpad", async () => {
    const recordCodexWorktreeOwnerThread = vi.fn(async () => {});
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      gitDirectoryService: {
        prepareLaunchpadWorkspace: vi.fn(async () => ({
          cwd: "/repo/app/.worktrees/thread-1/app",
          workMode: "worktree" as const,
        })),
        recordCodexWorktreeOwnerThread,
      } as never,
    });

    const response = await registry.materializeDirectoryLaunchpad({
      directoryKey: "directory:/repo/app",
      launchpad: {
        directoryKey: "directory:/repo/app",
        directoryKind: "directory",
        directoryLabel: "app",
        directoryPath: "/repo/app",
        backend: "codex",
        executionMode: "default",
        prompt: "",
        workMode: "worktree",
        model: "gpt-5.5",
        reasoningEffort: "high",
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    });

    expect(recordCodexWorktreeOwnerThread).toHaveBeenCalledWith({
      worktreePath: "/repo/app/.worktrees/thread-1/app",
      threadId: "thread-1",
    });
    expect(response.linkedDirectory).toEqual({
      id: "/repo/app",
      kind: "worktree",
      label: "app",
      path: "/repo/app",
      worktreePath: "/repo/app/.worktrees/thread-1/app",
    });

    await registry.close();
  });

  it("keeps failed environment setup worktree threads registered without starting the turn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-failure-"));
    const repoPath = path.join(root, "repo");
    const worktreePath = path.join(root, "worktree");
    await mkdir(path.join(repoPath, ".codex", "environments"), { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await writeFile(
      path.join(repoPath, ".codex", "environments", "environment.toml"),
      `
version = 1
name = "Broken Env"

[setup]
script = "printf setup-failed && exit 42"
`,
      "utf8",
    );

    const recordCodexWorktreeOwnerThread = vi.fn(async () => {});
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      gitDirectoryService: {
        prepareLaunchpadWorkspace: vi.fn(async () => ({
          cwd: worktreePath,
          workMode: "worktree" as const,
        })),
        recordCodexWorktreeOwnerThread,
      } as never,
    });

    try {
      const response = await registry.materializeDirectoryLaunchpad({
        directoryKey: `directory:${repoPath}`,
        input: [{ type: "text", text: "start after setup" }],
        launchpad: {
          directoryKey: `directory:${repoPath}`,
          directoryKind: "directory",
          directoryLabel: "repo",
          directoryPath: repoPath,
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "worktree",
          model: "gpt-5.5",
          reasoningEffort: "high",
          codexEnvironmentId: "environment",
          codexEnvironmentSetupEnabled: true,
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      });

      expect(response.threadId).toBe("thread-1");
      expect(response.turnId).toBeUndefined();
      expect(response.codexEnvironmentStartupFailure).toEqual({
        message: "Codex environment command exited with 42",
        phase: "setup",
        worktreeCleanupAvailable: true,
      });
      expect(response.codexEnvironmentRuntime).toMatchObject({
        environmentName: "Broken Env",
        setupStatus: "failed",
        setupExitCode: 42,
        setupOutput: "setup-failed",
      });
      expect(recordCodexWorktreeOwnerThread).toHaveBeenCalledWith({
        worktreePath,
        threadId: "thread-1",
      });
      expect(codexClient.lastStartTurnParams).toBeUndefined();
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores legacy launchpad environment actions until the thread exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-action-failure-"));
    const repoPath = path.join(root, "repo");
    const worktreePath = path.join(root, "missing-worktree");
    await mkdir(path.join(repoPath, ".codex", "environments"), { recursive: true });
    await writeFile(
      path.join(repoPath, ".codex", "environments", "environment.toml"),
      `
version = 1
name = "Broken Action Env"

[[actions]]
name = "Start dev"
command = "pnpm dev"
`,
      "utf8",
    );

    const recordCodexWorktreeOwnerThread = vi.fn(async () => {});
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      gitDirectoryService: {
        prepareLaunchpadWorkspace: vi.fn(async () => ({
          cwd: worktreePath,
          workMode: "worktree" as const,
        })),
        recordCodexWorktreeOwnerThread,
      } as never,
    });

    try {
      const response = await registry.materializeDirectoryLaunchpad({
        directoryKey: `directory:${repoPath}`,
        input: [{ type: "text", text: "start after setup" }],
        launchpad: {
          directoryKey: `directory:${repoPath}`,
          directoryKind: "directory",
          directoryLabel: "repo",
          directoryPath: repoPath,
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "worktree",
          model: "gpt-5.5",
          reasoningEffort: "high",
          codexEnvironmentId: "environment",
          codexEnvironmentActionId: "start-dev",
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      });

      expect(response.threadId).toBe("thread-1");
      expect(response.turnId).toBe("turn-1");
      expect(response.codexEnvironmentStartupFailure).toBeUndefined();
      expect(response.codexEnvironmentRuntime).toMatchObject({
        environmentName: "Broken Action Env",
      });
      expect(response.codexEnvironmentRuntime?.actionId).toBeUndefined();
      expect(response.codexEnvironmentRuntime?.actionStatus).toBeUndefined();
      expect(recordCodexWorktreeOwnerThread).toHaveBeenCalledWith({
        worktreePath,
        threadId: "thread-1",
      });
      expect(codexClient.lastStartTurnParams).toMatchObject({
        threadId: "thread-1",
        input: [{ type: "text", text: "start after setup" }],
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps materialized worktree threads linked as worktrees before the backend list catches up", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/start"] },
      threads: [],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      gitDirectoryService: {
        prepareLaunchpadWorkspace: vi.fn(async () => ({
          cwd: "/repo/app/.worktrees/thread-1/app",
          workMode: "worktree" as const,
        })),
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
      } as never,
    });

    await registry.materializeDirectoryLaunchpad({
      directoryKey: "directory:/repo/app",
      launchpad: {
        directoryKey: "directory:/repo/app",
        directoryKind: "directory",
        directoryLabel: "app",
        directoryPath: "/repo/app",
        backend: "codex",
        executionMode: "default",
        prompt: "",
        workMode: "worktree",
        model: "gpt-5.5",
        reasoningEffort: "high",
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    });

    await expect(registry.listThreads({ backend: "codex" })).resolves.toEqual([
      expect.objectContaining({
        id: "thread-1",
        projectKey: "/repo/app/.worktrees/thread-1/app",
        linkedDirectories: [
          {
            id: "/repo/app",
            kind: "worktree",
            label: "app",
            path: "/repo/app",
            worktreePath: "/repo/app/.worktrees/thread-1/app",
          },
        ],
      }),
    ]);

    await registry.close();
  });

  it("materializes Grok workspace launchpads into a scratch directory", async () => {
    const grokClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient,
      overlayStore: createOverlayStoreMock(),
      createScratchProjectDirectory: async () => "/Users/test/.pwragent/projects/2026-05-02-d4e5f6",
    });

    await registry.materializeDirectoryLaunchpad({
      directoryKey: "workspace:/Users/test/.pwragent/projects",
      launchpad: {
        directoryKey: "workspace:/Users/test/.pwragent/projects",
        directoryKind: "workspace",
        directoryLabel: "Workspaces",
        directoryPath: "/Users/test/.pwragent/projects",
        backend: "grok",
        executionMode: "default",
        prompt: "",
        workMode: "local",
        model: "grok-4.20-reasoning",
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    });

    expect(grokClient.lastStartThreadParams?.cwd).toBe(
      "/Users/test/.pwragent/projects/2026-05-02-d4e5f6",
    );

    await registry.close();
  });

  it("applies model settings from the selected thread overlay when starting turns", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-modelled": {
            backend: "codex",
            threadId: "thread-modelled",
            executionMode: "default",
            model: "gpt-5.5",
            reasoningEffort: "high",
            serviceTier: "priority",
            fastMode: true,
            extraLinkedDirectories: [],
          },
          "codex:thread-other": {
            backend: "codex",
            threadId: "thread-other",
            executionMode: "default",
            model: "gpt-5.5-pro",
            reasoningEffort: "low",
            serviceTier: "standard",
            fastMode: false,
            extraLinkedDirectories: [],
          },
        },
      }),
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-modelled",
      input: [{ type: "text", text: "Use this thread's model settings" }],
    });

    expect(codexClient.lastStartTurnParams).toEqual({
      threadId: "thread-modelled",
      input: [{ type: "text", text: "Use this thread's model settings" }],
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      model: "gpt-5.5",
      serviceTier: "priority",
      reasoningEffort: "high",
      fastMode: true,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-plain",
      input: [{ type: "text", text: "Do not inherit another thread's settings" }],
    });

    expect(codexClient.lastStartTurnParams).toEqual({
      threadId: "thread-plain",
      input: [{ type: "text", text: "Do not inherit another thread's settings" }],
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      model: "gpt-5.5",
      serviceTier: undefined,
      reasoningEffort: "medium",
      fastMode: undefined,
    });

    await registry.close();
  });

  it("resumes Codex turns in the current handoff worktree cwd", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-1": {
            backend: "codex",
            threadId: "thread-1",
            executionMode: "default",
            extraLinkedDirectories: [
              {
                id: "pwragent-handoff:codex:thread-1",
                label: "app",
                path: "/repo/app",
                worktreePath: "/repo/app/.worktrees/thread-1/app",
                kind: "worktree",
              },
            ],
          },
        },
      }),
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "What is the CWD?" }],
    });

    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "thread-1",
      cwd: "/repo/app/.worktrees/thread-1/app",
    });

    await registry.close();
  });

  it("applies requested full-access execution settings on the single Codex client when starting turns", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const overlayStore = createOverlayStoreMock({
      executionMode: "default",
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "full-access",
      input: [{ type: "text", text: "Run npm view dive" }],
    });

    expect(codexClient.lastStartTurnParams).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: "Run npm view dive" }],
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model: "gpt-5.5",
      serviceTier: undefined,
      reasoningEffort: "medium",
      fastMode: undefined,
    });
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      executionMode: "full-access",
    });

    await registry.close();
  });

  it("applies generated Codex thread titles after starting turns", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Leopard tea button",
      })),
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      threads: [
        {
          id: "thread-title",
          title: "Make button",
          titleSource: "derived",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok unavailable"),
      }),
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: titleService,
    });

    await expect(
      registry.startTurn({
        backend: "codex",
        threadId: "thread-title",
        input: [{ type: "text", text: "Make button" }],
      })
    ).resolves.toEqual({
      backend: "codex",
      threadId: "thread-title",
      turnId: "turn-1",
    });

    expect(codexClient.lastRenameThreadParams).toBeUndefined();
    await waitForCondition(() => codexClient.lastRenameThreadParams !== undefined);

    expect(titleService.generateTitle).toHaveBeenCalledWith({
      backend: "codex",
      userPrompt: "Make button",
    });
    expect(codexClient.lastRenameThreadParams).toEqual({
      threadId: "thread-title",
      name: "Leopard tea button",
    });

    await registry.close();
  });

  it("steers Codex turns through the single client and surfaces its error", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "turn/steer"] },
      steerTurnError: new Error(
        "json-rpc error (-32600): expected active turn id `turn-0` but found `turn-1`",
      ),
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok unavailable"),
      }),
      overlayStore: createOverlayStoreMock({ executionMode: "full-access" }),
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "Start active work" }],
    });

    await expect(
      registry.steerTurn({
        backend: "codex",
        threadId: "thread-1",
        expectedTurnId: "turn-0",
        input: [{ type: "text", text: "Course correct" }],
      }),
    ).rejects.toThrow("expected active turn id `turn-0` but found `turn-1`");

    expect(codexClient.steerTurnCallCount).toBe(1);

    await registry.close();
  });

  it("does not retry Codex title generation for a thread after one generated attempt", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Leopard tea button",
      })),
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      threads: [
        {
          id: "thread-title",
          title: "Make button",
          titleSource: "derived",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok unavailable"),
      }),
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: titleService,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-title",
      input: [{ type: "text", text: "Make button" }],
    });
    await waitForCondition(() => titleService.generateTitle.mock.calls.length === 1);

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-title",
      input: [{ type: "text", text: "Make button" }],
    });
    await flushAsync();
    await flushAsync();

    expect(titleService.generateTitle).toHaveBeenCalledTimes(1);

    await registry.close();
  });

  it("applies generated titles when Codex exposes the prompt as an explicit title", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Jaguar tea button",
      })),
    };
    const prompt =
      "Let's make a button with an animated jaguar sipping tea. Just for grins.";
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      threads: [
        {
          id: "thread-title",
          title: prompt,
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok unavailable"),
      }),
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: titleService,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-title",
      input: [{ type: "text", text: prompt }],
    });
    await waitForCondition(() => codexClient.lastRenameThreadParams !== undefined);

    expect(titleService.generateTitle).toHaveBeenCalledWith({
      backend: "codex",
      userPrompt: prompt,
    });
    expect(codexClient.lastRenameThreadParams).toEqual({
      threadId: "thread-title",
      name: "Jaguar tea button",
    });

    await registry.close();
  });

  it("applies generated titles when Codex derives the current title from injected AGENTS context", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Jaguar tea button",
      })),
    };
    const prompt =
      "Let's make a button with an animated jaguar sipping tea. Just for grins.";
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      threads: [
        {
          id: "thread-title",
          title:
            "# AGENTS.md instructions for /Users/huntharo/github/PwrAgent/.worktrees/launchpad-pwragent-main-moj56ty6",
          titleSource: "derived",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok unavailable"),
      }),
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: titleService,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-title",
      input: [{ type: "text", text: prompt }],
    });
    await waitForCondition(() => codexClient.lastRenameThreadParams !== undefined);

    expect(titleService.generateTitle).toHaveBeenCalledWith({
      backend: "codex",
      userPrompt: prompt,
    });
    expect(codexClient.lastRenameThreadParams).toEqual({
      threadId: "thread-title",
      name: "Jaguar tea button",
    });

    await registry.close();
  });

  it("applies generated Grok thread titles after starting turns", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Issue 123 rename",
      })),
    };
    const grokClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      threads: [
        {
          id: "thread-title",
          title: "Issue 123 rename",
          titleSource: "derived",
          linkedDirectories: [],
          source: "grok",
        },
      ],
    });
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeError: new Error("codex unavailable"),
      }),
      grokClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: titleService,
    });

    await registry.startTurn({
      backend: "grok",
      threadId: "thread-title",
      input: [{ type: "text", text: "Issue 123 rename" }],
    });
    await waitForCondition(() => grokClient.lastRenameThreadParams !== undefined);

    expect(titleService.generateTitle).toHaveBeenCalledWith({
      backend: "grok",
      userPrompt: "Issue 123 rename",
    });
    expect(grokClient.lastRenameThreadParams).toEqual({
      threadId: "thread-title",
      name: "Issue 123 rename",
    });

    await registry.close();
  });

  it("skips generated titles when the thread already has an explicit name", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Generated title",
      })),
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      threads: [
        {
          id: "thread-title",
          title: "User title",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok unavailable"),
      }),
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: titleService,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-title",
      input: [{ type: "text", text: "Make button" }],
    });
    await flushAsync();
    await flushAsync();

    expect(titleService.generateTitle).not.toHaveBeenCalled();
    expect(codexClient.lastRenameThreadParams).toBeUndefined();

    await registry.close();
  });

  it("does not schedule generated titles for image-only turns", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Generated title",
      })),
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok unavailable"),
      }),
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: titleService,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-title",
      input: [{ type: "image", url: "file:///tmp/image.png" }],
    });
    await flushAsync();

    expect(titleService.generateTitle).not.toHaveBeenCalled();

    await registry.close();
  });

  it("routes review start to the selected backend client", async () => {
    const grokClient = new MockBackendClient({
      initializeResult: { methods: ["review/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeError: new Error("codex unavailable"),
      }),
      grokClient,
      overlayStore: createOverlayStoreMock(),
    });

    const response = await registry.startReview({
      backend: "grok",
      threadId: "thread-1",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });

    expect(response).toEqual({
      backend: "grok",
      threadId: "thread-1",
      reviewThreadId: "thread-1",
      turnId: "turn-review-1",
    });
    expect(grokClient.lastStartReviewParams).toEqual({
      threadId: "thread-1",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });

    await registry.close();
  });

  it("rejects Codex review start while the thread has an active turn", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "review/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "Keep working" }],
    });

    await expect(
      registry.startReview({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
      }),
    ).rejects.toThrow("Thread already has an active turn in progress: thread-1");
    expect(codexClient.lastStartReviewParams).toBeUndefined();

    await registry.close();
  });

  it("normalizes backend notifications with backend identity", async () => {
    const grokClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
      }),
      grokClient,
      overlayStore: createOverlayStoreMock(),
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });

    await grokClient.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          output: [{ type: "text", text: "Done." }],
        },
      },
    });

    expect(events).toEqual([
      {
        backend: "grok",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              output: [{ type: "text", text: "Done." }],
            },
          },
        },
      },
    ]);

    unsubscribe();
    await registry.close();
  });

  it("emits local turn lifecycle events for registry-started Codex turns", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/read"] },
      replay: {
        entries: [
          {
            type: "message",
            id: "assistant-1",
            role: "assistant",
            text: "Done from replay.",
            turn: {
              id: "turn-1",
              status: "completed",
            },
          },
        ],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "Desktop-originated turn" }],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-1",
        },
      },
    });

    await waitForCondition(() => events.length === 2);
    expect(events).toEqual([
      expect.objectContaining({
        backend: "codex",
        notification: expect.objectContaining({
          method: "turn/started",
          params: expect.objectContaining({
            threadId: "thread-1",
          }),
        }),
      }),
      {
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: expect.objectContaining({
              id: "turn-1",
              status: "completed",
              output: [{ type: "text", text: "Done from replay." }],
            }),
          },
        },
      },
    ]);

    unsubscribe();
    await registry.close();
  });

  it("does not synthesize completion from in-progress replay text", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/read"] },
      replay: {
        entries: [
          {
            type: "message",
            id: "assistant-1",
            role: "assistant",
            text: "Partial replay text.",
            turn: {
              id: "turn-1",
              status: "in_progress",
            },
          },
        ],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "Desktop-originated turn" }],
    });
    await waitForCondition(() => codexClient.lastReadThreadParams !== undefined);
    await flushAsync();

    expect(events).toEqual([
      expect.objectContaining({
        backend: "codex",
        notification: expect.objectContaining({
          method: "turn/started",
          params: expect.objectContaining({
            threadId: "thread-1",
          }),
        }),
      }),
    ]);

    unsubscribe();
    await registry.close();
  });

  it("emits server request resolution when a pending request is submitted externally", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });

    const request: AppServerPendingRequestNotification = {
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "call-1",
        requestId: "approval-1",
        command: "npm view dive",
      },
    } as AppServerPendingRequestNotification;
    const responsePromise = codexClient.emitRequest(request);
    await waitForCondition(() => events.length === 1);

    await registry.submitServerRequest({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      requestId: "approval-1",
      response: { decision: "accept" },
    });

    await expect(responsePromise).resolves.toEqual({ decision: "accept" });
    expect(events.map((event) => event.notification.method)).toEqual([
      "item/commandExecution/requestApproval",
      "serverRequest/resolved",
    ]);
    expect(events.at(-1)).toMatchObject({
      backend: "codex",
      notification: {
        method: "serverRequest/resolved",
        params: {
          threadId: "thread-1",
          requestId: "approval-1",
        },
      },
    });

    unsubscribe();
    await registry.close();
  });

  it("forwards pagination parameters when reading a thread", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    await registry.readThread({
      backend: "codex",
      threadId: "thread-1",
      before: "cursor-1",
      limit: 25,
    });

    expect(codexClient.lastReadThreadParams).toEqual({
      threadId: "thread-1",
      before: "cursor-1",
      limit: 25,
    });

    await registry.close();
  });

  it("forwards normalized read-thread status metadata", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    await expect(
      registry.readThread({
        backend: "codex",
        threadId: "thread-1",
      })
    ).resolves.toMatchObject({
      threadStatus: "idle",
      replay: {
        threadStatus: "idle",
      },
    });

    await registry.close();
  });

  it("updates execution mode through the single Codex client", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read", "thread/resume"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock({ executionMode: "default" }),
    });

    const response = await registry.setThreadExecutionMode({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "full-access",
    });

    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "full-access",
    });
    expect(codexClient.lastSetThreadPermissionsParams).toEqual({
      threadId: "thread-1",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    await registry.close();
  });

  it("starts compaction through the single Codex client", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read", "thread/resume", "thread/compact/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock({ executionMode: "default" }),
    });

    const response = await registry.compactThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      turnId: "compact-turn-1",
      itemId: "compact-item-1",
    });
    expect(codexClient.lastCompactThreadParams).toEqual({
      threadId: "thread-1",
    });

    await registry.close();
  });

  it("lists Codex threads through the single client and reapplies overlay execution mode", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [
        {
          id: "thread-1",
          title: "Thread one",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
          updatedAt: 2,
        },
        {
          id: "thread-2",
          title: "Thread two",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
          updatedAt: 1,
        },
      ],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock({ executionMode: "full-access" }),
    });

    const threads = await registry.listThreads({ backend: "codex", filter: "thread" });

    expect(threads).toEqual([
      expect.objectContaining({
        id: "thread-1",
        executionMode: "full-access",
      }),
      expect.objectContaining({
        id: "thread-2",
        executionMode: "default",
      }),
    ]);
    expect(codexClient.listThreadsCallCount).toBe(1);
    expect(codexClient.lastListThreadsParams).toEqual({
      enrichDirectories: true,
      filter: "thread",
    });

    await registry.close();
  });

  it("snapshots and removes linked worktrees when archiving a thread", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archive me",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "worktree",
          worktreePath: "/repo/.worktrees/archive-me",
        },
      ],
      source: "codex",
      gitBranch: "codex/archive-me",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [thread],
    });
    const archiveWorktree = vi.fn(async () => ({
      id: "snapshot-1",
      backend: "codex" as const,
      threadId: "thread-1",
      worktreePath: "/repo/.worktrees/archive-me",
      repositoryPath: "/repo/app",
      snapshotRef: "refs/codex/snapshots/snapshot-1",
      snapshotCommit: "abc123",
      sourceBranch: "codex/archive-me",
      sourceHead: "def456",
      createdAt: 1000,
      archivedAt: 1000,
      state: "archived" as const,
      ignoredFilesExcluded: true,
    }));
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      worktreeArchiveService: {
        archive: archiveWorktree,
      } as unknown as WorktreeArchiveService,
    });

    const response = await registry.archiveThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(codexClient.lastArchiveThreadParams).toEqual({ threadId: "thread-1" });
    expect(archiveWorktree).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      worktreePath: "/repo/.worktrees/archive-me",
      repositoryPath: "/repo/app",
    });
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      archivedAt: expect.any(Number),
      cleanup: [
        {
          worktreePath: "/repo/.worktrees/archive-me",
          branch: "codex/archive-me",
          removedWorktree: true,
          deletedBranch: false,
        },
      ],
    });

    await registry.close();
  });

  it("does not report a cleanup failure when an archived thread has no linked worktrees", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archive local thread",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      gitBranch: "main",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [thread],
    });
    const archiveWorktree = vi.fn();
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      worktreeArchiveService: {
        archive: archiveWorktree,
      } as unknown as WorktreeArchiveService,
    });

    const response = await registry.archiveThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(archiveWorktree).not.toHaveBeenCalled();
    expect(response.cleanup).toEqual([]);

    await registry.close();
  });

  it("reports failed cleanup when a worktree directory remains after archive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-registry-sentinel-"));
    const repoPath = path.join(root, "PwrAgnt");
    const worktreePath = path.join(root, ".codex", "worktrees", "leaked", "PwrAgnt");

    try {
      await mkdir(worktreePath, { recursive: true });
      const thread: AppServerThreadSummary = {
        id: "thread-1",
        title: "Archive me",
        titleSource: "explicit",
        linkedDirectories: [
          {
            id: `directory:${repoPath}`,
            label: "PwrAgnt",
            path: repoPath,
            kind: "worktree",
            worktreePath,
          },
        ],
        source: "codex",
        gitBranch: "codex/archive-me",
        updatedAt: 2,
      };
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/list", "thread/archive"] },
        threads: [thread],
      });
      const archiveWorktree = vi.fn(async () => ({
        id: "snapshot-1",
        backend: "codex" as const,
        threadId: "thread-1",
        worktreePath,
        repositoryPath: repoPath,
        snapshotRef: "refs/codex/snapshots/snapshot-1",
        snapshotCommit: "abc123",
        sourceBranch: "codex/archive-me",
        sourceHead: "def456",
        createdAt: 1000,
        archivedAt: 1000,
        state: "archived" as const,
        ignoredFilesExcluded: true,
      }));
      const registry = new DesktopBackendRegistry({
        codexClient,
        grokClient: new MockBackendClient({
          initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
        }),
        overlayStore: createOverlayStoreMock(),
        worktreeArchiveService: {
          archive: archiveWorktree,
        } as unknown as WorktreeArchiveService,
      });

      const response = await registry.archiveThread({
        backend: "codex",
        threadId: "thread-1",
      });

      expect(response.cleanup).toEqual([
        {
          worktreePath,
          branch: "codex/archive-me",
          removedWorktree: false,
          deletedBranch: false,
          error: "Worktree directory still exists after archive cleanup.",
        },
      ]);

      await registry.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("revokes messaging bindings and clears pending intents when archiving a thread", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archive me",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [thread],
    });
    const overlayStore = createOverlayStoreMock();
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [
        { id: "binding-telegram", threadId: "thread-1", channel: "telegram" },
        { id: "binding-discord", threadId: "thread-1", channel: "discord" },
        { id: "binding-other", threadId: "thread-2", channel: "telegram" },
      ],
      pendingIntentIds: ["intent-approval", "intent-question"],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      messagingStore,
      overlayStore,
    });

    await registry.archiveThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(messagingStore.revokedBindingIds).toEqual([
      "binding-telegram",
      "binding-discord",
    ]);
    expect(messagingStore.deletedPendingThreads).toEqual([
      { backend: "codex", threadId: "thread-1" },
    ]);
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      messagingBindingTransitionLog: [
        expect.objectContaining({
          action: "unbound",
          bindingId: "binding-telegram",
          platform: "telegram",
        }),
        expect.objectContaining({
          action: "unbound",
          bindingId: "binding-discord",
          platform: "discord",
        }),
      ],
    });

    await registry.close();
  });

  it("routes archive binding revocation through the messaging archive cleaner when available", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archive me",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [thread],
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [{ id: "binding-telegram", threadId: "thread-1" }],
      pendingIntentIds: ["intent-approval"],
    });
    const messagingArchiveCleaner = createMessagingArchiveCleanerMock({
      notifiedCount: 1,
      revokedCount: 1,
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      messagingArchiveCleaner,
      messagingStore,
      overlayStore: createOverlayStoreMock(),
    });

    await registry.archiveThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(messagingStore.deletedPendingThreads).toEqual([
      { backend: "codex", threadId: "thread-1" },
    ]);
    expect(messagingArchiveCleaner.requests).toEqual([
      {
        backend: "codex",
        threadId: "thread-1",
        origin: "thread-archive",
      },
    ]);
    expect(messagingStore.revokedBindingIds).toEqual([]);

    await registry.close();
  });

  it("coalesces repeated archive messaging cleanup before invoking the cleaner", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archive me",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      archivedThreads: [thread],
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [thread],
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [{ id: "binding-telegram", threadId: "thread-1" }],
      pendingIntentIds: ["intent-approval"],
    });
    const cleanerReleased = createDeferred<{
      notifiedCount: number;
      revokedCount: number;
    }>();
    const messagingArchiveCleaner = createMessagingArchiveCleanerMock(
      cleanerReleased.promise,
    );
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      messagingArchiveCleaner,
      messagingStore,
      overlayStore: createOverlayStoreMock(),
    });

    const archivePromise = registry.archiveThread({
      backend: "codex",
      threadId: "thread-1",
    });
    while (messagingArchiveCleaner.requests.length === 0) {
      await flushAsync();
    }
    const notificationPromise = codexClient.emit({
      method: "thread/archived",
      params: { threadId: "thread-1" },
    });
    await flushAsync();

    expect(messagingArchiveCleaner.requests).toEqual([
      {
        backend: "codex",
        threadId: "thread-1",
        origin: "thread-archive",
      },
    ]);
    expect(messagingStore.deletedPendingThreads).toEqual([
      { backend: "codex", threadId: "thread-1" },
    ]);

    cleanerReleased.resolve({ notifiedCount: 1, revokedCount: 1 });
    await Promise.all([archivePromise, notificationPromise]);
    await registry.listThreads({ backend: "codex", archived: true });

    expect(messagingArchiveCleaner.requests).toHaveLength(1);
    expect(messagingStore.deletedPendingThreads).toHaveLength(1);

    await registry.close();
  });

  it("clears archive messaging cleanup cache when a thread is restored", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archive me again",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      initializeResult: {
        methods: ["thread/list", "thread/archive", "thread/unarchive"],
      },
      threads: [thread],
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [{ id: "binding-telegram", threadId: "thread-1" }],
      pendingIntentIds: ["intent-approval"],
    });
    const messagingArchiveCleaner = createMessagingArchiveCleanerMock({
      notifiedCount: 1,
      revokedCount: 1,
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      messagingArchiveCleaner,
      messagingStore,
      overlayStore: createOverlayStoreMock(),
    });

    await registry.archiveThread({ backend: "codex", threadId: "thread-1" });
    await registry.restoreThread({ backend: "codex", threadId: "thread-1" });
    await registry.archiveThread({ backend: "codex", threadId: "thread-1" });

    expect(messagingArchiveCleaner.requests).toEqual([
      { backend: "codex", threadId: "thread-1", origin: "thread-archive" },
      { backend: "codex", threadId: "thread-1", origin: "thread-archive" },
    ]);

    await registry.close();
  });

  it("clears archive messaging cleanup cache when an unarchive notification arrives", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archive me again",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [thread],
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [{ id: "binding-telegram", threadId: "thread-1" }],
      pendingIntentIds: ["intent-approval"],
    });
    const messagingArchiveCleaner = createMessagingArchiveCleanerMock({
      notifiedCount: 1,
      revokedCount: 1,
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      messagingArchiveCleaner,
      messagingStore,
      overlayStore: createOverlayStoreMock(),
    });

    await registry.archiveThread({ backend: "codex", threadId: "thread-1" });
    await codexClient.emit({
      method: "thread/unarchived",
      params: { threadId: "thread-1" },
    });
    await registry.archiveThread({ backend: "codex", threadId: "thread-1" });

    expect(messagingArchiveCleaner.requests).toHaveLength(2);

    await registry.close();
  });

  it("cleans messaging state when archived threads are discovered by refresh", async () => {
    const archivedThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archived elsewhere",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      archivedThreads: [archivedThread],
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [],
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [{ id: "binding-telegram", threadId: "thread-1" }],
      pendingIntentIds: ["intent-approval"],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      messagingStore,
      overlayStore: createOverlayStoreMock(),
    });

    await expect(
      registry.listThreads({ backend: "codex", archived: true }),
    ).resolves.toMatchObject([archivedThread]);
    await waitForCondition(() => messagingStore.revokedBindingIds.length === 1);

    expect(messagingStore.revokedBindingIds).toEqual(["binding-telegram"]);
    expect(messagingStore.deletedPendingThreads).toEqual([
      { backend: "codex", threadId: "thread-1" },
    ]);

    await registry.close();
  });

  it("cleans messaging state for bound threads missing from the active refresh", async () => {
    const archivedThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archived elsewhere",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      archivedThreads: [archivedThread],
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [],
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [{ id: "binding-telegram", threadId: "thread-1" }],
      pendingIntentIds: ["intent-approval"],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      messagingStore,
      overlayStore: createOverlayStoreMock(),
    });

    await expect(registry.listThreads({ backend: "codex" })).resolves.toEqual([]);
    await waitForCondition(() => messagingStore.revokedBindingIds.length === 1);

    expect(codexClient.lastListThreadsDiagnostics).toEqual({
      callerReason: "archive-bound-binding-cleanup",
      ownerId: expect.any(String),
    });
    expect(messagingStore.revokedBindingIds).toEqual(["binding-telegram"]);
    expect(messagingStore.deletedPendingThreads).toEqual([
      { backend: "codex", threadId: "thread-1" },
    ]);

    await registry.close();
  });

  it("does not block thread refresh when archive cleanup asks for navigation", async () => {
    const archivedThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archived elsewhere",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      archivedThreads: [archivedThread],
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [],
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [{ id: "binding-telegram", threadId: "thread-1" }],
    });
    let registry!: DesktopBackendRegistry;
    let nestedNavigationResolved = false;
    const messagingArchiveCleaner = {
      requests: [] as Array<{
        backend: "codex" | "grok";
        threadId: string;
        origin: "thread-archive";
      }>,
      async requestBindingRevokeAllForThread(request: {
        backend: "codex" | "grok";
        threadId: string;
        origin: "thread-archive";
      }) {
        messagingArchiveCleaner.requests.push(request);
        await registry.listThreads();
        nestedNavigationResolved = true;
        return { notifiedCount: 1, revokedCount: 1 };
      },
    };
    registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      messagingArchiveCleaner,
      messagingStore,
      overlayStore: createOverlayStoreMock(),
    });

    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), 100);
    });

    await expect(Promise.race([registry.listThreads(), timeout])).resolves.toEqual([]);
    await waitForCondition(() => nestedNavigationResolved);

    expect(messagingArchiveCleaner.requests).toEqual([
      {
        backend: "codex",
        threadId: "thread-1",
        origin: "thread-archive",
      },
    ]);

    await registry.close();
  });

  it("cleans messaging state when an active thread refresh transitions to archived", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archived elsewhere",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      archivedThreads: [thread],
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [thread],
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [{ id: "binding-telegram", threadId: "thread-1" }],
      pendingIntentIds: ["intent-approval"],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      messagingStore,
      overlayStore: createOverlayStoreMock(),
    });

    await expect(registry.listThreads({ backend: "codex" })).resolves.toMatchObject([
      thread,
    ]);
    codexClient.setThreads([]);
    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "another-thread",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          output: [],
        },
      },
    });
    await expect(registry.listThreads({ backend: "codex" })).resolves.toEqual([]);
    await waitForCondition(() => messagingStore.revokedBindingIds.length === 1);

    expect(messagingStore.revokedBindingIds).toEqual(["binding-telegram"]);
    expect(messagingStore.deletedPendingThreads).toEqual([
      { backend: "codex", threadId: "thread-1" },
    ]);

    await registry.close();
  });

  it("archives and reports skipped cleanup when worktree cleanup metadata cannot be loaded", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      listThreadsError: new Error("thread list unavailable"),
    });
    const archiveWorktree = vi.fn();
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      worktreeArchiveService: {
        archive: archiveWorktree,
      } as unknown as WorktreeArchiveService,
    });

    const response = await registry.archiveThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(codexClient.lastArchiveThreadParams).toEqual({ threadId: "thread-1" });
    expect(archiveWorktree).not.toHaveBeenCalled();
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      archivedAt: expect.any(Number),
      cleanup: [
        {
          removedWorktree: false,
          deletedBranch: false,
          skippedReason:
            "Unable to load thread metadata for archive cleanup: thread list unavailable",
        },
      ],
    });

    await registry.close();
  });

  it("removes a real Git worktree and unregisters it from the source repo when archiving a thread", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-registry-archive-"));
    const repoPath = path.join(root, "PwrAgnt");
    const worktreeRoot = path.join(root, ".codex", "worktrees", "mozycyl1");
    const worktreePath = path.join(worktreeRoot, "PwrAgnt");

    try {
      await mkdir(repoPath, { recursive: true });
      await git(repoPath, ["init", "-b", "main"]);
      await git(repoPath, ["config", "user.email", "test@example.com"]);
      await git(repoPath, ["config", "user.name", "Test User"]);
      await writeFile(path.join(repoPath, "README.md"), "base\n", "utf8");
      await git(repoPath, ["add", "README.md"]);
      await git(repoPath, ["commit", "-m", "initial"]);
      await mkdir(worktreeRoot, { recursive: true });
      await git(repoPath, ["worktree", "add", "-b", "feat/archive-cleanup", worktreePath, "main"]);
      const resolvedWorktreePath = await realpath(worktreePath);

      const thread: AppServerThreadSummary = {
        id: "thread-1",
        title: "Archive real worktree",
        titleSource: "explicit",
        linkedDirectories: [
          {
            id: `directory:${repoPath}`,
            label: "PwrAgnt",
            path: repoPath,
            kind: "worktree",
            worktreePath,
          },
        ],
        source: "codex",
        gitBranch: "feat/archive-cleanup",
        updatedAt: 2,
      };
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/list", "thread/archive"] },
        threads: [thread],
      });
      const registry = new DesktopBackendRegistry({
        codexClient,
        grokClient: new MockBackendClient({
          initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
        }),
        overlayStore: createOverlayStoreMock(),
      });

      const response = await registry.archiveThread({
        backend: "codex",
        threadId: "thread-1",
      });

      expect(response.cleanup).toEqual([
        {
          worktreePath: resolvedWorktreePath,
          branch: "feat/archive-cleanup",
          removedWorktree: true,
          deletedBranch: false,
        },
      ]);
      expect(await pathExists(resolvedWorktreePath)).toBe(false);
      expect(await git(repoPath, ["worktree", "list", "--porcelain"])).not.toContain(
        resolvedWorktreePath,
      );

      await registry.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hands off a local thread to a worktree and records the new workspace overlay", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Move me",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "local",
        },
      ],
      source: "codex",
      gitBranch: "feature/handoff",
      updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock();
    const handoff = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      direction: "local-to-worktree" as const,
      workMode: "worktree" as const,
      branch: "feature/handoff",
      repositoryPath: "/repo/app",
      targetPath: "/repo/app/.worktrees/app-feature-handoff",
      linkedDirectory: {
        id: "pwragent-handoff:codex:thread-1",
        label: "app",
        path: "/repo/app",
        worktreePath: "/repo/app/.worktrees/app-feature-handoff",
        kind: "worktree" as const,
      },
      warnings: [],
      completedAt: 1000,
    }));
    const recordCodexWorktreeOwnerThread = vi.fn(async () => {});
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [thread],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
      gitDirectoryService: {
        recordCodexWorktreeOwnerThread,
      } as never,
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });

    const response = await registry.handoffThreadWorkspace({
      backend: "codex",
      threadId: "thread-1",
      direction: "local-to-worktree",
      leaveLocalBranch: "main",
    });

    expect(handoff).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      direction: "local-to-worktree",
      leaveLocalBranch: "main",
      repositoryPath: "/repo/app",
      sourcePath: "/repo/app",
      sourceBranch: undefined,
    });
    expect(response.workMode).toBe("worktree");
    expect(recordCodexWorktreeOwnerThread).toHaveBeenCalledWith({
      worktreePath: "/repo/app/.worktrees/app-feature-handoff",
      threadId: "thread-1",
    });
    expect(codexClient.lastUpdateThreadMetadataParams).toEqual({
      threadId: "thread-1",
      gitInfo: {
        branch: "feature/handoff",
      },
    });
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      gitBranch: "feature/handoff",
      observedGitBranch: "feature/handoff",
      extraLinkedDirectories: [
        expect.objectContaining({
          id: "pwragent-handoff:codex:thread-1",
          kind: "worktree",
        }),
      ],
    });

    await registry.close();
  });

  it("rejects workspace handoff while the thread has an active turn", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Move me later",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "local",
        },
      ],
      source: "codex",
      gitBranch: "feature/handoff",
      updatedAt: 2,
    };
    const handoff = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      direction: "local-to-worktree" as const,
      workMode: "worktree" as const,
      branch: "feature/handoff",
      repositoryPath: "/repo/app",
      targetPath: "/repo/app/.worktrees/app-feature-handoff",
      linkedDirectory: {
        id: "pwragent-handoff:codex:thread-1",
        label: "app",
        path: "/repo/app",
        worktreePath: "/repo/app/.worktrees/app-feature-handoff",
        kind: "worktree" as const,
      },
      warnings: [],
      completedAt: 1000,
    }));
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "turn/start"] },
      threads: [thread],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      gitDirectoryService: {
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
      } as never,
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "keep working" }],
    });

    await expect(
      registry.handoffThreadWorkspace({
        backend: "codex",
        threadId: "thread-1",
        direction: "local-to-worktree",
      }),
    ).rejects.toThrow(
      "Worktree/local migration is not available while a turn is in progress. Resubmit when the turn completes.",
    );
    expect(handoff).not.toHaveBeenCalled();

    await registry.close();
  });

  it("rejects workspace handoff for active turns learned from backend notifications", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Notification active turn",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "local",
        },
      ],
      source: "codex",
      gitBranch: "feature/handoff",
      updatedAt: 2,
    };
    const handoff = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      direction: "local-to-worktree" as const,
      workMode: "worktree" as const,
      branch: "feature/handoff",
      repositoryPath: "/repo/app",
      targetPath: "/repo/app/.worktrees/app-feature-handoff",
      linkedDirectory: {
        id: "pwragent-handoff:codex:thread-1",
        label: "app",
        path: "/repo/app",
        worktreePath: "/repo/app/.worktrees/app-feature-handoff",
        kind: "worktree" as const,
      },
      warnings: [],
      completedAt: 1000,
    }));
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [thread],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      gitDirectoryService: {
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
      } as never,
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });

    await codexClient.emit({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-from-notification",
        turn: {
          id: "turn-from-notification",
          status: "inProgress",
        },
      },
    });

    await expect(
      registry.handoffThreadWorkspace({
        backend: "codex",
        threadId: "thread-1",
        direction: "local-to-worktree",
      }),
    ).rejects.toThrow(
      "Worktree/local migration is not available while a turn is in progress. Resubmit when the turn completes.",
    );

    await codexClient.emit({
      method: "turn/failed",
      params: {
        threadId: "thread-1",
        turnId: "turn-from-notification",
        turn: {
          id: "turn-from-notification",
          status: "failed",
          error: {
            message: "boom",
          },
        },
      },
    });

    await registry.handoffThreadWorkspace({
      backend: "codex",
      threadId: "thread-1",
      direction: "local-to-worktree",
    });
    expect(handoff).toHaveBeenCalledTimes(1);

    await registry.close();
  });

  it("records detached handoff results as HEAD immediately", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Detached handoff",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "pwragent-handoff:codex:thread-1",
          label: "app",
          path: "/repo/app",
          worktreePath: "/repo/app/.worktrees/app-main-detached",
          kind: "worktree",
        },
      ],
      source: "codex",
      gitBranch: "main",
      observedGitBranch: "HEAD",
      updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock();
    const handoff = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      direction: "worktree-to-local" as const,
      strategy: "detached-changes" as const,
      workMode: "local" as const,
      baseSha: "abc123",
      repositoryPath: "/repo/app",
      targetPath: "/repo/app",
      linkedDirectory: {
        id: "pwragent-handoff:codex:thread-1",
        label: "app",
        path: "/repo/app",
        kind: "local" as const,
      },
      warnings: [],
      completedAt: 1000,
    }));
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [thread],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });

    await registry.handoffThreadWorkspace({
      backend: "codex",
      threadId: "thread-1",
      direction: "worktree-to-local",
    });

    expect(codexClient.lastUpdateThreadMetadataParams).toEqual({
      threadId: "thread-1",
      gitInfo: {
        branch: "HEAD",
      },
    });
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      gitBranch: "HEAD",
      observedGitBranch: "HEAD",
      extraLinkedDirectories: [
        expect.objectContaining({
          id: "pwragent-handoff:codex:thread-1",
          kind: "local",
        }),
      ],
    });

    await registry.close();
  });

  it("uses an observed handoff branch as expected when legacy overlay state has no gitBranch", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Moved thread",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "local",
        },
      ],
      source: "codex",
      gitBranch: "fix/context-rail-slide-reflow",
      observedGitBranch: "feat/thread-workspace-handoff-plan",
      updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "full-access",
          observedGitBranch: "feat/thread-workspace-handoff-plan",
          extraLinkedDirectories: [
            {
              id: "pwragent-handoff:codex:thread-1",
              kind: "worktree",
              label: "app",
              path: "/repo/app",
              worktreePath: "/repo/app/.worktrees/app-feature",
            },
          ],
        },
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [thread],
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    const response = await registry.checkThreadBranchDrift({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(response).toMatchObject({
      expectedBranch: "feat/thread-workspace-handoff-plan",
      observedBranch: "feat/thread-workspace-handoff-plan",
      drifted: false,
    });

    await registry.close();
  });

  it("preserves the renderer expected branch when a fresh thread list reports a new branch", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Moved thread",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      gitBranch: "fix/steering-composer-navigation",
      observedGitBranch: "fix/steering-composer-navigation",
      updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "full-access",
          observedGitBranch: "fix/queued-composer-navigation",
          extraLinkedDirectories: [],
        },
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [thread],
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    const response = await registry.checkThreadBranchDrift({
      backend: "codex",
      expectedBranch: "fix/queued-composer-navigation",
      threadId: "thread-1",
    });

    expect(response).toMatchObject({
      expectedBranch: "fix/queued-composer-navigation",
      observedBranch: "fix/steering-composer-navigation",
      drifted: true,
    });
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      gitBranch: "fix/queued-composer-navigation",
      observedGitBranch: "fix/steering-composer-navigation",
    });

    await registry.close();
  });

  it("adopts a named branch change from an active turn before notifying listeners", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-active-turn-branch-"));
    const repo = path.join(root, "app");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "-b", "feature/old"]);
    await git(repo, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "--allow-empty",
      "-m",
      "init",
    ]);

    const thread: AppServerThreadSummary = {
      id: "thread-branch",
      title: "Active branch turn",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: `directory:${repo}`,
          label: "app",
          path: repo,
          kind: "local",
        },
      ],
      source: "codex",
      gitBranch: "feature/old",
      observedGitBranch: "feature/old",
      updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-branch": {
          backend: "codex",
          threadId: "thread-branch",
          executionMode: "default",
          gitBranch: "feature/old",
          observedGitBranch: "feature/old",
          extraLinkedDirectories: [],
        },
      },
    });
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/metadata/update"] },
      threads: [thread],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    let overlayDuringTerminalEvent: ThreadOverlayState | undefined;
    registry.onEvent(async (event) => {
      if (event.notification.method !== "turn/completed") {
        return;
      }
      overlayDuringTerminalEvent =
        await overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-branch",
        });
    });

    try {
      await codexClient.emit({
        method: "turn/started",
        params: {
          threadId: "thread-branch",
          turnId: "turn-branch",
          turn: {
            id: "turn-branch",
            status: "in_progress",
          },
        },
      });
      await git(repo, ["switch", "-c", "fix/queued-review-release"]);

      await codexClient.emit(
        {
          method: "turn/completed",
          params: {
            threadId: "thread-branch",
            turn: {
              id: "turn-branch",
              status: "completed",
              output: [],
            },
          },
        } as unknown as AppServerNotification,
      );

      expect(overlayDuringTerminalEvent).toMatchObject({
        gitBranch: "fix/queued-review-release",
        observedGitBranch: "fix/queued-review-release",
      });
      expect(codexClient.lastUpdateThreadMetadataParams).toEqual({
        threadId: "thread-branch",
        gitInfo: {
          branch: "fix/queued-review-release",
        },
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not persist a retained branch drift pair when expected branch is HEAD", async () => {
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-head": {
          backend: "codex",
          threadId: "thread-head",
          gitBranch: "HEAD",
          extraLinkedDirectories: [],
        },
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    const response = await registry.retainThreadBranchDrift({
      backend: "codex",
      threadId: "thread-head",
      expectedBranch: "HEAD",
      observedBranch: "feature/foo",
    });

    // Response still echoes the request so the renderer can update its
    // dialog state, but no pair is persisted.
    expect(response.expectedBranch).toBe("HEAD");
    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-head",
    });
    expect(overlay?.retainedBranchDriftPairs ?? []).toEqual([]);

    // Sanity: a non-HEAD pair still persists.
    await registry.retainThreadBranchDrift({
      backend: "codex",
      threadId: "thread-head",
      expectedBranch: "feature/old",
      observedBranch: "feature/new",
    });
    const overlayAfter = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-head",
    });
    expect(overlayAfter?.retainedBranchDriftPairs).toHaveLength(1);

    await registry.close();
  });

  it("flags drift when a thread is still detached at HEAD after a turn", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-archived",
      title: "Detached after work",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "local",
        },
      ],
      source: "codex",
      gitBranch: "feature/work-from-archive",
      observedGitBranch: "HEAD",
      updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-archived": {
          backend: "codex",
          threadId: "thread-archived",
          gitBranch: "feature/work-from-archive",
          observedGitBranch: "HEAD",
          extraLinkedDirectories: [],
        },
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [thread],
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    const response = await registry.checkThreadBranchDrift({
      backend: "codex",
      threadId: "thread-archived",
    });

    expect(response).toMatchObject({
      expectedBranch: "feature/work-from-archive",
      observedBranch: "HEAD",
      drifted: true,
    });

    await registry.close();
  });

  it("restores threads through the selected backend client", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/unarchive"] },
    });
    const grokClient = new MockBackendClient({
      initializeResult: { methods: ["thread/unarchive"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient,
      overlayStore: createOverlayStoreMock(),
    });

    await expect(
      registry.restoreThread({
        backend: "codex",
        threadId: "thread-1",
      })
    ).resolves.toEqual({
      backend: "codex",
      threadId: "thread-1",
      restoredAt: expect.any(Number),
    });

    await expect(
      registry.restoreThread({
        backend: "grok",
        threadId: "thread-2",
      })
    ).resolves.toEqual({
      backend: "grok",
      threadId: "thread-2",
      restoredAt: expect.any(Number),
    });

    expect(codexClient.lastRestoreThreadParams).toEqual({ threadId: "thread-1" });
    expect(grokClient.lastRestoreThreadParams).toEqual({ threadId: "thread-2" });

    await registry.close();
  });

  it("renames threads through the selected backend client", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/name/set"] },
    });
    const grokClient = new MockBackendClient({
      initializeResult: { methods: ["thread/name/set"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient,
      overlayStore: createOverlayStoreMock(),
    });

    await expect(
      registry.renameThread({
        backend: "codex",
        threadId: "thread-1",
        name: "Renamed Codex thread",
      })
    ).resolves.toEqual({
      backend: "codex",
      threadId: "thread-1",
      renamedAt: expect.any(Number),
    });

    await expect(
      registry.renameThread({
        backend: "grok",
        threadId: "thread-2",
        name: "Renamed Grok thread",
      })
    ).resolves.toEqual({
      backend: "grok",
      threadId: "thread-2",
      renamedAt: expect.any(Number),
    });

    expect(codexClient.lastRenameThreadParams).toEqual({
      threadId: "thread-1",
      name: "Renamed Codex thread",
    });
    expect(grokClient.lastRenameThreadParams).toEqual({
      threadId: "thread-2",
      name: "Renamed Grok thread",
    });

    await registry.close();
  });

  it("surfaces the single-client startTurn error directly when default mode is explicitly requested", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      startTurnError: new Error("thread not loaded on default instance"),
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok unavailable"),
      }),
      overlayStore: createOverlayStoreMock({ executionMode: "default" }),
    });

    await expect(
      registry.startTurn({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "default",
        input: [{ type: "text", text: "This must not silently escalate" }],
      }),
    ).rejects.toThrow("thread not loaded on default instance");

    await registry.close();
  });

  it("surfaces the single-client startTurn error directly when full-access mode is explicitly requested", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      startTurnError: new Error("thread not loaded on full-access instance"),
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok unavailable"),
      }),
      overlayStore: createOverlayStoreMock({ executionMode: "full-access" }),
    });

    await expect(
      registry.startTurn({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
        input: [{ type: "text", text: "This must not silently downgrade" }],
      }),
    ).rejects.toThrow("thread not loaded on full-access instance");

    await registry.close();
  });

  it("forwards per-turn override on the single client when execution mode is toggled", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/list"] },
      threads: [
        {
          id: "thread-toggle",
          title: "Toggle test",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-toggle": {
          backend: "codex",
          threadId: "thread-toggle",
          executionMode: "full-access",
          extraLinkedDirectories: [],
        },
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok unavailable"),
      }),
      overlayStore,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-toggle",
      executionMode: "full-access",
      input: [{ type: "text", text: "First turn on full-access" }],
    });
    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "thread-toggle",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    await registry.setThreadExecutionMode({
      backend: "codex",
      threadId: "thread-toggle",
      executionMode: "default",
    });

    codexClient.lastStartTurnParams = undefined;

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-toggle",
      executionMode: "default",
      input: [{ type: "text", text: "Second turn forwards default policy on the same client" }],
    });
    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "thread-toggle",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });

    await registry.close();
  });

  describe("queued permission-mode changes", () => {
    function buildIdleRegistry(options?: {
      executionMode?: "default" | "full-access";
    }) {
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/resume"] },
      });
      const overlayStore = createOverlayStoreMock({
        executionMode: options?.executionMode ?? "default",
      });
      const registry = new DesktopBackendRegistry({
        codexClient,
        grokClient: new MockBackendClient({
          initializeError: new Error("grok unavailable"),
        }),
        overlayStore,
      });
      return { codexClient, overlayStore, registry };
    }

    async function getLog(
      overlayStore: ReturnType<typeof createOverlayStoreMock>,
      threadId: string,
    ) {
      const overlay = await overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId,
      });
      return overlay?.permissionTransitionLog ?? [];
    }

    function startActiveTurn(
      registry: InstanceType<typeof DesktopBackendRegistry>,
      threadId: string,
      turnId = "turn-1",
    ) {
      // The registry exposes activeCodexTurnModes only privately; the
      // legitimate way to mark a thread active is to invoke startTurn.
      // For the queue tests the actual turn payload doesn't matter.
      return registry.startTurn({
        backend: "codex",
        threadId,
        input: [{ type: "text", text: "kicking off" }],
      }).then((response) => {
        // Sanity: the registry assigned an active turn key. Some tests
        // need a deterministic turnId, so we use the returned value.
        return response.turnId ?? turnId;
      });
    }

    it("toggle while idle applies immediately and logs a single applied entry", async () => {
      const { codexClient, overlayStore, registry } = buildIdleRegistry();

      const response = await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });

      expect(response).toEqual({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });
      expect(codexClient.lastSetThreadPermissionsParams).toEqual({
        threadId: "thread-1",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });

      const log = await getLog(overlayStore, "thread-1");
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        fromExecutionMode: "default",
        toExecutionMode: "full-access",
        status: "applied",
      });
      // No queueId on apply-immediately transitions.
      expect(log[0]?.queueId).toBeUndefined();

      await registry.close();
    });

    it("toggle while a turn is active queues without calling codex", async () => {
      const { codexClient, overlayStore, registry } = buildIdleRegistry();
      await startActiveTurn(registry, "thread-1");

      // startTurn calls setThreadPermissions? No — startTurn does NOT
      // call setThreadPermissions; it sets sandbox via the per-turn
      // override. Confirm the per-turn override is the only call so
      // far.
      expect(codexClient.lastSetThreadPermissionsParams).toBeUndefined();

      const response = await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });

      expect(response).toEqual({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });
      // Codex was NOT asked to switch — the queue holds the change.
      expect(codexClient.lastSetThreadPermissionsParams).toBeUndefined();

      const log = await getLog(overlayStore, "thread-1");
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        fromExecutionMode: "default",
        toExecutionMode: "full-access",
        status: "queued",
      });
      expect(log[0]?.queueId).toBeTruthy();

      await registry.close();
    });

    it("queue then explicit cancel records both entries with matching queueId and never calls codex", async () => {
      const { codexClient, overlayStore, registry } = buildIdleRegistry();
      await startActiveTurn(registry, "thread-1");

      await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });
      await registry.cancelThreadExecutionModeQueue({
        backend: "codex",
        threadId: "thread-1",
      });

      expect(codexClient.lastSetThreadPermissionsParams).toBeUndefined();

      const log = await getLog(overlayStore, "thread-1");
      expect(log).toHaveLength(2);
      expect(log[0]?.status).toBe("queued");
      expect(log[1]?.status).toBe("cancelled");
      expect(log[0]?.queueId).toBeTruthy();
      expect(log[1]?.queueId).toBe(log[0]?.queueId);

      await registry.close();
    });

    it("toggling back to the currently-applied mode while queued is treated as a cancel", async () => {
      const { codexClient, overlayStore, registry } = buildIdleRegistry();
      await startActiveTurn(registry, "thread-1");

      await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });
      // Toggle back to "default" (the currently-applied mode) while
      // the queue is still pending.
      await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "default",
      });

      // Codex never called.
      expect(codexClient.lastSetThreadPermissionsParams).toBeUndefined();

      const log = await getLog(overlayStore, "thread-1");
      expect(log.map((entry) => entry.status)).toEqual([
        "queued",
        "cancelled",
      ]);
      expect(log[0]?.queueId).toBe(log[1]?.queueId);

      await registry.close();
    });

    it("queue while a queue exists replaces the target with a fresh queueId", async () => {
      const { overlayStore, registry } = buildIdleRegistry();
      await startActiveTurn(registry, "thread-1");

      await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });
      // Re-queue. Same applied mode (default) is the from; the new
      // target is "full-access" again. The previous queueId is
      // orphaned in the log — that's correct (the user changed their
      // mind, then changed it back to the same target). The audit
      // semantically captures both intents.
      await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });

      const log = await getLog(overlayStore, "thread-1");
      // Two queued entries. The second one re-queued to the same
      // target — but the registry produced a fresh queueId because
      // the user intent (queue an apply) was re-asserted.
      expect(log.map((entry) => entry.status)).toEqual([
        "queued",
        "queued",
      ]);
      expect(log[0]?.queueId).not.toBe(log[1]?.queueId);

      await registry.close();
    });

    it("emits queued and queueCleared notifications around the lifecycle", async () => {
      const { registry } = buildIdleRegistry();
      const events: AgentEvent[] = [];
      registry.onEvent((event) => {
        events.push(event);
      });
      await startActiveTurn(registry, "thread-1");

      await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });
      await registry.cancelThreadExecutionModeQueue({
        backend: "codex",
        threadId: "thread-1",
      });

      const methodSequence = events.map(
        (event) => event.notification.method,
      );
      expect(methodSequence).toContain("thread/executionMode/queued");
      expect(methodSequence).toContain("thread/executionMode/queueCleared");

      const cleared = events.find(
        (event) =>
          event.notification.method === "thread/executionMode/queueCleared",
      );
      expect(cleared?.notification.params).toMatchObject({
        threadId: "thread-1",
        reason: "cancelled",
      });

      await registry.close();
    });

    it("turn-end fires the queue flush, applying the queued mode and emitting queueCleared(applied)", async () => {
      const { codexClient, overlayStore, registry } = buildIdleRegistry();
      const events: AgentEvent[] = [];
      registry.onEvent((event) => {
        events.push(event);
      });
      const turnId = await startActiveTurn(registry, "thread-1");

      await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });

      // Codex was NOT called yet — the queue holds the change.
      expect(codexClient.lastSetThreadPermissionsParams).toBeUndefined();

      // Simulate codex emitting turn/completed at the end of the turn.
      // The registry's emit() listener flushes the queue.
      await codexClient.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId,
          turn: {
            id: turnId,
            status: "completed",
            output: [],
          },
        },
      });
      // Wait for the fire-and-forget flush to settle. We need the
      // entire applyThreadExecutionMode path to complete (codex call,
      // overlay flip, audit-log append, both notifications) — polling
      // on setThreadPermissions alone is too early.
      const waitForApplied = async () => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const log = await getLog(overlayStore, "thread-1");
          if (log.some((entry) => entry.status === "applied")) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      };
      await waitForApplied();

      expect(codexClient.lastSetThreadPermissionsParams).toEqual({
        threadId: "thread-1",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });

      const log = await getLog(overlayStore, "thread-1");
      expect(log.map((entry) => entry.status)).toEqual([
        "queued",
        "applied",
      ]);
      // The applied entry must propagate the matching queueId.
      expect(log[0]?.queueId).toBeTruthy();
      expect(log[1]?.queueId).toBe(log[0]?.queueId);

      // Order: thread/executionMode/updated must precede
      // thread/executionMode/queueCleared(applied).
      const updatedIndex = events.findIndex(
        (event) =>
          event.notification.method === "thread/executionMode/updated",
      );
      const clearedIndex = events.findIndex(
        (event) =>
          event.notification.method === "thread/executionMode/queueCleared" &&
          (event.notification.params as { reason?: string }).reason ===
            "applied",
      );
      expect(updatedIndex).toBeGreaterThanOrEqual(0);
      expect(clearedIndex).toBeGreaterThan(updatedIndex);

      await registry.close();
    });

    it("startTurn flushes a pending queue before the new turn fires", async () => {
      const { codexClient, overlayStore, registry } = buildIdleRegistry();
      const turnId = await startActiveTurn(registry, "thread-1", "turn-1");

      await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });

      // The user-fast-path: turn ends, but before the emit() listener
      // gets to run, the user submits a new turn. startTurn must flush
      // the queue itself before letting codex see the new turn.
      // Simulate that by emitting turn/completed (which lets the prune
      // run) and then calling startTurn — but we don't await the
      // turn/completed emission; we go straight to startTurn.
      // The emit listener for the previous turn has already fired the
      // flush via fire-and-forget; startTurn awaits the same flush
      // function defensively, so the queue applies before the new turn.
      await codexClient.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId,
          turn: { id: turnId, status: "completed", output: [] },
        },
      });

      await registry.startTurn({
        backend: "codex",
        threadId: "thread-1",
        input: [{ type: "text", text: "next turn" }],
      });

      // setThreadPermissions must have been called before startTurn's
      // turn payload was finalized. The mock client tracks the latest
      // setThreadPermissions call; verify it was invoked at all.
      expect(codexClient.lastSetThreadPermissionsParams).toEqual({
        threadId: "thread-1",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });

      const log = await getLog(overlayStore, "thread-1");
      expect(log.map((entry) => entry.status)).toContain("applied");

      await registry.close();
    });

    it("startReview waits for an in-flight permission queue flush before review/start", async () => {
      const permissionFlush = createDeferred<void>();
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["turn/start", "review/start", "thread/resume"] },
        setThreadPermissionsDelay: permissionFlush.promise,
      });
      const overlayStore = createOverlayStoreMock({
        executionMode: "default",
      });
      const registry = new DesktopBackendRegistry({
        codexClient,
        grokClient: new MockBackendClient({
          initializeError: new Error("grok unavailable"),
        }),
        overlayStore,
      });
      const turnId = await startActiveTurn(registry, "thread-1");

      await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });
      expect(codexClient.lastSetThreadPermissionsParams).toBeUndefined();

      await codexClient.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId,
          turn: { id: turnId, status: "completed", output: [] },
        },
      });

      await waitForCondition(
        () => codexClient.lastSetThreadPermissionsParams !== undefined,
      );

      const reviewPromise = registry.startReview({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
      });
      await flushAsync();

      expect(codexClient.lastStartReviewParams).toBeUndefined();
      permissionFlush.resolve();
      await reviewPromise;

      expect(codexClient.lastSetThreadPermissionsParams).toEqual({
        threadId: "thread-1",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      expect(codexClient.lastStartReviewParams).toEqual({
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
      });
      const overlay = await overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      });
      expect(overlay?.executionMode).toBe("full-access");

      await registry.close();
    });

    it("emit-listener and startTurn flush hooks do not double-apply when both fire concurrently", async () => {
      // Regression: before the atomic-claim fix, both flush hooks
      // (emit-listener turn-end + startTurn race-safe prefix) could
      // both pass the `queue exists` check, both call
      // applyThreadExecutionMode, and both append an `applied`
      // transition. The user reported seeing two "Permissions
      // changed" entries in the transcript at the same timestamp.
      const { codexClient, overlayStore, registry } = buildIdleRegistry();
      const turnId = await startActiveTurn(registry, "thread-1");

      await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      });

      // Fire BOTH flush hooks back to back without awaiting in
      // between, mirroring the production race where the emit
      // listener and a subsequent startTurn call land on the same
      // tick. The atomic Map.delete claim must let only one through.
      const turnEndPromise = codexClient.emit({
        method: "thread/status/changed",
        params: {
          threadId: "thread-1",
          status: { type: "idle" },
        },
      });
      const startTurnPromise = registry.startTurn({
        backend: "codex",
        threadId: "thread-1",
        input: [{ type: "text", text: "next turn after queue applies" }],
      });
      await Promise.all([turnEndPromise, startTurnPromise]);

      // Wait for any deferred flush completion.
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const log = await getLog(overlayStore, "thread-1");
        if (log.filter((entry) => entry.status === "applied").length >= 1) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const log = await getLog(overlayStore, "thread-1");
      const appliedEntries = log.filter(
        (entry) => entry.status === "applied" && entry.toExecutionMode === "full-access",
      );
      expect(appliedEntries).toHaveLength(1);
      // codex.setThreadPermissions called exactly once (not twice).
      expect(codexClient.setThreadPermissionsCallCount).toBe(1);
      expect(turnId).toBeDefined();

      await registry.close();
    });

    it("evicts oldest entries past the 100-entry cap", async () => {
      const { overlayStore, registry } = buildIdleRegistry();

      // Each setThreadExecutionMode toggle on an idle thread produces
      // exactly one "applied" entry. Ping-pong 101 times.
      for (let index = 0; index < 101; index += 1) {
        const target = index % 2 === 0 ? "full-access" : "default";
        await registry.setThreadExecutionMode({
          backend: "codex",
          threadId: "thread-1",
          executionMode: target,
        });
      }

      const log = await getLog(overlayStore, "thread-1");
      expect(log).toHaveLength(100);

      await registry.close();
    });
  });
});
