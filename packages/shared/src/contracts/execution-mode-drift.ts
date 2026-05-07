import type { ThreadExecutionMode } from "./normalized-app-server";

/**
 * Detect whether the user's expected per-thread execution mode (PwrAgent's
 * overlay value) disagrees with the mode codex's app-server is reporting for
 * the same thread (the value derived from `approvalPolicy` + `sandbox` on
 * `thread/start` / `thread/resume` / `thread/fork` responses).
 *
 * Returns `false` when either side is missing — drift is only detectable
 * once both values are known.
 */
export function isExecutionModeDrifted(
  expected: ThreadExecutionMode | undefined,
  observed: ThreadExecutionMode | undefined,
): boolean {
  if (!expected || !observed) return false;
  return expected !== observed;
}

/**
 * Map the codex `approvalPolicy` + `sandbox` pair returned from
 * `thread/start` / `thread/resume` / `thread/fork` to PwrAgent's binary
 * execution mode. Returns `undefined` when the codex pair is not one of the
 * two combinations PwrAgent surfaces — callers should treat that as
 * "unknown" and skip drift detection rather than guessing.
 */
export function executionModeFromCodexResponse(params: {
  approvalPolicy?: string;
  sandbox?: string;
}): ThreadExecutionMode | undefined {
  const approval = params.approvalPolicy?.trim();
  const sandbox = params.sandbox?.trim();
  if (approval === "never" && sandbox === "danger-full-access") {
    return "full-access";
  }
  if (approval === "on-request" && sandbox === "workspace-write") {
    return "default";
  }
  return undefined;
}
