import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { issueProviderDiscoveryPermit } from "../settings/provider-discovery-permit";
import {
  federationTargetForChannelSubscriber,
  subscribersForChannel,
} from "../window-channels";
import {
  sanitizeRendererPayload,
  type AgentEvent,
  type ApplyThreadModelMigrationRequest,
  type ApplyThreadModelMigrationResponse,
  type CancelQueuedTurnRequest,
  type CancelQueuedTurnResponse,
  type ReleaseQueuedTurnRequest,
  type ReleaseQueuedTurnResponse,
  type CancelThreadExecutionModeQueueRequest,
  type CancelThreadExecutionModeQueueResponse,
  type CheckThreadBranchDriftRequest,
  type CheckThreadBranchDriftResponse,
  type CodexEnvironmentSetupProgressEvent,
  type CompactThreadRequest,
  type CompactThreadResponse,
  type ConfigureGrokWorkflowBudgetRequest,
  type ConfigureGrokWorkflowBudgetResponse,
  type ForkThreadRequest,
  type ForkThreadResponse,
  type MaterializeDirectoryLaunchpadRequest,
  type MaterializeDirectoryLaunchpadResponse,
  type InterruptTurnRequest,
  type InterruptTurnResponse,
  type StopSubAgentRequest,
  type StopSubAgentResponse,
  type LatestCodexConfigWarningResponse,
  type ListAcpThreadRewindPointsRequest,
  type ListAcpThreadRewindPointsResponse,
  type ListBackendsRequest,
  type ListBackendsResponse,
  type ListCodexMcpServersRequest,
  type ListCodexMcpServersResponse,
  type ListThreadMcpServersRequest,
  type ListThreadMcpServersResponse,
  type QueueThreadExecutionModeRequest,
  type QueueThreadExecutionModeResponse,
  type RetainThreadBranchDriftRequest,
  type RetainThreadBranchDriftResponse,
  type RewindAcpThreadRequest,
  type RewindAcpThreadResponse,
  type ReloadCodexMcpConfigRequest,
  type ReloadCodexMcpConfigResponse,
  type ReloadCodexMcpServersResponse,
  type ReloadCodexMcpServersRequest,
  type RemoveCodexMcpServerRequest,
  type RemoveCodexMcpServerResponse,
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
  type SetThreadPrAutoDispatchRequest,
  type SetThreadPrAutoDispatchResponse,
  type CancelThreadPrAutoDispatchRequest,
  type CancelThreadPrAutoDispatchResponse,
  type SendThreadPrAutoDispatchNowRequest,
  type SendThreadPrAutoDispatchNowResponse,
  type TurnOffCodexFastEverywhereResponse,
  type SteerTurnRequest,
  type SteerTurnResponse,
  type StartReviewRequest,
  type StartReviewResponse,
  type StartCodexMcpServerLoginRequest,
  type StartCodexMcpServerLoginResponse,
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
import {
  federationEventClassForMethod,
  getDesktopFederationRuntime,
} from "../federation/federation-runtime";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { buildLiveDiffActivityEntry } from "../app-server/live-diff-activity";
import { timeStartupProfileOperation } from "../diagnostics/startup-profile-events";
import {
  AGENT_CANCEL_QUEUED_TURN_CHANNEL,
  AGENT_RELEASE_QUEUED_TURN_CHANNEL,
  AGENT_CANCEL_THREAD_EXECUTION_MODE_QUEUE_CHANNEL,
  AGENT_APPLY_THREAD_MODEL_MIGRATION_CHANNEL,
  AGENT_EVENT_CHANNEL,
  AGENT_FORK_THREAD_CHANNEL,
  AGENT_LATEST_CODEX_CONFIG_WARNING_CHANNEL,
  AGENT_LIST_ACP_THREAD_REWIND_POINTS_CHANNEL,
  AGENT_CHECK_THREAD_BRANCH_DRIFT_CHANNEL,
  AGENT_COMPACT_THREAD_CHANNEL,
  AGENT_CONFIGURE_GROK_WORKFLOW_BUDGET_CHANNEL,
  AGENT_LIST_THREAD_MCP_SERVERS_CHANNEL,
  AGENT_RELOAD_CODEX_MCP_CONFIG_CHANNEL,
  CODEX_MCP_SERVERS_LIST_CHANNEL,
  CODEX_MCP_SERVERS_RELOAD_CHANNEL,
  CODEX_MCP_SERVER_LOGIN_CHANNEL,
  CODEX_MCP_SERVER_REMOVE_CHANNEL,
  AGENT_INTERRUPT_TURN_CHANNEL,
  AGENT_STOP_SUB_AGENT_CHANNEL,
  AGENT_MATERIALIZE_DIRECTORY_LAUNCHPAD_CHANNEL,
  AGENT_QUEUE_THREAD_EXECUTION_MODE_CHANNEL,
  AGENT_RETAIN_THREAD_BRANCH_DRIFT_CHANNEL,
  AGENT_REWIND_ACP_THREAD_CHANNEL,
  AGENT_RUN_CODEX_ENVIRONMENT_ACTION_CHANNEL,
  AGENT_STOP_CODEX_ENVIRONMENT_ACTION_CHANNEL,
  AGENT_SET_CODEX_THREAD_ENVIRONMENT_CHANNEL,
  AGENT_SET_ACP_SESSION_RUNTIME_OPTION_CHANNEL,
  AGENT_SET_THREAD_EXECUTION_MODE_CHANNEL,
  AGENT_SET_THREAD_MODEL_SETTINGS_CHANNEL,
  AGENT_SET_THREAD_PR_AUTO_DISPATCH_CHANNEL,
  AGENT_CANCEL_THREAD_PR_AUTO_DISPATCH_CHANNEL,
  AGENT_SEND_THREAD_PR_AUTO_DISPATCH_NOW_CHANNEL,
  AGENT_TURN_OFF_CODEX_FAST_EVERYWHERE_CHANNEL,
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

  appServerLog.debug(event, payload);
}

function summarizeTurnInput(input: StartTurnRequest["input"]): Record<string, unknown> {
  const textChars = input
    .filter((item): item is Extract<StartTurnRequest["input"][number], { type: "text" }> =>
      item.type === "text"
    )
    .reduce((count, item) => count + item.text.length, 0);
  const imageCount = input.filter((item) => item.type === "image" || item.type === "localImage")
    .length;
  const fileCount = input.filter(
    (item) => item.type === "file" || item.type === "localFile",
  ).length;

  return {
    inputCount: input.length,
    textChars,
    imageCount,
    fileCount,
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
    appServerLog.debug("agentEvent", summary);
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
    appServerLog.debug("agentEvent", summary);
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

/**
 * A peer's PR-status observation is authoritative only for PRs this
 * instance does not monitor itself.
 *
 * A window with no federation target renders local threads and pinned
 * remote rows side by side. When the same PR is attached to a local
 * thread, its status there is already driven by the local poller, and
 * `pullRequest/status/updated` is matched by `prKey` across every thread
 * in the snapshot — so the local observation reaches the pinned remote
 * row too. Letting the peer's observation in as well means two monitors
 * writing the same rows from slightly different points in time, which
 * reads as the status flickering between values. One monitor wins:
 * ours.
 *
 * A federation window has no local monitor to defer to — the peer is its
 * only source of truth — so it always receives the event, and its own
 * renderer-side target filter decides whether the event belongs to the
 * instance it fronts.
 */
function remotePrStatusEventIsSupersededLocally(event: AgentEvent): boolean {
  if (
    !event.federationTarget
    || event.notification.method !== "pullRequest/status/updated"
  ) {
    return false;
  }
  const { prKey } = event.notification.params as { prKey: string };
  return getDesktopBackendRegistry().isPullRequestLocallyMonitored(prKey);
}

export function broadcastAgentEvent(event: AgentEvent): void {
  const federationRuntime = getDesktopFederationRuntime();
  const hydratedEvent = federationRuntime.hydrateLiveThreadMessageOrigin(event);
  const eventSummary = summarizeAgentEvent(hydratedEvent);
  if (eventSummary) {
    logAgentEventSummary(eventSummary);
  }
  const rendererEvent = sanitizeRendererPayload(
    withRendererActivityEntry(hydratedEvent),
  );
  const federationWindowsOnly = remotePrStatusEventIsSupersededLocally(
    hydratedEvent,
  );

  // Only deliver to windows that registered for this channel.
  // Secondary windows (e.g. the Messaging Activity window) opt out by
  // default — see `apps/desktop/src/main/window-channels.ts`.
  for (const webContents of subscribersForChannel(AGENT_EVENT_CHANNEL)) {
    if (typeof webContents.send !== "function") continue;
    const windowTarget = federationTargetForChannelSubscriber(webContents);
    if (
      federationWindowsOnly
      && !windowTarget
    ) {
      continue;
    }
    if (hydratedEvent.federationTarget?.scope === "remote") {
      const isLocalPeerStatus =
        hydratedEvent.notification.method === "federation/peerStatus/changed"
        && !windowTarget;
      if (
        !isLocalPeerStatus
        && !federationRuntime.rendererWantsRemoteEvent(
          webContents.id,
          hydratedEvent.federationTarget.instanceId,
          federationEventClassForMethod(hydratedEvent.notification.method),
        )
      ) {
        continue;
      }
    } else if (windowTarget) {
      continue;
    }
    webContents.send(AGENT_EVENT_CHANNEL, rendererEvent);
  }
}

function broadcastCodexEnvironmentSetupProgress(
  event: CodexEnvironmentSetupProgressEvent,
): void {
  const rendererEvent = sanitizeRendererPayload(event);
  for (const webContents of subscribersForChannel(
    CODEX_ENVIRONMENT_SETUP_PROGRESS_CHANNEL,
  )) {
    if (typeof webContents.send !== "function") continue;
    webContents.send(CODEX_ENVIRONMENT_SETUP_PROGRESS_CHANNEL, rendererEvent);
  }
}

export function registerAgentIpcHandlers(): void {
  const registry = getDesktopBackendRegistry();

  unsubscribeRegistryEvents?.();
  getDesktopFederationRuntime().setAgentEventPublisher(broadcastAgentEvent);
  getDesktopFederationRuntime().setEnvironmentSetupProgressPublisher(
    broadcastCodexEnvironmentSetupProgress,
  );
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
        operation: async () => {
          if (
            request?.federationTarget
            && isRemoteFederationTarget(request.federationTarget)
          ) {
            return await getDesktopFederationRuntime()
              .remoteBackend(request.federationTarget)
              .listBackends(stripFederationTarget(request));
          }
          if (request?.refreshModels !== undefined) {
            if (!request.discoveryIntent) {
              throw new Error(
                "Provider model discovery requires a Settings user-action intent.",
              );
            }
            return await registry.listBackends(
              request,
              issueProviderDiscoveryPermit(request.discoveryIntent),
            );
          }
          return await registry.listBackends(request);
        },
      });
    },
  );

  ipcMain.removeHandler(AGENT_CANCEL_THREAD_PR_AUTO_DISPATCH_CHANNEL);
  ipcMain.handle(
    AGENT_CANCEL_THREAD_PR_AUTO_DISPATCH_CHANNEL,
    async (
      _event,
      request: CancelThreadPrAutoDispatchRequest,
    ): Promise<CancelThreadPrAutoDispatchResponse> => {
      if (
        request.federationTarget
        && isRemoteFederationTarget(request.federationTarget)
      ) {
        // The pending dispatch and its fingerprint only exist in the
        // owning instance's coordinator; cancelling locally would report
        // a no-op while the owner still fires the scheduled repair turn.
        return await getDesktopFederationRuntime()
          .remoteBackend(request.federationTarget)
          .cancelThreadPrAutoDispatch(stripFederationTarget(request));
      }
      return await registry.cancelThreadPrAutoDispatch(request);
    },
  );

  ipcMain.removeHandler(AGENT_SEND_THREAD_PR_AUTO_DISPATCH_NOW_CHANNEL);
  ipcMain.handle(
    AGENT_SEND_THREAD_PR_AUTO_DISPATCH_NOW_CHANNEL,
    async (
      _event,
      request: SendThreadPrAutoDispatchNowRequest,
    ): Promise<SendThreadPrAutoDispatchNowResponse> => {
      if (
        request.federationTarget
        && isRemoteFederationTarget(request.federationTarget)
      ) {
        // Same as cancel: only the owner holds the pending dispatch, so
        // "send now" has to run there to promote the scheduled turn.
        return await getDesktopFederationRuntime()
          .remoteBackend(request.federationTarget)
          .sendThreadPrAutoDispatchNow(stripFederationTarget(request));
      }
      return await registry.sendThreadPrAutoDispatchNow(request);
    },
  );

  ipcMain.removeHandler(AGENT_START_THREAD_CHANNEL);
  ipcMain.handle(
    AGENT_START_THREAD_CHANNEL,
    async (
      _event,
      request: StartThreadRequest
    ): Promise<StartThreadResponse> => {
      if (
        request.federationTarget &&
        isRemoteFederationTarget(request.federationTarget)
      ) {
        return await getDesktopFederationRuntime()
          .remoteBackend(request.federationTarget)
          .startThread(stripFederationTarget(request));
      }
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
      if (
        request.federationTarget &&
        isRemoteFederationTarget(request.federationTarget)
      ) {
        return await getDesktopFederationRuntime()
          .remoteBackend(request.federationTarget)
          .forkThread(stripFederationTarget(request));
      }
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
                queueEntryCreatedAt: submitted.entry.createdAt,
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

  ipcMain.removeHandler(AGENT_CANCEL_QUEUED_TURN_CHANNEL);
  ipcMain.handle(
    AGENT_CANCEL_QUEUED_TURN_CHANNEL,
    async (
      _event,
      request: CancelQueuedTurnRequest,
    ): Promise<CancelQueuedTurnResponse> => {
      if (
        request.federationTarget
        && isRemoteFederationTarget(request.federationTarget)
      ) {
        const { federationTarget, ...remoteRequest } = request;
        return await getDesktopFederationRuntime()
          .remoteBackend(federationTarget)
          .cancelQueuedTurn(remoteRequest);
      }
      return registry.cancelQueuedTurnWithDisposition(
        request.queueEntryId,
        "Cancelled from the desktop composer.",
      );
    },
  );

  ipcMain.removeHandler(AGENT_RELEASE_QUEUED_TURN_CHANNEL);
  ipcMain.handle(
    AGENT_RELEASE_QUEUED_TURN_CHANNEL,
    async (
      _event,
      request: ReleaseQueuedTurnRequest,
    ): Promise<ReleaseQueuedTurnResponse> => {
      if (
        request.federationTarget
        && isRemoteFederationTarget(request.federationTarget)
      ) {
        const { federationTarget, ...remoteRequest } = request;
        return await getDesktopFederationRuntime()
          .remoteBackend(federationTarget)
          .releaseQueuedTurn(remoteRequest);
      }
      return await registry.releaseQueuedTurnWithDisposition(
        request.queueEntryId,
      );
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
        if (
          request.federationTarget &&
          isRemoteFederationTarget(request.federationTarget)
        ) {
          return await getDesktopFederationRuntime()
            .remoteBackend(request.federationTarget)
            .startReview(stripFederationTarget(request));
        }
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

  ipcMain.removeHandler(AGENT_LIST_THREAD_MCP_SERVERS_CHANNEL);
  ipcMain.handle(
    AGENT_LIST_THREAD_MCP_SERVERS_CHANNEL,
    async (
      _event,
      request: ListThreadMcpServersRequest,
    ): Promise<ListThreadMcpServersResponse> => {
      if (
        request.federationTarget
        && isRemoteFederationTarget(request.federationTarget)
      ) {
        return await getDesktopFederationRuntime()
          .remoteBackend(request.federationTarget)
          .listThreadMcpServers(stripFederationTarget(request));
      }
      return await registry.listThreadMcpServers(request);
    },
  );

  ipcMain.removeHandler(AGENT_RELOAD_CODEX_MCP_CONFIG_CHANNEL);
  ipcMain.handle(
    AGENT_RELOAD_CODEX_MCP_CONFIG_CHANNEL,
    async (
      _event,
      request: ReloadCodexMcpConfigRequest,
    ): Promise<ReloadCodexMcpConfigResponse> => {
      if (
        request.federationTarget
        && isRemoteFederationTarget(request.federationTarget)
      ) {
        return await getDesktopFederationRuntime()
          .remoteBackend(request.federationTarget)
          .reloadCodexMcpConfig(stripFederationTarget(request));
      }
      return await registry.reloadCodexMcpConfig(request);
    },
  );

  ipcMain.removeHandler(CODEX_MCP_SERVERS_LIST_CHANNEL);
  ipcMain.handle(
    CODEX_MCP_SERVERS_LIST_CHANNEL,
    async (
      _event,
      request: ListCodexMcpServersRequest = {},
    ): Promise<ListCodexMcpServersResponse> =>
      await registry.listCodexMcpServers(request),
  );

  ipcMain.removeHandler(CODEX_MCP_SERVERS_RELOAD_CHANNEL);
  ipcMain.handle(
    CODEX_MCP_SERVERS_RELOAD_CHANNEL,
    async (
      _event,
      request: ReloadCodexMcpServersRequest,
    ): Promise<ReloadCodexMcpServersResponse> =>
      await registry.reloadCodexMcpServers(request),
  );

  ipcMain.removeHandler(CODEX_MCP_SERVER_LOGIN_CHANNEL);
  ipcMain.handle(
    CODEX_MCP_SERVER_LOGIN_CHANNEL,
    async (
      _event,
      request: StartCodexMcpServerLoginRequest,
    ): Promise<StartCodexMcpServerLoginResponse> =>
      await registry.startCodexMcpServerLogin(request),
  );

  ipcMain.removeHandler(CODEX_MCP_SERVER_REMOVE_CHANNEL);
  ipcMain.handle(
    CODEX_MCP_SERVER_REMOVE_CHANNEL,
    async (
      _event,
      request: RemoveCodexMcpServerRequest,
    ): Promise<RemoveCodexMcpServerResponse> =>
      await registry.removeCodexMcpServer(request),
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

  ipcMain.removeHandler(AGENT_STOP_SUB_AGENT_CHANNEL);
  ipcMain.handle(
    AGENT_STOP_SUB_AGENT_CHANNEL,
    async (
      _event,
      request: StopSubAgentRequest,
    ): Promise<StopSubAgentResponse> => {
      logDebug("stopSubAgent", {
        backend: request.backend,
        threadId: request.threadId,
        monitorId: request.monitorId,
      });

      try {
        if (
          request.federationTarget
          && isRemoteFederationTarget(request.federationTarget)
        ) {
          return await getDesktopFederationRuntime()
            .remoteBackend(request.federationTarget)
            .stopSubAgent(stripFederationTarget(request));
        }
        return await registry.stopSubAgent(request);
      } catch (error) {
        appServerLog.error("stopSubAgent failed", {
          backend: request.backend,
          threadId: request.threadId,
          monitorId: request.monitorId,
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
        requestId: request.requestId,
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
        const { admitSteerTurn } = await import(
          "../scheduled-actions/steer-turn-admission.js"
        );
        const { getScheduledThreadActionService } = await import(
          "../scheduled-actions/scheduled-thread-action-service.js"
        );
        return await admitSteerTurn(
          registry,
          getScheduledThreadActionService(registry),
          request,
        );
      } catch (error) {
        appServerLog.error("steerTurn failed", {
          backend: request.backend,
          threadId: request.threadId,
          expectedTurnId: request.expectedTurnId,
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  );

  ipcMain.removeHandler(AGENT_LIST_ACP_THREAD_REWIND_POINTS_CHANNEL);
  ipcMain.handle(
    AGENT_LIST_ACP_THREAD_REWIND_POINTS_CHANNEL,
    async (
      _event,
      request: ListAcpThreadRewindPointsRequest,
    ): Promise<ListAcpThreadRewindPointsResponse> => {
      if (
        request.federationTarget
        && isRemoteFederationTarget(request.federationTarget)
      ) {
        throw new Error("Conversation rewind is not available from a remote viewer yet");
      }
      return await registry.listAcpThreadRewindPoints(request);
    },
  );

  ipcMain.removeHandler(AGENT_REWIND_ACP_THREAD_CHANNEL);
  ipcMain.handle(
    AGENT_REWIND_ACP_THREAD_CHANNEL,
    async (
      _event,
      request: RewindAcpThreadRequest,
    ): Promise<RewindAcpThreadResponse> => {
      if (
        request.federationTarget
        && isRemoteFederationTarget(request.federationTarget)
      ) {
        throw new Error("Conversation rewind is not available from a remote viewer yet");
      }
      return await registry.rewindAcpThread(request);
    },
  );

  ipcMain.removeHandler(AGENT_CONFIGURE_GROK_WORKFLOW_BUDGET_CHANNEL);
  ipcMain.handle(
    AGENT_CONFIGURE_GROK_WORKFLOW_BUDGET_CHANNEL,
    async (
      _event,
      request: ConfigureGrokWorkflowBudgetRequest,
    ): Promise<ConfigureGrokWorkflowBudgetResponse> => {
      if (
        request.federationTarget
        && isRemoteFederationTarget(request.federationTarget)
      ) {
        throw new Error("Grok workflow budgets are not available from a remote viewer yet");
      }
      return await registry.configureGrokWorkflowBudget(request);
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

  ipcMain.removeHandler(AGENT_SET_THREAD_PR_AUTO_DISPATCH_CHANNEL);
  ipcMain.handle(
    AGENT_SET_THREAD_PR_AUTO_DISPATCH_CHANNEL,
    async (
      _event,
      request: SetThreadPrAutoDispatchRequest,
    ): Promise<SetThreadPrAutoDispatchResponse> => {
      if (
        request.federationTarget &&
        isRemoteFederationTarget(request.federationTarget)
      ) {
        // Auto-fix preference and its dispatch coordinator live on the
        // owning instance; a local write would flip a phantom row while
        // the owner keeps dispatching (or not).
        return await getDesktopFederationRuntime()
          .remoteBackend(request.federationTarget)
          .setThreadPrAutoDispatch(stripFederationTarget(request));
      }
      return await registry.setThreadPrAutoDispatch(request);
    },
  );

  ipcMain.removeHandler(AGENT_APPLY_THREAD_MODEL_MIGRATION_CHANNEL);
  ipcMain.handle(
    AGENT_APPLY_THREAD_MODEL_MIGRATION_CHANNEL,
    async (
      _event,
      request: ApplyThreadModelMigrationRequest,
    ): Promise<ApplyThreadModelMigrationResponse> => {
      if (
        request.federationTarget
        && isRemoteFederationTarget(request.federationTarget)
      ) {
        // Migration policy and acknowledgement state are profile-local. The
        // owning instance must decide whether its own thread needs migration;
        // forwarding this instance's policy would cross that ownership line.
        return {
          backend: request.backend,
          threadId: request.threadId,
          status: "not-owner",
        };
      }
      return await registry.applyThreadModelMigration(request);
    },
  );

  ipcMain.removeHandler(AGENT_TURN_OFF_CODEX_FAST_EVERYWHERE_CHANNEL);
  ipcMain.handle(
    AGENT_TURN_OFF_CODEX_FAST_EVERYWHERE_CHANNEL,
    async (): Promise<TurnOffCodexFastEverywhereResponse> => {
      return await registry.turnOffCodexFastEverywhere();
    },
  );

  ipcMain.removeHandler(AGENT_CHECK_THREAD_BRANCH_DRIFT_CHANNEL);
  ipcMain.handle(
    AGENT_CHECK_THREAD_BRANCH_DRIFT_CHANNEL,
    async (
      _event,
      request: CheckThreadBranchDriftRequest,
    ): Promise<CheckThreadBranchDriftResponse> => {
      if (
        request.federationTarget &&
        isRemoteFederationTarget(request.federationTarget)
      ) {
        return await getDesktopFederationRuntime()
          .remoteBackend(request.federationTarget)
          .checkThreadBranchDrift(stripFederationTarget(request));
      }
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
      if (
        request.federationTarget &&
        isRemoteFederationTarget(request.federationTarget)
      ) {
        return await getDesktopFederationRuntime()
          .remoteBackend(request.federationTarget)
          .updateThreadExpectedBranch(stripFederationTarget(request));
      }
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
      if (
        request.federationTarget &&
        isRemoteFederationTarget(request.federationTarget)
      ) {
        return await getDesktopFederationRuntime()
          .remoteBackend(request.federationTarget)
          .retainThreadBranchDrift(stripFederationTarget(request));
      }
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
      if (
        request.federationTarget &&
        isRemoteFederationTarget(request.federationTarget)
      ) {
        return await getDesktopFederationRuntime()
          .remoteBackend(request.federationTarget)
          .materializeDirectoryLaunchpad(stripFederationTarget(request));
      }
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
      if (
        request.federationTarget &&
        isRemoteFederationTarget(request.federationTarget)
      ) {
        return await getDesktopFederationRuntime()
          .remoteBackend(request.federationTarget)
          .stopCodexEnvironmentAction(stripFederationTarget(request));
      }
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
      if (
        request.federationTarget &&
        isRemoteFederationTarget(request.federationTarget)
      ) {
        return await getDesktopFederationRuntime()
          .remoteBackend(request.federationTarget)
          .trustCodexProject(stripFederationTarget(request));
      }
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
  ipcMain.removeHandler(AGENT_LIST_THREAD_MCP_SERVERS_CHANNEL);
  ipcMain.removeHandler(AGENT_RELOAD_CODEX_MCP_CONFIG_CHANNEL);
  ipcMain.removeHandler(CODEX_MCP_SERVERS_LIST_CHANNEL);
  ipcMain.removeHandler(CODEX_MCP_SERVERS_RELOAD_CHANNEL);
  ipcMain.removeHandler(CODEX_MCP_SERVER_LOGIN_CHANNEL);
  ipcMain.removeHandler(CODEX_MCP_SERVER_REMOVE_CHANNEL);
  ipcMain.removeHandler(AGENT_START_TURN_CHANNEL);
  ipcMain.removeHandler(AGENT_INTERRUPT_TURN_CHANNEL);
  ipcMain.removeHandler(AGENT_STOP_SUB_AGENT_CHANNEL);
  ipcMain.removeHandler(AGENT_STEER_TURN_CHANNEL);
  ipcMain.removeHandler(AGENT_LIST_ACP_THREAD_REWIND_POINTS_CHANNEL);
  ipcMain.removeHandler(AGENT_REWIND_ACP_THREAD_CHANNEL);
  ipcMain.removeHandler(AGENT_CONFIGURE_GROK_WORKFLOW_BUDGET_CHANNEL);
  ipcMain.removeHandler(AGENT_SET_THREAD_EXECUTION_MODE_CHANNEL);
  ipcMain.removeHandler(AGENT_QUEUE_THREAD_EXECUTION_MODE_CHANNEL);
  ipcMain.removeHandler(AGENT_CANCEL_THREAD_EXECUTION_MODE_QUEUE_CHANNEL);
  ipcMain.removeHandler(AGENT_SET_ACP_SESSION_RUNTIME_OPTION_CHANNEL);
  ipcMain.removeHandler(AGENT_SET_THREAD_MODEL_SETTINGS_CHANNEL);
  ipcMain.removeHandler(AGENT_APPLY_THREAD_MODEL_MIGRATION_CHANNEL);
  ipcMain.removeHandler(AGENT_TURN_OFF_CODEX_FAST_EVERYWHERE_CHANNEL);
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
