import type { AppServerBackendKind, LaunchpadWorkMode } from "@pwragent/shared";
import { getMainLogger } from "../log";

const backendRegistryLog = getMainLogger("pwragent:backend-registry");

/**
 * Refuse a thread whose workspace resolved to another mode than the caller
 * required, after removing what was prepared. A worktree request otherwise
 * falls back to sharing the project checkout.
 */
export async function refuseResolvedWorkMode(params: {
  required: LaunchpadWorkMode;
  resolved: LaunchpadWorkMode | undefined;
  rollback: (() => Promise<void>) | undefined;
  backend: AppServerBackendKind;
}): Promise<never> {
  await params.rollback?.().catch((error) => {
    backendRegistryLog.warn("required work mode rollback failed", {
      backend: params.backend,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  throw new Error(
    `Requested ${params.required} workspace, but workspace preparation resolved to ${params.resolved ?? "none"}. Verify the source directory is a Git repository and any branchName resolves to an existing branch or ref.`,
  );
}
