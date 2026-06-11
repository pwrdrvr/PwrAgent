import type {
  NavigationThreadSummary,
  ThreadSubAgentSummary,
} from "@pwragent/shared";

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
  return {
    subAgents: [...(thread.subAgents ?? [])].sort(
      (left, right) => right.createdAt - left.createdAt,
    ),
    loading: false,
    supported: true,
  };
}
