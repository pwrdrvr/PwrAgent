import type {
  AgentEvent,
  AppServerBackendKind,
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
} from "@pwragent/shared";
import type {
  MessagingBackendBridge,
  MessagingLastAssistantReply,
} from "./core/messaging-adapter";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopOverlayStore } from "../app-server/desktop-overlay-store";
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
    for (let index = response.replay.entries.length - 1; index >= 0; index -= 1) {
      const entry = response.replay.entries[index];
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
    for (let index = response.replay.messages.length - 1; index >= 0; index -= 1) {
      const message = response.replay.messages[index];
      if (message?.role !== "assistant") {
        continue;
      }
      const text = message.text.trim();
      if (!text) {
        continue;
      }
      return {
        text,
        ...(message.createdAt ? { createdAt: message.createdAt } : {}),
      };
    }
    const fallbackText = response.replay.lastAssistantMessage?.trim();
    return fallbackText ? { text: fallbackText } : undefined;
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
