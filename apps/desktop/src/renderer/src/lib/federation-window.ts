import type { FederationRemoteTarget } from "@pwragent/shared";

export function readRendererFederationTarget(): FederationRemoteTarget | undefined {
  const target = (window as typeof window & {
    __pwragentFederationTarget?: Partial<FederationRemoteTarget>;
  }).__pwragentFederationTarget;
  return target?.scope === "remote" && typeof target.instanceId === "string"
    ? { scope: "remote", instanceId: target.instanceId }
    : undefined;
}
