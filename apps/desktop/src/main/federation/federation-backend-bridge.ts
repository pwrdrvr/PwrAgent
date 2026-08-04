import type {
  AppServerListSkillsRequest,
  AppServerListSkillsResponse,
  AppServerListThreadsRequest,
  AppServerListThreadsResponse,
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  AgentEvent,
  ArchiveThreadRequest,
  ArchiveThreadResponse,
  CancelThreadExecutionModeQueueRequest,
  CancelThreadExecutionModeQueueResponse,
  CompactThreadRequest,
  CompactThreadResponse,
  CodexEnvironmentSetupProgressEvent,
  FederationCapability,
  ForkThreadRequest,
  ForkThreadResponse,
  GetNavigationSnapshotRequest,
  HandoffThreadWorkspaceRequest,
  HandoffThreadWorkspaceResponse,
  InterruptTurnRequest,
  InterruptTurnResponse,
  ListBackendsRequest,
  ListBackendsResponse,
  MaterializeDirectoryLaunchpadOptions,
  MaterializeDirectoryLaunchpadRequest,
  MaterializeDirectoryLaunchpadResponse,
  NavigationSnapshot,
  DesktopApplicationsSnapshot,
  OpenDesktopApplicationRequest,
  OpenDesktopApplicationResponse,
  QueueThreadExecutionModeRequest,
  QueueThreadExecutionModeResponse,
  RenameThreadRequest,
  RenameThreadResponse,
  RunCodexEnvironmentActionRequest,
  RunCodexEnvironmentActionResponse,
  SetAcpSessionRuntimeOptionRequest,
  SetAcpSessionRuntimeOptionResponse,
  SetCodexThreadEnvironmentRequest,
  SetCodexThreadEnvironmentResponse,
  SetThreadExecutionModeRequest,
  SetThreadExecutionModeResponse,
  SetThreadModelSettingsRequest,
  SetThreadModelSettingsResponse,
  SteerTurnRequest,
  SteerTurnResponse,
  StartTurnRequest,
  StartTurnResponse,
  StartReviewRequest,
  StartReviewResponse,
  StartThreadRequest,
  StartThreadResponse,
  StopCodexEnvironmentActionRequest,
  StopCodexEnvironmentActionResponse,
  SubmitServerRequestRequest,
  SubmitServerRequestResponse,
  TrustCodexProjectRequest,
  TrustCodexProjectResponse,
} from "@pwragent/shared";
import type { FederationRouter } from "./federation-router";
import type { FederationRpcEndpoint } from "./federation-rpc";

export const FEDERATION_BACKEND_METHODS = {
  getNavigationSnapshot: "backend.getNavigationSnapshot",
  listThreads: "backend.listThreads",
  readThread: "backend.readThread",
  listSkills: "backend.listSkills",
  listBackends: "backend.listBackends",
  archiveThread: "backend.archiveThread",
  startThread: "backend.startThread",
  forkThread: "backend.forkThread",
  startTurn: "backend.startTurn",
  startReview: "backend.startReview",
  compactThread: "backend.compactThread",
  interruptTurn: "backend.interruptTurn",
  steerTurn: "backend.steerTurn",
  setThreadExecutionMode: "backend.setThreadExecutionMode",
  queueThreadExecutionMode: "backend.queueThreadExecutionMode",
  cancelThreadExecutionModeQueue: "backend.cancelThreadExecutionModeQueue",
  setAcpSessionRuntimeOption: "backend.setAcpSessionRuntimeOption",
  setThreadModelSettings: "backend.setThreadModelSettings",
  submitServerRequest: "backend.submitServerRequest",
  runCodexEnvironmentAction: "backend.runCodexEnvironmentAction",
  stopCodexEnvironmentAction: "backend.stopCodexEnvironmentAction",
  setCodexThreadEnvironment: "backend.setCodexThreadEnvironment",
  materializeDirectoryLaunchpad: "backend.materializeDirectoryLaunchpad",
  handoffThreadWorkspace: "backend.handoffThreadWorkspace",
  renameThread: "backend.renameThread",
  readApplications: "backend.readApplications",
  openApplication: "backend.openApplication",
  trustCodexProject: "backend.trustCodexProject",
} as const;

export const FEDERATION_BACKEND_EVENT_METHOD = "backend.event";
export const FEDERATION_ENVIRONMENT_SETUP_PROGRESS_METHOD =
  "backend.environmentSetupProgress";

export type FederationBackendEventNotification = {
  method: typeof FEDERATION_BACKEND_EVENT_METHOD;
  params: AgentEvent;
};

export type FederationEnvironmentSetupProgressNotification = {
  method: typeof FEDERATION_ENVIRONMENT_SETUP_PROGRESS_METHOD;
  params: CodexEnvironmentSetupProgressEvent;
};

export type FederationBackendMethod =
  (typeof FEDERATION_BACKEND_METHODS)[keyof typeof FEDERATION_BACKEND_METHODS];

export const FEDERATION_BACKEND_METHOD_CAPABILITIES: Record<
  FederationBackendMethod,
  FederationCapability
> = {
  [FEDERATION_BACKEND_METHODS.getNavigationSnapshot]: "thread_navigation",
  [FEDERATION_BACKEND_METHODS.listThreads]: "thread_navigation",
  [FEDERATION_BACKEND_METHODS.readThread]: "thread_detail",
  [FEDERATION_BACKEND_METHODS.listSkills]: "thread_detail",
  [FEDERATION_BACKEND_METHODS.listBackends]: "thread_detail",
  [FEDERATION_BACKEND_METHODS.archiveThread]: "turn_control",
  [FEDERATION_BACKEND_METHODS.startThread]: "turn_control",
  [FEDERATION_BACKEND_METHODS.forkThread]: "turn_control",
  [FEDERATION_BACKEND_METHODS.startTurn]: "turn_control",
  [FEDERATION_BACKEND_METHODS.startReview]: "turn_control",
  [FEDERATION_BACKEND_METHODS.compactThread]: "turn_control",
  [FEDERATION_BACKEND_METHODS.interruptTurn]: "turn_control",
  [FEDERATION_BACKEND_METHODS.steerTurn]: "turn_control",
  [FEDERATION_BACKEND_METHODS.setThreadExecutionMode]: "turn_control",
  [FEDERATION_BACKEND_METHODS.queueThreadExecutionMode]: "turn_control",
  [FEDERATION_BACKEND_METHODS.cancelThreadExecutionModeQueue]: "turn_control",
  [FEDERATION_BACKEND_METHODS.setAcpSessionRuntimeOption]: "turn_control",
  [FEDERATION_BACKEND_METHODS.setThreadModelSettings]: "turn_control",
  [FEDERATION_BACKEND_METHODS.submitServerRequest]: "pending_request_control",
  [FEDERATION_BACKEND_METHODS.runCodexEnvironmentAction]: "environment_actions",
  [FEDERATION_BACKEND_METHODS.stopCodexEnvironmentAction]: "environment_actions",
  [FEDERATION_BACKEND_METHODS.setCodexThreadEnvironment]: "environment_actions",
  [FEDERATION_BACKEND_METHODS.materializeDirectoryLaunchpad]: "environment_actions",
  [FEDERATION_BACKEND_METHODS.handoffThreadWorkspace]: "turn_control",
  [FEDERATION_BACKEND_METHODS.renameThread]: "turn_control",
  [FEDERATION_BACKEND_METHODS.readApplications]: "remote_window",
  [FEDERATION_BACKEND_METHODS.openApplication]: "remote_window",
  [FEDERATION_BACKEND_METHODS.trustCodexProject]: "environment_actions",
};

export type FederationBackendOperations = {
  getNavigationSnapshot(
    request?: GetNavigationSnapshotRequest,
  ): Promise<NavigationSnapshot>;
  listThreads(
    request?: AppServerListThreadsRequest,
  ): Promise<AppServerListThreadsResponse>;
  readThread(
    request: AppServerReadThreadRequest,
  ): Promise<AppServerReadThreadResponse>;
  listSkills(
    request?: AppServerListSkillsRequest,
  ): Promise<AppServerListSkillsResponse>;
  listBackends(request?: ListBackendsRequest): Promise<ListBackendsResponse>;
  archiveThread(request: ArchiveThreadRequest): Promise<ArchiveThreadResponse>;
  startThread(request: StartThreadRequest): Promise<StartThreadResponse>;
  forkThread(
    request: ForkThreadRequest,
    options?: Pick<
      MaterializeDirectoryLaunchpadOptions,
      "onCodexEnvironmentSetupProgress"
    >,
  ): Promise<ForkThreadResponse>;
  startTurn(request: StartTurnRequest): Promise<StartTurnResponse>;
  startReview(request: StartReviewRequest): Promise<StartReviewResponse>;
  compactThread(request: CompactThreadRequest): Promise<CompactThreadResponse>;
  interruptTurn(request: InterruptTurnRequest): Promise<InterruptTurnResponse>;
  steerTurn(request: SteerTurnRequest): Promise<SteerTurnResponse>;
  setThreadExecutionMode(
    request: SetThreadExecutionModeRequest,
  ): Promise<SetThreadExecutionModeResponse>;
  queueThreadExecutionMode(
    request: QueueThreadExecutionModeRequest,
  ): Promise<QueueThreadExecutionModeResponse>;
  cancelThreadExecutionModeQueue(
    request: CancelThreadExecutionModeQueueRequest,
  ): Promise<CancelThreadExecutionModeQueueResponse>;
  setAcpSessionRuntimeOption(
    request: SetAcpSessionRuntimeOptionRequest,
  ): Promise<SetAcpSessionRuntimeOptionResponse>;
  setThreadModelSettings(
    request: SetThreadModelSettingsRequest,
  ): Promise<SetThreadModelSettingsResponse>;
  submitServerRequest(
    request: SubmitServerRequestRequest,
  ): Promise<SubmitServerRequestResponse>;
  runCodexEnvironmentAction(
    request: RunCodexEnvironmentActionRequest,
  ): Promise<RunCodexEnvironmentActionResponse>;
  stopCodexEnvironmentAction(
    request: StopCodexEnvironmentActionRequest,
  ): Promise<StopCodexEnvironmentActionResponse>;
  setCodexThreadEnvironment(
    request: SetCodexThreadEnvironmentRequest,
  ): Promise<SetCodexThreadEnvironmentResponse>;
  materializeDirectoryLaunchpad(
    request: MaterializeDirectoryLaunchpadRequest,
    options?: MaterializeDirectoryLaunchpadOptions,
  ): Promise<MaterializeDirectoryLaunchpadResponse>;
  handoffThreadWorkspace(
    request: HandoffThreadWorkspaceRequest,
  ): Promise<HandoffThreadWorkspaceResponse>;
  renameThread(request: RenameThreadRequest): Promise<RenameThreadResponse>;
  readApplications(): Promise<DesktopApplicationsSnapshot>;
  openApplication(
    request: OpenDesktopApplicationRequest,
  ): Promise<OpenDesktopApplicationResponse>;
  trustCodexProject(
    request: TrustCodexProjectRequest,
  ): Promise<TrustCodexProjectResponse>;
};

export function registerFederationBackendHandlers(params: {
  router: FederationRouter;
  backend: FederationBackendOperations;
  onEnvironmentSetupProgress?: (
    event: CodexEnvironmentSetupProgressEvent,
    targetInstanceId: string,
  ) => void;
}): void {
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.getNavigationSnapshot,
    async (envelope) =>
      await params.backend.getNavigationSnapshot(
        (envelope.params ?? {}) as GetNavigationSnapshotRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.listThreads,
    async (envelope) =>
      await params.backend.listThreads(
        (envelope.params ?? {}) as AppServerListThreadsRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.readThread,
    async (envelope) =>
      await params.backend.readThread(
        envelope.params as AppServerReadThreadRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.listSkills,
    async (envelope) =>
      await params.backend.listSkills(
        (envelope.params ?? {}) as AppServerListSkillsRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.listBackends,
    async (envelope) =>
      await params.backend.listBackends(
        (envelope.params ?? {}) as ListBackendsRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.archiveThread,
    async (envelope) =>
      await params.backend.archiveThread(
        envelope.params as ArchiveThreadRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.startThread,
    async (envelope) =>
      await params.backend.startThread(
        envelope.params as StartThreadRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.forkThread,
    async (envelope) =>
      await params.backend.forkThread(
        envelope.params as ForkThreadRequest,
        {
          onCodexEnvironmentSetupProgress: (event) => {
            params.onEnvironmentSetupProgress?.(
              event,
              envelope.sourceInstanceId,
            );
          },
        },
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.startTurn,
    async (envelope) =>
      await params.backend.startTurn(
        envelope.params as StartTurnRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.startReview,
    async (envelope) =>
      await params.backend.startReview(
        envelope.params as StartReviewRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.compactThread,
    async (envelope) =>
      await params.backend.compactThread(
        envelope.params as CompactThreadRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.interruptTurn,
    async (envelope) =>
      await params.backend.interruptTurn(
        envelope.params as InterruptTurnRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.steerTurn,
    async (envelope) =>
      await params.backend.steerTurn(
        envelope.params as SteerTurnRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.setThreadExecutionMode,
    async (envelope) =>
      await params.backend.setThreadExecutionMode(
        envelope.params as SetThreadExecutionModeRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.queueThreadExecutionMode,
    async (envelope) =>
      await params.backend.queueThreadExecutionMode(
        envelope.params as QueueThreadExecutionModeRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.cancelThreadExecutionModeQueue,
    async (envelope) =>
      await params.backend.cancelThreadExecutionModeQueue(
        envelope.params as CancelThreadExecutionModeQueueRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.setAcpSessionRuntimeOption,
    async (envelope) =>
      await params.backend.setAcpSessionRuntimeOption(
        envelope.params as SetAcpSessionRuntimeOptionRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.setThreadModelSettings,
    async (envelope) =>
      await params.backend.setThreadModelSettings(
        envelope.params as SetThreadModelSettingsRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.submitServerRequest,
    async (envelope) =>
      await params.backend.submitServerRequest(
        envelope.params as SubmitServerRequestRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.runCodexEnvironmentAction,
    async (envelope) =>
      await params.backend.runCodexEnvironmentAction(
        envelope.params as RunCodexEnvironmentActionRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.stopCodexEnvironmentAction,
    async (envelope) =>
      await params.backend.stopCodexEnvironmentAction(
        envelope.params as StopCodexEnvironmentActionRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.setCodexThreadEnvironment,
    async (envelope) =>
      await params.backend.setCodexThreadEnvironment(
        envelope.params as SetCodexThreadEnvironmentRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.materializeDirectoryLaunchpad,
    async (envelope) =>
      await params.backend.materializeDirectoryLaunchpad(
        envelope.params as MaterializeDirectoryLaunchpadRequest,
        {
          onCodexEnvironmentSetupProgress: (event) => {
            params.onEnvironmentSetupProgress?.(
              event,
              envelope.sourceInstanceId,
            );
          },
        },
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.handoffThreadWorkspace,
    async (envelope) =>
      await params.backend.handoffThreadWorkspace(
        envelope.params as HandoffThreadWorkspaceRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.renameThread,
    async (envelope) =>
      await params.backend.renameThread(
        envelope.params as RenameThreadRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.readApplications,
    async () => await params.backend.readApplications(),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.openApplication,
    async (envelope) =>
      await params.backend.openApplication(
        envelope.params as OpenDesktopApplicationRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.trustCodexProject,
    async (envelope) =>
      await params.backend.trustCodexProject(
        envelope.params as TrustCodexProjectRequest,
      ),
  );
}

export class FederationRemoteBackendClient implements FederationBackendOperations {
  constructor(private readonly rpc: FederationRpcEndpoint) {}

  async getNavigationSnapshot(
    request: GetNavigationSnapshotRequest = {},
  ): Promise<NavigationSnapshot> {
    return await this.rpc.request<NavigationSnapshot>({
      method: FEDERATION_BACKEND_METHODS.getNavigationSnapshot,
      params: request,
    });
  }

  async listThreads(
    request: AppServerListThreadsRequest = {},
  ): Promise<AppServerListThreadsResponse> {
    return await this.rpc.request<AppServerListThreadsResponse>({
      method: FEDERATION_BACKEND_METHODS.listThreads,
      params: request,
    });
  }

  async readThread(
    request: AppServerReadThreadRequest,
  ): Promise<AppServerReadThreadResponse> {
    return await this.rpc.request<AppServerReadThreadResponse>({
      method: FEDERATION_BACKEND_METHODS.readThread,
      params: request,
    });
  }

  async listSkills(
    request: AppServerListSkillsRequest = {},
  ): Promise<AppServerListSkillsResponse> {
    return await this.rpc.request<AppServerListSkillsResponse>({
      method: FEDERATION_BACKEND_METHODS.listSkills,
      params: request,
    });
  }

  async listBackends(
    request: ListBackendsRequest = {},
  ): Promise<ListBackendsResponse> {
    return await this.rpc.request<ListBackendsResponse>({
      method: FEDERATION_BACKEND_METHODS.listBackends,
      params: request,
    });
  }

  async archiveThread(
    request: ArchiveThreadRequest,
  ): Promise<ArchiveThreadResponse> {
    return await this.rpc.request<ArchiveThreadResponse>({
      method: FEDERATION_BACKEND_METHODS.archiveThread,
      params: request,
    });
  }

  async startThread(request: StartThreadRequest): Promise<StartThreadResponse> {
    return await this.rpc.request<StartThreadResponse>({
      method: FEDERATION_BACKEND_METHODS.startThread,
      params: request,
    });
  }

  async forkThread(request: ForkThreadRequest): Promise<ForkThreadResponse> {
    return await this.rpc.request<ForkThreadResponse>({
      method: FEDERATION_BACKEND_METHODS.forkThread,
      params: request,
    });
  }

  async startTurn(request: StartTurnRequest): Promise<StartTurnResponse> {
    return await this.rpc.request<StartTurnResponse>({
      method: FEDERATION_BACKEND_METHODS.startTurn,
      params: request,
    });
  }

  async startReview(request: StartReviewRequest): Promise<StartReviewResponse> {
    return await this.rpc.request<StartReviewResponse>({
      method: FEDERATION_BACKEND_METHODS.startReview,
      params: request,
    });
  }

  async compactThread(
    request: CompactThreadRequest,
  ): Promise<CompactThreadResponse> {
    return await this.rpc.request<CompactThreadResponse>({
      method: FEDERATION_BACKEND_METHODS.compactThread,
      params: request,
    });
  }

  async interruptTurn(
    request: InterruptTurnRequest,
  ): Promise<InterruptTurnResponse> {
    return await this.rpc.request<InterruptTurnResponse>({
      method: FEDERATION_BACKEND_METHODS.interruptTurn,
      params: request,
    });
  }

  async steerTurn(request: SteerTurnRequest): Promise<SteerTurnResponse> {
    return await this.rpc.request<SteerTurnResponse>({
      method: FEDERATION_BACKEND_METHODS.steerTurn,
      params: request,
    });
  }

  async setThreadExecutionMode(
    request: SetThreadExecutionModeRequest,
  ): Promise<SetThreadExecutionModeResponse> {
    return await this.rpc.request<SetThreadExecutionModeResponse>({
      method: FEDERATION_BACKEND_METHODS.setThreadExecutionMode,
      params: request,
    });
  }

  async queueThreadExecutionMode(
    request: QueueThreadExecutionModeRequest,
  ): Promise<QueueThreadExecutionModeResponse> {
    return await this.rpc.request<QueueThreadExecutionModeResponse>({
      method: FEDERATION_BACKEND_METHODS.queueThreadExecutionMode,
      params: request,
    });
  }

  async cancelThreadExecutionModeQueue(
    request: CancelThreadExecutionModeQueueRequest,
  ): Promise<CancelThreadExecutionModeQueueResponse> {
    return await this.rpc.request<CancelThreadExecutionModeQueueResponse>({
      method: FEDERATION_BACKEND_METHODS.cancelThreadExecutionModeQueue,
      params: request,
    });
  }

  async setAcpSessionRuntimeOption(
    request: SetAcpSessionRuntimeOptionRequest,
  ): Promise<SetAcpSessionRuntimeOptionResponse> {
    return await this.rpc.request<SetAcpSessionRuntimeOptionResponse>({
      method: FEDERATION_BACKEND_METHODS.setAcpSessionRuntimeOption,
      params: request,
    });
  }

  async setThreadModelSettings(
    request: SetThreadModelSettingsRequest,
  ): Promise<SetThreadModelSettingsResponse> {
    return await this.rpc.request<SetThreadModelSettingsResponse>({
      method: FEDERATION_BACKEND_METHODS.setThreadModelSettings,
      params: request,
    });
  }

  async submitServerRequest(
    request: SubmitServerRequestRequest,
  ): Promise<SubmitServerRequestResponse> {
    return await this.rpc.request<SubmitServerRequestResponse>({
      method: FEDERATION_BACKEND_METHODS.submitServerRequest,
      params: request,
    });
  }

  async runCodexEnvironmentAction(
    request: RunCodexEnvironmentActionRequest,
  ): Promise<RunCodexEnvironmentActionResponse> {
    return await this.rpc.request<RunCodexEnvironmentActionResponse>({
      method: FEDERATION_BACKEND_METHODS.runCodexEnvironmentAction,
      params: request,
    });
  }

  async stopCodexEnvironmentAction(
    request: StopCodexEnvironmentActionRequest,
  ): Promise<StopCodexEnvironmentActionResponse> {
    return await this.rpc.request<StopCodexEnvironmentActionResponse>({
      method: FEDERATION_BACKEND_METHODS.stopCodexEnvironmentAction,
      params: request,
    });
  }

  async setCodexThreadEnvironment(
    request: SetCodexThreadEnvironmentRequest,
  ): Promise<SetCodexThreadEnvironmentResponse> {
    return await this.rpc.request<SetCodexThreadEnvironmentResponse>({
      method: FEDERATION_BACKEND_METHODS.setCodexThreadEnvironment,
      params: request,
    });
  }

  async materializeDirectoryLaunchpad(
    request: MaterializeDirectoryLaunchpadRequest,
  ): Promise<MaterializeDirectoryLaunchpadResponse> {
    return await this.rpc.request<MaterializeDirectoryLaunchpadResponse>({
      method: FEDERATION_BACKEND_METHODS.materializeDirectoryLaunchpad,
      params: request,
    });
  }

  async handoffThreadWorkspace(
    request: HandoffThreadWorkspaceRequest,
  ): Promise<HandoffThreadWorkspaceResponse> {
    return await this.rpc.request<HandoffThreadWorkspaceResponse>({
      method: FEDERATION_BACKEND_METHODS.handoffThreadWorkspace,
      params: request,
    });
  }

  async renameThread(
    request: RenameThreadRequest,
  ): Promise<RenameThreadResponse> {
    return await this.rpc.request<RenameThreadResponse>({
      method: FEDERATION_BACKEND_METHODS.renameThread,
      params: request,
    });
  }

  async openApplication(
    request: OpenDesktopApplicationRequest,
  ): Promise<OpenDesktopApplicationResponse> {
    return await this.rpc.request<OpenDesktopApplicationResponse>({
      method: FEDERATION_BACKEND_METHODS.openApplication,
      params: request,
    });
  }

  async readApplications(): Promise<DesktopApplicationsSnapshot> {
    return await this.rpc.request<DesktopApplicationsSnapshot>({
      method: FEDERATION_BACKEND_METHODS.readApplications,
      params: {},
    });
  }

  async trustCodexProject(
    request: TrustCodexProjectRequest,
  ): Promise<TrustCodexProjectResponse> {
    return await this.rpc.request<TrustCodexProjectResponse>({
      method: FEDERATION_BACKEND_METHODS.trustCodexProject,
      params: request,
    });
  }
}
