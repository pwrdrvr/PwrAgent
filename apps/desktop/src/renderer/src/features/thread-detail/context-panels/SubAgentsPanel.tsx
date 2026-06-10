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

/** Sub-Agents tab: durable task-monitor cards spawned from this thread. */
export function SubAgentsPanel(props: SubAgentsPanelProps) {
  const { subAgents, loading } = useSubAgents(props.thread);

  return (
    <section className="context-panel__section">
      <h3>Sub-agents</h3>
      {loading ? (
        <p className="context-empty">Loading sub-agents…</p>
      ) : subAgents.length > 0 ? (
        <ul className="context-list context-list--cards">
          {subAgents.map((subAgent) => (
            <li key={subAgent.monitorId} className="subagent-card">
              <div className="subagent-card__header">
                <div className="subagent-card__title-row">
                  <span
                    aria-hidden="true"
                    className={`subagent-card__dot subagent-card__dot--${statusTone(subAgent.status)}`}
                  />
                  <p className="context-list__label">{subAgent.task}</p>
                </div>
                <span
                  className={`subagent-card__status subagent-card__status--${statusTone(subAgent.status)}`}
                >
                  {statusLabel(subAgent.status)}
                </span>
              </div>
              <p className="context-list__meta">
                {subAgent.preferredModel ? `${subAgent.preferredModel} · ` : ""}
                {formatTimestamp(subAgent.createdAt)}
              </p>
              {subAgent.lastMessage ? (
                <p className="subagent-card__message">{subAgent.lastMessage}</p>
              ) : null}
              {subAgent.monitorUsage?.summary ? (
                <p className="subagent-card__usage">
                  Monitor usage: {subAgent.monitorUsage.summary}
                </p>
              ) : null}
              <button
                className="context-list__action"
                type="button"
                disabled
                title="Sub-agent history is not available yet."
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
