import type { FederationRequestEnvelope } from "@pwragent/shared/contracts/federation";
import type {
  NavigationLaunchpadConfigRequest,
  NavigationLaunchpadConfigResponse,
  NavigationQueryPage,
  NavigationQueryRequest,
  FederationNavigationPageRequest,
  NavigationQueueProjection,
  NavigationQueueProjectionRequest,
  NavigationSelectedDetailRequest,
  NavigationSelectedDetailResponse,
} from "@pwragent/shared/contracts/navigation";
import { FEDERATION_BACKEND_METHODS } from "@pwragent/federation/federation-backend-methods";
import type { FederationRouter } from "./federation-router";
import type { FederationRpcRequestOptions } from "./federation-rpc";
import { FederationNavigationPageDeltas } from "./federation-navigation-page-deltas";

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
    const deltas = new FederationNavigationPageDeltas();
    params.router.registerHandler(FEDERATION_BACKEND_METHODS.getNavigationQueryPage, async (envelope, sourcePeerId) => {
      const { ownerPageBase, ...request } = envelope.params as FederationNavigationPageRequest;
      if (request.inventory === "viewer" && !params.localContext?.(envelope)) {
        throw new Error("Viewer navigation inventory is available only on its local machine.");
      }
      const connection = sourcePeerId && params.router.getConnection(sourcePeerId);
      if (connection && !params.localContext && request.consumer === "main-sidebar" && typeof ownerPageBase === "string"
        && ownerPageBase.length <= 128 && connection.capabilities.includes("navigation_page_deltas_v1")) {
        // A peer token names one raw page. Only a fresh projection can establish what that page contains now.
        const page = await params.backend.getNavigationQueryPage!({ ...request, completeBaselineRevision: undefined,
          retainedRange: undefined, windowPageBase: undefined }, options(envelope));
        return deltas.encode(envelope.sourceInstanceId, connection, { ...request, ownerPageBase }, page);
      }
      return params.backend.getNavigationQueryPage!(request, options(envelope));
    });
  }
  if (params.backend.getNavigationSelectedDetail) {
    params.router.registerHandler(FEDERATION_BACKEND_METHODS.getNavigationSelectedDetail, (envelope) =>
      params.backend.getNavigationSelectedDetail!(envelope.params as NavigationSelectedDetailRequest, options(envelope)));
    params.router.registerHandler(FEDERATION_BACKEND_METHODS.getNavigationThreadLinkDetail, (envelope) =>
      params.backend.getNavigationSelectedDetail!({
        ...envelope.params as NavigationSelectedDetailRequest, lookup: "thread-link",
      }, options(envelope)));
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
