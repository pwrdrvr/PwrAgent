import type { FederationRemoteTarget } from "@pwragent/shared";

export const FEDERATION_WINDOW_TARGET_ARG_PREFIX =
  "--pwragent-federation-target=";

export function federationWindowTargetAdditionalArguments(
  target: FederationRemoteTarget | undefined,
): string[] {
  return target
    ? [`${FEDERATION_WINDOW_TARGET_ARG_PREFIX}${JSON.stringify(target)}`]
    : [];
}

export function readFederationWindowTargetFromArgv(
  argv: readonly string[],
): FederationRemoteTarget | undefined {
  for (const arg of argv) {
    if (!arg.startsWith(FEDERATION_WINDOW_TARGET_ARG_PREFIX)) continue;
    try {
      const raw = JSON.parse(
        arg.slice(FEDERATION_WINDOW_TARGET_ARG_PREFIX.length),
      ) as Partial<FederationRemoteTarget>;
      return raw.scope === "remote" && typeof raw.instanceId === "string"
        ? { scope: "remote", instanceId: raw.instanceId }
        : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
