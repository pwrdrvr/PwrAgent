import type { NavigationThreadSummary } from "@pwragent/shared";
import {
  useSubAgents,
  type SubAgentStatus,
  type SubAgentSummary,
} from "./useSubAgents";
import { formatTimestamp } from "./context-rail-shared";

type SubAgentsPanelProps = {
  thread: NavigationThreadSummary;
  /** Opens a sub-agent's monitor thread in the main view, when wired. */
  onViewSubAgent?: (subAgent: SubAgentSummary) => void;
};

/**
 * Sub-Agents tab — lists task-monitor delegations spawned from this
 * thread and offers to open each one's history. The data source is a
 * placeholder until `feat/subagent-task-monitoring` exposes monitors
 * over IPC; the layout + interactivity are built so that integration is
 * a one-line swap in {@link useSubAgents}.
 */
export function SubAgentsPanel(props: SubAgentsPanelProps) {
  const { subAgents, loading } = useSubAgents(props.thread);

  return (
    <section className="context-panel__section">
      <h3>Sub-agents</h3>
      {loading ? (
        <p className="context-empty">Loading sub-agents…</p>
      ) : subAgents.length > 0 ? (
        <ul className="context-list context-list--rows">
          {subAgents.map((subAgent) => (
            <li key={subAgent.monitorId} className="subagent-row">
              <div className="subagent-row__main">
                <span
                  aria-hidden="true"
                  className={`subagent-row__dot subagent-row__dot--${statusTone(subAgent.status)}`}
                />
                <div className="subagent-row__text">
                  <p className="context-list__label">{subAgent.task}</p>
                  <p className="context-list__meta">
                    {statusLabel(subAgent.status)}
                    {subAgent.preferredModel ? ` · ${subAgent.preferredModel}` : ""}
                    {" · "}
                    {formatTimestamp(subAgent.createdAt)}
                  </p>
                  {subAgent.lastMessage ? (
                    <p className="subagent-row__message">{subAgent.lastMessage}</p>
                  ) : null}
                </div>
              </div>
              <button
                className="context-list__action"
                type="button"
                disabled={!props.onViewSubAgent || !subAgent.monitorThreadId}
                onClick={() => props.onViewSubAgent?.(subAgent)}
              >
                History
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="context-empty">
          No sub-agents yet. Delegated task monitors started from this thread
          will appear here.
        </p>
      )}
    </section>
  );
}

function statusTone(status: SubAgentStatus): "active" | "done" | "warn" | "idle" {
  switch (status) {
    case "running":
      return "active";
    case "success":
      return "done";
    case "blocked":
    case "failed":
    case "failure":
    case "cancelled":
      return "warn";
    case "pending":
      return "idle";
  }
}

function statusLabel(status: SubAgentStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Failed";
    case "success":
      return "Completed";
    case "failure":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}
