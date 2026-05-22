import type {
  AgentEvent,
  AppServerBackendKind,
  AppServerThreadReplay,
  AppServerListSkillsRequest,
  AppServerListSkillsResponse,
  AppServerThreadStatus,
  CancelThreadExecutionModeQueueRequest,
  CancelThreadExecutionModeQueueResponse,
  CompactThreadRequest,
  CompactThreadResponse,
  GetNavigationSnapshotRequest,
  HandoffThreadWorkspaceRequest,
  HandoffThreadWorkspaceResponse,
  InterruptTurnRequest,
  InterruptTurnResponse,
  ListBackendsRequest,
  ListBackendsResponse,
  MaterializeDirectoryLaunchpadRequest,
  MaterializeDirectoryLaunchpadResponse,
  NavigationSnapshot,
  SetThreadExecutionModeRequest,
  SetThreadExecutionModeResponse,
  SetThreadModelSettingsRequest,
  SetThreadModelSettingsResponse,
  StartTurnRequest,
  StartTurnResponse,
  SteerTurnRequest,
  SteerTurnResponse,
  StartThreadRequest,
  StartThreadResponse,
  SubmitServerRequestRequest,
  SubmitServerRequestResponse,
  ThreadMessagingBindingTransition,
  UpdateDirectoryLaunchpadRequest,
  UpdateDirectoryLaunchpadResponse,
} from "@pwragent/shared";
import type {
  MessagingBackendBridge,
  MessagingLastAssistantReply,
} from "./core/messaging-adapter";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopOverlayStore } from "../app-server/desktop-overlay-store";
import { resolveScratchProjectsRoots } from "../app-server/scratch-projects";
import { buildMessagingBindingsByThreadKey } from "./messaging-bindings-snapshot";

export class DesktopMessagingBackendBridge implements MessagingBackendBridge {
  constructor(
    private readonly registry: DesktopBackendRegistry = getDesktopBackendRegistry(),
  ) {}

  async getNavigationSnapshot(
    request: GetNavigationSnapshotRequest = {},
  ): Promise<NavigationSnapshot> {
    const backend = request.backend ?? "all";
    const threads = await this.registry.listThreads({
      backend: backend === "all" ? undefined : backend,
      callerReason: "messaging-navigation-snapshot",
      filter: request.filter,
    });
    const messagingBindingsByThreadKey = await buildMessagingBindingsByThreadKey(threads);
    const queuedExecutionModesByThreadId =
      this.registry.getQueuedExecutionModesSnapshot();
    const snapshot = await getDesktopOverlayStore().reconcileNavigationSnapshot({
      backend,
      fetchedAt: Date.now(),
      messagingBindingsByThreadKey,
      queuedExecutionModesByThreadId,
      threads,
      workspaceRoots: resolveScratchProjectsRoots(),
    });
    const directoryStatuses = await this.registry.readDirectoryStatuses(
      snapshot.directories,
    );

    return {
      ...snapshot,
      directories: snapshot.directories.map((directory) => ({
        ...directory,
        gitStatus: directoryStatuses[directory.key],
      })),
    };
  }

  async readThreadStatus(request: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<AppServerThreadStatus | undefined> {
    const response = await this.registry.readThread({
      backend: request.backend,
      limit: 0,
      threadId: request.threadId,
    });
    return response.threadStatus ?? response.replay.threadStatus;
  }

  async readThreadLastAssistantMessage(request: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<string | undefined> {
    return (await this.readThreadLastAssistantReply(request))?.text;
  }

  async readThreadLastAssistantReply(request: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<MessagingLastAssistantReply | undefined> {
    const response = await this.registry.readThread({
      backend: request.backend,
      limit: 20,
      threadId: request.threadId,
    });
    const messageReply = findLastAssistantMessageReply(response.replay);
    if (messageReply) {
      return messageReply;
    }
    const fallbackText = response.replay.lastAssistantMessage?.trim();
    if (fallbackText) {
      const createdAt = findLastAssistantEntryCreatedAt(
        response.replay,
        fallbackText,
      );
      return {
        text: fallbackText,
        ...(createdAt ? { createdAt } : {}),
      };
    }
    return findLastAssistantEntryReply(response.replay);
  }

  async handoffThreadWorkspace(
    request: HandoffThreadWorkspaceRequest,
  ): Promise<HandoffThreadWorkspaceResponse> {
    return await this.registry.handoffThreadWorkspace(request);
  }

  async materializeDirectoryLaunchpad(
    request: MaterializeDirectoryLaunchpadRequest,
  ): Promise<MaterializeDirectoryLaunchpadResponse> {
    return await this.registry.materializeDirectoryLaunchpad(request);
  }

  async updateDirectoryLaunchpad(
    request: UpdateDirectoryLaunchpadRequest,
  ): Promise<UpdateDirectoryLaunchpadResponse> {
    return await this.registry.updateDirectoryLaunchpad(request);
  }

  async startTurn(request: StartTurnRequest): Promise<StartTurnResponse> {
    return await this.registry.startTurn(request);
  }

  async steerTurn(request: SteerTurnRequest): Promise<SteerTurnResponse> {
    return await this.registry.steerTurn(request);
  }

  async startThread(request: StartThreadRequest): Promise<StartThreadResponse> {
    return await this.registry.startThread(request);
  }

  async compactThread(request: CompactThreadRequest): Promise<CompactThreadResponse> {
    return await this.registry.compactThread(request);
  }

  async interruptTurn(request: InterruptTurnRequest): Promise<InterruptTurnResponse> {
    return await this.registry.interruptTurn(request);
  }

  async listSkills(
    request: AppServerListSkillsRequest = {},
  ): Promise<Pick<AppServerListSkillsResponse, "data">> {
    return await this.registry.listSkills(request);
  }

  async listBackends(request: ListBackendsRequest = {}): Promise<ListBackendsResponse> {
    return await this.registry.listBackends(request);
  }

  async setThreadExecutionMode(
    request: SetThreadExecutionModeRequest,
  ): Promise<SetThreadExecutionModeResponse> {
    return await this.registry.setThreadExecutionMode(request);
  }

  async cancelThreadExecutionModeQueue(
    request: CancelThreadExecutionModeQueueRequest,
  ): Promise<CancelThreadExecutionModeQueueResponse> {
    return await this.registry.cancelThreadExecutionModeQueue(request);
  }

  async setThreadModelSettings(
    request: SetThreadModelSettingsRequest,
  ): Promise<SetThreadModelSettingsResponse> {
    return await this.registry.setThreadModelSettings(request);
  }

  async recordMessagingBindingTransition(request: {
    backend: AppServerBackendKind;
    threadId: string;
    transition: ThreadMessagingBindingTransition;
  }): Promise<void> {
    await getDesktopOverlayStore().appendMessagingBindingTransition(request);
  }

  async submitServerRequest(
    request: SubmitServerRequestRequest,
  ): Promise<SubmitServerRequestResponse> {
    return await this.registry.submitServerRequest(request);
  }

  onEvent(listener: (event: AgentEvent) => void | Promise<void>): () => void {
    return this.registry.onEvent(listener);
  }
}

function findLastAssistantMessageReply(
  replay: AppServerThreadReplay,
): MessagingLastAssistantReply | undefined {
  for (let index = replay.messages.length - 1; index >= 0; index -= 1) {
    const message = replay.messages[index];
    if (message?.role !== "assistant") {
      continue;
    }
    const text = message.text.trim();
    if (!text) {
      continue;
    }
    const createdAt =
      message.createdAt ?? findLastAssistantEntryCreatedAt(replay, text);
    return {
      text,
      ...(createdAt ? { createdAt } : {}),
    };
  }
  return undefined;
}

function findLastAssistantEntryReply(
  replay: AppServerThreadReplay,
): MessagingLastAssistantReply | undefined {
  for (let index = replay.entries.length - 1; index >= 0; index -= 1) {
    const entry = replay.entries[index];
    if (entry?.type !== "message" || entry.role !== "assistant") {
      continue;
    }
    const text = entry.text.trim();
    if (!text) {
      continue;
    }
    return {
      text,
      ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
    };
  }
  return undefined;
}

function findLastAssistantEntryCreatedAt(
  replay: AppServerThreadReplay,
  text: string,
): number | undefined {
  for (let index = replay.entries.length - 1; index >= 0; index -= 1) {
    const entry = replay.entries[index];
    if (
      entry?.type === "message" &&
      entry.role === "assistant" &&
      entry.text.trim() === text
    ) {
      return entry.createdAt;
    }
  }
  return undefined;
}
