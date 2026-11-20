import type { NavigationThreadSummary, ThreadSubAgentSummary } from "@pwragent/shared/contracts/navigation";
import { isThreadSubAgentVisibleInPanel } from "@pwragent/shared/subagent-visibility";

export type UseSubAgentsResult = {
  subAgents: ThreadSubAgentSummary[];
  loading: boolean;
  /** True when the running backend exposes the monitor surface. */
  supported: boolean;
};

/**
 * Lists sub-agents (task monitors) delegated from a thread. The source is
 * the persisted thread overlay projected onto the navigation snapshot.
 */
export function useSubAgents(thread: NavigationThreadSummary): UseSubAgentsResult {
  const now = Date.now();
  return {
    subAgents: (thread.subAgents ?? [])
      .filter((subAgent) => isThreadSubAgentVisibleInPanel(subAgent, now))
      .sort((left, right) => right.createdAt - left.createdAt),
    loading: false,
    supported: true,
  };
}
