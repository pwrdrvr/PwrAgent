import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  ApplyThreadModelMigrationRequest,
  CancelQueuedTurnRequest,
  CancelThreadExecutionModeQueueRequest,
  CancelThreadPrAutoDispatchRequest,
  CheckThreadBranchDriftRequest,
  CompactThreadRequest,
  ForkThreadRequest,
  InterruptTurnRequest,
  ListBackendsRequest,
  MaterializeDirectoryLaunchpadRequest,
  QueueThreadExecutionModeRequest,
  RunCodexEnvironmentActionRequest,
  RetainThreadBranchDriftRequest,
  StopCodexEnvironmentActionRequest,
  SetAcpSessionRuntimeOptionRequest,
  SetCodexThreadEnvironmentRequest,
  SendThreadPrAutoDispatchNowRequest,
  SetThreadExecutionModeRequest,
  SetThreadModelSettingsRequest,
  SetThreadPrAutoDispatchRequest,
  StopSubAgentRequest,
  StartReviewRequest,
  StartThreadRequest,
  StartTurnRequest,
  SteerTurnRequest,
  SubmitServerRequestRequest,
  TrustCodexProjectRequest,
  UpdateThreadExpectedBranchRequest,
} from "@pwragent/shared";
import type { ThreadTurnQueueSubmissionResult } from "../app-server/thread-turn-queue";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const send = vi.fn();
const mockAppServerLog = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));
// A second subscriber standing in for a federation (remote viewer)
// window, so PR-authority fan-out can be asserted per window kind.
const federationWindowSend = vi.fn();
const federationWindowWebContents = { id: 2, send: federationWindowSend };
let channelSubscribers: Array<{ id: number; send: typeof send }> = [
  { id: 1, send },
  federationWindowWebContents,
];
const channelSubscriberTargets = new Map<number, {
  scope: "remote";
  instanceId: string;
}>();
let registryListener: ((event: AgentEvent) => void | Promise<void>) | undefined;

const registry = {
  isPullRequestLocallyMonitored: vi.fn((_prKey: string) => false),
  listBackends: vi.fn(async (_request?: ListBackendsRequest) => ({
    fetchedAt: 1,
    backends: [],
  })),
  onEvent: vi.fn((listener: (event: AgentEvent) => void | Promise<void>) => {
    registryListener = listener;
    return () => {
      registryListener = undefined;
    };
  }),
  startThread: vi.fn(async (request: StartThreadRequest) => ({
    backend: request.backend,
    threadId: "thread-1",
  })),
  startTurn: vi.fn(async (request: StartTurnRequest) => ({
    backend: request.backend,
    threadId: request.threadId,
    turnId: "turn-1",
  })),
  submitTurn: vi.fn(
    async (
      request: StartTurnRequest & { origin: "manual" },
    ): Promise<ThreadTurnQueueSubmissionResult> => ({
      status: "started" as const,
      entry: {
        id: "queue-1",
        backend: request.backend,
        createdAt: 1,
        input: request.input,
        origin: request.origin,
        threadId: request.threadId,
      },
      turnId: "turn-1",
    }),
  ),
  startReview: vi.fn(async (request: StartReviewRequest) => ({
    backend: request.backend,
    threadId: request.threadId,
    reviewThreadId: request.threadId,
    turnId: "turn-review-1",
  })),
  cancelQueuedTurn: vi.fn(() => true),
  cancelQueuedTurnWithDisposition: vi.fn((queueEntryId: string) => ({
    queueEntryId,
    cancelled: true,
    disposition: "cancelled" as const,
  })),
  interruptTurn: vi.fn(async (request: InterruptTurnRequest) => ({
    backend: request.backend,
    threadId: request.threadId,
    turnId: request.turnId,
  })),
  stopSubAgent: vi.fn(async (request: StopSubAgentRequest) => ({
    backend: request.backend,
    threadId: request.threadId,
    monitorId: request.monitorId,
    stoppedAt: 1,
  })),
  steerTurn: vi.fn(async (request: SteerTurnRequest) => ({
    backend: request.backend,
    threadId: request.threadId,
    turnId: request.expectedTurnId,
  })),
  materializeDirectoryLaunchpad: vi.fn(
    async (request: MaterializeDirectoryLaunchpadRequest) => ({
      backend: "codex" as const,
      threadId: `materialized:${request.directoryKey}`,
      executionMode: "default" as const,
      workMode: "local" as const,
      turnId: "turn-2",
    }),
  ),
  trustCodexProject: vi.fn(async (request: TrustCodexProjectRequest) => ({
    ...request,
    trusted: true,
  })),
  setThreadPrAutoDispatch: vi.fn(
    async (request: SetThreadPrAutoDispatchRequest) => request,
  ),
  cancelThreadPrAutoDispatch: vi.fn(
    async (request: CancelThreadPrAutoDispatchRequest) => ({
      ...request,
      cancelled: true,
    }),
  ),
  sendThreadPrAutoDispatchNow: vi.fn(
    async (request: SendThreadPrAutoDispatchNowRequest) => ({
      ...request,
      accepted: true,
    }),
  ),
  applyThreadModelMigration: vi.fn(
    async (request: ApplyThreadModelMigrationRequest) => ({
      ...request,
      status: "acknowledged-new-thread" as const,
    }),
  ),
  getLatestCodexConfigWarning: vi.fn(() => ({})),
};

const federationMock = vi.hoisted(() => {
  const remoteBackend = {
    listBackends: vi.fn(async () => ({ fetchedAt: 1, backends: [] })),
    startThread: vi.fn(async (request: StartThreadRequest) => ({
      backend: request.backend,
      threadId: "remote-thread-1",
      executionMode: "default" as const,
    })),
    forkThread: vi.fn(async (request: ForkThreadRequest) => ({
      backend: request.backend,
      sourceThreadId: request.sourceThreadId,
      threadId: "remote-fork-1",
      executionMode: "default" as const,
      workMode: "local" as const,
    })),
    startTurn: vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "remote-turn-1",
      queueStatus: "started" as const,
    })),
    cancelQueuedTurn: vi.fn(async (request: CancelQueuedTurnRequest) => ({
      queueEntryId: request.queueEntryId,
      cancelled: true,
    })),
    startReview: vi.fn(async (request: StartReviewRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      reviewThreadId: request.threadId,
      turnId: "remote-review-1",
    })),
    compactThread: vi.fn(async (request: CompactThreadRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "remote-compact-1",
    })),
    interruptTurn: vi.fn(async (request: InterruptTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: request.turnId,
    })),
    stopSubAgent: vi.fn(async (request: StopSubAgentRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      monitorId: request.monitorId,
      stoppedAt: 1,
    })),
    steerTurn: vi.fn(async (request: SteerTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: request.expectedTurnId,
    })),
    setThreadExecutionMode: vi.fn(
      async (request: SetThreadExecutionModeRequest) => ({
        backend: request.backend,
        threadId: request.threadId,
        executionMode: request.executionMode,
      }),
    ),
    queueThreadExecutionMode: vi.fn(
      async (request: QueueThreadExecutionModeRequest) => ({
        backend: request.backend,
        threadId: request.threadId,
        queuedExecutionMode: request.executionMode,
        queuedAt: 1_000,
      }),
    ),
    cancelThreadExecutionModeQueue: vi.fn(
      async (request: CancelThreadExecutionModeQueueRequest) => ({
        backend: request.backend,
        threadId: request.threadId,
        executionMode: "default" as const,
      }),
    ),
    setAcpSessionRuntimeOption: vi.fn(
      async (request: SetAcpSessionRuntimeOptionRequest) => ({
        backend: request.backend,
        threadId: request.threadId,
      }),
    ),
    setThreadModelSettings: vi.fn(
      async (request: SetThreadModelSettingsRequest) => request,
    ),
    setThreadPrAutoDispatch: vi.fn(
      async (request: SetThreadPrAutoDispatchRequest) => request,
    ),
    cancelThreadPrAutoDispatch: vi.fn(
      async (request: CancelThreadPrAutoDispatchRequest) => ({
        ...request,
        cancelled: true,
      }),
    ),
    sendThreadPrAutoDispatchNow: vi.fn(
      async (request: SendThreadPrAutoDispatchNowRequest) => ({
        ...request,
        accepted: true,
      }),
    ),
    checkThreadBranchDrift: vi.fn(
      async (request: CheckThreadBranchDriftRequest) => ({
        ...request,
        checkedAt: 1_000,
        drifted: true,
        observedBranch: "main",
      }),
    ),
    updateThreadExpectedBranch: vi.fn(
      async (request: UpdateThreadExpectedBranchRequest) => ({
        ...request,
        updatedAt: 1_000,
      }),
    ),
    retainThreadBranchDrift: vi.fn(
      async (request: RetainThreadBranchDriftRequest) => ({
        ...request,
        retainedAt: 1_000,
      }),
    ),
    runCodexEnvironmentAction: vi.fn(
      async (request: RunCodexEnvironmentActionRequest) => ({
        backend: request.backend,
        threadId: request.threadId,
        codexEnvironmentRuntime: {
          environmentId: "node",
          environmentName: "Node",
          executionTarget: "local" as const,
        },
      }),
    ),
    stopCodexEnvironmentAction: vi.fn(
      async (request: StopCodexEnvironmentActionRequest) => ({
        backend: request.backend,
        threadId: request.threadId,
        codexEnvironmentRuntime: {
          environmentId: "node",
          environmentName: "Node",
          executionTarget: "local" as const,
        },
      }),
    ),
    setCodexThreadEnvironment: vi.fn(
      async (request: SetCodexThreadEnvironmentRequest) => ({
        backend: request.backend,
        threadId: request.threadId,
        codexEnvironmentRuntime: request.environmentId
          ? {
              environmentId: request.environmentId,
              environmentName: request.environmentId,
              executionTarget: "local" as const,
            }
          : undefined,
      }),
    ),
    materializeDirectoryLaunchpad: vi.fn(
      async (request: MaterializeDirectoryLaunchpadRequest) => ({
        backend: "codex" as const,
        threadId: `remote:${request.directoryKey}`,
        executionMode: "default" as const,
        workMode: "local" as const,
      }),
    ),
    submitServerRequest: vi.fn(async (request: SubmitServerRequestRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: request.turnId,
      requestId: request.requestId,
    })),
    trustCodexProject: vi.fn(async (request: TrustCodexProjectRequest) => ({
      ...request,
      trusted: true,
    })),
  };
  return {
    remoteBackend,
    runtime: {
      hydrateLiveThreadMessageOrigin: vi.fn((event: AgentEvent) => event),
      remoteBackend: vi.fn(() => remoteBackend),
      rendererWantsRemoteEvent: vi.fn(() => true),
      setAgentEventPublisher: vi.fn(),
      setEnvironmentSetupProgressPublisher: vi.fn(),
    },
  };
});

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send },
      },
    ],
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

// Stub the per-window channel registry — `broadcastAgentEvent` now
// fans out via `subscribersForChannel(...)` instead of
// `BrowserWindow.getAllWindows()`. The test pretends a single
// subscriber exists for any channel, which routes back to the
// shared `send` mock above.
vi.mock("../window-channels", () => ({
  federationTargetForChannelSubscriber: (webContents: { id: number }) =>
    channelSubscriberTargets.get(webContents.id),
  subscribersForChannel: () => channelSubscribers,
  WINDOW_KIND_MAIN: "main",
  WINDOW_KIND_MESSAGING_ACTIVITY: "messaging-activity",
  registerWindowChannels: () => undefined,
  debugListRegisteredWindows: () => [],
  _resetWindowChannelsForTests: () => undefined,
}));

vi.mock("../app-server/backend-registry", () => ({
  getDesktopBackendRegistry: () => registry,
}));

vi.mock("../federation/federation-runtime", () => ({
  federationEventClassForMethod: () => "transcript",
  getDesktopFederationRuntime: () => federationMock.runtime,
}));

vi.mock("../scheduled-actions/scheduled-thread-action-service", () => ({
  getScheduledThreadActionService: () => ({ create: vi.fn() }),
}));

vi.mock("../log", () => ({
  getMainLogger: vi.fn(() => mockAppServerLog),
}));

describe("agent ipc", () => {
  beforeEach(() => {
    handlers.clear();
    send.mockReset();
    mockAppServerLog.debug.mockClear();
    mockAppServerLog.error.mockClear();
    mockAppServerLog.info.mockClear();
    mockAppServerLog.warn.mockClear();
    federationWindowSend.mockReset();
    registry.isPullRequestLocallyMonitored.mockClear();
    registry.isPullRequestLocallyMonitored.mockReturnValue(false);
    channelSubscribers = [{ id: 1, send }, federationWindowWebContents];
    channelSubscriberTargets.clear();
    channelSubscriberTargets.set(2, {
      scope: "remote",
      instanceId: "peer-1",
    });
    registry.listBackends.mockClear();
    registry.onEvent.mockClear();
    registry.startThread.mockClear();
    registry.startTurn.mockClear();
    registry.submitTurn.mockClear();
    registry.startReview.mockClear();
    registry.cancelQueuedTurn.mockClear();
    registry.cancelQueuedTurnWithDisposition.mockClear();
    registry.interruptTurn.mockClear();
    registry.stopSubAgent.mockClear();
    registry.steerTurn.mockClear();
    registry.materializeDirectoryLaunchpad.mockClear();
    registry.setThreadPrAutoDispatch.mockClear();
    registry.cancelThreadPrAutoDispatch.mockClear();
    registry.sendThreadPrAutoDispatchNow.mockClear();
    registry.applyThreadModelMigration.mockClear();
    federationMock.runtime.remoteBackend.mockClear();
    federationMock.runtime.hydrateLiveThreadMessageOrigin.mockReset();
    federationMock.runtime.hydrateLiveThreadMessageOrigin.mockImplementation(
      (event: AgentEvent) => event,
    );
    federationMock.runtime.rendererWantsRemoteEvent.mockReset();
    federationMock.runtime.rendererWantsRemoteEvent.mockReturnValue(true);
    federationMock.runtime.setAgentEventPublisher.mockClear();
    federationMock.runtime.setEnvironmentSetupProgressPublisher.mockClear();
    for (const method of Object.values(federationMock.remoteBackend)) {
      method.mockClear();
    }
    registryListener = undefined;
  });

  it("routes remote thread controls through federation without leaking the target", async () => {
    const { registerAgentIpcHandlers, disposeAgentIpcHandlers } = await import(
      "../ipc/agent-ipc"
    );
    const {
      AGENT_CANCEL_QUEUED_TURN_CHANNEL,
      AGENT_CANCEL_THREAD_EXECUTION_MODE_QUEUE_CHANNEL,
      AGENT_CANCEL_THREAD_PR_AUTO_DISPATCH_CHANNEL,
      AGENT_SEND_THREAD_PR_AUTO_DISPATCH_NOW_CHANNEL,
      AGENT_SET_THREAD_PR_AUTO_DISPATCH_CHANNEL,
      AGENT_APPLY_THREAD_MODEL_MIGRATION_CHANNEL,
      AGENT_CHECK_THREAD_BRANCH_DRIFT_CHANNEL,
      AGENT_COMPACT_THREAD_CHANNEL,
      AGENT_FORK_THREAD_CHANNEL,
      AGENT_INTERRUPT_TURN_CHANNEL,
      AGENT_MATERIALIZE_DIRECTORY_LAUNCHPAD_CHANNEL,
      AGENT_QUEUE_THREAD_EXECUTION_MODE_CHANNEL,
      AGENT_RUN_CODEX_ENVIRONMENT_ACTION_CHANNEL,
      AGENT_RETAIN_THREAD_BRANCH_DRIFT_CHANNEL,
      AGENT_STOP_CODEX_ENVIRONMENT_ACTION_CHANNEL,
      AGENT_SET_ACP_SESSION_RUNTIME_OPTION_CHANNEL,
      AGENT_SET_CODEX_THREAD_ENVIRONMENT_CHANNEL,
      AGENT_SET_THREAD_EXECUTION_MODE_CHANNEL,
      AGENT_SET_THREAD_MODEL_SETTINGS_CHANNEL,
      AGENT_START_TURN_CHANNEL,
      AGENT_START_REVIEW_CHANNEL,
      AGENT_START_THREAD_CHANNEL,
      AGENT_STEER_TURN_CHANNEL,
      AGENT_STOP_SUB_AGENT_CHANNEL,
      AGENT_SUBMIT_SERVER_REQUEST_CHANNEL,
      AGENT_TRUST_CODEX_PROJECT_CHANNEL,
      AGENT_UPDATE_THREAD_EXPECTED_BRANCH_CHANNEL,
    } = await import("../../shared/ipc");
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "client_one",
    };

    registerAgentIpcHandlers();

    await handlers.get(AGENT_START_THREAD_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      cwd: "/repo/app",
    });
    await handlers.get(AGENT_TRUST_CODEX_PROJECT_CHANNEL)?.({}, {
      federationTarget,
      projectPath: "/repo/app",
      configPath: "/remote/.codex/config.toml",
    });
    await handlers.get(AGENT_FORK_THREAD_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      sourceThreadId: "thread-1",
    });
    await handlers.get(AGENT_START_TURN_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-1",
      input: [{ type: "text", text: "Ship it" }],
    });
    await handlers.get(AGENT_CANCEL_QUEUED_TURN_CHANNEL)?.({}, {
      federationTarget,
      queueEntryId: "queue-1",
    });
    await handlers.get(AGENT_START_REVIEW_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-1",
      target: { type: "uncommittedChanges" },
    });
    await handlers.get(AGENT_COMPACT_THREAD_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-1",
    });
    await handlers.get(AGENT_INTERRUPT_TURN_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await handlers.get(AGENT_STOP_SUB_AGENT_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-1",
      monitorId: "monitor-1",
    });
    await handlers.get(AGENT_STEER_TURN_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "Actually do this" }],
    });
    await handlers.get(AGENT_SET_THREAD_EXECUTION_MODE_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-1",
      executionMode: "plan",
    });
    await handlers.get(AGENT_QUEUE_THREAD_EXECUTION_MODE_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-1",
      executionMode: "default",
    });
    await handlers.get(AGENT_CANCEL_THREAD_EXECUTION_MODE_QUEUE_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-1",
    });
    await handlers.get(AGENT_SET_ACP_SESSION_RUNTIME_OPTION_CHANNEL)?.({}, {
      backend: "acp:gemini",
      federationTarget,
      threadId: "thread-1",
      source: "model",
      optionId: "model",
      value: "gemini-pro",
    });
    await handlers.get(AGENT_SET_THREAD_MODEL_SETTINGS_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-1",
      model: "gpt-5-codex",
    });
    await handlers.get(AGENT_SET_THREAD_PR_AUTO_DISPATCH_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-1",
      enabled: true,
    });
    await handlers.get(AGENT_CANCEL_THREAD_PR_AUTO_DISPATCH_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-1",
      fingerprint: "fingerprint-1",
    });
    await handlers.get(AGENT_SEND_THREAD_PR_AUTO_DISPATCH_NOW_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-1",
      fingerprint: "fingerprint-1",
    });
    await handlers.get(AGENT_APPLY_THREAD_MODEL_MIGRATION_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-1",
      threadCreatedAt: 1_000,
      threadModel: "gpt-5-codex",
    });
    await handlers.get(AGENT_CHECK_THREAD_BRANCH_DRIFT_CHANNEL)?.({}, {
      backend: "codex",
      expectedBranch: "feature/expected",
      federationTarget,
      threadId: "thread-1",
    });
    await handlers.get(AGENT_UPDATE_THREAD_EXPECTED_BRANCH_CHANNEL)?.({}, {
      backend: "codex",
      branch: "main",
      federationTarget,
      threadId: "thread-1",
    });
    await handlers.get(AGENT_RETAIN_THREAD_BRANCH_DRIFT_CHANNEL)?.({}, {
      backend: "codex",
      expectedBranch: "feature/expected",
      federationTarget,
      observedBranch: "main",
      threadId: "thread-1",
    });
    await handlers.get(AGENT_RUN_CODEX_ENVIRONMENT_ACTION_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-1",
      actionId: "setup",
      cwd: "/repo/app",
    });
    await handlers.get(AGENT_STOP_CODEX_ENVIRONMENT_ACTION_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-1",
      runId: "run-1",
      mode: "stop",
    });
    await handlers.get(AGENT_SET_CODEX_THREAD_ENVIRONMENT_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-1",
      environmentId: "node",
      actionId: "setup",
    });
    await handlers.get(AGENT_SUBMIT_SERVER_REQUEST_CHANNEL)?.({}, {
      backend: "codex",
      federationTarget,
      threadId: "thread-1",
      turnId: "turn-1",
      requestId: "approval-1",
      response: { decision: "approve" },
    });
    await handlers.get(AGENT_MATERIALIZE_DIRECTORY_LAUNCHPAD_CHANNEL)?.({}, {
      directoryKey: "directory:/repo/app",
      federationTarget,
    });

    expect(federationMock.runtime.remoteBackend).toHaveBeenCalledWith(federationTarget);
    expect(federationMock.remoteBackend.startThread).toHaveBeenCalledWith({
      backend: "codex",
      cwd: "/repo/app",
    });
    expect(federationMock.remoteBackend.forkThread).toHaveBeenCalledWith({
      backend: "codex",
      sourceThreadId: "thread-1",
    });
    expect(federationMock.remoteBackend.startTurn).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "Ship it" }],
    });
    expect(federationMock.remoteBackend.cancelQueuedTurn).toHaveBeenCalledWith({
      queueEntryId: "queue-1",
    });
    expect(registry.cancelQueuedTurn).not.toHaveBeenCalled();
    expect(registry.cancelQueuedTurnWithDisposition).not.toHaveBeenCalled();
    expect(federationMock.remoteBackend.startReview).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      target: { type: "uncommittedChanges" },
    });
    expect(federationMock.remoteBackend.compactThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(federationMock.remoteBackend.interruptTurn).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(federationMock.remoteBackend.stopSubAgent).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      monitorId: "monitor-1",
    });
    expect(registry.stopSubAgent).not.toHaveBeenCalled();
    expect(federationMock.remoteBackend.steerTurn).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "Actually do this" }],
    });
    expect(federationMock.remoteBackend.setThreadExecutionMode).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "plan",
    });
    expect(federationMock.remoteBackend.queueThreadExecutionMode).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
    });
    expect(
      federationMock.remoteBackend.cancelThreadExecutionModeQueue,
    ).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(federationMock.remoteBackend.setAcpSessionRuntimeOption).toHaveBeenCalledWith({
      backend: "acp:gemini",
      threadId: "thread-1",
      source: "model",
      optionId: "model",
      value: "gemini-pro",
    });
    expect(federationMock.remoteBackend.setThreadModelSettings).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      model: "gpt-5-codex",
    });
    expect(federationMock.remoteBackend.setThreadPrAutoDispatch).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      enabled: true,
    });
    expect(registry.setThreadPrAutoDispatch).not.toHaveBeenCalled();
    // The pending dispatch and its fingerprint live only in the owner's
    // coordinator, so a viewer that resolves these locally silently
    // no-ops while the owner still fires the scheduled repair turn.
    expect(
      federationMock.remoteBackend.cancelThreadPrAutoDispatch,
    ).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      fingerprint: "fingerprint-1",
    });
    expect(registry.cancelThreadPrAutoDispatch).not.toHaveBeenCalled();
    expect(
      federationMock.remoteBackend.sendThreadPrAutoDispatchNow,
    ).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      fingerprint: "fingerprint-1",
    });
    expect(registry.sendThreadPrAutoDispatchNow).not.toHaveBeenCalled();
    expect(registry.applyThreadModelMigration).not.toHaveBeenCalled();
    expect(federationMock.remoteBackend.checkThreadBranchDrift).toHaveBeenCalledWith({
      backend: "codex",
      expectedBranch: "feature/expected",
      threadId: "thread-1",
    });
    expect(federationMock.remoteBackend.updateThreadExpectedBranch).toHaveBeenCalledWith({
      backend: "codex",
      branch: "main",
      threadId: "thread-1",
    });
    expect(federationMock.remoteBackend.retainThreadBranchDrift).toHaveBeenCalledWith({
      backend: "codex",
      expectedBranch: "feature/expected",
      observedBranch: "main",
      threadId: "thread-1",
    });
    expect(federationMock.remoteBackend.runCodexEnvironmentAction).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      actionId: "setup",
      cwd: "/repo/app",
    });
    expect(federationMock.remoteBackend.stopCodexEnvironmentAction).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      runId: "run-1",
      mode: "stop",
    });
    expect(federationMock.remoteBackend.setCodexThreadEnvironment).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      environmentId: "node",
      actionId: "setup",
    });
    expect(federationMock.remoteBackend.submitServerRequest).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      requestId: "approval-1",
      response: { decision: "approve" },
    });
    expect(federationMock.remoteBackend.trustCodexProject).toHaveBeenCalledWith({
      projectPath: "/repo/app",
      configPath: "/remote/.codex/config.toml",
    });
    expect(
      federationMock.remoteBackend.materializeDirectoryLaunchpad,
    ).toHaveBeenCalledWith({
      directoryKey: "directory:/repo/app",
    });

    disposeAgentIpcHandlers();
  });

  it("loads backend summaries from the selected federation peer", async () => {
    const { registerAgentIpcHandlers, disposeAgentIpcHandlers } = await import(
      "../ipc/agent-ipc"
    );
    const { BACKEND_LIST_CHANNEL } = await import("../../shared/ipc");
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "client_one",
    };
    registerAgentIpcHandlers();

    await handlers.get(BACKEND_LIST_CHANNEL)?.({}, {
      includeUnavailable: true,
      federationTarget,
    });

    expect(federationMock.runtime.remoteBackend).toHaveBeenCalledWith(
      federationTarget,
    );
    expect(federationMock.remoteBackend.listBackends).toHaveBeenCalledWith({
      includeUnavailable: true,
    });
    expect(registry.listBackends).not.toHaveBeenCalled();
    disposeAgentIpcHandlers();
  });

  it("refuses to apply this instance's model migration to a remote thread", async () => {
    const { registerAgentIpcHandlers, disposeAgentIpcHandlers } = await import(
      "../ipc/agent-ipc"
    );
    const { AGENT_APPLY_THREAD_MODEL_MIGRATION_CHANNEL } = await import(
      "../../shared/ipc"
    );
    registerAgentIpcHandlers();

    // Migration configuration and acknowledgement state are profile-local.
    // Forwarding this request would apply this instance's migration policy to
    // a thread owned by another instance.
    expect(
      await handlers.get(AGENT_APPLY_THREAD_MODEL_MIGRATION_CHANNEL)?.({}, {
        backend: "codex",
        federationTarget: { scope: "remote", instanceId: "client_one" },
        threadId: "thread-1",
        threadCreatedAt: 1_000,
        threadModel: "gpt-5-codex",
      }),
    ).toEqual({
      backend: "codex",
      threadId: "thread-1",
      status: "not-owner",
    });
    expect(federationMock.runtime.remoteBackend).not.toHaveBeenCalled();
    expect(registry.applyThreadModelMigration).not.toHaveBeenCalled();

    disposeAgentIpcHandlers();
  });

  it("registers backend and agent handlers and broadcasts backend-tagged events", async () => {
    const {
      registerAgentIpcHandlers,
      disposeAgentIpcHandlers,
    } = await import("../ipc/agent-ipc");
    const {
      AGENT_EVENT_CHANNEL,
      AGENT_CANCEL_QUEUED_TURN_CHANNEL,
      AGENT_INTERRUPT_TURN_CHANNEL,
      AGENT_MATERIALIZE_DIRECTORY_LAUNCHPAD_CHANNEL,
      AGENT_START_THREAD_CHANNEL,
      AGENT_START_REVIEW_CHANNEL,
      AGENT_START_TURN_CHANNEL,
      AGENT_STOP_SUB_AGENT_CHANNEL,
      AGENT_STEER_TURN_CHANNEL,
      BACKEND_LIST_CHANNEL,
    } = await import("../../shared/ipc");

    registerAgentIpcHandlers();

    expect(await handlers.get(BACKEND_LIST_CHANNEL)?.({}, {})).toEqual({
      fetchedAt: 1,
      backends: [],
    });
    expect(
      await handlers.get(AGENT_START_THREAD_CHANNEL)?.({}, { backend: "acp:grok" }),
    ).toEqual({
      backend: "acp:grok",
      threadId: "thread-1",
    });
    vi.mocked(registry.submitTurn).mockResolvedValueOnce({
      status: "queued",
      entry: {
        id: "renderer-queue-1",
        backend: "acp:grok",
        createdAt: 2,
        input: [{ type: "text", text: "Queue it" }],
        origin: "manual",
        threadId: "thread-1",
      },
      position: 1,
    });
    expect(
      await handlers.get(AGENT_START_TURN_CHANNEL)?.({}, {
        backend: "acp:grok",
        threadId: "thread-1",
        queueEntryId: "renderer-queue-1",
        input: [{ type: "text", text: "Queue it" }],
      }),
    ).toEqual({
      backend: "acp:grok",
      queueEntryId: "renderer-queue-1",
      queueEntryCreatedAt: 2,
      queueStatus: "queued",
      threadId: "thread-1",
      turnId: "renderer-queue-1",
    });
    expect(registry.submitTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ queueEntryId: "renderer-queue-1" }),
    );
    expect(
      await handlers.get(AGENT_START_TURN_CHANNEL)?.({}, {
        backend: "acp:grok",
        threadId: "thread-1",
        input: [{ type: "text", text: "Ship it" }],
      }),
    ).toEqual({
      backend: "acp:grok",
      queueEntryId: "queue-1",
      queueStatus: "started",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(
      await handlers.get(AGENT_CANCEL_QUEUED_TURN_CHANNEL)?.({}, {
        queueEntryId: "queue-2",
      }),
    ).toEqual({
      queueEntryId: "queue-2",
      cancelled: true,
      disposition: "cancelled",
    });
    expect(registry.cancelQueuedTurnWithDisposition).toHaveBeenCalledWith(
      "queue-2",
      "Cancelled from the desktop composer.",
    );
    expect(
      await handlers.get(AGENT_START_REVIEW_CHANNEL)?.({}, {
        backend: "acp:grok",
        threadId: "thread-1",
        target: { type: "uncommittedChanges" },
      }),
    ).toEqual({
      backend: "acp:grok",
      threadId: "thread-1",
      reviewThreadId: "thread-1",
      turnId: "turn-review-1",
    });
    expect(
      await handlers.get(AGENT_INTERRUPT_TURN_CHANNEL)?.({}, {
        backend: "acp:grok",
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    ).toEqual({
      backend: "acp:grok",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(
      await handlers.get(AGENT_STOP_SUB_AGENT_CHANNEL)?.({}, {
        backend: "codex",
        threadId: "thread-1",
        monitorId: "monitor-1",
      }),
    ).toEqual({
      backend: "codex",
      threadId: "thread-1",
      monitorId: "monitor-1",
      stoppedAt: 1,
    });
    expect(
      await handlers.get(AGENT_STEER_TURN_CHANNEL)?.({}, {
        backend: "codex",
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "Course correct" }],
        requestId: "steer-1",
      }),
    ).toEqual({
      backend: "codex",
      disposition: "steered",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(
      await handlers.get(AGENT_MATERIALIZE_DIRECTORY_LAUNCHPAD_CHANNEL)?.({}, {
        directoryKey: "directory:/repo/app",
      }),
    ).toEqual({
      backend: "codex",
      threadId: "materialized:directory:/repo/app",
      executionMode: "default",
      workMode: "local",
      turnId: "turn-2",
    });

    await registryListener?.({
      backend: "acp:grok",
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
    });

    expect(send).toHaveBeenCalledWith(AGENT_EVENT_CHANNEL, {
      backend: "acp:grok",
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
    });

    disposeAgentIpcHandlers();
  });

  it("routes remote events only to subscribed windows for the owning instance", async () => {
    const { broadcastAgentEvent } = await import("../ipc/agent-ipc");
    const localSend = vi.fn();
    const ownerSend = vi.fn();
    const unrelatedSend = vi.fn();
    channelSubscribers = [
      { id: 1, send: localSend },
      { id: 2, send: ownerSend },
      { id: 3, send: unrelatedSend },
    ];
    channelSubscriberTargets.set(2, {
      scope: "remote",
      instanceId: "owner_one",
    });
    channelSubscriberTargets.set(3, {
      scope: "remote",
      instanceId: "owner_two",
    });
    federationMock.runtime.rendererWantsRemoteEvent.mockImplementation(
      (webContentsId?: number, instanceId?: string) =>
        webContentsId === 2 && instanceId === "owner_one",
    );

    broadcastAgentEvent({
      backend: "codex",
      federationTarget: { scope: "remote", instanceId: "owner_one" },
      notification: {
        method: "item/agentMessage/delta",
        params: {
          delta: "hello",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      },
    } as AgentEvent);

    expect(ownerSend).toHaveBeenCalledTimes(1);
    expect(localSend).not.toHaveBeenCalled();
    expect(unrelatedSend).not.toHaveBeenCalled();
  });

  it("hydrates live message provenance before broadcasting it", async () => {
    const { broadcastAgentEvent } = await import("../ipc/agent-ipc");
    const { AGENT_EVENT_CHANNEL } = await import("../../shared/ipc");
    federationMock.runtime.hydrateLiveThreadMessageOrigin.mockImplementation(
      (event: AgentEvent) => ({
        ...event,
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "user-message-1",
              type: "userMessage",
              origin: {
                kind: "agent",
                sourceThread: {
                  backend: "codex",
                  instanceId: "source_one",
                  instanceLabel: "Source Mac",
                  celestialIcon: "moon",
                  threadId: "source-thread",
                  title: "Source thread",
                },
              },
              content: [{ type: "text", text: "Remote result" }],
            },
          },
        },
      } as AgentEvent),
    );

    broadcastAgentEvent({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "user-message-1",
            type: "userMessage",
            origin: {
              kind: "agent",
              sourceThread: {
                backend: "codex",
                instanceId: "source_one",
                threadId: "source-thread",
                title: "Source thread",
              },
            },
            content: [{ type: "text", text: "Remote result" }],
          },
        },
      },
    } as AgentEvent);

    expect(send).toHaveBeenCalledWith(
      AGENT_EVENT_CHANNEL,
      expect.objectContaining({
        notification: expect.objectContaining({
          params: expect.objectContaining({
            item: expect.objectContaining({
              origin: expect.objectContaining({
                sourceThread: expect.objectContaining({
                  instanceLabel: "Source Mac",
                  celestialIcon: "moon",
                }),
              }),
            }),
          }),
        }),
      }),
    );
  });

  it("caps oversized live agent event strings before broadcasting to renderer subscribers", async () => {
    const {
      registerAgentIpcHandlers,
      disposeAgentIpcHandlers,
    } = await import("../ipc/agent-ipc");
    const { AGENT_EVENT_CHANNEL } = await import("../../shared/ipc");
    const oversizedOutput =
      `{"backend":"codex","captureId":"2026-04-19T01-40-27-292Z-codex"}` +
      "x".repeat(80_000) +
      "protocol-tail";

    registerAgentIpcHandlers();

    await registryListener?.({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "cmd-1",
            type: "commandExecution",
            command: "cat protocol-capture.json",
            data: {
              aggregatedOutput: oversizedOutput,
            },
          },
        },
      },
    } as AgentEvent);

    const sentEvent = send.mock.calls[0]?.[1] as AgentEvent | undefined;
    const item =
      sentEvent?.notification.method === "item/completed"
        ? sentEvent.notification.params.item
        : undefined;
    const output = (item as { data?: Record<string, unknown> } | undefined)
      ?.data?.aggregatedOutput;

    expect(send).toHaveBeenCalledWith(
      AGENT_EVENT_CHANNEL,
      expect.objectContaining({
        backend: "codex",
      }),
    );
    expect(typeof output).toBe("string");
    expect(output).toContain("PwrAgent renderer boundary: truncated");
    expect(output).toContain("$.notification.params.item.data.aggregatedOutput");
    expect(output).toContain("protocol-tail");
    expect(output).not.toContain("x".repeat(60_000));

    disposeAgentIpcHandlers();
  });

  it("caps oversized live diff payloads before broadcasting to renderer subscribers", async () => {
    const {
      registerAgentIpcHandlers,
      disposeAgentIpcHandlers,
    } = await import("../ipc/agent-ipc");
    const { AGENT_EVENT_CHANNEL } = await import("../../shared/ipc");
    const oversizedDiff =
      `{"backend":"codex","captureId":"2026-04-19T01-40-27-292Z-codex"}` +
      "x".repeat(80_000) +
      "protocol-tail";

    registerAgentIpcHandlers();

    await registryListener?.({
      backend: "codex",
      notification: {
        method: "turn/diff/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          diff: oversizedDiff,
        },
      },
    } as AgentEvent);

    const sentEvent = send.mock.calls[0]?.[1] as AgentEvent | undefined;
    const diff =
      sentEvent?.notification.method === "turn/diff/updated"
        ? sentEvent.notification.params.diff
        : undefined;

    expect(send).toHaveBeenCalledWith(
      AGENT_EVENT_CHANNEL,
      expect.objectContaining({
        backend: "codex",
      }),
    );
    expect(typeof diff).toBe("string");
    expect(diff).toContain("PwrAgent renderer boundary: truncated");
    expect(diff).toContain("$.notification.params.diff");
    expect(diff).toContain("protocol-tail");
    expect(diff).not.toContain("x".repeat(60_000));
    expect(mockAppServerLog.debug).toHaveBeenCalledWith(
      "agentEvent",
      expect.objectContaining({
        method: "turn/diff/updated",
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    );
    expect(mockAppServerLog.info).not.toHaveBeenCalledWith(
      "agentEvent",
      expect.anything(),
    );

    disposeAgentIpcHandlers();
  });

  it("attaches pre-shaped live diff activity before broadcasting to renderer subscribers", async () => {
    const {
      registerAgentIpcHandlers,
      disposeAgentIpcHandlers,
    } = await import("../ipc/agent-ipc");
    const { AGENT_EVENT_CHANNEL } = await import("../../shared/ipc");
    const diff = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,1 +1,2 @@",
      " existing",
      "+added",
    ].join("\n");

    registerAgentIpcHandlers();

    await registryListener?.({
      backend: "codex",
      notification: {
        method: "turn/diff/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          diff,
        },
      },
    } as AgentEvent);

    expect(send).toHaveBeenCalledWith(
      AGENT_EVENT_CHANNEL,
      expect.objectContaining({
        rendererActivityEntry: expect.objectContaining({
          id: "live-diff-turn-1",
          summary: "Edited 1 file, +1, -0",
          details: [
            expect.objectContaining({
              label: "Update example.ts",
              path: "src/example.ts",
              fileDiff: expect.objectContaining({
                diff: "",
                diffRef: expect.objectContaining({
                  source: "live",
                  threadId: "thread-1",
                  entryId: "live-diff-turn-1",
                  detailId: "live-diff-turn-1-1",
                }),
                additions: 1,
                removals: 0,
              }),
            }),
          ],
        }),
      }),
    );

    disposeAgentIpcHandlers();
  });

  it("withholds a peer's PR status from windows that monitor the PR locally", async () => {
    const { registerAgentIpcHandlers, disposeAgentIpcHandlers } = await import(
      "../ipc/agent-ipc"
    );
    const { AGENT_EVENT_CHANNEL } = await import("../../shared/ipc");

    registerAgentIpcHandlers();

    const remotePrEvent = {
      backend: "codex" as const,
      federationTarget: { scope: "remote" as const, instanceId: "peer-1" },
      notification: {
        method: "pullRequest/status/updated" as const,
        params: {
          prKey: "github/pwrdrvr/pwragent#1270",
          pr: {
            number: 1270,
            provider: "github" as const,
            org: "pwrdrvr",
            repo: "PwrAgent",
            title: "canonical PR status",
            url: "https://github.com/pwrdrvr/PwrAgent/pull/1270",
            state: "open" as const,
          },
        },
      },
    };

    // Not attached locally: the peer is the only observer, so every
    // window — including the main one rendering a pinned remote row —
    // needs it.
    registry.isPullRequestLocallyMonitored.mockReturnValue(false);
    await registryListener?.(remotePrEvent as unknown as AgentEvent);
    expect(send).toHaveBeenCalledWith(
      AGENT_EVENT_CHANNEL,
      expect.objectContaining({ federationTarget: { scope: "remote", instanceId: "peer-1" } }),
    );
    expect(federationWindowSend).toHaveBeenCalledTimes(1);

    // Attached locally: our own poller owns this PR and its events
    // already patch the pinned row by prKey, so the peer's copy must not
    // reach the main window. The federation window has no local monitor
    // to defer to and still gets it.
    send.mockReset();
    federationWindowSend.mockReset();
    registry.isPullRequestLocallyMonitored.mockReturnValue(true);
    await registryListener?.(remotePrEvent as unknown as AgentEvent);
    expect(send).not.toHaveBeenCalled();
    expect(federationWindowSend).toHaveBeenCalledTimes(1);

    // The gate is scoped to remote PR status: a local observation of the
    // same PR still reaches every window.
    send.mockReset();
    await registryListener?.({
      ...remotePrEvent,
      federationTarget: undefined,
    } as unknown as AgentEvent);
    expect(send).toHaveBeenCalledTimes(1);

    // A peer's ATTACHMENT LIST is never gated, even while we monitor a
    // PR on that list ourselves: which PRs hang off a peer's thread is
    // the peer's to declare, and only its own rows are rewritten (the
    // renderer scopes that apply by federation origin). Widening the
    // gate to cover this method would silently freeze pinned remote
    // rows, so this asymmetry is pinned on purpose.
    send.mockReset();
    federationWindowSend.mockReset();
    registry.isPullRequestLocallyMonitored.mockReturnValue(true);
    await registryListener?.({
      backend: "codex",
      federationTarget: { scope: "remote", instanceId: "peer-1" },
      notification: {
        method: "thread/pullRequests/updated",
        params: { threadId: "peer-thread-1", prs: [remotePrEvent.notification.params.pr] },
      },
    } as unknown as AgentEvent);
    expect(send).toHaveBeenCalledTimes(1);
    expect(federationWindowSend).toHaveBeenCalledTimes(1);

    disposeAgentIpcHandlers();
  });
});
