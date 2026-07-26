import type { FederationRemoteTarget } from "@pwragent/shared";

export function readRendererFederationTarget(): FederationRemoteTarget | undefined {
  const target = (window as typeof window & {
    __pwragentFederationTarget?: Partial<FederationRemoteTarget>;
  }).__pwragentFederationTarget;
  return target?.scope === "remote" && typeof target.instanceId === "string"
    ? { scope: "remote", instanceId: target.instanceId }
    : undefined;
}

export function readRendererFederationLabel(): string | undefined {
  const label = (window as typeof window & {
    __pwragentFederationLabel?: unknown;
  }).__pwragentFederationLabel;
  return typeof label === "string" && label.trim()
    ? label.trim()
    : undefined;
}
