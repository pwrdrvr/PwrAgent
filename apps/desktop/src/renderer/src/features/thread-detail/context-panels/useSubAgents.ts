import type { NavigationThreadSummary } from "@pwragent/shared";

/**
 * Renderer-facing summary of one delegated sub-agent ("task monitor")
 * spawned from this thread. Shaped to match the in-flight backend on
 * branch `feat/subagent-task-monitoring`
 * (`packages/shared/src/contracts/task-monitor-tools.ts` +
 * `BackendRegistry`'s `TaskMonitorDelegationRecord`): a monitor has a
 * stable `monitorId`, the delegated `task`, an injected progress
 * `status`, and a terminal `outcome` once it completes.
 *
 * Kept renderer-local on purpose so this UI branch stays independent of
 * the shared-contract additions that land with that feature; swap this
 * for the shared type at merge time.
 */
export type SubAgentStatus =
  | "pending"
  | "running"
  | "blocked"
  | "failed"
  | "success"
  | "failure"
  | "cancelled";

export type SubAgentSummary = {
  monitorId: string;
  task: string;
  status: SubAgentStatus;
  createdAt: number;
  preferredModel?: string;
  /** Bound once the monitor thread reports its first progress update. */
  monitorThreadId?: string;
  /** Most recent injected progress message, when known. */
  lastMessage?: string;
};

export type UseSubAgentsResult = {
  subAgents: SubAgentSummary[];
  loading: boolean;
  /** True when the running backend exposes the monitor surface. */
  supported: boolean;
};

/**
 * Lists sub-agents (task monitors) delegated from a thread.
 *
 * Placeholder: returns an empty, unsupported result today. The backend
 * protocol exists (`pwragent_task_monitors` tools, delegation records in
 * `BackendRegistry`) but is not yet surfaced over IPC.
 *
 * TODO(merge `feat/subagent-task-monitoring`): wire this to a navigation
 * field or a `desktopApi.listTaskMonitors({ backend, threadId })` call
 * that returns the registry's delegation records for the parent thread,
 * mapping `outcome`/injected `status` onto {@link SubAgentStatus}.
 */
export function useSubAgents(_thread: NavigationThreadSummary): UseSubAgentsResult {
  return { subAgents: [], loading: false, supported: false };
}
