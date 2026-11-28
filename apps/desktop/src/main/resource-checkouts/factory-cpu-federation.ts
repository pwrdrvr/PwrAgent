import { FederationRoleDeniedError, type FederationRouter } from "@pwragent/federation/federation-router";
import type { FactoryCpuStatus } from "@pwragent/owner-core/resource-checkout-authority";
import type { FederationPeerSummary } from "@pwragent/shared/contracts/federation";

export const FACTORY_CPU_FEDERATION_METHOD = "resourceCheckouts.factoryCpu.v1";

export function registerFactoryCpuFederationHandler(options: {
  router: Pick<FederationRouter, "registerHandler" | "getConnection">;
  enrolledPeer(instanceId: string): Pick<FederationPeerSummary, "status" | "permissionRole" | "revokedAt"> | undefined;
  pinnedGateway(): string | undefined;
  execute(gateway: string, request: unknown): FactoryCpuStatus | null;
}): void {
  const { router } = options;
  router.registerHandler(FACTORY_CPU_FEDERATION_METHOD, (envelope, sourcePeerId) => {
    if (!sourcePeerId || sourcePeerId !== envelope.sourceInstanceId || !router.getConnection(sourcePeerId)) {
      throw new FederationRoleDeniedError("Factory CPU requires a direct enrolled peer.");
    }
    const peer = options.enrolledPeer(sourcePeerId);
    const enrolled = peer ? peer.status === "connected" && peer.permissionRole === "full" && !peer.revokedAt
      : sourcePeerId === options.pinnedGateway();
    if (!enrolled) throw new FederationRoleDeniedError("Factory CPU requires a full enrolled peer.");
    return options.execute(sourcePeerId, envelope.params);
  });
}
