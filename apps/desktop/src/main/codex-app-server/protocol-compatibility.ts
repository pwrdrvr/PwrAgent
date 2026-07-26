import type { DynamicToolSpec } from "@pwrdrvr/codex-app-server-protocol/v2";

const PERSIST_EXTENDED_HISTORY_REMOVED_VERSION = [0, 137, 0] as const;
const NAMESPACED_DYNAMIC_TOOLS_MIN_VERSION = [0, 141, 0] as const;
const ON_FAILURE_APPROVAL_REMOVED_VERSION = [0, 143, 0] as const;

export type CodexProtocolCompatibility = {
  dynamicToolFormat: "flat" | "namespaced";
  includePersistExtendedHistory: boolean;
  supportsOnFailureApprovalPolicy: boolean;
};

type ModernDynamicToolFunction = Extract<
  DynamicToolSpec,
  { type: "function" }
>;

export type LegacyDynamicToolSpec = Omit<
  ModernDynamicToolFunction,
  "type"
> & {
  namespace?: string;
};

export type CompatibleDynamicToolSpec =
  | DynamicToolSpec
  | LegacyDynamicToolSpec;

export type CompatibleApprovalPolicy =
  | "untrusted"
  | "on-failure"
  | "on-request"
  | "never";

/**
 * These experimental App Server contracts changed independently between the
 * package's 0.135.0 and 0.144.0 snapshots:
 * - 0.137.0 removed the deprecated `persistExtendedHistory` thread parameter.
 * - 0.141.0 changed dynamic tools to function/namespace discriminated specs.
 * - 0.143.0 removed the `on-failure` approval policy.
 *
 * Missing or unparseable versions stay on the legacy shape. That preserves
 * the contract PwrAgent used before this migration instead of assuming that
 * an unidentified local App Server understands newer experimental fields.
 */
export function resolveCodexProtocolCompatibility(
  serverVersion?: string,
): CodexProtocolCompatibility {
  const version = parseSemanticVersion(serverVersion);
  const isAtLeast = (minimum: readonly [number, number, number]): boolean =>
    version !== undefined && compareSemanticVersions(version, minimum) >= 0;

  return {
    dynamicToolFormat: isAtLeast(NAMESPACED_DYNAMIC_TOOLS_MIN_VERSION)
      ? "namespaced"
      : "flat",
    includePersistExtendedHistory:
      !isAtLeast(PERSIST_EXTENDED_HISTORY_REMOVED_VERSION),
    supportsOnFailureApprovalPolicy:
      !isAtLeast(ON_FAILURE_APPROVAL_REMOVED_VERSION),
  };
}

export function serializeCompatibleDynamicTools(
  tools: DynamicToolSpec[],
  compatibility: CodexProtocolCompatibility,
): CompatibleDynamicToolSpec[] {
  if (compatibility.dynamicToolFormat === "namespaced") {
    return tools;
  }

  return tools.flatMap((spec): LegacyDynamicToolSpec[] => {
    if (spec.type === "namespace") {
      return spec.tools.map(({ type: _type, ...tool }) => ({
        namespace: spec.name,
        ...tool,
      }));
    }

    const { type: _type, ...tool } = spec;
    return [tool];
  });
}

export function normalizeCompatibleApprovalPolicy(
  value: string | undefined,
  compatibility: CodexProtocolCompatibility,
): CompatibleApprovalPolicy | undefined {
  const normalized = value?.trim();
  if (normalized === "on-failure") {
    // New App Servers no longer accept on-failure. Preserve the old value for
    // old servers and choose the safer interactive policy for modern servers.
    return compatibility.supportsOnFailureApprovalPolicy
      ? normalized
      : "on-request";
  }
  if (
    normalized === "untrusted" ||
    normalized === "on-request" ||
    normalized === "never"
  ) {
    return normalized;
  }
  return undefined;
}

function parseSemanticVersion(
  value?: string,
): readonly [number, number, number] | undefined {
  const match = value?.match(/(?:^|[^\d])(\d+)\.(\d+)\.(\d+)(?:[^\d]|$)/);
  if (!match) {
    return undefined;
  }
  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10),
  ];
}

function compareSemanticVersions(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
