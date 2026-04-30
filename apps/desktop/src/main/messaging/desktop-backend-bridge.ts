import type {
  AgentEvent,
  GetNavigationSnapshotRequest,
  NavigationSnapshot,
  StartTurnRequest,
  StartTurnResponse,
  SubmitServerRequestRequest,
  SubmitServerRequestResponse,
} from "@pwragnt/shared";
import type { MessagingBackendBridge } from "@pwragnt/agent-core";
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

  async startTurn(request: StartTurnRequest): Promise<StartTurnResponse> {
    return await this.registry.startTurn(request);
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
