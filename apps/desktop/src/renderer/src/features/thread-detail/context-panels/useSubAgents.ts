import { useMemo } from "react";
import type { NavigationThreadSummary, ThreadSubAgentSummary } from "@pwragent/shared/contracts/navigation";
import { isThreadSubAgentVisibleInPanel } from "@pwragent/shared/subagent-visibility";

export type UseSubAgentsResult = {
  subAgents: ThreadSubAgentSummary[];
  loading: boolean;
  /** True when the running backend exposes the monitor surface. */
  supported: boolean;
};

/**
 * Lists sub-agents (task monitors and native harness workers) delegated from a
 * thread. The source is the persisted thread overlay projected onto the
 * navigation snapshot.
 */
export function useSubAgents(thread: NavigationThreadSummary): UseSubAgentsResult {
  const rawSubAgents = thread.subAgents;
  const subAgents = useMemo(() => {
    if (!rawSubAgents?.length) {
      return [];
    }
    const now = Date.now();
    return rawSubAgents
      .filter((subAgent) => isThreadSubAgentVisibleInPanel(subAgent, now))
      .sort((left, right) => right.createdAt - left.createdAt);
  }, [rawSubAgents]);
  return {
    subAgents,
    loading: false,
    supported: true,
  };
}
