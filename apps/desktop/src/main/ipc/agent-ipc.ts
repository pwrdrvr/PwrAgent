import { ipcMain } from "electron";
import { subscribersForChannel } from "../window-channels";
import type {
  AgentEvent,
  CheckThreadBranchDriftRequest,
  CheckThreadBranchDriftResponse,
  MaterializeDirectoryLaunchpadRequest,
  MaterializeDirectoryLaunchpadResponse,
  InterruptTurnRequest,
  InterruptTurnResponse,
  ListBackendsRequest,
  ListBackendsResponse,
  RetainThreadBranchDriftRequest,
  RetainThreadBranchDriftResponse,
  SetThreadExecutionModeRequest,
  SetThreadExecutionModeResponse,
  SetThreadModelSettingsRequest,
  SetThreadModelSettingsResponse,
  SteerTurnRequest,
  SteerTurnResponse,
  StartReviewRequest,
  StartReviewResponse,
  StartThreadRequest,
  StartThreadResponse,
  StartTurnRequest,
  StartTurnResponse,
  SubmitServerRequestRequest,
  SubmitServerRequestResponse,
  UpdateThreadExpectedBranchRequest,
  UpdateThreadExpectedBranchResponse,
} from "@pwragent/shared";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import {
  AGENT_EVENT_CHANNEL,
  AGENT_CHECK_THREAD_BRANCH_DRIFT_CHANNEL,
  AGENT_INTERRUPT_TURN_CHANNEL,
  AGENT_MATERIALIZE_DIRECTORY_LAUNCHPAD_CHANNEL,
  AGENT_RETAIN_THREAD_BRANCH_DRIFT_CHANNEL,
  AGENT_SET_THREAD_EXECUTION_MODE_CHANNEL,
  AGENT_SET_THREAD_MODEL_SETTINGS_CHANNEL,
  AGENT_START_THREAD_CHANNEL,
  AGENT_START_REVIEW_CHANNEL,
  AGENT_START_TURN_CHANNEL,
  AGENT_STEER_TURN_CHANNEL,
  AGENT_SUBMIT_SERVER_REQUEST_CHANNEL,
  AGENT_UPDATE_THREAD_EXPECTED_BRANCH_CHANNEL,
  BACKEND_LIST_CHANNEL,
} from "../../shared/ipc";
import { getMainLogger } from "../log";

let unsubscribeRegistryEvents: (() => void) | undefined;

const isDevelopment = process.env.NODE_ENV !== "production";
const appServerLog = getMainLogger("pwragent:app-server");

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

function broadcastAgentEvent(event: AgentEvent): void {
  const eventSummary = summarizeAgentEvent(event);
  if (eventSummary) {
    logDebug("agentEvent", eventSummary);
  }

  // Only deliver to windows that registered for this channel.
  // Secondary windows (e.g. the Messaging Activity window) opt out by
  // default — see `apps/desktop/src/main/window-channels.ts`.
  for (const webContents of subscribersForChannel(AGENT_EVENT_CHANNEL)) {
    if (typeof webContents.send !== "function") continue;
    webContents.send(AGENT_EVENT_CHANNEL, event);
  }
}

export function registerAgentIpcHandlers(): void {
  const registry = getDesktopBackendRegistry();

  unsubscribeRegistryEvents?.();
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
      return await registry.listBackends(request);
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
        const response = await registry.startTurn(request);
        logDebug("startTurnResult", {
          backend: response.backend,
          threadId: response.threadId,
          turnId: response.turnId,
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
      return await registry.setThreadExecutionMode(request);
    },
  );

  ipcMain.removeHandler(AGENT_SET_THREAD_MODEL_SETTINGS_CHANNEL);
  ipcMain.handle(
    AGENT_SET_THREAD_MODEL_SETTINGS_CHANNEL,
    async (
      _event,
      request: SetThreadModelSettingsRequest
    ): Promise<SetThreadModelSettingsResponse> => {
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
      _event,
      request: MaterializeDirectoryLaunchpadRequest
    ): Promise<MaterializeDirectoryLaunchpadResponse> => {
      return await registry.materializeDirectoryLaunchpad(request);
    },
  );

  ipcMain.removeHandler(AGENT_SUBMIT_SERVER_REQUEST_CHANNEL);
  ipcMain.handle(
    AGENT_SUBMIT_SERVER_REQUEST_CHANNEL,
    async (
      _event,
      request: SubmitServerRequestRequest
    ): Promise<SubmitServerRequestResponse> => {
      return await registry.submitServerRequest(request);
    },
  );
}

export function disposeAgentIpcHandlers(): void {
  unsubscribeRegistryEvents?.();
  unsubscribeRegistryEvents = undefined;
  ipcMain.removeHandler(BACKEND_LIST_CHANNEL);
  ipcMain.removeHandler(AGENT_START_THREAD_CHANNEL);
  ipcMain.removeHandler(AGENT_START_REVIEW_CHANNEL);
  ipcMain.removeHandler(AGENT_START_TURN_CHANNEL);
  ipcMain.removeHandler(AGENT_INTERRUPT_TURN_CHANNEL);
  ipcMain.removeHandler(AGENT_STEER_TURN_CHANNEL);
  ipcMain.removeHandler(AGENT_SET_THREAD_EXECUTION_MODE_CHANNEL);
  ipcMain.removeHandler(AGENT_SET_THREAD_MODEL_SETTINGS_CHANNEL);
  ipcMain.removeHandler(AGENT_CHECK_THREAD_BRANCH_DRIFT_CHANNEL);
  ipcMain.removeHandler(AGENT_UPDATE_THREAD_EXPECTED_BRANCH_CHANNEL);
  ipcMain.removeHandler(AGENT_RETAIN_THREAD_BRANCH_DRIFT_CHANNEL);
  ipcMain.removeHandler(AGENT_MATERIALIZE_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.removeHandler(AGENT_SUBMIT_SERVER_REQUEST_CHANNEL);
}
