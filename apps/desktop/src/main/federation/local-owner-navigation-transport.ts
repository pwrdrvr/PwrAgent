import { FEDERATION_CAPABILITIES, FEDERATION_PROTOCOL_VERSION, type FederationRequestEnvelope } from "@pwragent/shared";
import { FEDERATION_BACKEND_METHOD_CAPABILITIES } from "@pwragent/federation/federation-backend-methods";
import type { OwnerNavigationRequest } from "../../shared/owner-request";
import { NavigationQueryError } from "../app-server/navigation-query-store";
import { FederationRouter } from "./federation-router";
import { registerNavigationBackendHandlers, type NavigationBackendOperations } from "./federation-navigation-handlers";

/** No sockets, profile identity, RPC timers or federation runtime lease are needed for a native window. */
export class LocalOwnerNavigationTransport {
  private readonly router = new FederationRouter({
    localInstanceId: "local-desktop-owner",
    methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
  });
  private readonly contexts = new WeakMap<FederationRequestEnvelope, { consumerId: string }>();
  private nextRequest = 0;

  constructor(backend: NavigationBackendOperations) {
    this.router.registerConnection({ peerId: "local-desktop-window", capabilities: FEDERATION_CAPABILITIES,
      sendEnvelope: () => {} });
    registerNavigationBackendHandlers({ router: this.router, backend, localContext: (envelope) => this.contexts.get(envelope) });
  }

  async request(request: OwnerNavigationRequest, consumerId: string): Promise<unknown> {
    const deadlineAt = "deadlineAt" in request.params ? request.params.deadlineAt : undefined;
    const envelope: FederationRequestEnvelope = {
      id: `local-owner:${++this.nextRequest}`, kind: "request", protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: "local-desktop-window", targetInstanceId: "local-desktop-owner",
      method: request.method, params: request.params, createdAt: Date.now(), deadlineAt,
    };
    this.contexts.set(envelope, { consumerId });
    try {
      const result = await this.router.routeEnvelope({ envelope, sourcePeerId: "local-desktop-window" });
      if (result.status === "handled") return result.response?.result;
      if (result.status === "rejected") {
        if (result.cause !== undefined) throw result.cause;
        if (result.code === "deadline_expired") {
          throw new NavigationQueryError("navigation_busy", "Navigation read cancelled or its deadline expired.");
        }
        throw Object.assign(new Error(`${result.code}: ${result.message}`), { code: result.code });
      }
      throw new Error("A native owner request cannot be relayed.");
    } finally { this.contexts.delete(envelope); }
  }
}
