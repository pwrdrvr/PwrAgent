import type {
  FederationRequestEnvelope,
  NavigationLaunchpadConfigRequest,
  NavigationLaunchpadConfigResponse,
  NavigationQueryPage,
  NavigationQueryRequest,
  NavigationQueueProjection,
  NavigationQueueProjectionRequest,
  NavigationSelectedDetailRequest,
  NavigationSelectedDetailResponse,
} from "@pwragent/shared";
import { FEDERATION_BACKEND_METHODS } from "@pwragent/federation/federation-backend-methods";
import type { FederationRouter } from "./federation-router";
import type { FederationRpcRequestOptions } from "./federation-rpc";

export type NavigationBackendRequestOptions = FederationRpcRequestOptions & {
  /** Native transport demand. Never read from a request's serialized params. */
  localConsumerId?: string;
};

export type NavigationBackendOperations = {
  getNavigationQueryPage?(request: NavigationQueryRequest, options?: NavigationBackendRequestOptions): Promise<NavigationQueryPage>;
  getNavigationSelectedDetail?(request: NavigationSelectedDetailRequest, options?: NavigationBackendRequestOptions): Promise<NavigationSelectedDetailResponse>;
  getNavigationQueueProjection?(request: NavigationQueueProjectionRequest, options?: NavigationBackendRequestOptions): Promise<NavigationQueueProjection>;
  getNavigationLaunchpadConfig?(request: NavigationLaunchpadConfigRequest, options?: NavigationBackendRequestOptions): Promise<NavigationLaunchpadConfigResponse>;
};

/** Both transports register these handlers; only the native transport supplies local context. */
export function registerNavigationBackendHandlers(params: {
  router: FederationRouter;
  backend: NavigationBackendOperations;
  localContext?: (envelope: FederationRequestEnvelope) => { consumerId: string } | undefined;
}): void {
  const options = (envelope: FederationRequestEnvelope): NavigationBackendRequestOptions => {
    const local = params.localContext?.(envelope);
    return {
      deadlineAt: envelope.deadlineAt,
      requesterInstanceId: envelope.sourceInstanceId,
      ...(local ? { localConsumerId: local.consumerId } : {}),
    };
  };
  if (params.backend.getNavigationQueryPage) {
    params.router.registerHandler(FEDERATION_BACKEND_METHODS.getNavigationQueryPage, async (envelope) => {
      const request = envelope.params as NavigationQueryRequest;
      if (request.inventory === "viewer" && !params.localContext?.(envelope)) {
        throw new Error("Viewer navigation inventory is available only on its local machine.");
      }
      return params.backend.getNavigationQueryPage!(request, options(envelope));
    });
  }
  if (params.backend.getNavigationSelectedDetail) {
    params.router.registerHandler(FEDERATION_BACKEND_METHODS.getNavigationSelectedDetail, (envelope) =>
      params.backend.getNavigationSelectedDetail!(envelope.params as NavigationSelectedDetailRequest, options(envelope)));
  }
  if (params.backend.getNavigationQueueProjection) {
    params.router.registerHandler(FEDERATION_BACKEND_METHODS.getNavigationQueueProjection, (envelope) =>
      params.backend.getNavigationQueueProjection!(envelope.params as NavigationQueueProjectionRequest, options(envelope)));
  }
  if (params.backend.getNavigationLaunchpadConfig) {
    params.router.registerHandler(FEDERATION_BACKEND_METHODS.getNavigationLaunchpadConfig, (envelope) =>
      params.backend.getNavigationLaunchpadConfig!(envelope.params as NavigationLaunchpadConfigRequest, options(envelope)));
  }
}
