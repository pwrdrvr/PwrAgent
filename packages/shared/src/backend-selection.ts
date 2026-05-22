import type { AppServerBackendKind } from "./contracts/normalized-app-server";
import type { BackendSummary } from "./contracts/backend";

export function selectableNewThreadBackends(
  backends: BackendSummary[],
): BackendSummary[] {
  return backends.filter(
    (backend) =>
      backend.available &&
      backend.capabilities.createThread &&
      backend.executionModes.some((mode) => mode.available),
  );
}

export function resolveNewThreadBackend(
  backends: BackendSummary[],
  preferredBackend?: AppServerBackendKind,
): BackendSummary | undefined {
  const selectable = selectableNewThreadBackends(backends);
  return (
    selectable.find((backend) => backend.kind === preferredBackend) ??
    selectable.find((backend) => backend.kind === "codex") ??
    selectable[0]
  );
}
