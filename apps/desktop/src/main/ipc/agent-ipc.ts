import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { subscribersForChannel } from "../window-channels";
import {
  sanitizeRendererPayload,
  type AgentEvent,
  type CancelThreadExecutionModeQueueRequest,
  type CancelThreadExecutionModeQueueResponse,
  type CheckThreadBranchDriftRequest,
  type CheckThreadBranchDriftResponse,
  type CompactThreadRequest,
  type CompactThreadResponse,
  type ForkThreadRequest,
  type ForkThreadResponse,
  type MaterializeDirectoryLaunchpadRequest,
  type MaterializeDirectoryLaunchpadResponse,
  type InterruptTurnRequest,
  type InterruptTurnResponse,
  type LatestCodexConfigWarningResponse,
  type ListBackendsRequest,
  type ListBackendsResponse,
  type QueueThreadExecutionModeRequest,
  type QueueThreadExecutionModeResponse,
  type RetainThreadBranchDriftRequest,
  type RetainThreadBranchDriftResponse,
  type RunCodexEnvironmentActionRequest,
  type RunCodexEnvironmentActionResponse,
  type StopCodexEnvironmentActionRequest,
  type StopCodexEnvironmentActionResponse,
  type SetAcpSessionRuntimeOptionRequest,
  type SetAcpSessionRuntimeOptionResponse,
  type SetCodexThreadEnvironmentRequest,
  type SetCodexThreadEnvironmentResponse,
  type SetThreadExecutionModeRequest,
  type SetThreadExecutionModeResponse,
  type SetThreadModelSettingsRequest,
  type SetThreadModelSettingsResponse,
  type SteerTurnRequest,
  type SteerTurnResponse,
  type StartReviewRequest,
  type StartReviewResponse,
  type StartThreadRequest,
  type StartThreadResponse,
  type StartTurnRequest,
  type StartTurnResponse,
  type SubmitServerRequestRequest,
  type SubmitServerRequestResponse,
  type TrustCodexProjectRequest,
  type TrustCodexProjectResponse,
  type UpdateThreadExpectedBranchRequest,
  type UpdateThreadExpectedBranchResponse,
} from "@pwragent/shared";
import { isRemoteFederationTarget } from "@pwragent/shared";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { buildLiveDiffActivityEntry } from "../app-server/live-diff-activity";
import { timeStartupProfileOperation } from "../diagnostics/startup-profile-events";
import {
  AGENT_CANCEL_THREAD_EXECUTION_MODE_QUEUE_CHANNEL,
  AGENT_EVENT_CHANNEL,
  AGENT_FORK_THREAD_CHANNEL,
  AGENT_LATEST_CODEX_CONFIG_WARNING_CHANNEL,
  AGENT_CHECK_THREAD_BRANCH_DRIFT_CHANNEL,
  AGENT_COMPACT_THREAD_CHANNEL,
  AGENT_INTERRUPT_TURN_CHANNEL,
  AGENT_MATERIALIZE_DIRECTORY_LAUNCHPAD_CHANNEL,
  AGENT_QUEUE_THREAD_EXECUTION_MODE_CHANNEL,
  AGENT_RETAIN_THREAD_BRANCH_DRIFT_CHANNEL,
  AGENT_RUN_CODEX_ENVIRONMENT_ACTION_CHANNEL,
  AGENT_STOP_CODEX_ENVIRONMENT_ACTION_CHANNEL,
  AGENT_SET_CODEX_THREAD_ENVIRONMENT_CHANNEL,
  AGENT_SET_ACP_SESSION_RUNTIME_OPTION_CHANNEL,
  AGENT_SET_THREAD_EXECUTION_MODE_CHANNEL,
  AGENT_SET_THREAD_MODEL_SETTINGS_CHANNEL,
  AGENT_START_THREAD_CHANNEL,
  AGENT_START_REVIEW_CHANNEL,
  AGENT_START_TURN_CHANNEL,
  AGENT_STEER_TURN_CHANNEL,
  AGENT_SUBMIT_SERVER_REQUEST_CHANNEL,
  AGENT_TRUST_CODEX_PROJECT_CHANNEL,
  AGENT_UPDATE_THREAD_EXPECTED_BRANCH_CHANNEL,
  BACKEND_LIST_CHANNEL,
  CODEX_ENVIRONMENT_SETUP_PROGRESS_CHANNEL,
} from "../../shared/ipc";
import { getMainLogger } from "../log";

let unsubscribeRegistryEvents: (() => void) | undefined;

const isDevelopment = process.env.NODE_ENV !== "production";
const appServerLog = getMainLogger("pwragent:app-server");
const AGENT_EVENT_LOG_INTERVAL_MS = 1_000;

type CoalescedAgentEventLog = {
  firstSuppressedAt: number;
  lastLoggedAt: number;
  lastSuppressedAt: number;
  latestSummary: Record<string, unknown>;
  suppressedCount: number;
};

const coalescedAgentEventLogs = new Map<string, CoalescedAgentEventLog>();

function logDebug(event: string, payload: Record<string, unknown>): void {
  if (!isDevelopment) {
    return;
  }

  appServerLog.info(event, payload);
}

function summarizeTurnInput(input: StartTurnRequest["input"]): Record<string, unknown> {
  const textChars = input
    .filter((item): item is Extract<StartTurnRequest["input"][number], { type: "text" }> =>
      item.type === "text"
    )
    .reduce((count, item) => count + item.text.length, 0);
  const imageCount = input.filter((item) => item.type !== "text").length;

  return {
    inputCount: input.length,
    textChars,
    imageCount,
  };
}

function stripFederationTarget<T extends { federationTarget?: unknown }>(
  request: T,
): Omit<T, "federationTarget"> {
  const { federationTarget: _federationTarget, ...rest } = request;
  return rest;
}

function summarizeAgentEvent(event: AgentEvent): Record<string, unknown> | undefined {
  const params = event.notification.params;
  const turn =
    "turn" in params && typeof params.turn === "object" && params.turn !== null
      ? (params.turn as Record<string, unknown>)
      : undefined;
  const threadId =
    "threadId" in params && typeof params.threadId === "string"
      ? params.threadId
      : undefined;
  const turnId =
    "turnId" in params && typeof params.turnId === "string"
      ? params.turnId
      : undefined;

  if (
    event.notification.method === "item/started" ||
    event.notification.method === "item/completed"
  ) {
    const item =
      "item" in params && typeof params.item === "object" && params.item !== null
        ? (params.item as Record<string, unknown>)
        : undefined;
    return {
      backend: event.backend,
      method: event.notification.method,
      threadId: threadId ?? null,
      turnId: turnId ?? null,
      itemType: typeof item?.type === "string" ? item.type : null,
      toolName: typeof item?.toolName === "string" ? item.toolName : null,
      status: typeof item?.status === "string" ? item.status : null,
      textChars: typeof item?.text === "string" ? item.text.length : 0,
      elapsedMs:
        item?.data &&
        typeof item.data === "object" &&
        !Array.isArray(item.data) &&
        typeof (item.data as Record<string, unknown>).elapsedMs === "number"
          ? (item.data as Record<string, unknown>).elapsedMs
          : null,
    };
  }

  if (!event.notification.method.startsWith("turn/")) {
    return undefined;
  }

  const summary: Record<string, unknown> = {
    backend: event.backend,
    method: event.notification.method,
    threadId: threadId ?? null,
    turnId: turnId ?? null,
  };

  if (event.notification.method === "turn/completed") {
    const output = Array.isArray(turn?.output) ? turn.output : [];
    summary.outputTextChars = output.reduce((count, item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return count;
      }

      const text = (item as Record<string, unknown>).text;
      return typeof text === "string" ? count + text.length : count;
    }, 0);
  }

  if (event.notification.method === "turn/failed") {
    const error =
      turn?.error && typeof turn.error === "object" && !Array.isArray(turn.error)
        ? (turn.error as Record<string, unknown>)
        : undefined;
    summary.error = typeof error?.message === "string" ? error.message : null;
  }

  return summary;
}

function logAgentEventSummary(summary: Record<string, unknown>): void {
  if (!isDevelopment) {
    return;
  }

  const key = coalescedAgentEventLogKey(summary);
  if (!key) {
    appServerLog.info("agentEvent", summary);
    return;
  }

  const now = Date.now();
  const existing = coalescedAgentEventLogs.get(key);
  if (!existing) {
    coalescedAgentEventLogs.set(key, {
      firstSuppressedAt: now,
      lastLoggedAt: now,
      lastSuppressedAt: now,
      latestSummary: summary,
      suppressedCount: 0,
    });
    appServerLog.info("agentEvent", summary);
    return;
  }

  existing.latestSummary = summary;
  existing.lastSuppressedAt = now;
  existing.suppressedCount += 1;
  if (now - existing.lastLoggedAt < AGENT_EVENT_LOG_INTERVAL_MS) {
    return;
  }

  appServerLog.debug("agentEventCoalesced", {
    ...existing.latestSummary,
    coalescedDurationMs: existing.lastSuppressedAt - existing.firstSuppressedAt,
    suppressedCount: existing.suppressedCount,
  });
  existing.firstSuppressedAt = now;
  existing.lastLoggedAt = now;
  existing.lastSuppressedAt = now;
  existing.suppressedCount = 0;
}

function coalescedAgentEventLogKey(
  summary: Record<string, unknown>,
): string | undefined {
  const method = summary.method;
  if (method !== "item/started" && method !== "item/completed") {
    return undefined;
  }
  return JSON.stringify({
    backend: summary.backend,
    itemType: summary.itemType,
    method,
    status: summary.status,
    threadId: summary.threadId,
    toolName: summary.toolName,
    turnId: summary.turnId,
  });
}

function withRendererActivityEntry(event: AgentEvent): AgentEvent {
  if (event.backend !== "codex" || event.notification.method !== "turn/diff/updated") {
    return event;
  }

  const rendererActivityEntry = buildLiveDiffActivityEntry(
    event.notification as Extract<AgentEvent["notification"], { method: "turn/diff/updated" }>,
  );
  return rendererActivityEntry ? { ...event, rendererActivityEntry } : event;
}

export function broadcastAgentEvent(event: AgentEvent): void {
  const eventSummary = summarizeAgentEvent(event);
  if (eventSummary) {
    logAgentEventSummary(eventSummary);
  }
  const rendererEvent = sanitizeRendererPayload(withRendererActivityEntry(event));

  // Only deliver to windows that registered for this channel.
  // Secondary windows (e.g. the Messaging Activity window) opt out by
  // default — see `apps/desktop/src/main/window-channels.ts`.
  for (const webContents of subscribersForChannel(AGENT_EVENT_CHANNEL)) {
    if (typeof webContents.send !== "function") continue;
    webContents.send(AGENT_EVENT_CHANNEL, rendererEvent);
  }
}

export function registerAgentIpcHandlers(): void {
  const registry = getDesktopBackendRegistry();

  unsubscribeRegistryEvents?.();
  getDesktopFederationRuntime().setAgentEventPublisher(broadcastAgentEvent);
  unsubscribeRegistryEvents = registry.onEvent((event) => {
    broadcastAgentEvent(event);
  });

  ipcMain.removeHandler(BACKEND_LIST_CHANNEL);
  ipcMain.handle(
    BACKEND_LIST_CHANNEL,
    async (
      _event,
      request?: ListBackendsRequest
    ): Promise<ListBackendsResponse> => {
      return await timeStartupProfileOperation({
        type: "ipc-main:listBackends",
        detail: {
          hasRequest: request !== undefined,
        },
        operation: async () => await registry.listBackends(request),
      });
    },
  );

  ipcMain.removeHandler(AGENT_START_THREAD_CHANNEL);
  ipcMain.handle(
    AGENT_START_THREAD_CHANNEL,
    async (
      _event,
      request: StartThreadRequest
    ): Promise<StartThreadResponse> => {
      return await registry.startThread(request);
    },
  );

  ipcMain.removeHandler(AGENT_FORK_THREAD_CHANNEL);
  ipcMain.handle(
    AGENT_FORK_THREAD_CHANNEL,
    async (
      event: IpcMainInvokeEvent,
      request: ForkThreadRequest,
    ): Promise<ForkThreadResponse> => {
      return await registry.forkThread({
        ...request,
        onCodexEnvironmentSetupProgress: (progress) => {
          event.sender?.send?.(CODEX_ENVIRONMENT_SETUP_PROGRESS_CHANNEL, progress);
        },
      });
    },
  );

  ipcMain.removeHandler(AGENT_START_TURN_CHANNEL);
  ipcMain.handle(
    AGENT_START_TURN_CHANNEL,
    async (
      _event,
      request: StartTurnRequest
    ): Promise<StartTurnResponse> => {
      logDebug("startTurn", {
        backend: request.backend,
        threadId: request.threadId,
        model: request.model ?? null,
        reasoningEffort: request.reasoningEffort ?? null,
        serviceTier: request.serviceTier ?? null,
        fastMode: request.fastMode ?? null,
        ...summarizeTurnInput(request.input),
      });

      try {
        if (
          request.federationTarget &&
          isRemoteFederationTarget(request.federationTarget)
        ) {
          return await getDesktopFederationRuntime()
            .remoteBackend(request.federationTarget)
            .startTurn(stripFederationTarget(request));
        }
        const submitted = await registry.submitTurn({
          ...request,
          origin: "manual",
        });
        const response: StartTurnResponse =
          submitted.status === "started"
            ? {
                backend: submitted.entry.backend,
                threadId: submitted.entry.threadId,
                turnId: submitted.turnId,
                queueStatus: "started",
                queueEntryId: submitted.entry.id,
              }
            : {
                backend: submitted.entry.backend,
                threadId: submitted.entry.threadId,
                turnId: submitted.entry.id,
                queueStatus: "queued",
                queueEntryId: submitted.entry.id,
              };
        logDebug("startTurnResult", {
          backend: response.backend,
          threadId: response.threadId,
          turnId: response.turnId,
          queueStatus: response.queueStatus ?? "started",
        });
        return response;
      } catch (error) {
        appServerLog.error("startTurn failed", {
          backend: request.backend,
          threadId: request.threadId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  );

  ipcMain.removeHandler(AGENT_START_REVIEW_CHANNEL);
  ipcMain.handle(
    AGENT_START_REVIEW_CHANNEL,
    async (
      _event,
      request: StartReviewRequest
    ): Promise<StartReviewResponse> => {
      logDebug("startReview", {
        backend: request.backend,
        threadId: request.threadId,
        targetType: request.target.type,
        delivery: request.delivery ?? "inline",
      });

      try {
        const response = await registry.startReview(request);
        logDebug("startReviewResult", {
          backend: response.backend,
          threadId: response.threadId,
          reviewThreadId: response.reviewThreadId,
          turnId: response.turnId,
        });
        return response;
      } catch (error) {
        appServerLog.error("startReview failed", {
          backend: request.backend,
          threadId: request.threadId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  );

  ipcMain.removeHandler(AGENT_COMPACT_THREAD_CHANNEL);
  ipcMain.handle(
    AGENT_COMPACT_THREAD_CHANNEL,
    async (
      _event,
      request: CompactThreadRequest
    ): Promise<CompactThreadResponse> => {
      logDebug("compactThread", {
        backend: request.backend,
        threadId: request.threadId,
      });

      try {
        if (
          request.federationTarget &&
          isRemoteFederationTarget(request.federationTarget)
        ) {
          const response = await getDesktopFederationRuntime()
            .remoteBackend(request.federationTarget)
            .compactThread(stripFederationTarget(request));
          logDebug("compactThreadResult", {
            backend: response.backend,
            threadId: response.threadId,
            turnId: response.turnId,
            itemId: response.itemId,
          });
          return response;
        }
        const response = await registry.compactThread(request);
        logDebug("compactThreadResult", {
          backend: response.backend,
          threadId: response.threadId,
          turnId: response.turnId,
          itemId: response.itemId,
        });
        return response;
      } catch (error) {
        appServerLog.error("compactThread failed", {
          backend: request.backend,
          threadId: request.threadId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  );

  ipcMain.removeHandler(AGENT_INTERRUPT_TURN_CHANNEL);
  ipcMain.handle(
    AGENT_INTERRUPT_TURN_CHANNEL,
    async (
      _event,
      request: InterruptTurnRequest
    ): Promise<InterruptTurnResponse> => {
      logDebug("interruptTurn", {
        backend: request.backend,
        threadId: request.threadId,
        turnId: request.turnId,
      });

      try {
        if (
          request.federationTarget &&
          isRemoteFederationTarget(request.federationTarget)
        ) {
          return await getDesktopFederationRuntime()
            .remoteBackend(request.federationTarget)
            .interruptTurn(stripFederationTarget(request));
        }
        return await registry.interruptTurn(request);
      } catch (error) {
        appServerLog.error("interruptTurn failed", {
          backend: request.backend,
          threadId: request.threadId,
          turnId: request.turnId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  );

  ipcMain.removeHandler(AGENT_STEER_TURN_CHANNEL);
  ipcMain.handle(
    AGENT_STEER_TURN_CHANNEL,
    async (
      _event,
      request: SteerTurnRequest
    ): Promise<SteerTurnResponse> => {
      logDebug("steerTurn", {
        backend: request.backend,
        threadId: request.threadId,
        expectedTurnId: request.expectedTurnId,
        ...summarizeTurnInput(request.input),
      });

      try {
        if (
          request.federationTarget &&
          isRemoteFederationTarget(request.federationTarget)
        ) {
          return await getDesktopFederationRuntime()
            .remoteBackend(request.federationTarget)
            .steerTurn(stripFederationTarget(request));
        }
        return await registry.steerTurn(request);
      } catch (error) {
        appServerLog.error("steerTurn failed", {
          backend: request.backend,
          threadId: request.threadId,
          expectedTurnId: request.expectedTurnId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  );

  ipcMain.removeHandler(AGENT_SET_THREAD_EXECUTION_MODE_CHANNEL);
  ipcMain.handle(
    AGENT_SET_THREAD_EXECUTION_MODE_CHANNEL,
    async (
      _event,
      request: SetThreadExecutionModeRequest
    ): Promise<SetThreadExecutionModeResponse> => {
      if (
        request.federationTarget &&
        isRemoteFederationTarget(request.federationTarget)
      ) {
        return await getDesktopFederationRuntime()
          .remoteBackend(request.federationTarget)
          .setThreadExecutionMode(stripFederationTarget(request));
      }
      return await registry.setThreadExecutionMode(request);
    },
  );

  ipcMain.removeHandler(AGENT_QUEUE_THREAD_EXECUTION_MODE_CHANNEL);
  ipcMain.handle(
    AGENT_QUEUE_THREAD_EXECUTION_MODE_CHANNEL,
    async (
      _event,
      request: QueueThreadExecutionModeRequest,
    ): Promise<QueueThreadExecutionModeResponse> => {
      if (
        request.federationTarget &&
        isRemoteFederationTarget(request.federationTarget)
      ) {
        return await getDesktopFederationRuntime()
          .remoteBackend(request.federationTarget)
          .queueThreadExecutionMode(stripFederationTarget(request));
      }
      return await registry.queueThreadExecutionMode(request);
    },
  );

  ipcMain.removeHandler(AGENT_CANCEL_THREAD_EXECUTION_MODE_QUEUE_CHANNEL);
  ipcMain.handle(
    AGENT_CANCEL_THREAD_EXECUTION_MODE_QUEUE_CHANNEL,
    async (
      _event,
      request: CancelThreadExecutionModeQueueRequest,
    ): Promise<CancelThreadExecutionModeQueueResponse> => {
      if (
        request.federationTarget &&
        isRemoteFederationTarget(request.federationTarget)
      ) {
        return await getDesktopFederationRuntime()
          .remoteBackend(request.federationTarget)
          .cancelThreadExecutionModeQueue(stripFederationTarget(request));
      }
      return await registry.cancelThreadExecutionModeQueue(request);
    },
  );

  ipcMain.removeHandler(AGENT_SET_ACP_SESSION_RUNTIME_OPTION_CHANNEL);
  ipcMain.handle(
    AGENT_SET_ACP_SESSION_RUNTIME_OPTION_CHANNEL,
    async (
      _event,
      request: SetAcpSessionRuntimeOptionRequest,
    ): Promise<SetAcpSessionRuntimeOptionResponse> => {
      if (
        request.federationTarget &&
        isRemoteFederationTarget(request.federationTarget)
      ) {
        return await getDesktopFederationRuntime()
          .remoteBackend(request.federationTarget)
          .setAcpSessionRuntimeOption(stripFederationTarget(request));
      }
      return await registry.setAcpSessionRuntimeOption(request);
    },
  );

  ipcMain.removeHandler(AGENT_SET_THREAD_MODEL_SETTINGS_CHANNEL);
  ipcMain.handle(
    AGENT_SET_THREAD_MODEL_SETTINGS_CHANNEL,
    async (
      _event,
      request: SetThreadModelSettingsRequest
    ): Promise<SetThreadModelSettingsResponse> => {
      if (
        request.federationTarget &&
        isRemoteFederationTarget(request.federationTarget)
      ) {
        return await getDesktopFederationRuntime()
          .remoteBackend(request.federationTarget)
          .setThreadModelSettings(stripFederationTarget(request));
      }
      return await registry.setThreadModelSettings(request);
    },
  );

  ipcMain.removeHandler(AGENT_CHECK_THREAD_BRANCH_DRIFT_CHANNEL);
  ipcMain.handle(
    AGENT_CHECK_THREAD_BRANCH_DRIFT_CHANNEL,
    async (
      _event,
      request: CheckThreadBranchDriftRequest,
    ): Promise<CheckThreadBranchDriftResponse> => {
      return await registry.checkThreadBranchDrift(request);
    },
  );

  ipcMain.removeHandler(AGENT_UPDATE_THREAD_EXPECTED_BRANCH_CHANNEL);
  ipcMain.handle(
    AGENT_UPDATE_THREAD_EXPECTED_BRANCH_CHANNEL,
    async (
      _event,
      request: UpdateThreadExpectedBranchRequest,
    ): Promise<UpdateThreadExpectedBranchResponse> => {
      return await registry.updateThreadExpectedBranch(request);
    },
  );

  ipcMain.removeHandler(AGENT_RETAIN_THREAD_BRANCH_DRIFT_CHANNEL);
  ipcMain.handle(
    AGENT_RETAIN_THREAD_BRANCH_DRIFT_CHANNEL,
    async (
      _event,
      request: RetainThreadBranchDriftRequest,
    ): Promise<RetainThreadBranchDriftResponse> => {
      return await registry.retainThreadBranchDrift(request);
    },
  );

  ipcMain.removeHandler(AGENT_MATERIALIZE_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.handle(
    AGENT_MATERIALIZE_DIRECTORY_LAUNCHPAD_CHANNEL,
    async (
      event,
      request: MaterializeDirectoryLaunchpadRequest
    ): Promise<MaterializeDirectoryLaunchpadResponse> => {
      return await registry.materializeDirectoryLaunchpad(request, {
        onCodexEnvironmentSetupProgress: (progress) => {
          event.sender?.send?.(CODEX_ENVIRONMENT_SETUP_PROGRESS_CHANNEL, progress);
        },
      });
    },
  );

  ipcMain.removeHandler(AGENT_RUN_CODEX_ENVIRONMENT_ACTION_CHANNEL);
  ipcMain.handle(
    AGENT_RUN_CODEX_ENVIRONMENT_ACTION_CHANNEL,
    async (
      _event,
      request: RunCodexEnvironmentActionRequest,
    ): Promise<RunCodexEnvironmentActionResponse> => {
      if (
        request.federationTarget &&
        isRemoteFederationTarget(request.federationTarget)
      ) {
        return await getDesktopFederationRuntime()
          .remoteBackend(request.federationTarget)
          .runCodexEnvironmentAction(stripFederationTarget(request));
      }
      return await registry.runCodexEnvironmentAction(request);
    },
  );

  ipcMain.removeHandler(AGENT_STOP_CODEX_ENVIRONMENT_ACTION_CHANNEL);
  ipcMain.handle(
    AGENT_STOP_CODEX_ENVIRONMENT_ACTION_CHANNEL,
    async (
      _event,
      request: StopCodexEnvironmentActionRequest,
    ): Promise<StopCodexEnvironmentActionResponse> => {
      return await registry.stopCodexEnvironmentAction(request);
    },
  );

  ipcMain.removeHandler(AGENT_SET_CODEX_THREAD_ENVIRONMENT_CHANNEL);
  ipcMain.handle(
    AGENT_SET_CODEX_THREAD_ENVIRONMENT_CHANNEL,
    async (
      _event,
      request: SetCodexThreadEnvironmentRequest,
    ): Promise<SetCodexThreadEnvironmentResponse> => {
      if (
        request.federationTarget &&
        isRemoteFederationTarget(request.federationTarget)
      ) {
        return await getDesktopFederationRuntime()
          .remoteBackend(request.federationTarget)
          .setCodexThreadEnvironment(stripFederationTarget(request));
      }
      return await registry.setCodexThreadEnvironment(request);
    },
  );

  ipcMain.removeHandler(AGENT_SUBMIT_SERVER_REQUEST_CHANNEL);
  ipcMain.handle(
    AGENT_SUBMIT_SERVER_REQUEST_CHANNEL,
    async (
      _event,
      request: SubmitServerRequestRequest
    ): Promise<SubmitServerRequestResponse> => {
      if (
        request.federationTarget &&
        isRemoteFederationTarget(request.federationTarget)
      ) {
        return await getDesktopFederationRuntime()
          .remoteBackend(request.federationTarget)
          .submitServerRequest(stripFederationTarget(request));
      }
      return await registry.submitServerRequest(request);
    },
  );

  ipcMain.removeHandler(AGENT_TRUST_CODEX_PROJECT_CHANNEL);
  ipcMain.handle(
    AGENT_TRUST_CODEX_PROJECT_CHANNEL,
    async (
      _event,
      request: TrustCodexProjectRequest,
    ): Promise<TrustCodexProjectResponse> => {
      return await registry.trustCodexProject(request);
    },
  );

  ipcMain.removeHandler(AGENT_LATEST_CODEX_CONFIG_WARNING_CHANNEL);
  ipcMain.handle(
    AGENT_LATEST_CODEX_CONFIG_WARNING_CHANNEL,
    async (): Promise<LatestCodexConfigWarningResponse> => {
      return registry.getLatestCodexConfigWarning();
    },
  );
}

export function disposeAgentIpcHandlers(): void {
  unsubscribeRegistryEvents?.();
  unsubscribeRegistryEvents = undefined;
  ipcMain.removeHandler(BACKEND_LIST_CHANNEL);
  ipcMain.removeHandler(AGENT_START_THREAD_CHANNEL);
  ipcMain.removeHandler(AGENT_FORK_THREAD_CHANNEL);
  ipcMain.removeHandler(AGENT_START_REVIEW_CHANNEL);
  ipcMain.removeHandler(AGENT_COMPACT_THREAD_CHANNEL);
  ipcMain.removeHandler(AGENT_START_TURN_CHANNEL);
  ipcMain.removeHandler(AGENT_INTERRUPT_TURN_CHANNEL);
  ipcMain.removeHandler(AGENT_STEER_TURN_CHANNEL);
  ipcMain.removeHandler(AGENT_SET_THREAD_EXECUTION_MODE_CHANNEL);
  ipcMain.removeHandler(AGENT_QUEUE_THREAD_EXECUTION_MODE_CHANNEL);
  ipcMain.removeHandler(AGENT_CANCEL_THREAD_EXECUTION_MODE_QUEUE_CHANNEL);
  ipcMain.removeHandler(AGENT_SET_ACP_SESSION_RUNTIME_OPTION_CHANNEL);
  ipcMain.removeHandler(AGENT_SET_THREAD_MODEL_SETTINGS_CHANNEL);
  ipcMain.removeHandler(AGENT_CHECK_THREAD_BRANCH_DRIFT_CHANNEL);
  ipcMain.removeHandler(AGENT_UPDATE_THREAD_EXPECTED_BRANCH_CHANNEL);
  ipcMain.removeHandler(AGENT_RETAIN_THREAD_BRANCH_DRIFT_CHANNEL);
  ipcMain.removeHandler(AGENT_MATERIALIZE_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.removeHandler(AGENT_RUN_CODEX_ENVIRONMENT_ACTION_CHANNEL);
  ipcMain.removeHandler(AGENT_STOP_CODEX_ENVIRONMENT_ACTION_CHANNEL);
  ipcMain.removeHandler(AGENT_SET_CODEX_THREAD_ENVIRONMENT_CHANNEL);
  ipcMain.removeHandler(AGENT_SUBMIT_SERVER_REQUEST_CHANNEL);
  ipcMain.removeHandler(AGENT_TRUST_CODEX_PROJECT_CHANNEL);
  ipcMain.removeHandler(AGENT_LATEST_CODEX_CONFIG_WARNING_CHANNEL);
}
