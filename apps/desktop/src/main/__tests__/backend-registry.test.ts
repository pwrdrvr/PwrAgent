import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildThreadIdentityKey } from "@pwragent/shared";
import type {
  AcpBackendId,
  AgentEvent,
  AppServerNotification,
  AppServerPendingRequestNotification,
  AppServerSkillSummary,
  AppServerThreadReplay,
  AppServerThreadSummary,
  AppServerReviewTarget,
  AppServerTurnInputItem,
  BackendAccountSummary,
  BackendAcpRuntimeOptionSource,
  BackendAcpSessionRuntimeState,
  BackendRateLimitSummary,
  NavigationLaunchpadDefaults,
  NavigationLaunchpadDraft,
  ThreadExecutionMode,
  ThreadOverlayState,
  WorktreeSnapshotSummary,
} from "@pwragent/shared";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import { buildNavigationSnapshot } from "@pwragent/agent-core";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import {
  CodexEnvironmentCommandError,
  type CodexEnvironmentCommandRunner,
} from "../app-server/codex-environment-runtime";
import type { OverlayStoreLike } from "../state/overlay-store-sqlite";
import type { WorktreeArchiveService } from "../app-server/worktree-archive-service";
import type { AcpInstalledAgentRecord } from "../acp/acp-registry-types";
import type { AcpSessionMetadata } from "../acp/acp-session-store";

const localAcpDiscoveryMock = vi.hoisted(() => ({
  discoverLocalAcpAgents: vi.fn(async () => [] as AcpInstalledAgentRecord[]),
}));

vi.mock("../acp/acp-local-discovery", () => localAcpDiscoveryMock);

const desktopNotificationServiceMock = vi.hoisted(() => {
  const notifyAttention = vi.fn();
  const notifyTerminal = vi.fn();
  const clearAttentionKey = vi.fn();
  const service = { notifyAttention, notifyTerminal, clearAttentionKey };
  return {
    notifyAttention,
    notifyTerminal,
    clearAttentionKey,
    getDesktopNotificationService: vi.fn(() => service),
  };
});

vi.mock("../notifications/desktop-notification-service", () => ({
  getDesktopNotificationService:
    desktopNotificationServiceMock.getDesktopNotificationService,
}));

// These tests pre-date the agent-core Grok experimental flag and exercise
// the direct xAI HTTP provider's behavior (model warm-up, availability
// reporting, etc.). The flag now defaults to off; enable it for this file
// so the registry continues to instantiate the Grok provider rather than
// emitting the "experimental and disabled" stub summary. Production
// gating is exercised elsewhere.
const PRIOR_AGENT_CORE_GROK_ENV =
  process.env.PWRAGENT_EXPERIMENTAL_AGENT_CORE_GROK;
beforeAll(() => {
  process.env.PWRAGENT_EXPERIMENTAL_AGENT_CORE_GROK = "1";
});
afterAll(() => {
  if (PRIOR_AGENT_CORE_GROK_ENV === undefined) {
    delete process.env.PWRAGENT_EXPERIMENTAL_AGENT_CORE_GROK;
  } else {
    process.env.PWRAGENT_EXPERIMENTAL_AGENT_CORE_GROK = PRIOR_AGENT_CORE_GROK_ENV;
  }
});

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
  timeoutMs = 10_000,
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
    setThreadAgent: async (settings: {
      backend: "codex" | "grok";
      threadId: string;
      agent: ThreadOverlayState["agent"] | null;
    }) => {
      const key = `${settings.backend}:${settings.threadId}`;
      const current = overlays.get(key) ?? {
        backend: settings.backend,
        threadId: settings.threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        agent: settings.agent ?? undefined,
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
    listThreadOverlaysWithCodexEnvironmentRuntime: async () => {
      return Array.from(overlays.values()).filter(
        (overlay) => overlay.codexEnvironmentRuntime !== undefined,
      );
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
  } as unknown as OverlayStoreLike;
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
    dynamicTools?: unknown;
    ephemeral?: boolean;
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
    cwd?: string;
    approvalPolicy?: string;
    sandbox?: string;
    model?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  };
  startTurnCallCount = 0;
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
  lastTrustProjectParams?: {
    projectPath: string;
    configPath?: string;
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
  listThreadsCalls: Array<{
    diagnostics?: {
      callerReason?: string;
      ownerId?: string;
    };
    params?: {
      archived?: boolean;
      enrichDirectories?: boolean;
      filter?: string;
    };
  }> = [];

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
    this.listThreadsCalls.push({ diagnostics, params });
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
    dynamicTools?: unknown;
    ephemeral?: boolean;
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
    this.startTurnCallCount += 1;
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

  async trustProject(params: {
    projectPath: string;
    configPath?: string;
  }): Promise<{ projectPath: string; configPath?: string }> {
    this.lastTrustProjectParams = params;
    return params;
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

function createAcpAgentStoreMock(records: AcpInstalledAgentRecord[]) {
  return {
    getInstalledAgent: (backendId: AcpBackendId) =>
      records.find((record) => record.backendId === backendId),
    listInstalledAgents: () => records,
    upsertInstalledAgent: (record: AcpInstalledAgentRecord) => {
      const index = records.findIndex(
        (candidate) => candidate.backendId === record.backendId,
      );
      if (index >= 0) {
        records[index] = record;
      } else {
        records.push(record);
      }
    },
  };
}

function createAcpSessionStoreMock(records: AcpSessionMetadata[]) {
  return {
    listSessions: (backendId: string, params?: { archived?: boolean }) =>
      records.filter(
        (record) =>
          record.backendId === backendId &&
          Boolean(record.archivedAt) === (params?.archived === true),
      ),
    getSession: (backendId: string, sessionId: string) =>
      records.find(
        (record) =>
          record.backendId === backendId && record.sessionId === sessionId,
      ),
    upsertSession: (metadata: AcpSessionMetadata) => {
      const index = records.findIndex(
        (record) =>
          record.backendId === metadata.backendId &&
          record.sessionId === metadata.sessionId,
      );
      if (index === -1) {
        records.push(metadata);
      } else {
        records[index] = metadata;
      }
    },
  };
}

function createKimiAgentRecord(
  backendId: AcpBackendId = "acp:kimi" as AcpBackendId,
): AcpInstalledAgentRecord {
  return {
    backendId,
    registryId: "kimi",
    name: "Kimi Code CLI",
    version: "1.44.0",
    distributionKind: "local",
    distributionSource: "kimi acp",
    installStatus: "installed",
    authStatus: "not-required",
    verificationStatus: "not-applicable",
    allowlistRuleId: "local-kimi-cli",
    installedAt: 1000,
    updatedAt: 2000,
    launchDescriptor: {
      backendId,
      registryId: "kimi",
      distributionKind: "local",
      command: "kimi",
      args: ["acp"],
      env: {},
    },
  };
}

type KimiSendControlPrompt = (params: {
  sessionId: string;
  prompt: string;
}) => Promise<{ text: string }>;

type KimiStartPrompt = (params: {
  sessionId: string;
  prompt: string;
  promptContent?: unknown[];
  parts?: unknown[];
  turnId?: string;
}) => { sessionId: string; turnId: string };

function createKimiAcpRegistry(options?: {
  acpBackendId?: AcpBackendId;
  sessionId?: string;
  sessions?: AcpSessionMetadata[];
  sendControlPrompt?: KimiSendControlPrompt;
  startPrompt?: KimiStartPrompt;
  overlayStore?: ReturnType<typeof createOverlayStoreMock>;
  codexClient?: MockBackendClient;
  codexEnvironmentCommandRunner?: CodexEnvironmentCommandRunner;
  gitDirectoryService?: unknown;
}) {
  const acpBackendId = options?.acpBackendId ?? ("acp:kimi" as AcpBackendId);
  const sessions = options?.sessions ?? [];
  const sessionId = options?.sessionId ?? "kimi-session-1";
  const sendControlPrompt: KimiSendControlPrompt =
    options?.sendControlPrompt ??
    vi.fn(async () => ({
      text: "You only live once! All actions will be auto-approved.",
    }));
  const startPrompt: KimiStartPrompt =
    options?.startPrompt ??
    vi.fn(() => ({ sessionId, turnId: "turn-1" }));
  const acpClient = {
    controlPromptReceiverMarker: true,
    initialize: vi.fn(async () => undefined),
    dispose: vi.fn(),
    startSession: vi.fn(async (params: {
      cwd?: string;
      executionMode: "default" | "full-access";
    }) => {
      const metadata: AcpSessionMetadata = {
        backendId: acpBackendId,
        sessionId,
        title: "ACP session",
        cwd: params.cwd,
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: params.executionMode,
        status: "idle",
      };
      sessions.push(metadata);
      return metadata;
    }),
    startPrompt,
    sendControlPrompt,
    ensureSession: vi.fn(async () => undefined),
    loadSession: vi.fn(async (): Promise<AppServerThreadReplay> => ({
      entries: [],
      messages: [],
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
      threadStatus: "idle",
    })),
    refreshSession: vi.fn(async () => undefined),
    cancelSession: vi.fn(),
    readReplay: vi.fn((): AppServerThreadReplay => ({
      entries: [],
      messages: [],
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
      threadStatus: "idle",
    })),
  };
  const registry = new DesktopBackendRegistry({
    codexClient: options?.codexClient ?? new MockBackendClient({ threads: [] }),
    grokClient: new MockBackendClient({ threads: [] }),
    overlayStore: options?.overlayStore ?? createOverlayStoreMock(),
    acpAgentStore: createAcpAgentStoreMock([createKimiAgentRecord(acpBackendId)]),
    acpSessionStore: createAcpSessionStoreMock(sessions),
    createAcpClient: () => acpClient,
    codexEnvironmentCommandRunner: options?.codexEnvironmentCommandRunner,
    gitDirectoryService: options?.gitDirectoryService as never,
  });
  return {
    acpBackendId,
    acpClient,
    registry,
    sendControlPrompt,
    sessions,
    startPrompt,
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
        label: "AgentCore - Grok",
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

  it("delegates Codex project trust to the Codex client", async () => {
    const codexClient = new MockBackendClient({});
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({}),
      overlayStore: createOverlayStoreMock(),
    });

    const response = await registry.trustCodexProject({
      projectPath: "/Users/huntharo/github/PwrAgnt",
      configPath: "/Users/huntharo/.codex/profiles/acp-smoke/config.toml",
    });

    expect(response).toEqual({
      projectPath: "/Users/huntharo/github/PwrAgnt",
      configPath: "/Users/huntharo/.codex/profiles/acp-smoke/config.toml",
      trusted: true,
    });
    expect(codexClient.lastTrustProjectParams).toEqual({
      projectPath: "/Users/huntharo/github/PwrAgnt",
      configPath: "/Users/huntharo/.codex/profiles/acp-smoke/config.toml",
    });

    await registry.close();
  });

  it("buffers the latest Codex config warning until the project is trusted", async () => {
    const codexClient = new MockBackendClient({});
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({}),
      overlayStore: createOverlayStoreMock(),
    });

    expect(registry.getLatestCodexConfigWarning()).toEqual({});

    await codexClient.emit({
      method: "configWarning",
      params: {
        summary: "Project-local config is disabled.",
        details: null,
        trustedProjectPath: "/Users/huntharo/github/PwrAgnt",
        configPath: "/Users/huntharo/.codex/profiles/acp-smoke/config.toml",
      },
    });

    expect(registry.getLatestCodexConfigWarning()).toEqual({
      event: {
        backend: "codex",
        notification: {
          method: "configWarning",
          params: {
            summary: "Project-local config is disabled.",
            details: null,
            trustedProjectPath: "/Users/huntharo/github/PwrAgnt",
            configPath: "/Users/huntharo/.codex/profiles/acp-smoke/config.toml",
          },
        },
      },
    });

    await registry.trustCodexProject({
      projectPath: "/Users/huntharo/github/PwrAgnt",
      configPath: "/Users/huntharo/.codex/profiles/acp-smoke/config.toml",
    });

    expect(registry.getLatestCodexConfigWarning()).toEqual({});
    await registry.close();
  });

  it("reports installed ACP agents as backend summaries", async () => {
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      grokClient: new MockBackendClient({}),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: "acp:gemini",
          registryId: "gemini",
          name: "Gemini CLI",
          version: "0.42.0",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "gemini-local",
          installedAt: 1000,
          updatedAt: 2000,
          registryAgent: {
            id: "gemini",
            backendId: "acp:gemini",
            name: "Gemini CLI",
            version: "0.42.0",
            authors: ["Google"],
            license: "Apache-2.0",
            repositoryUrl: "https://github.com/google-gemini/gemini-cli",
            distributions: [],
            distributionKinds: [],
            auth: { required: false, methods: [] },
            raw: {},
          },
        },
      ]),
    });

    const response = await registry.listBackends({ includeUnavailable: true });

    expect(response.backends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "acp:gemini",
          source: "acp",
          label: "Gemini",
          available: true,
          acp: expect.objectContaining({
            registryId: "gemini",
            version: "0.42.0",
            installStatus: "installed",
            authStatus: "not-required",
            verificationStatus: "not-applicable",
            allowlistRuleId: "gemini-local",
            license: "Apache-2.0",
          }),
          capabilities: expect.objectContaining({
            createThread: true,
            renameThread: true,
            readThread: true,
            startTurn: true,
          }),
        }),
      ]),
    );

    await registry.close();
  });

  it("does not report banned ACP adapters as backend summaries", async () => {
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      grokClient: new MockBackendClient({}),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: "acp:codex-acp",
          registryId: "codex-acp",
          name: "Codex CLI",
          distributionKind: "npx",
          distributionSource: "@zed-industries/codex-acp@0.14.0",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "codex-rule",
          installedAt: 1000,
          updatedAt: 2000,
        },
      ]),
    });

    const response = await registry.listBackends({ includeUnavailable: true });

    expect(response.backends.some((backend) => backend.kind === "acp:codex-acp"))
      .toBe(false);

    await registry.close();
  });

  it("reports locally discovered ACP agents as backend summaries", async () => {
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      grokClient: new MockBackendClient({}),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([]),
      discoverLocalAcpAgents: async () => [
        {
          backendId: "acp:gemini",
          registryId: "gemini",
          name: "Gemini CLI",
          version: "0.42.0",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 1000,
          launchDescriptor: {
            backendId: "acp:gemini",
            registryId: "gemini",
            distributionKind: "local",
            command: "gemini",
            args: ["--acp", "--skip-trust"],
            env: {},
          },
        },
      ],
    });

    const response = await registry.listBackends({ includeUnavailable: true });

    expect(response.backends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "acp:gemini",
          source: "acp",
          label: "Gemini",
          available: true,
          acp: expect.objectContaining({
            registryId: "gemini",
            distributionKinds: ["local"],
            installStatus: "installed",
            allowlistRuleId: "local-gemini-cli",
          }),
        }),
      ]),
    );

    await registry.close();
  });

  it("lists persisted ACP sessions as thread summaries", async () => {
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      grokClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: "acp:gemini",
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "gemini-local",
          installedAt: 1000,
          updatedAt: 2000,
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock([
        {
          backendId: "acp:gemini",
          sessionId: "session-1",
          title: "ACP Thread",
          cwd: "/repo/project",
          createdAt: 1000,
          updatedAt: 3000,
          executionMode: "full-access",
          status: "idle",
        },
      ]),
    });

    await expect(
      registry.listThreads({ backend: "acp:gemini" }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "session-1",
        source: "acp:gemini",
        title: "ACP Thread",
        executionMode: "full-access",
        linkedDirectories: [
          {
            id: "/repo/project",
            label: "project",
            path: "/repo/project",
            kind: "local",
          },
        ],
      }),
    ]);
    await expect(registry.listThreads()).resolves.toEqual([
      expect.objectContaining({
        id: "session-1",
        source: "acp:gemini",
      }),
    ]);

    await registry.close();
  });

  it("marks Gemini ACP thread workspace handoff unavailable after conversation history", async () => {
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      grokClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: "acp:gemini",
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock([
        {
          backendId: "acp:gemini",
          sessionId: "session-1",
          title: "ACP Thread",
          cwd: "/repo/project",
          createdAt: 1000,
          updatedAt: 3000,
          executionMode: "default",
          status: "idle",
          hasConversationHistory: true,
        },
      ]),
    });

    await expect(
      registry.listThreads({ backend: "acp:gemini" }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "session-1",
        workspaceHandoff: {
          available: false,
          unavailableReason: expect.stringContaining("cannot hand off"),
        },
      }),
    ]);

    await registry.close();
  });

  it("invalidates cached ACP thread summaries when a live topic update renames the thread", async () => {
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const sessions: AcpSessionMetadata[] = [
      {
        backendId: acpBackendId,
        sessionId: "session-1",
        title: "ACP session",
        cwd: "/repo/project",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        status: "idle",
      },
    ];
    const sessionStore = createAcpSessionStoreMock(sessions);
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      grokClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 1000,
        },
      ]),
      acpSessionStore: sessionStore,
    });

    await expect(
      registry.listThreads({ backend: acpBackendId }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "session-1",
        title: "ACP session",
      }),
    ]);

    sessionStore.upsertSession({
      ...sessions[0]!,
      title: "Exploring PwrSnap Project",
      updatedAt: 2000,
    });
    await (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit({
      backend: acpBackendId,
      notification: {
        method: "thread/name/updated",
        params: {
          threadId: "session-1",
          threadName: "Exploring PwrSnap Project",
        },
      },
    });

    await expect(
      registry.listThreads({ backend: acpBackendId }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "session-1",
        title: "Exploring PwrSnap Project",
      }),
    ]);

    await registry.close();
  });

  it("invalidates cached ACP thread summaries when runtime mode changes", async () => {
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const sessions: AcpSessionMetadata[] = [
      {
        backendId: acpBackendId,
        sessionId: "session-1",
        title: "ACP session",
        cwd: "/repo/project",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        acpRuntime: {
          currentModeId: "default",
          updatedAt: 1000,
        },
        status: "idle",
      },
    ];
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(),
      startSession: vi.fn(),
      startPrompt: vi.fn(),
      ensureSession: vi.fn(async () => undefined),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(),
      readReplay: vi.fn((): AppServerThreadReplay => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      })),
      setRuntimeOption: vi.fn(
        async (): Promise<BackendAcpSessionRuntimeState> => ({
          currentModeId: "yolo",
          updatedAt: 2000,
        }),
      ),
    };
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      grokClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 1000,
          runtimeCapabilities: {
            schemaVersion: 1,
            status: "discovered",
            source: "session-load",
            discoveredAt: 1000,
            checkedAt: 1000,
            modes: {
              currentModeId: "default",
              availableModes: [
                { id: "default", label: "Default" },
                { id: "yolo", label: "YOLO" },
              ],
            },
          },
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock(sessions),
      createAcpClient: () => acpClient,
    });

    await expect(
      registry.listThreads({ backend: acpBackendId }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "session-1",
        acpRuntime: expect.objectContaining({ currentModeId: "default" }),
      }),
    ]);

    await registry.setAcpSessionRuntimeOption({
      backend: acpBackendId,
      threadId: "session-1",
      source: "mode",
      optionId: "mode",
      value: "yolo",
    });

    await expect(
      registry.listThreads({ backend: acpBackendId }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "session-1",
        acpRuntime: expect.objectContaining({ currentModeId: "yolo" }),
      }),
    ]);

    await registry.close();
  });

  it("keeps ACP config-option mode state when the agent returns stale config", async () => {
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const sessions: AcpSessionMetadata[] = [
      {
        backendId: acpBackendId,
        sessionId: "session-1",
        title: "ACP session",
        cwd: "/repo/project",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        acpRuntime: {
          configValues: { "approval-mode": "default" },
          currentModeId: "default",
          updatedAt: 1000,
        },
        status: "idle",
      },
    ];
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(),
      startSession: vi.fn(),
      startPrompt: vi.fn(),
      ensureSession: vi.fn(async () => undefined),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(),
      readReplay: vi.fn((): AppServerThreadReplay => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      })),
      setRuntimeOption: vi.fn(
        async (): Promise<BackendAcpSessionRuntimeState> => ({
          configValues: { "approval-mode": "default" },
          updatedAt: 2000,
        }),
      ),
    };
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      grokClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 1000,
          runtimeCapabilities: {
            schemaVersion: 1,
            status: "discovered",
            source: "session-load",
            discoveredAt: 1000,
            checkedAt: 1000,
            configOptions: [
              {
                id: "approval-mode",
                label: "Approval mode",
                type: "select",
                category: "mode",
                currentValue: "default",
                values: [
                  { value: "default", label: "Default" },
                  { value: "yolo", label: "YOLO" },
                ],
              },
            ],
          },
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock(sessions),
      createAcpClient: () => acpClient,
    });

    await registry.setAcpSessionRuntimeOption({
      backend: acpBackendId,
      threadId: "session-1",
      source: "configOption",
      optionId: "approval-mode",
      value: "yolo",
    });

    await expect(
      registry.listThreads({ backend: acpBackendId }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "session-1",
        acpRuntime: expect.objectContaining({
          configValues: { "approval-mode": "yolo" },
          currentModeId: "yolo",
        }),
      }),
    ]);

    await registry.close();
  });

  it("archives and restores persisted ACP sessions locally", async () => {
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const sessions: AcpSessionMetadata[] = [
      {
        backendId: acpBackendId,
        sessionId: "session-1",
        title: "Gemini ACP Thread",
        cwd: "/repo/project",
        createdAt: 1000,
        updatedAt: 3000,
        executionMode: "default",
        status: "idle",
      },
    ];
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      grokClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock(sessions),
    });

    await expect(
      registry.archiveThread({
        backend: acpBackendId,
        threadId: "session-1",
      }),
    ).resolves.toMatchObject({
      backend: acpBackendId,
      threadId: "session-1",
      cleanup: [],
    });
    await expect(
      registry.listThreads({ backend: acpBackendId }),
    ).resolves.toEqual([]);
    await expect(
      registry.listThreads({ backend: acpBackendId, archived: true }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "session-1",
        archivedAt: expect.any(Number),
      }),
    ]);

    await expect(
      registry.restoreThread({
        backend: acpBackendId,
        threadId: "session-1",
      }),
    ).resolves.toMatchObject({
      backend: acpBackendId,
      threadId: "session-1",
      worktrees: [],
    });
    await expect(
      registry.listThreads({ backend: acpBackendId }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "session-1",
        archivedAt: undefined,
      }),
    ]);

    await registry.close();
  });

  it("starts ACP sessions, prompts them, reads replay, and cancels turns", async () => {
    const sessions: AcpSessionMetadata[] = [];
    const startedPrompts: Array<{
      sessionId: string;
      prompt: string;
      promptContent?: unknown;
      parts?: unknown;
      turnId?: string;
    }> = [];
    const cancelledSessions: string[] = [];
    const emittedEvents: AgentEvent[] = [];
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(),
      startSession: vi.fn(async (params: {
        cwd?: string;
        executionMode: "default" | "full-access";
        title?: string;
      }) => {
        const metadata: AcpSessionMetadata = {
          backendId: acpBackendId,
          sessionId: "session-1",
          title: params.title ?? "ACP session",
          cwd: params.cwd,
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: params.executionMode,
          status: "idle",
        };
        sessions.push(metadata);
        return metadata;
      }),
      startPrompt: vi.fn((params: {
        sessionId: string;
        prompt: string;
        promptContent?: unknown;
        parts?: unknown;
        turnId?: string;
      }) => {
        startedPrompts.push(params);
        return {
          sessionId: params.sessionId,
          turnId: params.turnId ?? "pending:session-1:1001",
        };
      }),
      ensureSession: vi.fn(async () => undefined),
      loadSession: vi.fn(async (): Promise<AppServerThreadReplay> => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      })),
      refreshSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(async (sessionId: string) => {
        cancelledSessions.push(sessionId);
      }),
      readReplay: vi.fn((): AppServerThreadReplay => ({
        entries: [
          {
            type: "message",
            id: "assistant:1",
            role: "assistant",
            text: "Done",
            createdAt: 1002,
          },
        ],
        messages: [
          {
            id: "assistant:1",
            role: "assistant",
            text: "Done",
            createdAt: 1002,
          },
        ],
        lastAssistantMessage: "Done",
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      })),
    };
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      grokClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
          launchDescriptor: {
            backendId: acpBackendId,
            registryId: "gemini",
            distributionKind: "local",
            command: "gemini",
            args: ["--acp", "--skip-trust"],
            env: {},
          },
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock(sessions),
      createAcpClient: () => acpClient,
    });
    registry.onEvent((event) => {
      emittedEvents.push(event);
    });

    await expect(
      registry.startThread({
        backend: acpBackendId,
        cwd: "/repo/project",
        executionMode: "full-access",
      }),
    ).resolves.toMatchObject({
      backend: acpBackendId,
      threadId: "session-1",
      executionMode: "full-access",
    });
    const startedTurn = await registry.startTurn({
      backend: acpBackendId,
      threadId: "session-1",
      input: [{ type: "text", text: "hello ACP" }],
    });
    expect(startedTurn).toEqual({
      backend: acpBackendId,
      threadId: "session-1",
      turnId: expect.stringMatching(/^pending:session-1:\d+$/),
    });
    await (registry as unknown as { emit(event: AgentEvent): Promise<void> }).emit({
      backend: acpBackendId,
      notification: {
        method: "turn/completed",
        params: {
          threadId: "session-1",
          turnId: startedTurn.turnId,
          turn: {
            id: startedTurn.turnId,
            status: "completed",
            completedAt: 1002,
            output: [{ type: "text", text: "Done" }],
          },
        },
      },
    });
    const imageUrl = "data:image/png;base64,aGVsbG8=";
    const imageTurn = await registry.startTurn({
      backend: acpBackendId,
      threadId: "session-1",
      input: [
        { type: "text", text: "What's in this image?" },
        { type: "image", url: imageUrl },
      ],
    });
    expect(imageTurn).toEqual({
      backend: acpBackendId,
      threadId: "session-1",
      turnId: expect.stringMatching(/^pending:session-1:\d+$/),
    });
    await (registry as unknown as { emit(event: AgentEvent): Promise<void> }).emit({
      backend: acpBackendId,
      notification: {
        method: "turn/completed",
        params: {
          threadId: "session-1",
          turnId: imageTurn.turnId,
          turn: {
            id: imageTurn.turnId,
            status: "completed",
            completedAt: 1003,
            output: [{ type: "text", text: "Done" }],
          },
        },
      },
    });
    await expect(
      registry.readThread({
        backend: acpBackendId,
        threadId: "session-1",
      }),
    ).resolves.toMatchObject({
      backend: acpBackendId,
      threadId: "session-1",
      replay: {
        lastAssistantMessage: "Done",
      },
    });
    await expect(
      registry.interruptTurn({
        backend: acpBackendId,
        threadId: "session-1",
        turnId: startedTurn.turnId,
      }),
    ).resolves.toEqual({
      backend: acpBackendId,
      threadId: "session-1",
      turnId: startedTurn.turnId,
    });

    expect(acpClient.initialize).toHaveBeenCalledTimes(1);
    const startSessionParams = acpClient.startSession.mock.calls[0]?.[0];
    expect(startSessionParams).toMatchObject({
      cwd: "/repo/project",
      executionMode: "full-access",
    });
    expect(startSessionParams).not.toHaveProperty("title");
    expect(startedPrompts).toEqual([
      {
        sessionId: "session-1",
        prompt: "hello ACP",
        promptContent: [{ type: "text", text: "hello ACP" }],
        parts: [{ type: "text", text: "hello ACP" }],
        turnId: startedTurn.turnId,
      },
      {
        sessionId: "session-1",
        prompt: "What's in this image?",
        promptContent: [
          { type: "text", text: "What's in this image?" },
          { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
        ],
        parts: [
          { type: "text", text: "What's in this image?" },
          { type: "image", url: imageUrl },
        ],
        turnId: imageTurn.turnId,
      },
    ]);
    expect(cancelledSessions).toEqual(["session-1"]);
    expect(emittedEvents.map((event) => event.notification.method)).toEqual([
      "turn/started",
      "turn/completed",
      "turn/started",
      "turn/completed",
      "turn/cancelled",
    ]);

    await registry.close();
    expect(acpClient.dispose).toHaveBeenCalledTimes(1);
  });

  it("runs Kimi ACP execution mode changes through slash control prompts", async () => {
    const sessions: AcpSessionMetadata[] = [];
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const sendControlPrompt = vi
      .fn()
      .mockResolvedValueOnce({
        text: "You only live once! All actions will be auto-approved.",
      })
      .mockResolvedValueOnce({
        text: "You only die once! Actions will require approval.",
      });
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(),
      startSession: vi.fn(async (params: {
        cwd?: string;
        executionMode: "default" | "full-access";
      }) => {
        const metadata: AcpSessionMetadata = {
          backendId: acpBackendId,
          sessionId: "kimi-session-1",
          title: "ACP session",
          cwd: params.cwd,
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: params.executionMode,
          status: "idle",
        };
        sessions.push(metadata);
        return metadata;
      }),
      startPrompt: vi.fn(),
      sendControlPrompt,
      ensureSession: vi.fn(async () => undefined),
      loadSession: vi.fn(async (): Promise<AppServerThreadReplay> => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      })),
      refreshSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(),
      readReplay: vi.fn((): AppServerThreadReplay => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      })),
    };
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      grokClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "kimi",
          name: "Kimi Code CLI",
          version: "1.44.0",
          distributionKind: "local",
          distributionSource: "kimi acp",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-kimi-cli",
          installedAt: 1000,
          updatedAt: 2000,
          launchDescriptor: {
            backendId: acpBackendId,
            registryId: "kimi",
            distributionKind: "local",
            command: "kimi",
            args: ["acp"],
            env: {},
          },
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock(sessions),
      createAcpClient: () => acpClient,
    });

    const backends = await registry.listBackends({ includeUnavailable: true });
    expect(backends.backends.find((backend) => backend.kind === acpBackendId))
      .toMatchObject({
        executionModes: [
          { mode: "default", available: true },
          { mode: "full-access", available: true },
        ],
      });

    await expect(
      registry.startThread({
        backend: acpBackendId,
        cwd: "/repo/project",
        executionMode: "full-access",
      }),
    ).resolves.toMatchObject({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      executionMode: "full-access",
    });

    expect(sendControlPrompt).toHaveBeenCalledWith({
      sessionId: "kimi-session-1",
      prompt: "/yolo",
    });

    sendControlPrompt.mockClear();
    await expect(
      registry.setThreadExecutionMode({
        backend: acpBackendId,
        threadId: "kimi-session-1",
        executionMode: "default",
      }),
    ).resolves.toEqual({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      executionMode: "default",
    });
    expect(sendControlPrompt).toHaveBeenCalledWith({
      sessionId: "kimi-session-1",
      prompt: "/yolo",
    });
    expect(sessions[0]?.executionMode).toBe("default");

    await registry.close();
  });

  it("runs Grok ACP execution mode changes through /always-approve slash control prompts", async () => {
    // Regression test for the Grok-ACP Full Access bug: creating a Grok
    // thread with executionMode="full-access" must persist that mode to
    // session metadata AND surface it via listThreads, so the chip and
    // composer dropdown both read "Full Access" right after thread
    // creation. The slash command itself is fire-and-forget — Grok
    // returns no text confirmation, unlike Kimi's /yolo — so we trust a
    // clean resolve from sendControlPrompt.
    const sessions: AcpSessionMetadata[] = [];
    const acpBackendId = "acp:grok" as AcpBackendId;
    const sendControlPrompt = vi
      .fn(async () => ({ text: "" }));
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(),
      startSession: vi.fn(async (params: {
        cwd?: string;
        executionMode: "default" | "full-access";
      }) => {
        const metadata: AcpSessionMetadata = {
          backendId: acpBackendId,
          sessionId: "grok-session-1",
          title: "ACP session",
          cwd: params.cwd,
          createdAt: 1000,
          updatedAt: 1000,
          // Slash-controlled backends start the agent in "default" and
          // immediately flip via the slash command — so the seed mode
          // here is whatever startAcpSession passes, NOT the
          // user-requested target.
          executionMode: params.executionMode,
          status: "idle",
        };
        sessions.push(metadata);
        return metadata;
      }),
      startPrompt: vi.fn(),
      sendControlPrompt,
      ensureSession: vi.fn(async () => undefined),
      loadSession: vi.fn(async (): Promise<AppServerThreadReplay> => ({
        entries: [],
        messages: [],
        pagination: { supportsPagination: false, hasPreviousPage: false },
        threadStatus: "idle",
      })),
      refreshSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(),
      readReplay: vi.fn((): AppServerThreadReplay => ({
        entries: [],
        messages: [],
        pagination: { supportsPagination: false, hasPreviousPage: false },
        threadStatus: "idle",
      })),
    };
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      grokClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "grok",
          name: "Grok",
          version: "0.2.3",
          distributionKind: "local",
          distributionSource: "grok agent stdio",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-grok-cli",
          installedAt: 1000,
          updatedAt: 2000,
          launchDescriptor: {
            backendId: acpBackendId,
            registryId: "grok",
            distributionKind: "local",
            command: "grok",
            args: ["agent", "stdio"],
            env: {},
          },
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock(sessions),
      createAcpClient: () => acpClient,
    });

    const backends = await registry.listBackends({ includeUnavailable: true });
    expect(backends.backends.find((backend) => backend.kind === acpBackendId))
      .toMatchObject({
        executionModes: [
          { mode: "default", available: true },
          { mode: "full-access", available: true },
        ],
      });

    const startResponse = await registry.startThread({
      backend: acpBackendId,
      cwd: "/repo/project",
      executionMode: "full-access",
    });
    expect(startResponse).toMatchObject({
      backend: acpBackendId,
      threadId: "grok-session-1",
      executionMode: "full-access",
    });

    expect(sendControlPrompt).toHaveBeenCalledWith({
      sessionId: "grok-session-1",
      prompt: "/always-approve on",
    });
    expect(sessions[0]?.executionMode).toBe("full-access");

    // This is the assertion the user-reported bug fails on: listThreads
    // must surface the just-applied "full-access" mode so the renderer
    // chip + composer dropdown both reflect the user's choice the moment
    // the thread opens.
    const threads = await registry.listThreads({ backend: acpBackendId });
    const thread = threads.find(
      (candidate) => candidate.id === "grok-session-1",
    );
    expect(thread).toBeDefined();
    expect(thread?.executionMode).toBe("full-access");

    sendControlPrompt.mockClear();
    await expect(
      registry.setThreadExecutionMode({
        backend: acpBackendId,
        threadId: "grok-session-1",
        executionMode: "default",
      }),
    ).resolves.toEqual({
      backend: acpBackendId,
      threadId: "grok-session-1",
      executionMode: "default",
    });
    expect(sendControlPrompt).toHaveBeenCalledWith({
      sessionId: "grok-session-1",
      prompt: "/always-approve off",
    });
    expect(sessions[0]?.executionMode).toBe("default");

    await registry.close();
  });

  it("does not persist Kimi execution mode when /yolo confirms the wrong state", async () => {
    const { acpBackendId, registry, sendControlPrompt, sessions } =
      createKimiAcpRegistry({
        sessions: [
          {
            backendId: "acp:kimi" as AcpBackendId,
            sessionId: "kimi-session-1",
            title: "ACP session",
            createdAt: 1000,
            updatedAt: 1000,
            executionMode: "default",
            status: "idle",
          },
        ],
        sendControlPrompt: vi.fn(async () => ({
          text: "You only die once! Actions will require approval.",
        })),
      });

    await expect(
      registry.setThreadExecutionMode({
        backend: acpBackendId,
        threadId: "kimi-session-1",
        executionMode: "full-access",
      }),
    ).rejects.toThrow(/did not confirm Full Access/);

    expect(sendControlPrompt).toHaveBeenCalledWith({
      sessionId: "kimi-session-1",
      prompt: "/yolo",
    });
    expect(sessions[0]?.executionMode).toBe("default");

    await registry.close();
  });

  it("keeps the ACP client receiver when sending Kimi /yolo prompts", async () => {
    const sendControlPrompt = vi.fn(function (
      this: { controlPromptReceiverMarker?: boolean } | undefined,
    ) {
      if (this?.controlPromptReceiverMarker !== true) {
        throw new Error("lost ACP client receiver");
      }
      return Promise.resolve({
        text: "You only live once! All actions will be auto-approved.",
      });
    });
    const { acpBackendId, registry } = createKimiAcpRegistry({
      sendControlPrompt,
    });

    await expect(
      registry.startThread({
        backend: acpBackendId,
        cwd: "/repo/project",
        executionMode: "full-access",
      }),
    ).resolves.toMatchObject({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      executionMode: "full-access",
    });

    expect(sendControlPrompt).toHaveBeenCalledWith({
      sessionId: "kimi-session-1",
      prompt: "/yolo",
    });

    await registry.close();
  });

  it("materializes Kimi worktree launchpads with local environment setup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-kimi-launchpad-"));
    const worktreePath = path.join(root, ".worktrees", "thread-1", "app");
    await mkdir(path.join(root, ".codex", "environments"), { recursive: true });
    await writeFile(
      path.join(root, ".codex", "environments", "environment.toml"),
      `
version = 1
name = "Repo Environment"

[setup]
script = "echo setup"
`,
      "utf8",
    );
    const commandRunner = vi.fn(async () => ({ output: "setup", exitCode: 0 }));
    const recordCodexWorktreeOwnerThread = vi.fn(async () => {});
    const { acpBackendId, registry, sendControlPrompt, sessions } =
      createKimiAcpRegistry({
        codexEnvironmentCommandRunner: commandRunner,
        gitDirectoryService: {
          prepareLaunchpadWorkspace: vi.fn(async () => ({
            cwd: worktreePath,
            repositoryPath: root,
            workMode: "worktree" as const,
          })),
          recordCodexWorktreeOwnerThread,
        },
      });

    try {
      const response = await registry.materializeDirectoryLaunchpad({
        directoryKey: `directory:${root}`,
        launchpad: {
          directoryKey: `directory:${root}`,
          directoryKind: "directory",
          directoryLabel: "app",
          directoryPath: root,
          backend: acpBackendId,
          executionMode: "full-access",
          prompt: "",
          workMode: "worktree",
          model: "kimi-for-coding",
          codexEnvironmentId: "environment",
          codexEnvironmentExecutionTarget: "local",
          codexEnvironmentSetupEnabled: true,
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      });

      expect(response).toMatchObject({
        backend: acpBackendId,
        threadId: "kimi-session-1",
        executionMode: "full-access",
        workMode: "worktree",
        linkedDirectory: {
          id: root,
          kind: "worktree",
          label: "app",
          path: root,
          worktreePath,
        },
      });
      expect(response.codexEnvironmentRuntime).toMatchObject({
        environmentId: "environment",
        environmentName: "Repo Environment",
        executionTarget: "local",
        cwd: worktreePath,
        setupEnabled: true,
        setupStatus: "completed",
        setupCommand: "echo setup",
        setupOutput: "setup",
      });
      expect(response.codexEnvironmentStartupFailure).toBeUndefined();
      expect(commandRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: worktreePath,
          command: "echo setup",
          mode: "wait",
        }),
      );
      expect(recordCodexWorktreeOwnerThread).not.toHaveBeenCalled();
      expect(sendControlPrompt).toHaveBeenCalledWith({
        sessionId: "kimi-session-1",
        prompt: "/yolo",
      });
      expect(sessions[0]).toMatchObject({
        cwd: worktreePath,
        executionMode: "full-access",
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps new Kimi sessions at default when startup /yolo fails", async () => {
    const { acpBackendId, registry, sessions } = createKimiAcpRegistry({
      sendControlPrompt: vi.fn(async () => {
        throw new Error("control prompt failed");
      }),
    });

    await expect(
      registry.startThread({
        backend: acpBackendId,
        cwd: "/repo/project",
        executionMode: "full-access",
      }),
    ).rejects.toThrow("control prompt failed");

    expect(sessions[0]?.executionMode).toBe("default");

    await registry.close();
  });

  it("queues Kimi ACP execution mode changes during active turns and flushes once", async () => {
    const events: AgentEvent[] = [];
    const { acpBackendId, registry, sendControlPrompt, sessions } =
      createKimiAcpRegistry({
        sessions: [
          {
            backendId: "acp:kimi" as AcpBackendId,
            sessionId: "kimi-session-1",
            title: "ACP session",
            createdAt: 1000,
            updatedAt: 1000,
            executionMode: "default",
            status: "idle",
          },
        ],
        sendControlPrompt: vi.fn(async () => ({
          text: "You only live once! All actions will be auto-approved.",
        })),
      });
    registry.onEvent((event) => {
      events.push(event);
    });

    await expect(
      registry.listThreads({ backend: acpBackendId }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "kimi-session-1",
        executionMode: "default",
      }),
    ]);

    await registry.startTurn({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      input: [{ type: "text", text: "work" }],
    });

    await expect(
      registry.setThreadExecutionMode({
        backend: acpBackendId,
        threadId: "kimi-session-1",
        executionMode: "full-access",
      }),
    ).resolves.toEqual({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      executionMode: "full-access",
    });
    expect(sendControlPrompt).not.toHaveBeenCalled();

    await (registry as unknown as { emit(event: AgentEvent): Promise<void> }).emit({
      backend: acpBackendId,
      notification: {
        method: "turn/completed",
        params: {
          threadId: "kimi-session-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [],
          },
        },
      },
    });
    await vi.waitFor(() => {
      expect(sendControlPrompt).toHaveBeenCalledTimes(1);
    });

    expect(sessions[0]?.executionMode).toBe("full-access");
    await expect(
      registry.listThreads({ backend: acpBackendId }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "kimi-session-1",
        executionMode: "full-access",
      }),
    ]);
    const methods = events.map((event) => event.notification.method);
    expect(methods).toContain("thread/executionMode/queued");
    expect(methods).toContain("thread/executionMode/updated");
    expect(methods).toContain("thread/executionMode/queueCleared");

    await registry.close();
  });

  it("serializes Kimi control prompts before starting the next ACP turn", async () => {
    const controlPrompt = createDeferred<{ text: string }>();
    const startPrompt = vi.fn(() => ({
      sessionId: "kimi-session-1",
      turnId: "turn-1",
    }));
    const sendControlPrompt = vi.fn(() => controlPrompt.promise);
    const { acpBackendId, registry } = createKimiAcpRegistry({
      sessions: [
        {
          backendId: "acp:kimi" as AcpBackendId,
          sessionId: "kimi-session-1",
          title: "ACP session",
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: "default",
          status: "idle",
        },
      ],
      sendControlPrompt,
      startPrompt,
    });

    const modeChange = registry.setThreadExecutionMode({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      executionMode: "full-access",
    });
    await vi.waitFor(() => {
      expect(sendControlPrompt).toHaveBeenCalledTimes(1);
    });
    const turnStart = registry.startTurn({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      input: [{ type: "text", text: "after mode change" }],
    });
    await flushAsync();
    expect(startPrompt).not.toHaveBeenCalled();

    controlPrompt.resolve({
      text: "You only live once! All actions will be auto-approved.",
    });
    await expect(modeChange).resolves.toMatchObject({
      backend: acpBackendId,
      executionMode: "full-access",
    });
    await expect(turnStart).resolves.toMatchObject({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      turnId: "turn-1",
    });
    expect(startPrompt).toHaveBeenCalledTimes(1);

    await registry.close();
  });

  it("uses the latest applied Kimi permission transition when session metadata is stale", async () => {
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "acp:kimi:kimi-session-1": {
          backend: "acp:kimi",
          threadId: "kimi-session-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          permissionTransitionLog: [
            {
              id: "transition-1",
              fromExecutionMode: "default",
              toExecutionMode: "full-access",
              status: "applied",
              occurredAt: 2000,
            },
          ],
        } as ThreadOverlayState,
      },
    });
    const sendControlPrompt = vi.fn(async () => ({
      text: "You only live once! All actions will be auto-approved.",
    }));
    const { acpBackendId, registry, sessions } = createKimiAcpRegistry({
      overlayStore,
      sendControlPrompt,
      sessions: [
        {
          backendId: "acp:kimi" as AcpBackendId,
          sessionId: "kimi-session-1",
          title: "ACP session",
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: "default",
          status: "idle",
        },
      ],
    });

    await expect(
      registry.listThreads({ backend: acpBackendId }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "kimi-session-1",
        executionMode: "full-access",
      }),
    ]);

    await expect(
      registry.setThreadExecutionMode({
        backend: acpBackendId,
        threadId: "kimi-session-1",
        executionMode: "full-access",
      }),
    ).resolves.toEqual({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      executionMode: "full-access",
    });

    expect(sendControlPrompt).not.toHaveBeenCalled();
    expect(sessions[0]?.executionMode).toBe("default");

    await registry.close();
  });

  it("isolates queued execution modes by backend when thread ids collide", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/resume"] },
    });
    const { acpBackendId, registry } = createKimiAcpRegistry({
      codexClient,
      sessions: [
        {
          backendId: "acp:kimi" as AcpBackendId,
          sessionId: "same-thread",
          title: "ACP session",
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: "default",
          status: "idle",
        },
      ],
    });

    await registry.queueThreadExecutionMode({
      backend: "codex",
      threadId: "same-thread",
      executionMode: "full-access",
    });
    await registry.queueThreadExecutionMode({
      backend: acpBackendId,
      threadId: "same-thread",
      executionMode: "full-access",
    });

    expect(registry.getQueuedExecutionModesSnapshot()).toMatchObject({
      [buildThreadIdentityKey("codex", "same-thread")]: {
        mode: "full-access",
      },
      [buildThreadIdentityKey(acpBackendId, "same-thread")]: {
        mode: "full-access",
      },
    });

    await registry.cancelThreadExecutionModeQueue({
      backend: "codex",
      threadId: "same-thread",
    });

    expect(registry.getQueuedExecutionModesSnapshot()).toMatchObject({
      [buildThreadIdentityKey(acpBackendId, "same-thread")]: {
        mode: "full-access",
      },
    });
    expect(
      registry.getQueuedExecutionModesSnapshot()[
        buildThreadIdentityKey("codex", "same-thread")
      ],
    ).toBeUndefined();

    await registry.close();
  });

  it("reads persisted ACP sessions locally and refreshes the agent in the background", async () => {
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const localReplay: AppServerThreadReplay = {
      entries: [
        {
          type: "message",
          id: "assistant:cached",
          role: "assistant",
          text: "Cached ACP transcript",
          createdAt: 1002,
        },
      ],
      messages: [
        {
          id: "assistant:cached",
          role: "assistant",
          text: "Cached ACP transcript",
          createdAt: 1002,
        },
      ],
      lastAssistantMessage: "Cached ACP transcript",
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
      threadStatus: "idle",
    };
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      startSession: vi.fn(),
      startPrompt: vi.fn(),
      cancelSession: vi.fn(),
      ensureSession: vi.fn(async () => undefined),
      readReplay: vi.fn(() => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      })),
      loadSession: vi.fn(async () => localReplay),
      refreshSession: vi.fn(async () => undefined),
    };
    const session: AcpSessionMetadata = {
      backendId: acpBackendId,
      sessionId: "session-1",
      title: "Stored ACP Thread",
      cwd: "/repo/project",
      createdAt: 1000,
      updatedAt: 3000,
      executionMode: "default",
      status: "idle",
    };
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      grokClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
          launchDescriptor: {
            backendId: acpBackendId,
            registryId: "gemini",
            distributionKind: "local",
            command: "gemini",
            args: ["--acp", "--skip-trust"],
            env: {},
          },
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock([session]),
      createAcpClient: () => acpClient,
    });

    await expect(
      registry.readThread({
        backend: acpBackendId,
        threadId: "session-1",
      }),
    ).resolves.toMatchObject({
      backend: acpBackendId,
      threadId: "session-1",
      replay: {
        lastAssistantMessage: "Cached ACP transcript",
      },
    });
    expect(acpClient.initialize).toHaveBeenCalledTimes(1);
    expect(acpClient.loadSession).toHaveBeenCalledWith(session);
    expect(acpClient.refreshSession).toHaveBeenCalledWith(session);

    await registry.close();
  });

  it("preserves ACP launchpad model selections when starting sessions", async () => {
    const sessions: AcpSessionMetadata[] = [];
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const setRuntimeOption = vi.fn(
      async (params: {
        sessionId: string;
        source: BackendAcpRuntimeOptionSource;
        optionId: string;
        value: string;
      }): Promise<BackendAcpSessionRuntimeState> =>
        params.source === "model"
          ? { currentModelId: params.value, updatedAt: 1001 }
          : { configValues: { [params.optionId]: params.value }, updatedAt: 1001 },
    );
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(),
      startSession: vi.fn(async (params: {
        cwd?: string;
        executionMode: ThreadExecutionMode;
        title?: string;
        acpRuntime?: BackendAcpSessionRuntimeState;
      }) => {
        const metadata: AcpSessionMetadata = {
          backendId: acpBackendId,
          sessionId: "session-1",
          title: params.title ?? "ACP session",
          titleSource: params.title ? "explicit" : "fallback",
          cwd: params.cwd,
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: params.executionMode,
          acpRuntime: params.acpRuntime,
          status: "idle",
        };
        sessions.push(metadata);
        return metadata;
      }),
      startPrompt: vi.fn(),
      ensureSession: vi.fn(async () => undefined),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(),
      readReplay: vi.fn((): AppServerThreadReplay => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      })),
      setRuntimeOption,
    };
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      grokClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
          runtimeCapabilities: {
            schemaVersion: 1,
            status: "discovered",
            models: {
              currentModelId: "gemini-3-flash-preview",
              availableModels: [
                {
                  id: "gemini-3-flash-preview",
                  label: "Gemini 3 Flash Preview",
                },
                {
                  id: "gemini-3-pro-preview",
                  label: "Gemini 3 Pro Preview",
                },
              ],
            },
          },
          launchDescriptor: {
            backendId: acpBackendId,
            registryId: "gemini",
            distributionKind: "local",
            command: "gemini",
            args: ["--acp"],
            env: {},
          },
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock(sessions),
      createAcpClient: () => acpClient,
    });

    await expect(
      registry.startThread({
        backend: acpBackendId,
        cwd: "/repo/project",
        executionMode: "default",
        model: "gemini-3-pro-preview",
      }),
    ).resolves.toMatchObject({
      backend: acpBackendId,
      threadId: "session-1",
    });

    expect(acpClient.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/repo/project",
        executionMode: "default",
        acpRuntime: expect.objectContaining({
          currentModelId: "gemini-3-pro-preview",
        }),
      }),
    );
    expect(setRuntimeOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      source: "model",
      optionId: "model",
      value: "gemini-3-pro-preview",
    });
    expect(sessions[0]?.acpRuntime).toMatchObject({
      currentModelId: "gemini-3-pro-preview",
    });

    await registry.close();
  });

  it("does not send privileged Gemini ACP modes for default access sessions", async () => {
    const sessions: AcpSessionMetadata[] = [];
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const setRuntimeOption = vi.fn(
      async (params: {
        sessionId: string;
        source: BackendAcpRuntimeOptionSource;
        optionId: string;
        value: string;
      }): Promise<BackendAcpSessionRuntimeState> =>
        params.source === "configOption"
          ? { configValues: { [params.optionId]: params.value }, updatedAt: 1001 }
          : { currentModeId: params.value, updatedAt: 1001 },
    );
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(),
      startSession: vi.fn(async (params: {
        cwd?: string;
        executionMode: "default" | "full-access";
        title?: string;
        acpRuntime?: BackendAcpSessionRuntimeState;
      }) => {
        const metadata: AcpSessionMetadata = {
          backendId: acpBackendId,
          sessionId: "session-1",
          title: params.title ?? "ACP session",
          cwd: params.cwd,
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: params.executionMode,
          acpRuntime: params.acpRuntime,
          status: "idle",
        };
        sessions.push(metadata);
        return metadata;
      }),
      startPrompt: vi.fn(),
      ensureSession: vi.fn(async () => undefined),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(),
      readReplay: vi.fn((): AppServerThreadReplay => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      })),
      setRuntimeOption,
    };
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      grokClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
          launchDescriptor: {
            backendId: acpBackendId,
            registryId: "gemini",
            distributionKind: "local",
            command: "gemini",
            args: ["--acp", "--skip-trust"],
            env: {},
          },
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock(sessions),
      createAcpClient: () => acpClient,
    });

    await registry.startThread({
      backend: acpBackendId,
      cwd: "/repo/project",
      executionMode: "default",
      acpRuntime: {
        configValues: { "approval-mode": "yolo" },
        currentModeId: "yolo",
      },
    });

    expect(acpClient.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        acpRuntime: {
          configValues: { "approval-mode": "default" },
          currentModeId: "default",
        },
      }),
    );
    expect(setRuntimeOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      source: "configOption",
      optionId: "approval-mode",
      value: "default",
    });
    expect(setRuntimeOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      source: "mode",
      optionId: "mode",
      value: "default",
    });
    expect(setRuntimeOption).not.toHaveBeenCalledWith(
      expect.objectContaining({ value: "yolo" }),
    );
    expect(sessions[0]?.acpRuntime).toEqual({
      configValues: { "approval-mode": "default" },
      currentModeId: "default",
    });

    await registry.close();
  });

  it("rejects a second ACP turn while the first start is still resolving", async () => {
    const ensureSession = createDeferred<void>();
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const session: AcpSessionMetadata = {
      backendId: acpBackendId,
      sessionId: "session-1",
      title: "ACP session",
      cwd: "/repo/project",
      createdAt: 1000,
      updatedAt: 1000,
      executionMode: "default",
      status: "idle",
    };
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(),
      startSession: vi.fn(),
      startPrompt: vi.fn((params: {
        sessionId: string;
        prompt: string;
        turnId?: string;
      }) => ({
        sessionId: params.sessionId,
        turnId: params.turnId ?? "pending:session-1:1001",
      })),
      ensureSession: vi.fn(async () => await ensureSession.promise),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(),
      readReplay: vi.fn((): AppServerThreadReplay => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "active",
      })),
    };
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      grokClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
          launchDescriptor: {
            backendId: acpBackendId,
            registryId: "gemini",
            distributionKind: "local",
            command: "gemini",
            args: ["--acp", "--skip-trust"],
            env: {},
          },
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock([session]),
      createAcpClient: () => acpClient,
    });

    const firstTurn = registry.startTurn({
      backend: acpBackendId,
      threadId: "session-1",
      input: [{ type: "text", text: "first" }],
    });
    await waitForCondition(() => acpClient.ensureSession.mock.calls.length === 1);

    await expect(
      registry.startTurn({
        backend: acpBackendId,
        threadId: "session-1",
        input: [{ type: "text", text: "second" }],
      }),
    ).rejects.toThrow("A turn is already active for this thread.");

    ensureSession.resolve();
    await expect(firstTurn).resolves.toMatchObject({
      backend: acpBackendId,
      threadId: "session-1",
    });
    expect(acpClient.startPrompt).toHaveBeenCalledTimes(1);

    await registry.close();
  });

  it("keeps stored ACP sessions readable when the agent cannot reload them", async () => {
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const session: AcpSessionMetadata = {
      backendId: acpBackendId,
      sessionId: "session-1",
      title: "Stored Gemini Thread",
      cwd: "/repo/project",
      createdAt: 1000,
      updatedAt: 3000,
      executionMode: "default",
      status: "idle",
    };
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      startSession: vi.fn(),
      startPrompt: vi.fn(),
      cancelSession: vi.fn(),
      ensureSession: vi.fn(async () => undefined),
      readReplay: vi.fn(),
      loadSession: vi.fn(async (): Promise<AppServerThreadReplay> => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      })),
      refreshSession: vi.fn(async () => {
        throw new Error("No previous sessions found for this project.");
      }),
    };
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      grokClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
          launchDescriptor: {
            backendId: acpBackendId,
            registryId: "gemini",
            distributionKind: "local",
            command: "gemini",
            args: ["--acp", "--skip-trust"],
            env: {},
          },
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock([session]),
      createAcpClient: () => acpClient,
    });

    await expect(
      registry.readThread({
        backend: acpBackendId,
        threadId: "session-1",
      }),
    ).resolves.toMatchObject({
      backend: acpBackendId,
      threadId: "session-1",
      replay: {
        entries: [],
        threadStatus: "idle",
      },
    });
    expect(acpClient.loadSession).toHaveBeenCalledWith(session);
    expect(acpClient.refreshSession).toHaveBeenCalledWith(session);

    await registry.close();
  });

  it("replays persisted ACP transcript updates when agent reload fails", async () => {
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const session: AcpSessionMetadata = {
      backendId: acpBackendId,
      sessionId: "session-1",
      title: "Stored Gemini Thread",
      cwd: "/repo/project",
      createdAt: 1000,
      updatedAt: 3000,
      executionMode: "default",
      status: "idle",
      hasConversationHistory: true,
    };
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      startSession: vi.fn(),
      startPrompt: vi.fn(),
      cancelSession: vi.fn(),
      ensureSession: vi.fn(async () => undefined),
      readReplay: vi.fn(),
      loadSession: vi.fn(async (): Promise<AppServerThreadReplay> => ({
        entries: [
          {
            type: "message",
            id: "user:session-1:2000",
            role: "user",
            text: "What is this project?",
            createdAt: 2000,
          },
          {
            type: "message",
            id: "assistant:session-1:2100",
            role: "assistant",
            text: "It is PwrSnap.",
            createdAt: 2100,
          },
        ],
        messages: [
          {
            id: "user:session-1:2000",
            role: "user",
            text: "What is this project?",
            createdAt: 2000,
          },
          {
            id: "assistant:session-1:2100",
            role: "assistant",
            text: "It is PwrSnap.",
            createdAt: 2100,
          },
        ],
        lastUserMessage: "What is this project?",
        lastAssistantMessage: "It is PwrSnap.",
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      })),
      refreshSession: vi.fn(async () => {
        throw new Error("No previous sessions found for this project.");
      }),
    };
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      grokClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
          launchDescriptor: {
            backendId: acpBackendId,
            registryId: "gemini",
            distributionKind: "local",
            command: "gemini",
            args: ["--acp", "--skip-trust"],
            env: {},
          },
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock([session]),
      createAcpClient: () => acpClient,
    });

    await expect(
      registry.readThread({
        backend: acpBackendId,
        threadId: "session-1",
      }),
    ).resolves.toMatchObject({
      replay: {
        lastUserMessage: "What is this project?",
        lastAssistantMessage: "It is PwrSnap.",
        threadStatus: "idle",
        messages: [
          expect.objectContaining({ role: "user", text: "What is this project?" }),
          expect.objectContaining({ role: "assistant", text: "It is PwrSnap." }),
        ],
      },
    });

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

  it("passes automation inspection dynamic tools when starting Codex threads", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      createScratchProjectDirectory: async () => "/tmp/pwragent-scratch",
    });

    await registry.startThread({ backend: "codex" });

    expect(codexClient.lastStartThreadParams?.dynamicTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          namespace: "pwragent_automations",
          name: "list_automations",
        }),
        expect.objectContaining({
          namespace: "pwragent_automations",
          name: "get_automation_run_artifact",
        }),
      ]),
    );

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

  it("does not let non-backfilling cheap list cache suppress navigation backfill", async () => {
    const projectA = "/Users/huntharo/projects/ProjectA";
    const worktreePath = "/Users/huntharo/.codex/profiles/sstk/worktrees/wt1/ProjectA";
    const cheapThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "ProjectA worktree",
      titleSource: "explicit",
      source: "codex",
      projectKey: worktreePath,
      createdAt: 1_000,
      updatedAt: 1_000,
      linkedDirectories: [
        {
          id: worktreePath,
          label: "ProjectA",
          path: worktreePath,
          kind: "local",
        },
      ],
    };
    const codexClient = new MockBackendClient({
      threads: [cheapThread],
    });
    const enrichThreadDirectories = vi.fn(
      async (threads: AppServerThreadSummary[]) =>
        threads.map((thread) => ({
          ...thread,
          linkedDirectories: [
            {
              id: projectA,
              label: "ProjectA",
              path: projectA,
              worktreePath,
              kind: "worktree" as const,
            },
          ],
        })),
    );
    Object.assign(codexClient, { enrichThreadDirectories });
    const overlayStore = createOverlayStoreMock();
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({}),
      overlayStore,
    });

    await registry.listThreads({
      backend: "codex",
      callerReason: "branch-drift",
    });
    expect(enrichThreadDirectories).not.toHaveBeenCalled();

    await registry.listThreads({
      backend: "codex",
      callerReason: "startup-prewarm",
    });

    expect(codexClient.listThreadsCallCount).toBe(2);
    expect(enrichThreadDirectories).toHaveBeenCalledTimes(1);
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      extraLinkedDirectories: [
        expect.objectContaining({
          id: worktreePath,
          path: projectA,
          worktreePath,
          kind: "worktree",
        }),
      ],
    });

    await registry.close();
  });

  it("lets fresh Codex local metadata replace stale overlay worktree relationships", async () => {
    const projectA = "/Users/huntharo/projects/ProjectA";
    const staleWorktreePath =
      "/Users/huntharo/.codex/profiles/sstk/worktrees/wt1/ProjectA";
    const localThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "ProjectA local",
      titleSource: "explicit",
      source: "codex",
      projectKey: projectA,
      createdAt: 1_000,
      updatedAt: 1_000,
      linkedDirectories: [
        {
          id: projectA,
          label: "ProjectA",
          path: projectA,
          kind: "local",
        },
      ],
    };
    const codexClient = new MockBackendClient({
      threads: [localThread],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [
            {
              id: staleWorktreePath,
              label: "ProjectA",
              path: projectA,
              worktreePath: staleWorktreePath,
              kind: "worktree",
            },
          ],
        },
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({}),
      overlayStore,
    });

    await registry.listThreads({
      backend: "codex",
      callerReason: "startup-prewarm",
    });

    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      extraLinkedDirectories: [
        {
          id: projectA,
          label: "ProjectA",
          path: projectA,
          kind: "local",
        },
      ],
    });

    await registry.close();
  });

  it("does not let Codex source metadata replace active handoff workspace overlays", async () => {
    const projectA = "/Users/huntharo/projects/ProjectA";
    const handoffWorktreePath = "/Users/huntharo/projects/ProjectA/.worktrees/thread-1";
    const localThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "ProjectA local",
      titleSource: "explicit",
      source: "codex",
      projectKey: projectA,
      createdAt: 1_000,
      updatedAt: 1_000,
      linkedDirectories: [
        {
          id: projectA,
          label: "ProjectA",
          path: projectA,
          kind: "local",
        },
      ],
    };
    const codexClient = new MockBackendClient({
      threads: [localThread],
    });
    const handoffDirectory: ThreadOverlayState["extraLinkedDirectories"][number] = {
      id: "pwragent-handoff:codex:thread-1",
      label: "ProjectA",
      path: projectA,
      worktreePath: handoffWorktreePath,
      kind: "worktree",
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [handoffDirectory],
        },
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({}),
      overlayStore,
    });

    await registry.listThreads({
      backend: "codex",
      callerReason: "startup-prewarm",
    });

    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      extraLinkedDirectories: [handoffDirectory],
    });

    await registry.close();
  });

  it("does not let Codex source worktree metadata replace active handoff workspace overlays", async () => {
    const projectA = "/Users/huntharo/projects/ProjectA";
    const codexWorktreePath =
      "/Users/huntharo/.codex/profiles/sstk/worktrees/original/ProjectA";
    const handoffWorktreePath = "/Users/huntharo/projects/ProjectA/.worktrees/thread-1";
    const worktreeThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "ProjectA worktree",
      titleSource: "explicit",
      source: "codex",
      projectKey: codexWorktreePath,
      createdAt: 1_000,
      updatedAt: 1_000,
      linkedDirectories: [
        {
          id: projectA,
          label: "ProjectA",
          path: projectA,
          worktreePath: codexWorktreePath,
          kind: "worktree",
        },
      ],
    };
    const codexClient = new MockBackendClient({
      threads: [worktreeThread],
    });
    const handoffDirectory: ThreadOverlayState["extraLinkedDirectories"][number] = {
      id: "pwragent-handoff:codex:thread-1",
      label: "ProjectA",
      path: projectA,
      worktreePath: handoffWorktreePath,
      kind: "worktree",
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [handoffDirectory],
        },
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({}),
      overlayStore,
    });

    await registry.listThreads({
      backend: "codex",
      callerReason: "startup-prewarm",
    });

    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      extraLinkedDirectories: [handoffDirectory],
    });

    await registry.close();
  });

  it("does not backfill Codex worktree metadata over active handoff workspace overlays", async () => {
    const projectA = "/Users/huntharo/projects/ProjectA";
    const codexWorktreePath =
      "/Users/huntharo/.codex/profiles/sstk/worktrees/original/ProjectA";
    const handoffWorktreePath = "/Users/huntharo/projects/ProjectA/.worktrees/thread-1";
    const cheapThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "ProjectA worktree",
      titleSource: "explicit",
      source: "codex",
      projectKey: codexWorktreePath,
      createdAt: 1_000,
      updatedAt: 1_000,
      linkedDirectories: [
        {
          id: codexWorktreePath,
          label: "ProjectA",
          path: codexWorktreePath,
          kind: "local",
        },
      ],
    };
    const codexClient = new MockBackendClient({
      threads: [cheapThread],
    });
    const enrichThreadDirectories = vi.fn(
      async (threads: AppServerThreadSummary[]) =>
        threads.map((thread) => ({
          ...thread,
          linkedDirectories: [
            {
              id: projectA,
              label: "ProjectA",
              path: projectA,
              worktreePath: codexWorktreePath,
              kind: "worktree" as const,
            },
          ],
        })),
    );
    Object.assign(codexClient, { enrichThreadDirectories });
    const handoffDirectory: ThreadOverlayState["extraLinkedDirectories"][number] = {
      id: "pwragent-handoff:codex:thread-1",
      label: "ProjectA",
      path: projectA,
      worktreePath: handoffWorktreePath,
      kind: "worktree",
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [handoffDirectory],
        },
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({}),
      overlayStore,
    });

    await registry.listThreads({
      backend: "codex",
      callerReason: "startup-prewarm",
    });

    expect(enrichThreadDirectories).not.toHaveBeenCalled();
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      extraLinkedDirectories: [handoffDirectory],
    });

    await registry.close();
  });

  it("repairs a selected Codex worktree thread with a single-thread directory enrichment", async () => {
    const projectA = "/Users/example/ProjectA";
    const worktreePath = "/Users/example/.codex/worktrees/worktree-1/ProjectA";
    const nestedWorktreeCwd = `${worktreePath}/apps/desktop`;
    const cheapThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "ProjectA worktree",
      titleSource: "explicit",
      source: "codex",
      projectKey: nestedWorktreeCwd,
      createdAt: 1_000,
      updatedAt: 2_000,
      linkedDirectories: [
        {
          id: nestedWorktreeCwd,
          label: "desktop",
          path: nestedWorktreeCwd,
          kind: "local",
        },
      ],
    };
    const codexClient = new MockBackendClient({
      threads: [cheapThread],
    });
    const enrichThreadDirectories = vi.fn(
      async (threads: AppServerThreadSummary[]) =>
        threads.map((thread) => ({
          ...thread,
          linkedDirectories: [
            {
              id: projectA,
              label: "ProjectA",
              path: projectA,
              worktreePath,
              kind: "worktree" as const,
            },
          ],
        })),
    );
    Object.assign(codexClient, { enrichThreadDirectories });
    const overlayStore = createOverlayStoreMock();
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({}),
      overlayStore,
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });

    await registry.readThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(enrichThreadDirectories).toHaveBeenCalledTimes(1);
    expect(enrichThreadDirectories).toHaveBeenCalledWith([cheapThread]);
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      extraLinkedDirectories: [
        expect.objectContaining({
          id: nestedWorktreeCwd,
          path: projectA,
          worktreePath,
          kind: "worktree",
        }),
      ],
    });
    expect(events).toContainEqual({
      backend: "codex",
      notification: {
        method: "navigation/threadDirectories/updated",
        params: {
          reason: "selected-thread",
          threadIds: ["thread-1"],
        },
      },
    });

    unsubscribe();
    await registry.close();
  });

  it("runs the full Codex directory reconcile once after three distinct selected-thread repairs", async () => {
    const projectA = "/Users/example/ProjectA";
    const makeCheapThread = (index: number): AppServerThreadSummary => {
      const projectKey = `/Users/example/.codex/worktrees/worktree-${index}/ProjectA`;
      return {
        id: `thread-${index}`,
        title: `ProjectA worktree ${index}`,
        titleSource: "explicit",
        source: "codex",
        projectKey,
        createdAt: 1_000 + index,
        updatedAt: 2_000 + index,
        linkedDirectories: [
          {
            id: projectKey,
            label: `worktree-${index}`,
            path: projectKey,
            kind: "local",
          },
        ],
      };
    };
    const cheapThreads = [1, 2, 3, 4, 5].map(makeCheapThread);
    const codexClient = new MockBackendClient({
      threads: cheapThreads,
    });
    const enrichThreadDirectories = vi.fn(
      async (threads: AppServerThreadSummary[]) =>
        threads.map((thread) => ({
          ...thread,
          linkedDirectories: [
            {
              id: projectA,
              label: "ProjectA",
              path: projectA,
              worktreePath: thread.projectKey,
              kind: "worktree" as const,
            },
          ],
        })),
    );
    Object.assign(codexClient, { enrichThreadDirectories });
    const overlayStore = createOverlayStoreMock();
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({}),
      overlayStore,
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });

    await registry.readThread({ backend: "codex", threadId: "thread-1" });
    await registry.readThread({ backend: "codex", threadId: "thread-2" });
    const fullReconcileCalls = () =>
      enrichThreadDirectories.mock.calls.filter(([threads]) => threads.length > 1);
    expect(fullReconcileCalls()).toHaveLength(0);
    await registry.readThread({ backend: "codex", threadId: "thread-3" });

    await waitForCondition(() =>
      enrichThreadDirectories.mock.calls.some(
        ([threads]) =>
          threads.length === 2 &&
          threads.map((thread) => thread.id).join(",") === "thread-4,thread-5",
      ),
    );
    expect(fullReconcileCalls()).toHaveLength(1);
    const hasFullReconcileEvent = () =>
      events.some(
        (event) =>
          event.backend === "codex" &&
          event.notification.method === "navigation/threadDirectories/updated" &&
          (event.notification.params as { reason?: string; threadIds?: string[] })
            .reason === "full-reconcile" &&
          (event.notification.params as { threadIds?: string[] }).threadIds?.join(
            ",",
          ) === "thread-4,thread-5",
      );
    await waitForCondition(hasFullReconcileEvent);
    expect(hasFullReconcileEvent()).toBe(true);

    const lateThread = makeCheapThread(6);
    codexClient.setThreads([...cheapThreads, lateThread]);
    await registry.readThread({ backend: "codex", threadId: "thread-6" });
    await flushAsync();

    expect(fullReconcileCalls()).toHaveLength(1);

    unsubscribe();
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

  it("keeps environment options available after switching a launchpad to ACP", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-acp-env-options-"));
    await mkdir(path.join(root, ".codex", "environments"), { recursive: true });
    await writeFile(
      path.join(root, ".codex", "environments", "environment.toml"),
      `
version = 1
name = "Repo Environment"

[setup]
script = "pnpm install"
`,
      "utf8",
    );

    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    try {
      await registry.ensureDirectoryLaunchpad({
        directoryKey: `directory:${root}`,
        directoryKind: "directory",
        directoryLabel: "repo",
        directoryPath: root,
      });

      const updated = await registry.updateDirectoryLaunchpad({
        directoryKey: `directory:${root}`,
        patch: {
          backend: "acp:kimi" as AcpBackendId,
          codexEnvironmentId: undefined,
          codexEnvironmentExecutionTarget: undefined,
          codexEnvironmentSetupEnabled: false,
          codexEnvironmentActionId: undefined,
        },
      });

      expect(updated.launchpad.backend).toBe("acp:kimi");
      expect(updated.launchpad.codexEnvironmentOptions).toMatchObject([
        {
          id: "environment",
          name: "Repo Environment",
          setupScript: "pnpm install",
        },
      ]);
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
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
    expect(codexClient.lastStartThreadParams).toMatchObject({
      cwd: "/Users/test/.pwragent/projects/2026-04-16-a1b2c3",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      serviceTier: undefined,
      fastMode: undefined,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      dynamicTools: expect.arrayContaining([
        expect.objectContaining({
          namespace: "pwragent_automations",
          name: "list_automations",
        }),
      ]),
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

  it("surfaces environment options on existing ACP threads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-acp-thread-env-"));
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

    const { acpBackendId, registry } = createKimiAcpRegistry({
      sessions: [
        {
          backendId: "acp:kimi" as AcpBackendId,
          sessionId: "kimi-session-1",
          title: "Kimi thread",
          titleSource: "explicit",
          cwd: root,
          createdAt: 1_000,
          updatedAt: 2_000,
          executionMode: "default",
          status: "idle",
        },
      ],
    });

    try {
      await expect(registry.listThreads({ backend: acpBackendId })).resolves.toEqual([
        expect.objectContaining({
          id: "kimi-session-1",
          source: acpBackendId,
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
    const events: AgentEvent[] = [];
    registry.onEvent((event) => {
      events.push(event);
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

      expect(
        events.find(
          (event) =>
            event.notification.method === "thread/codexEnvironment/updated",
        ),
      ).toMatchObject({
        backend: "codex",
        notification: {
          method: "thread/codexEnvironment/updated",
          params: {
            threadId: "thread-1",
            codexEnvironmentRuntime: {
              environmentId: "environment",
              environmentName: "PwrAgnt",
            },
          },
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
          actionRuns: [
            expect.objectContaining({
              actionId: "dev-messaging",
              actionName: "Dev - Messaging",
              status: "started",
            }),
          ],
        },
      });
      await expectEventually(async () => await readFile(outputPath, "utf8"), "action-ran");
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs existing-thread environment actions from the current worktree directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-env-worktree-"));
    const localPath = path.join(root, "local");
    const worktreePath = path.join(root, "worktree");
    const outputPath = path.join(root, "action-cwd.txt");
    await mkdir(localPath, { recursive: true });
    await mkdir(worktreePath, { recursive: true });

    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [
            {
              id: "fixture-repo",
              label: "FixtureRepo",
              path: localPath,
              worktreePath,
              kind: "worktree",
            },
          ],
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgnt",
            executionTarget: "local",
            cwd: localPath,
            setupEnabled: false,
            actions: [
              {
                id: "capture-cwd",
                name: "Capture CWD",
                command: `node -e "require('node:fs').writeFileSync(process.argv[1], process.cwd())" ${JSON.stringify(outputPath)}`,
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
          actionId: "capture-cwd",
        }),
      ).resolves.toMatchObject({
        codexEnvironmentRuntime: {
          cwd: worktreePath,
          actionRuns: [
            expect.objectContaining({
              actionId: "capture-cwd",
              actionName: "Capture CWD",
              status: "started",
            }),
          ],
        },
      });
      await expectEventually(
        async () => await readFile(outputPath, "utf8"),
        await realpath(worktreePath),
      );
      await expect(
        overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        }),
      ).resolves.toMatchObject({
        codexEnvironmentRuntime: {
          cwd: worktreePath,
        },
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs existing-thread environment actions from Local after worktree handoff back", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-env-local-"));
    const localPath = path.join(root, "local");
    const worktreePath = path.join(root, "worktree");
    const outputPath = path.join(root, "action-cwd.txt");
    await mkdir(localPath, { recursive: true });
    await mkdir(worktreePath, { recursive: true });

    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [
            {
              id: "fixture-repo",
              label: "FixtureRepo",
              path: localPath,
              kind: "local",
            },
          ],
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgnt",
            executionTarget: "local",
            cwd: worktreePath,
            setupEnabled: false,
            actions: [
              {
                id: "capture-cwd",
                name: "Capture CWD",
                command: `node -e "require('node:fs').writeFileSync(process.argv[1], process.cwd())" ${JSON.stringify(outputPath)}`,
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
          actionId: "capture-cwd",
        }),
      ).resolves.toMatchObject({
        codexEnvironmentRuntime: {
          cwd: localPath,
          actionRuns: [
            expect.objectContaining({
              actionId: "capture-cwd",
              actionName: "Capture CWD",
              status: "started",
            }),
          ],
        },
      });
      await expectEventually(
        async () => await readFile(outputPath, "utf8"),
        await realpath(localPath),
      );
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
          actionRuns: [
            expect.objectContaining({
              actionId: "dev-messaging",
              actionName: "Dev - Messaging",
              command: "pnpm dev",
              status: "failed",
            }),
          ],
        },
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("attributes output to the right run when two env actions run concurrently on the same thread", async () => {
    // Multi-instance regression test: Start + Test (or E2E + Unit) workflows
    // require independent run tracking, otherwise a second concurrent run
    // would overwrite the first's overlay entry and the first run's output
    // would disappear.
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-env-parallel-"));
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
            actions: [
              {
                // Print a marker to stdout so the captured output (which
                // gets attributed to the run via onDetachedExit) has a
                // deterministic value to assert on. A small sleep makes
                // the two children genuinely overlap in time.
                id: "action-a",
                name: "Action A",
                command: "sleep 0.2 && printf 'A-output-marker'",
              },
              {
                id: "action-b",
                name: "Action B",
                command: "sleep 0.2 && printf 'B-output-marker'",
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
      // Fire both run requests without awaiting either, so the spawn paths
      // and their detached children interleave.
      const [resultA, resultB] = await Promise.all([
        registry.runCodexEnvironmentAction({
          backend: "codex",
          threadId: "thread-1",
          actionId: "action-a",
        }),
        registry.runCodexEnvironmentAction({
          backend: "codex",
          threadId: "thread-1",
          actionId: "action-b",
        }),
      ]);

      // Each invocation's return value should carry its own runId.
      const runIdA = resultA.codexEnvironmentRuntime?.actionRuns?.find(
        (run) => run.actionId === "action-a",
      )?.runId;
      const runIdB = resultB.codexEnvironmentRuntime?.actionRuns?.find(
        (run) => run.actionId === "action-b",
      )?.runId;
      expect(runIdA).toBeTruthy();
      expect(runIdB).toBeTruthy();
      expect(runIdA).not.toBe(runIdB);

      // After both detached children exit, the overlay's actionRuns should
      // contain both entries, each with its own captured output. Poll
      // until the exit + output handlers have both fired and persisted.
      const deadline = Date.now() + 10_000;
      let lastSnapshot: ReadonlyArray<unknown> | undefined;
      let lastError: string | undefined;
      while (Date.now() < deadline) {
        const overlay = await overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        });
        const runs = overlay?.codexEnvironmentRuntime?.actionRuns ?? [];
        lastSnapshot = runs;
        const a = runs.find((run) => run.actionId === "action-a");
        const b = runs.find((run) => run.actionId === "action-b");
        if (
          a?.status === "exited" &&
          b?.status === "exited" &&
          a.output === "A-output-marker" &&
          b.output === "B-output-marker"
        ) {
          // Sanity-check the runId attribution: each invocation's return
          // value's run should match the overlay's persisted entry.
          expect(a.runId).toBe(runIdA);
          expect(b.runId).toBe(runIdB);
          return;
        }
        lastError = `a.status=${a?.status} b.status=${b?.status} a.output=${JSON.stringify(a?.output)} b.output=${JSON.stringify(b?.output)}`;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(
        `concurrent runs did not settle in time. last snapshot: ${JSON.stringify(lastSnapshot)} (${lastError ?? "no probe"})`,
      );
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("cleans up prior-session env-action runs on startup", async () => {
    // Before the cleanup pass: an overlay row from a previous app launch
    // carries a "started" run that's effectively a zombie (the child died
    // when the parent exited) plus completed runs whose ~36KB outputs no
    // longer matter. After construction, those should be normalised:
    // zombies become "failed" with output dropped; finished runs keep
    // status but lose their stored output.
    const fakeSessionStart = Date.now();
    const longAgo = fakeSessionStart - 60_000; // 1 minute before this session
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-zombie": {
          backend: "codex",
          threadId: "thread-zombie",
          executionMode: "default",
          extraLinkedDirectories: [],
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgnt",
            executionTarget: "local",
            cwd: "/tmp/x",
            setupEnabled: false,
            actions: [],
            actionRuns: [
              {
                runId: "old-zombie",
                actionId: "dev",
                actionName: "Dev",
                command: "pnpm dev",
                status: "started",
                startedAt: longAgo,
                pid: 12345,
                output: "a lot of stale output bytes that nobody will read",
              },
            ],
          },
        },
        "codex:thread-finished": {
          backend: "codex",
          threadId: "thread-finished",
          executionMode: "default",
          extraLinkedDirectories: [],
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgnt",
            executionTarget: "local",
            cwd: "/tmp/y",
            setupEnabled: false,
            actions: [],
            actionRuns: [
              {
                runId: "old-exited",
                actionId: "test",
                actionName: "Test",
                command: "pnpm test",
                status: "exited",
                startedAt: longAgo,
                exitedAt: longAgo + 5_000,
                exitCode: 0,
                durationMs: 5_000,
                output: "build done\nready\n…lots more bytes…",
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
      // The cleanup runs fire-and-forget in the constructor; poll until
      // the persisted overlay reflects the post-cleanup shape.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const zombie = await overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-zombie",
        });
        const finished = await overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-finished",
        });
        const zombieRun = zombie?.codexEnvironmentRuntime?.actionRuns?.[0];
        const finishedRun = finished?.codexEnvironmentRuntime?.actionRuns?.[0];
        if (
          zombieRun?.status === "failed" &&
          zombieRun.output === undefined &&
          finishedRun?.status === "exited" &&
          finishedRun.output === undefined
        ) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("startup cleanup did not normalise overlays in time");
    } finally {
      await registry.close();
    }
  });

  it("converts started env-action runs to failed even when timestamps are 0 or missing (legacy-synthesised data)", async () => {
    // Reproduces the PwrAgent-killed-by-Computer-Use regression: an
    // overlay row from a pre-actionStartedAt build (or any data where
    // synthesis produces startedAt=0) used to slip past the
    // timestamp-gated cleanup, then slip past the renderer's
    // session-start filter, leaving the user with a perpetual
    // "running" anchor and no Dismiss control. The fix is to convert
    // any "started" run unconditionally — by lifecycle, anything we
    // didn't start in this process lifetime is a zombie.
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-zombie-legacy": {
          backend: "codex",
          threadId: "thread-zombie-legacy",
          executionMode: "default",
          extraLinkedDirectories: [],
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgnt",
            executionTarget: "local",
            cwd: "/tmp/x",
            setupEnabled: false,
            actions: [],
            actionRuns: [
              {
                runId: "legacy:dev:0",
                actionId: "dev",
                actionName: "Dev",
                command: "pnpm dev",
                status: "started",
                startedAt: 0, // legacy-synthesised
                pid: 72685,
                output: "lots of stale bytes",
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
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const overlay = await overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-zombie-legacy",
        });
        const run = overlay?.codexEnvironmentRuntime?.actionRuns?.[0];
        if (run?.status === "failed" && run.output === undefined) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("cleanup did not convert legacy zombie run in time");
    } finally {
      await registry.close();
    }
  });

  it("leaves current-session env-action runs untouched on startup", async () => {
    // Negative case: a run whose startedAt is >= the registry's session
    // start (which is captured at construction) must survive the cleanup
    // pass intact. This guards against the cleanup accidentally clobbering
    // runs that the auto-action emitted during the same session.
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
            cwd: "/tmp/x",
            setupEnabled: false,
            actions: [],
            // startedAt set well into the future so the cleanup is
            // guaranteed to see this run as "fresh this session" no
            // matter when the test executes.
            actionRuns: [
              {
                runId: "fresh-run",
                actionId: "dev",
                actionName: "Dev",
                command: "pnpm dev",
                status: "started",
                startedAt: Date.now() + 60_000,
                pid: 99999,
                output: "important live output",
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
      // Wait long enough for the cleanup pass to run.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const overlay = await overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      });
      const run = overlay?.codexEnvironmentRuntime?.actionRuns?.[0];
      expect(run?.status).toBe("started");
      expect(run?.output).toBe("important live output");
    } finally {
      await registry.close();
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
    const commandRunner: CodexEnvironmentCommandRunner = vi.fn(async (params) => {
      expect(params).toMatchObject({
        cwd: root,
        command: "printf setup-output",
        mode: "wait",
      });
      params.onProgress?.({
        phase: "stdout",
        chunk: "setup-output",
        at: Date.now(),
      });
      return {
        durationMs: 4,
        exitCode: 0,
        output: "setup-output",
      };
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      codexEnvironmentCommandRunner: commandRunner,
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
              output: expect.stringContaining("setup-output"),
              exitCode: 0,
            },
          },
        ],
      });
      expect(commandRunner).toHaveBeenCalledTimes(1);
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
    const commandRunner: CodexEnvironmentCommandRunner = vi.fn(async (params) => {
      expect(params).toMatchObject({
        cwd: worktreePath,
        command: "printf setup-failed && exit 42",
        mode: "wait",
      });
      throw new CodexEnvironmentCommandError(
        "Codex environment command exited with 42",
        {
          durationMs: 3,
          exitCode: 42,
          output: "setup-failed",
        },
      );
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      codexEnvironmentCommandRunner: commandRunner,
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
      expect(response.codexEnvironmentStartupFailure).toMatchObject({
        message: expect.stringContaining("Codex environment command exited with 42"),
        phase: "setup",
        worktreeCleanupAvailable: true,
      });
      expect(response.codexEnvironmentRuntime).toMatchObject({
        environmentName: "Broken Env",
        setupStatus: "failed",
        setupExitCode: 42,
        setupOutput: expect.stringContaining("setup-failed"),
      });
      expect(commandRunner).toHaveBeenCalledTimes(1);
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

  it("rejects duplicate Codex turn starts while the thread is already active", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok unavailable"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "first queued release" }],
    });

    await expect(
      registry.startTurn({
        backend: "codex",
        threadId: "thread-1",
        input: [{ type: "text", text: "first queued release" }],
      }),
    ).rejects.toThrow("A turn is already active for this thread.");
    expect(codexClient.startTurnCallCount).toBe(1);

    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          output: [],
        },
      },
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "next queued release" }],
    });
    expect(codexClient.startTurnCallCount).toBe(2);

    await registry.close();
  });

  it("reserves Codex turn starts before awaited pre-start work", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok unavailable"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    const firstStart = registry.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "first queued release" }],
    });
    const secondStart = registry.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "first queued release" }],
    });

    await expect(secondStart).rejects.toThrow(
      "A turn is already active for this thread.",
    );
    await firstStart;
    expect(codexClient.startTurnCallCount).toBe(1);

    await registry.close();
  });

  it("clears Codex start reservations after startTurn fails", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      startTurnError: new Error("codex start failed"),
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok unavailable"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    await expect(
      registry.startTurn({
        backend: "codex",
        threadId: "thread-1",
        input: [{ type: "text", text: "first queued release" }],
      }),
    ).rejects.toThrow("codex start failed");
    await expect(
      registry.startTurn({
        backend: "codex",
        threadId: "thread-1",
        input: [{ type: "text", text: "retry queued release" }],
      }),
    ).rejects.toThrow("codex start failed");
    expect(codexClient.startTurnCallCount).toBe(2);

    await registry.close();
  });

  it("reports in-progress quit threads across Codex active, queued, and ACP active turns", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok unavailable"),
      }),
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: null,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "hello" }],
    });
    await registry.submitTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "queued" }],
    });
    await (
      registry as unknown as {
        emit(event: AgentEvent): Promise<void>;
      }
    ).emit({
      backend: "acp:grok",
      notification: {
        method: "turn/started",
        params: {
          threadId: "acp-thread-1",
          turnId: "pending:acp-thread-1:123456",
          turn: {
            id: "pending:acp-thread-1:123456",
            status: "in_progress",
            startedAt: Date.now(),
          },
        },
      },
    });

    expect(registry.getInProgressThreadSnapshotForQuit()).toEqual({
      count: 2,
      threadIds: ["acp:grok:acp-thread-1", "codex:thread-1"],
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
    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-title",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          output: [],
        },
      },
    });

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

  it("rejects review start for ACP backends instead of routing through built-in clients", async () => {
    const { acpBackendId, registry } = createKimiAcpRegistry();

    await expect(
      registry.startReview({
        backend: acpBackendId,
        threadId: "kimi-session-1",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
      }),
    ).rejects.toThrow("Selected backend does not support review/start");

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

  it("releases queued turns for Grok terminal events", async () => {
    const grokClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
      }),
      grokClient,
      overlayStore: createOverlayStoreMock(),
    });

    const first = await registry.submitTurn({
      backend: "grok",
      threadId: "thread-1",
      origin: "manual",
      input: [{ type: "text", text: "first" }],
    });
    const second = await registry.submitTurn({
      backend: "grok",
      threadId: "thread-1",
      origin: "manual",
      input: [{ type: "text", text: "second" }],
    });

    expect(first.status).toBe("started");
    expect(second.status).toBe("queued");
    expect(grokClient.lastStartTurnParams?.input).toEqual([
      { type: "text", text: "first" },
    ]);

    await grokClient.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          output: [{ type: "text", text: "Automation finished." }],
        },
      },
    });

    await waitForCondition(() =>
      grokClient.lastStartTurnParams?.input.some(
        (item) => item.type === "text" && item.text === "second",
      ) ?? false,
    );
    expect(grokClient.lastStartTurnParams?.input).toEqual([
      { type: "text", text: "second" },
    ]);

    await registry.close();
  });

  it("mirrors headless automation turn lifecycle onto the Agent thread", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
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

    const started = await registry.startAutomationHeadlessTurn({
      backend: "codex",
      agentThreadId: "agent-thread-1",
      automationName: "Check email",
      automationRunId: "run-1",
      input: [{ type: "text", text: "Run the scheduled task." }],
    });

    expect(started).toEqual({
      backend: "codex",
      headlessThreadId: "thread-1",
      queueEntryId: "headless:run-1",
      threadId: "agent-thread-1",
      turnId: "turn-1",
    });
    expect(codexClient.lastStartThreadParams).toMatchObject({
      approvalPolicy: "never",
      ephemeral: true,
      sandbox: "workspace-write",
    });
    expect(codexClient.lastStartTurnParams).toMatchObject({
      approvalPolicy: "never",
      sandbox: "workspace-write",
      threadId: "thread-1",
    });
    expect(codexClient.lastStartTurnParams?.input).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Access mode: Default Access (default)."),
      },
      { type: "text", text: "Run the scheduled task." },
    ]);
    expect(events).toEqual([
      {
        backend: "codex",
        notification: {
          method: "thread/turnQueue/updated",
          params: {
            threadId: "agent-thread-1",
            queueEntryId: "headless:run-1",
            origin: "automation",
            automationRunId: "run-1",
            automationName: "Check email",
            status: "started",
            backendThreadId: "thread-1",
            turnId: "turn-1",
          },
        },
      },
    ]);

    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          output: [{ type: "text", text: "Automation finished." }],
        },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        notification: expect.objectContaining({
          method: "thread/turnQueue/updated",
          params: expect.objectContaining({ status: "started" }),
        }),
      }),
      {
        backend: "codex",
        notification: {
          method: "thread/turnQueue/updated",
          params: {
            threadId: "agent-thread-1",
            queueEntryId: "headless:run-1",
            origin: "automation",
            automationRunId: "run-1",
            automationName: "Check email",
            status: "terminal",
            turnId: "turn-1",
            finalText: "Automation finished.",
            terminalStatus: "turn/completed",
          },
        },
      },
      {
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              output: [{ type: "text", text: "Automation finished." }],
            },
          },
        },
      },
    ]);

    unsubscribe();
    await registry.close();
  });

  it("runs headless automations with the Agent thread's full access settings", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:agent-thread-1": {
            backend: "codex",
            threadId: "agent-thread-1",
            executionMode: "full-access",
            extraLinkedDirectories: [
              {
                id: "/tmp/full-access-project",
                label: "Full Access Project",
                path: "/tmp/full-access-project",
                kind: "local",
              },
            ],
          },
        },
      }),
    });

    await registry.startAutomationHeadlessTurn({
      backend: "codex",
      agentThreadId: "agent-thread-1",
      automationName: "Check weather",
      automationRunId: "run-1",
      input: [{ type: "text", text: "Check whether it will rain." }],
    });

    expect(codexClient.lastStartThreadParams).toMatchObject({
      approvalPolicy: "never",
      cwd: "/tmp/full-access-project",
      ephemeral: true,
      sandbox: "danger-full-access",
    });
    expect(codexClient.lastStartTurnParams).toMatchObject({
      approvalPolicy: "never",
      cwd: "/tmp/full-access-project",
      sandbox: "danger-full-access",
      threadId: "thread-1",
    });
    expect(codexClient.lastStartTurnParams?.input).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Access mode: Full Access (full-access)."),
      },
      { type: "text", text: "Check whether it will rain." },
    ]);

    await registry.close();
  });

  it("auto-cancels approval requests from headless automations", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
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

    await registry.startAutomationHeadlessTurn({
      backend: "codex",
      agentThreadId: "agent-thread-1",
      automationName: "Check weather",
      automationRunId: "run-1",
      input: [{ type: "text", text: "Check whether it will rain." }],
    });

    const response = await codexClient.emitRequest({
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "call-1",
        requestId: "approval-1",
        command: "curl https://example.com",
      },
    } as AppServerPendingRequestNotification);

    expect(response).toEqual({ decision: "cancel" });
    expect(events.map((event) => event.notification.method)).toEqual([
      "thread/turnQueue/updated",
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

  it("submits non-automation thread turns without synthetic automation context", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/read"] },
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
      input: [{ type: "text", text: "What happened?" }],
    });

    expect(codexClient.lastStartTurnParams?.input).toEqual([
      { type: "text", text: "What happened?" },
    ]);

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

  it("handles automation inspection dynamic tool calls without surfacing pending requests", async () => {
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
    registry.setAutomationInspectionHandler((request) => {
      expect(request).toEqual({
        operation: "list_automations",
        context: {
          backend: "codex",
          threadId: "thread-1",
        },
        args: {
          limit: 2,
        },
      });
      return {
        ok: true,
        operation: "list_automations",
        data: {
          automations: [],
        },
      };
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });
    events.length = 0;
    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent_automations",
        tool: "list_automations",
        arguments: {
          limit: 2,
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toEqual({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({ automations: [] }, null, 2),
        },
      ],
    });
    expect(events).toEqual([]);

    unsubscribe();
    await registry.close();
  });

  it("rejects automation inspection dynamic tool calls that do not match an active turn", async () => {
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
    const handler = vi.fn();
    registry.setAutomationInspectionHandler(handler);
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });
    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "agent-thread-2",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent_automations",
        tool: "list_automations",
        arguments: {},
      },
    } as AppServerPendingRequestNotification);

    expect(response).toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify(
            {
              code: "forbidden",
              message:
                "Automation inspection tool calls must originate from an active turn on the same thread.",
            },
            null,
            2,
          ),
        },
      ],
    });
    expect(handler).not.toHaveBeenCalled();

    await registry.close();
  });

  it("returns a tool error for unknown PwrAgent automation dynamic tools", async () => {
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
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });
    events.length = 0;

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent_automations",
        tool: "unknown_tool",
        arguments: {},
      },
    } as AppServerPendingRequestNotification);

    expect(response).toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify(
            {
              code: "unsupported_operation",
              message: "Unsupported PwrAgent automation tool.",
            },
            null,
            2,
          ),
        },
      ],
    });
    expect(events).toEqual([]);

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

  it("restores archived thread worktrees from retained snapshots", async () => {
    const snapshot: WorktreeSnapshotSummary = {
      id: "snapshot-1",
      backend: "codex",
      threadId: "thread-1",
      worktreePath: "/repo/.worktrees/archive-me",
      repositoryPath: "/repo/app",
      snapshotRef: "refs/codex/snapshots/snapshot-1",
      snapshotCommit: "abc123",
      sourceBranch: "codex/archive-me",
      sourceHead: "def456",
      createdAt: 1000,
      archivedAt: 1000,
      state: "archived",
      ignoredFilesExcluded: true,
    };
    const restoredSnapshot: WorktreeSnapshotSummary = {
      ...snapshot,
      restoredAt: 2000,
      state: "restored",
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/unarchive"] },
    });
    const restoreWorktree = vi.fn(async () => restoredSnapshot);
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
            extraLinkedDirectories: [],
            worktreeSnapshots: [snapshot],
          },
        },
      }),
      worktreeArchiveService: {
        restore: restoreWorktree,
      } as unknown as WorktreeArchiveService,
    });

    const response = await registry.restoreThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(restoreWorktree).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      worktreePath: "/repo/.worktrees/archive-me",
      repositoryPath: "/repo/app",
      snapshotRef: "refs/codex/snapshots/snapshot-1",
      snapshotCommit: "abc123",
      snapshot,
      allowDetachedFallback: true,
    });
    expect(response).toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      worktrees: [
        {
          worktreePath: "/repo/.worktrees/archive-me",
          repositoryPath: "/repo/app",
          snapshotRef: "refs/codex/snapshots/snapshot-1",
          restored: true,
          snapshot: restoredSnapshot,
        },
      ],
    });

    await registry.close();
  });

  it("restores deleted archived thread worktrees from retained metadata when no snapshot exists", async () => {
    const archivedThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archived worktree",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/PwrSnap",
          label: "PwrSnap",
          path: "/repo/PwrSnap",
          kind: "worktree",
          worktreePath: "/Users/test/.codex/worktrees/mp32wplq/PwrSnap",
        },
      ],
      source: "codex",
      gitBranch: "fix/float-over-hitbox",
      updatedAt: 2,
    };
    const restoredSnapshot: WorktreeSnapshotSummary = {
      id: "snapshot-1",
      backend: "codex",
      threadId: "thread-1",
      worktreePath: "/Users/test/.codex/worktrees/mp32wplq/PwrSnap",
      repositoryPath: "/repo/PwrSnap",
      snapshotRef: "fix/float-over-hitbox",
      snapshotCommit: "ecce5f83",
      sourceBranch: "fix/float-over-hitbox",
      createdAt: 2000,
      restoredAt: 2000,
      state: "restored",
      ignoredFilesExcluded: true,
      unavailableReason:
        "Restored detached worktree from repository state because no archived snapshot was available.",
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/unarchive"] },
      archivedThreads: [archivedThread],
    });
    const restoreDetached = vi.fn(async () => restoredSnapshot);
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      worktreeArchiveService: {
        restoreDetached,
      } as unknown as WorktreeArchiveService,
    });

    const response = await registry.restoreThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(codexClient.listThreadsCalls[0]?.params).toMatchObject({
      archived: true,
    });
    expect(restoreDetached).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      worktreePath: "/Users/test/.codex/worktrees/mp32wplq/PwrSnap",
      repositoryPath: "/repo/PwrSnap",
      restoreRef: "fix/float-over-hitbox",
    });
    expect(response).toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      worktrees: [
        {
          worktreePath: "/Users/test/.codex/worktrees/mp32wplq/PwrSnap",
          repositoryPath: "/repo/PwrSnap",
          snapshotRef: "fix/float-over-hitbox",
          restored: true,
        },
      ],
    });

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

  it("hides archived records for threads that are active again", async () => {
    const restoredThread: AppServerThreadSummary = {
      id: "thread-restored",
      title: "Restored elsewhere",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const stillArchivedThread: AppServerThreadSummary = {
      id: "thread-archived",
      title: "Still archived",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 1,
    };
    const codexClient = new MockBackendClient({
      archivedThreads: [restoredThread, stillArchivedThread],
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [restoredThread],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    await expect(
      registry.listThreads({ backend: "codex", archived: true }),
    ).resolves.toEqual([expect.objectContaining({ id: "thread-archived" })]);

    expect(codexClient.listThreadsCalls.map((call) => call.params)).toEqual([
      { archived: true, enrichDirectories: true },
      { archived: false, enrichDirectories: false },
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

  it("rebinds ACP protocol sessions when the thread workspace overlay changes cwd", async () => {
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const sessionStore = createAcpSessionStoreMock([
      {
        backendId: acpBackendId,
        sessionId: "session-1",
        title: "ACP session",
        cwd: "/repo/app",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        status: "idle",
      },
    ]);
    const overlayStore = createOverlayStoreMock();
    await overlayStore.replaceWorkspaceLinkedDirectory({
      backend: acpBackendId as never,
      threadId: "session-1",
      directory: {
        id: "pwragent-handoff:acp:gemini:session-1",
        label: "app",
        path: "/repo/app",
        worktreePath: "/repo/app/.worktrees/app-feature-handoff",
        kind: "worktree",
      },
      gitBranch: "feature/handoff",
    });
    const startSession = vi.fn(async (params: {
      sessionId?: string;
      cwd?: string;
      executionMode: ThreadExecutionMode;
      title?: string;
      createdAt?: number;
    }) => {
      const metadata: AcpSessionMetadata = {
        backendId: acpBackendId,
        sessionId: params.sessionId ?? "agent-session-2",
        agentSessionId: "agent-session-2",
        title: params.title ?? "ACP session",
        cwd: params.cwd,
        createdAt: params.createdAt ?? 1000,
        updatedAt: 2000,
        executionMode: params.executionMode,
        status: "idle",
      };
      sessionStore.upsertSession(metadata);
      return metadata;
    });
    const ensureSession = vi.fn(async () => undefined);
    const startPrompt = vi.fn((params: {
      sessionId: string;
      prompt: string;
      turnId?: string;
    }) => ({
      sessionId: params.sessionId,
      turnId: params.turnId ?? "pending:session-1:1001",
    }));
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      startSession,
      ensureSession,
      startPrompt,
      cancelSession: vi.fn(),
      readReplay: vi.fn(),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
    };
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      grokClient: new MockBackendClient({ threads: [] }),
      overlayStore,
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
          launchDescriptor: {
            backendId: acpBackendId,
            registryId: "gemini",
            distributionKind: "local",
            command: "gemini",
            args: ["--acp", "--skip-trust"],
            env: {},
          },
        },
      ]),
      acpSessionStore: sessionStore,
      createAcpClient: () => acpClient,
    });

    await registry.startTurn({
      backend: acpBackendId,
      threadId: "session-1",
      input: [{ type: "text", text: "What is the CWD?" }],
    });

    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        cwd: "/repo/app/.worktrees/app-feature-handoff",
      }),
    );
    expect(sessionStore.getSession(acpBackendId, "session-1")).toMatchObject({
      agentSessionId: "agent-session-2",
      cwd: "/repo/app/.worktrees/app-feature-handoff",
    });
    expect(ensureSession).not.toHaveBeenCalled();

    await registry.close();
  });

  it("updates stored ACP session cwd on workspace handoff before the next turn", async () => {
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const sessionStore = createAcpSessionStoreMock([
      {
        backendId: acpBackendId,
        sessionId: "session-1",
        title: "ACP session",
        cwd: "/repo/app",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        status: "idle",
      },
    ]);
    const startSession = vi.fn(async (params: {
      sessionId?: string;
      cwd?: string;
      executionMode: ThreadExecutionMode;
      title?: string;
      createdAt?: number;
    }) => {
      const metadata: AcpSessionMetadata = {
        backendId: acpBackendId,
        sessionId: params.sessionId ?? "agent-session-2",
        agentSessionId: "agent-session-2",
        title: params.title ?? "ACP session",
        cwd: params.cwd,
        createdAt: params.createdAt ?? 1000,
        updatedAt: 2000,
        executionMode: params.executionMode,
        status: "idle",
      };
      sessionStore.upsertSession(metadata);
      return metadata;
    });
    const ensureSession = vi.fn(async () => undefined);
    const startPrompt = vi.fn((params: {
      sessionId: string;
      prompt: string;
      turnId?: string;
    }) => ({
      sessionId: params.sessionId,
      turnId: params.turnId ?? "pending:session-1:1001",
    }));
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      startSession,
      ensureSession,
      startPrompt,
      cancelSession: vi.fn(),
      readReplay: vi.fn(),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
    };
    const handoff = vi.fn(async () => ({
      backend: acpBackendId,
      threadId: "session-1",
      direction: "local-to-worktree" as const,
      workMode: "worktree" as const,
      branch: "feature/handoff",
      repositoryPath: "/repo/app",
      targetPath: "/repo/app/.worktrees/app-feature-handoff",
      linkedDirectory: {
        id: "pwragent-handoff:acp:gemini:session-1",
        label: "app",
        path: "/repo/app",
        worktreePath: "/repo/app/.worktrees/app-feature-handoff",
        kind: "worktree" as const,
      },
      warnings: [],
      completedAt: 1000,
    }));
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      grokClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
          launchDescriptor: {
            backendId: acpBackendId,
            registryId: "gemini",
            distributionKind: "local",
            command: "gemini",
            args: ["--acp", "--skip-trust"],
            env: {},
          },
        },
      ]),
      acpSessionStore: sessionStore,
      createAcpClient: () => acpClient,
      gitDirectoryService: {
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
      } as never,
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });

    await registry.handoffThreadWorkspace({
      backend: acpBackendId,
      threadId: "session-1",
      direction: "local-to-worktree",
      leaveLocalBranch: "main",
    });
    await registry.startTurn({
      backend: acpBackendId,
      threadId: "session-1",
      input: [{ type: "text", text: "What is the CWD?" }],
    });

    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        cwd: "/repo/app/.worktrees/app-feature-handoff",
      }),
    );
    expect(sessionStore.getSession(acpBackendId, "session-1")).toMatchObject({
      agentSessionId: "agent-session-2",
      cwd: "/repo/app/.worktrees/app-feature-handoff",
    });
    expect(ensureSession).not.toHaveBeenCalled();
    expect(startPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        prompt: "What is the CWD?",
      }),
    );

    await registry.close();
  });

  it("rejects Gemini ACP workspace handoff after the first message", async () => {
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const handoff = vi.fn();
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      grokClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock([
        {
          backendId: acpBackendId,
          sessionId: "session-1",
          title: "ACP session",
          cwd: "/repo/app",
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: "default",
          status: "idle",
          hasConversationHistory: true,
        },
      ]),
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });

    await expect(
      registry.handoffThreadWorkspace({
        backend: acpBackendId,
        threadId: "session-1",
        direction: "local-to-worktree",
        leaveLocalBranch: "main",
      }),
    ).rejects.toThrow("cannot hand off a workspace after the first message");
    expect(handoff).not.toHaveBeenCalled();

    await registry.close();
  });

  it("rejects rebinding legacy Gemini ACP sessions after conversation history exists", async () => {
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const sessionStore = createAcpSessionStoreMock([
      {
        backendId: acpBackendId,
        sessionId: "session-1",
        title: "ACP session",
        cwd: "/repo/app/.worktrees/app-feature-handoff",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        status: "idle",
        hasConversationHistory: true,
      },
    ]);
    const ensureSession = vi.fn(async () => {
      throw new Error(
        'json-rpc error (-32603): Internal error: {"details":"No previous sessions found for this project."}',
      );
    });
    const startSession = vi.fn(async (params: {
      sessionId?: string;
      cwd?: string;
      executionMode: ThreadExecutionMode;
      title?: string;
      createdAt?: number;
    }) => {
      const metadata: AcpSessionMetadata = {
        backendId: acpBackendId,
        sessionId: params.sessionId ?? "agent-session-2",
        agentSessionId: "agent-session-2",
        title: params.title ?? "ACP session",
        cwd: params.cwd,
        createdAt: params.createdAt ?? 1000,
        updatedAt: 2000,
        executionMode: params.executionMode,
        status: "idle",
      };
      sessionStore.upsertSession(metadata);
      return metadata;
    });
    const startPrompt = vi.fn((params: {
      sessionId: string;
      prompt: string;
      turnId?: string;
    }) => ({
      sessionId: params.sessionId,
      turnId: params.turnId ?? "pending:session-1:1001",
    }));
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      startSession,
      ensureSession,
      startPrompt,
      cancelSession: vi.fn(),
      readReplay: vi.fn(),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
    };
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      grokClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
          launchDescriptor: {
            backendId: acpBackendId,
            registryId: "gemini",
            distributionKind: "local",
            command: "gemini",
            args: ["--acp", "--skip-trust"],
            env: {},
          },
        },
      ]),
      acpSessionStore: sessionStore,
      createAcpClient: () => acpClient,
    });

    await expect(
      registry.startTurn({
        backend: acpBackendId,
        threadId: "session-1",
        input: [{ type: "text", text: "What is the CWD now?" }],
      }),
    ).rejects.toThrow("cannot hand off a workspace after the first message");

    expect(ensureSession).toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
    expect(sessionStore.getSession(acpBackendId, "session-1")).toMatchObject({
      cwd: "/repo/app/.worktrees/app-feature-handoff",
    });
    expect(startPrompt).not.toHaveBeenCalled();

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
      worktrees: [],
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
      worktrees: [],
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

  it("renames ACP threads in the local session store", async () => {
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const sessions: AcpSessionMetadata[] = [
      {
        backendId: acpBackendId,
        sessionId: "session-1",
        title: "ACP session",
        titleSource: "fallback",
        cwd: "/repo/project",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        status: "idle",
      },
    ];
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      grokClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpSessionStore: createAcpSessionStoreMock(sessions),
    });

    await expect(
      registry.renameThread({
        backend: acpBackendId,
        threadId: "session-1",
        name: "  Cleaned up formatting  ",
      }),
    ).resolves.toEqual({
      backend: acpBackendId,
      threadId: "session-1",
      renamedAt: expect.any(Number),
    });

    expect(sessions[0]).toMatchObject({
      title: "Cleaned up formatting",
      titleSource: "explicit",
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
    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-toggle",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          output: [],
        },
      },
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
      await Promise.resolve();
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

  // Bootstrap-mode hard gate: when the registry runs inside the
  // throwaway `.bootstrap/` profile (any post-wizard dev window that
  // stays alive while the new profile spawns), listThreads must
  // ALWAYS return empty — independent of `isCodexBootstrapDeferred`
  // and the persisted `onboarding.completed` flag. Otherwise, the
  // bootstrap profile's empty `codex.profile` would resolve to the
  // operator's real Codex install and surface their real thread
  // list as soon as they focused the bootstrap window.
  describe("bootstrap mode short-circuit for listThreads", () => {
    it("returns empty for codex-only queries in bootstrap mode", async () => {
      const codexClient = new MockBackendClient({
        threads: [
          {
            id: "thread-codex",
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
        isBootstrapMode: () => true,
        // Even with the secondary gate explicitly OFF, bootstrap-mode
        // hard gate must still short-circuit. This is the key
        // invariant the user surfaced: the dev-mode post-wizard
        // window had `onboarding.completed = true` from a stale
        // run, so `isCodexBootstrapDeferred` returned false — but
        // the renderer focusing the window still triggered a thread
        // load against the user's real Codex install. The bootstrap
        // gate is what catches that.
        isCodexBootstrapDeferred: () => false,
      });

      const result = await registry.listThreads({
        backend: "codex",
        callerReason: "navigation-snapshot",
      });

      expect(result).toEqual([]);
      expect(codexClient.listThreadsCallCount).toBe(0);

      await registry.close();
    });

    it("returns empty for grok-only queries in bootstrap mode (defense in depth)", async () => {
      // Bootstrap profile shouldn't surface ANY thread data —
      // including from Grok. The wizard's xAI key buffer never
      // graduates to `.bootstrap/state.db` (we removed that path),
      // so any Grok call from bootstrap would either fail or surface
      // unrelated identity data. Short-circuit to empty here.
      const grokClient = new MockBackendClient({
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
      const registry = new DesktopBackendRegistry({
        codexClient: new MockBackendClient({}),
        grokClient,
        overlayStore: createOverlayStoreMock(),
        isBootstrapMode: () => true,
        isCodexBootstrapDeferred: () => false,
      });

      const result = await registry.listThreads({
        backend: "grok",
        callerReason: "navigation-snapshot",
      });

      expect(result).toEqual([]);
      expect(grokClient.listThreadsCallCount).toBe(0);

      await registry.close();
    });

    it("throws on readThread in bootstrap mode", async () => {
      // Defense in depth: even if a renderer has a stale Codex
      // threadId in memory and tries to read it, the registry
      // refuses. The error surfaces as a thrown IPC reject; the
      // wizard's only-window-is-the-wizard invariant means no
      // operator-visible path leads here, so failing loud is the
      // right signal that something is wrong.
      const codexClient = new MockBackendClient({});
      const registry = new DesktopBackendRegistry({
        codexClient,
        grokClient: new MockBackendClient({}),
        overlayStore: createOverlayStoreMock(),
        isBootstrapMode: () => true,
        isCodexBootstrapDeferred: () => false,
      });

      await expect(
        registry.readThread({
          backend: "codex",
          threadId: "thread-abc",
        }),
      ).rejects.toThrow(/readThread is forbidden in bootstrap mode/);

      await registry.close();
    });

    it("throws on startThread in bootstrap mode", async () => {
      const codexClient = new MockBackendClient({});
      const registry = new DesktopBackendRegistry({
        codexClient,
        grokClient: new MockBackendClient({}),
        overlayStore: createOverlayStoreMock(),
        isBootstrapMode: () => true,
        isCodexBootstrapDeferred: () => false,
      });

      await expect(
        registry.startThread({
          backend: "codex",
          executionMode: "default",
          cwd: "/tmp/example",
        }),
      ).rejects.toThrow(/startThread is forbidden in bootstrap mode/);

      await registry.close();
    });

    it("hits the backends normally when isBootstrapMode is false", async () => {
      // Sanity: the gate is a NO-OP outside bootstrap mode. Production
      // boots into active-profile mode and the registry behaves
      // exactly as it did pre-#524.
      const codexClient = new MockBackendClient({
        threads: [
          {
            id: "thread-codex",
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
        isBootstrapMode: () => false,
        isCodexBootstrapDeferred: () => false,
      });

      const result = await registry.listThreads({
        backend: "codex",
        callerReason: "navigation-snapshot",
      });

      expect(result.map((t) => t.id)).toEqual(["thread-codex"]);
      expect(codexClient.listThreadsCallCount).toBe(1);

      await registry.close();
    });
  });

  // Deferred Codex `listThreads` probe for brand-new PwrAgent profiles.
  // The wizard flips `resolveOnboardingCompleted` to `true` after the
  // operator picks a Codex profile model; until then we must not hit the
  // Codex backend for thread-list reads.
  describe("onboarding gate for Codex listThreads", () => {
    it("returns empty for explicit codex queries when onboarding is incomplete", async () => {
      const codexClient = new MockBackendClient({
        threads: [
          {
            id: "thread-codex",
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
        isCodexBootstrapDeferred: () => true,
      });

      const result = await registry.listThreads({
        backend: "codex",
        callerReason: "startup-prewarm",
      });

      expect(result).toEqual([]);
      expect(codexClient.listThreadsCallCount).toBe(0);

      await registry.close();
    });

    it("returns grok-only results for unfiltered queries when onboarding is incomplete", async () => {
      const codexClient = new MockBackendClient({
        threads: [
          {
            id: "thread-codex",
            title: "Codex thread",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [],
          },
        ],
      });
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
      const registry = new DesktopBackendRegistry({
        codexClient,
        grokClient,
        overlayStore: createOverlayStoreMock(),
        isCodexBootstrapDeferred: () => true,
      });

      const result = await registry.listThreads({
        callerReason: "startup-prewarm",
      });

      expect(result.map((thread) => thread.id)).toEqual(["thread-grok"]);
      expect(codexClient.listThreadsCallCount).toBe(0);
      expect(grokClient.listThreadsCallCount).toBe(1);

      await registry.close();
    });

    it("hits Codex once onboarding is complete", async () => {
      const codexClient = new MockBackendClient({
        threads: [
          {
            id: "thread-codex",
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
        isCodexBootstrapDeferred: () => false,
      });

      const result = await registry.listThreads({
        backend: "codex",
        callerReason: "startup-prewarm",
      });

      expect(result.map((thread) => thread.id)).toEqual(["thread-codex"]);
      expect(codexClient.listThreadsCallCount).toBe(1);

      await registry.close();
    });
  });

  describe("notification wiring", () => {
    function makeRegistry(): DesktopBackendRegistry {
      return new DesktopBackendRegistry({
        codexClient: new MockBackendClient({}),
        grokClient: new MockBackendClient({
          initializeError: new Error(
            "grok app server unavailable: XAI_API_KEY is not set",
          ),
        }),
        overlayStore: createOverlayStoreMock(),
      });
    }

    function resetNotificationMocks(): void {
      desktopNotificationServiceMock.notifyAttention.mockClear();
      desktopNotificationServiceMock.notifyTerminal.mockClear();
      desktopNotificationServiceMock.clearAttentionKey.mockClear();
    }

    it("calls notifyAttention on turn/requestApproval with a backend:thread:request key", async () => {
      resetNotificationMocks();
      const registry = makeRegistry();

      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/requestApproval",
          params: {
            threadId: "thread-1",
            requestId: "req-1",
          },
        } as AppServerNotification,
      });

      expect(desktopNotificationServiceMock.notifyAttention).toHaveBeenCalledTimes(1);
      const call = desktopNotificationServiceMock.notifyAttention.mock.calls[0]?.[0];
      expect(call).toMatchObject({
        key: "codex:thread-1:req-1",
        title: "PwrAgent approval needed",
      });
      expect(typeof call.body).toBe("string");
      expect(typeof call.enabled).toBe("boolean");

      await registry.close();
    });

    it("calls notifyAttention on item/tool/requestUserInput with the question title", async () => {
      resetNotificationMocks();
      const registry = makeRegistry();

      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-q",
            requestId: "req-q",
          },
        } as AppServerNotification,
      });

      const call = desktopNotificationServiceMock.notifyAttention.mock.calls[0]?.[0];
      expect(call).toMatchObject({
        key: "codex:thread-q:req-q",
        title: "PwrAgent question waiting",
      });

      await registry.close();
    });

    it("calls notifyTerminal on turn/completed and includes the cached thread title", async () => {
      resetNotificationMocks();
      const registry = makeRegistry();

      // Seed the title cache via thread/name/updated, then complete the turn.
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "thread/name/updated",
          params: {
            threadId: "thread-2",
            threadName: "My Investigation",
          },
        } as AppServerNotification,
      });
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-2",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              output: [{ type: "text", text: "Done" }],
            },
          },
        },
      });

      expect(desktopNotificationServiceMock.notifyTerminal).toHaveBeenCalledTimes(1);
      const call = desktopNotificationServiceMock.notifyTerminal.mock.calls[0]?.[0];
      expect(call).toMatchObject({
        title: "PwrAgent turn completed",
      });
      expect(call.body).toContain("My Investigation");
      expect(call.body).toContain("completed");

      await registry.close();
    });

    it("falls back to a generic terminal body when no thread title has been observed", async () => {
      resetNotificationMocks();
      const registry = makeRegistry();

      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/failed",
          params: {
            threadId: "thread-no-title",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "failed",
              error: { message: "boom" },
            },
          },
        },
      });

      const call = desktopNotificationServiceMock.notifyTerminal.mock.calls[0]?.[0];
      expect(call.title).toBe("PwrAgent turn failed");
      expect(call.body).not.toContain("undefined");
      expect(call.body).toContain("failed");

      await registry.close();
    });

    it("clears the attention key on serverRequest/resolved (covers legacy applyPatchApproval cleanup)", async () => {
      resetNotificationMocks();
      const registry = makeRegistry();

      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "applyPatchApproval",
          params: {
            threadId: "thread-legacy",
            requestId: "approval-7",
          },
        } as AppServerNotification,
      });
      expect(desktopNotificationServiceMock.notifyAttention).toHaveBeenCalledTimes(1);
      expect(
        desktopNotificationServiceMock.notifyAttention.mock.calls[0]?.[0]?.key,
      ).toBe("codex:thread-legacy:approval-7");

      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "serverRequest/resolved",
          params: {
            threadId: "thread-legacy",
            requestId: "approval-7",
          },
        } as AppServerNotification,
      });

      expect(desktopNotificationServiceMock.clearAttentionKey).toHaveBeenCalledWith(
        "codex:thread-legacy:approval-7",
      );

      await registry.close();
    });
  });
});
