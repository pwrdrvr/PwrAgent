import type { BackendAcpDistributionKind } from "@pwragent/shared";
import type { AcpRegistryDistribution } from "./acp-registry-types.js";

export function describeDistributionSource(
  distribution: AcpRegistryDistribution,
): string {
  if (distribution.kind === "binary") {
    return distribution.archiveUrl;
  }
  return distribution.packageName;
}

export function distributionKind(
  distribution: AcpRegistryDistribution,
): BackendAcpDistributionKind {
  return distribution.kind;
}
