import type { FederationRemoteTarget } from "@pwragent/shared";

export const FEDERATION_WINDOW_TARGET_ARG_PREFIX =
  "--pwragent-federation-target=";
export const FEDERATION_WINDOW_LABEL_ARG_PREFIX =
  "--pwragent-federation-label=";

export function federationWindowTargetAdditionalArguments(
  target: FederationRemoteTarget | undefined,
  label?: string,
): string[] {
  return target
    ? [
        `${FEDERATION_WINDOW_TARGET_ARG_PREFIX}${JSON.stringify(target)}`,
        ...(label?.trim()
          ? [`${FEDERATION_WINDOW_LABEL_ARG_PREFIX}${JSON.stringify(label.trim())}`]
          : []),
      ]
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

export function readFederationWindowLabelFromArgv(
  argv: readonly string[],
): string | undefined {
  for (const arg of argv) {
    if (!arg.startsWith(FEDERATION_WINDOW_LABEL_ARG_PREFIX)) continue;
    try {
      const label = JSON.parse(
        arg.slice(FEDERATION_WINDOW_LABEL_ARG_PREFIX.length),
      );
      return typeof label === "string" && label.trim()
        ? label.trim()
        : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
