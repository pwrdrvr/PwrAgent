import type {
  BackendAcpRuntimeCapabilities,
  BackendAcpRuntimeConfigOption,
  BackendAcpSessionRuntimeState,
} from "./contracts/backend";
import type { ThreadExecutionMode } from "./contracts/normalized-app-server";

/** Grok's permission config is independent of ACP's native planning mode. */
export function findAcpPermissionModeConfigOption(
  runtime: BackendAcpRuntimeCapabilities | undefined,
): BackendAcpRuntimeConfigOption | undefined {
  return runtime?.configOptions?.find(
    (option) => option.id === "permission_mode" && option.category === "mode",
  );
}

/** The ids Kimi's and Antigravity's session modes and Grok's
 * `permission_mode` use for PwrAgent's access levels, lowest first. */
const ACP_NATIVE_ACCESS_MODE_IDS: ReadonlyArray<readonly [ThreadExecutionMode, string]> = [
  ["default", "default"],
  ["auto", "auto"],
  ["full-access", "yolo"],
];

export type AcpNativeAccessMode = {
  /** The PwrAgent access level the native mode carries. */
  executionMode: ThreadExecutionMode;
  /** Runtime state that selects the native mode when the session starts. */
  runtime: Pick<BackendAcpSessionRuntimeState, "configValues" | "currentModeId">;
};

/**
 * The agent's own mode for a PwrAgent access level, for an agent whose native
 * selector owns approval policy and so lists no PwrAgent execution modes. It
 * picks the highest listed mode at or below `executionMode`, so a provider
 * switch never raises access. Modes with no PwrAgent level, such as Plan and
 * Accept edits, are never picked.
 */
export function acpNativeAccessMode(
  runtime: BackendAcpRuntimeCapabilities | undefined,
  executionMode: ThreadExecutionMode,
): AcpNativeAccessMode | undefined {
  const permission = findAcpPermissionModeConfigOption(runtime);
  const offered = permission
    ? permission.values.map((value) => value.value)
    : runtime?.modes?.availableModes.map((mode) => mode.id) ?? [];
  if (offered.length < 2) return undefined;
  const ceiling = ACP_NATIVE_ACCESS_MODE_IDS.findIndex(([mode]) => mode === executionMode);
  for (const [mode, id] of ACP_NATIVE_ACCESS_MODE_IDS.slice(0, ceiling + 1).reverse()) {
    if (!offered.includes(id)) continue;
    return {
      executionMode: mode,
      runtime: permission ? { configValues: { [permission.id]: id } } : { currentModeId: id },
    };
  }
  return undefined;
}
