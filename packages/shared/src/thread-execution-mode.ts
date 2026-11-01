import type { ThreadExecutionMode } from "./contracts/normalized-app-server";

/**
 * Every execution mode, least access first. Escalation checks compare modes
 * through this one order so they all agree on what a raise is.
 */
export const THREAD_EXECUTION_MODES_BY_ACCESS = [
  "default",
  "auto",
  "full-access",
] as const satisfies readonly ThreadExecutionMode[];

export function isThreadExecutionMode(
  value: unknown,
): value is ThreadExecutionMode {
  return (THREAD_EXECUTION_MODES_BY_ACCESS as readonly unknown[]).includes(value);
}

/** 0 for Default Access, rising with access. */
export function threadExecutionModeRank(mode: ThreadExecutionMode): number {
  return THREAD_EXECUTION_MODES_BY_ACCESS.indexOf(mode);
}

/** Whether `mode` grants more access than `ceiling`. Equal is not above. */
export function threadExecutionModeExceeds(
  mode: ThreadExecutionMode,
  ceiling: ThreadExecutionMode,
): boolean {
  return threadExecutionModeRank(mode) > threadExecutionModeRank(ceiling);
}

/** The mode with less access. */
export function lowerThreadExecutionMode(
  a: ThreadExecutionMode,
  b: ThreadExecutionMode,
): ThreadExecutionMode {
  return threadExecutionModeRank(a) <= threadExecutionModeRank(b) ? a : b;
}

const DEFAULT_ACCESS_APPROVAL_POLICIES: readonly string[] = ["untrusted", "on-request"];
const DEFAULT_ACCESS_SANDBOXES: readonly string[] = ["read-only", "workspace-write"];

/**
 * The least execution mode that grants what a raw Codex approval policy and
 * sandbox override grant. Policies that skip approvals (`never`,
 * `on-failure`) and the unsandboxed `danger-full-access` rank as Full Access.
 * So does any value not listed here: an unknown override is not proof of
 * less access.
 */
export function threadExecutionModeForRawPermissions(params: {
  approvalPolicy?: string;
  sandbox?: string;
}): ThreadExecutionMode {
  const approvalPolicy = params.approvalPolicy?.trim();
  const sandbox = params.sandbox?.trim();
  if (approvalPolicy && !DEFAULT_ACCESS_APPROVAL_POLICIES.includes(approvalPolicy)) {
    return "full-access";
  }
  if (sandbox && !DEFAULT_ACCESS_SANDBOXES.includes(sandbox)) {
    return "full-access";
  }
  return "default";
}
