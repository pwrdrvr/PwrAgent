import type {
  AppServerListSkillsRequest,
  AppServerListSkillsResponse,
  AppServerListThreadsRequest,
  AppServerListThreadsResponse,
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  AgentEvent,
  CancelThreadExecutionModeQueueRequest,
  CancelThreadExecutionModeQueueResponse,
  CompactThreadRequest,
  CompactThreadResponse,
  FederationCapability,
  HandoffThreadWorkspaceRequest,
  HandoffThreadWorkspaceResponse,
  InterruptTurnRequest,
  InterruptTurnResponse,
  QueueThreadExecutionModeRequest,
  QueueThreadExecutionModeResponse,
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
  SubmitServerRequestRequest,
  SubmitServerRequestResponse,
} from "@pwragent/shared";
import type { FederationRouter } from "./federation-router";
import type { FederationRpcEndpoint } from "./federation-rpc";

export const FEDERATION_BACKEND_METHODS = {
  listThreads: "backend.listThreads",
  readThread: "backend.readThread",
  listSkills: "backend.listSkills",
  startTurn: "backend.startTurn",
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
  setCodexThreadEnvironment: "backend.setCodexThreadEnvironment",
  handoffThreadWorkspace: "backend.handoffThreadWorkspace",
} as const;

export const FEDERATION_BACKEND_EVENT_METHOD = "backend.event";

export type FederationBackendEventNotification = {
  method: typeof FEDERATION_BACKEND_EVENT_METHOD;
  params: AgentEvent;
};

export type FederationBackendMethod =
  (typeof FEDERATION_BACKEND_METHODS)[keyof typeof FEDERATION_BACKEND_METHODS];

export const FEDERATION_BACKEND_METHOD_CAPABILITIES: Record<
  FederationBackendMethod,
  FederationCapability
> = {
  [FEDERATION_BACKEND_METHODS.listThreads]: "thread_navigation",
  [FEDERATION_BACKEND_METHODS.readThread]: "thread_detail",
  [FEDERATION_BACKEND_METHODS.listSkills]: "thread_detail",
  [FEDERATION_BACKEND_METHODS.startTurn]: "turn_control",
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
  [FEDERATION_BACKEND_METHODS.setCodexThreadEnvironment]: "environment_actions",
  [FEDERATION_BACKEND_METHODS.handoffThreadWorkspace]: "turn_control",
};

export type FederationBackendOperations = {
  listThreads(
    request?: AppServerListThreadsRequest,
  ): Promise<AppServerListThreadsResponse>;
  readThread(
    request: AppServerReadThreadRequest,
  ): Promise<AppServerReadThreadResponse>;
  listSkills(
    request?: AppServerListSkillsRequest,
  ): Promise<AppServerListSkillsResponse>;
  startTurn(request: StartTurnRequest): Promise<StartTurnResponse>;
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
  setCodexThreadEnvironment(
    request: SetCodexThreadEnvironmentRequest,
  ): Promise<SetCodexThreadEnvironmentResponse>;
  handoffThreadWorkspace(
    request: HandoffThreadWorkspaceRequest,
  ): Promise<HandoffThreadWorkspaceResponse>;
};

export function registerFederationBackendHandlers(params: {
  router: FederationRouter;
  backend: FederationBackendOperations;
}): void {
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
    FEDERATION_BACKEND_METHODS.startTurn,
    async (envelope) =>
      await params.backend.startTurn(
        envelope.params as StartTurnRequest,
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
    FEDERATION_BACKEND_METHODS.setCodexThreadEnvironment,
    async (envelope) =>
      await params.backend.setCodexThreadEnvironment(
        envelope.params as SetCodexThreadEnvironmentRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.handoffThreadWorkspace,
    async (envelope) =>
      await params.backend.handoffThreadWorkspace(
        envelope.params as HandoffThreadWorkspaceRequest,
      ),
  );
}

export class FederationRemoteBackendClient implements FederationBackendOperations {
  constructor(private readonly rpc: FederationRpcEndpoint) {}

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

  async startTurn(request: StartTurnRequest): Promise<StartTurnResponse> {
    return await this.rpc.request<StartTurnResponse>({
      method: FEDERATION_BACKEND_METHODS.startTurn,
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

  async setCodexThreadEnvironment(
    request: SetCodexThreadEnvironmentRequest,
  ): Promise<SetCodexThreadEnvironmentResponse> {
    return await this.rpc.request<SetCodexThreadEnvironmentResponse>({
      method: FEDERATION_BACKEND_METHODS.setCodexThreadEnvironment,
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
}
