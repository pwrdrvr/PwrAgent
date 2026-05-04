import type {
  AgentEvent,
  AppServerBackendKind,
  AppServerThreadStatus,
  CompactThreadRequest,
  CompactThreadResponse,
  GetNavigationSnapshotRequest,
  HandoffThreadWorkspaceRequest,
  HandoffThreadWorkspaceResponse,
  InterruptTurnRequest,
  InterruptTurnResponse,
  ListBackendsRequest,
  ListBackendsResponse,
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
} from "@pwragnt/shared";
import type { MessagingBackendBridge } from "./core/messaging-adapter";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopOverlayStore } from "../app-server/desktop-overlay-store";

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
    const snapshot = await getDesktopOverlayStore().reconcileNavigationSnapshot({
      backend,
      fetchedAt: Date.now(),
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

  async handoffThreadWorkspace(
    request: HandoffThreadWorkspaceRequest,
  ): Promise<HandoffThreadWorkspaceResponse> {
    return await this.registry.handoffThreadWorkspace(request);
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

  async listBackends(request: ListBackendsRequest = {}): Promise<ListBackendsResponse> {
    return await this.registry.listBackends(request);
  }

  async setThreadExecutionMode(
    request: SetThreadExecutionModeRequest,
  ): Promise<SetThreadExecutionModeResponse> {
    return await this.registry.setThreadExecutionMode(request);
  }

  async setThreadModelSettings(
    request: SetThreadModelSettingsRequest,
  ): Promise<SetThreadModelSettingsResponse> {
    return await this.registry.setThreadModelSettings(request);
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
