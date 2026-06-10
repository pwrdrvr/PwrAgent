import type {
  AppServerListSkillsRequest,
  AppServerListSkillsResponse,
  AppServerListThreadsRequest,
  AppServerListThreadsResponse,
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  FederationCapability,
  StartTurnRequest,
  StartTurnResponse,
} from "@pwragent/shared";
import type { FederationRouter } from "./federation-router";
import type { FederationRpcEndpoint } from "./federation-rpc";

export const FEDERATION_BACKEND_METHODS = {
  listThreads: "backend.listThreads",
  readThread: "backend.readThread",
  listSkills: "backend.listSkills",
  startTurn: "backend.startTurn",
} as const;

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
}
