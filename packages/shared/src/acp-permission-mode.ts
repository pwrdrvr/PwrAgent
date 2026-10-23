import type { BackendAcpRuntimeCapabilities, BackendAcpRuntimeConfigOption } from "./contracts/backend";

/** Grok's permission config is independent of ACP's native planning mode. */
export function findAcpPermissionModeConfigOption(
  runtime: BackendAcpRuntimeCapabilities | undefined,
): BackendAcpRuntimeConfigOption | undefined {
  return runtime?.configOptions?.find(
    (option) => option.id === "permission_mode" && option.category === "mode",
  );
}
