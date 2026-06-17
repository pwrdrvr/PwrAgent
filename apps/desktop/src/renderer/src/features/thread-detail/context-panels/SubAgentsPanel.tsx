import { useState } from "react";
import type {
  NavigationThreadSummary,
  ThreadSubAgentSummary,
} from "@pwragent/shared";
import { useSubAgents } from "./useSubAgents";
import { formatTimestamp } from "./context-rail-shared";
import { subAgentStatusLabel, subAgentTone } from "./subagent-format";
import { RailStatusChip } from "./RailStatusChip";
import { SubAgentDetailsModal } from "./SubAgentDetailsModal";

type SubAgentsPanelProps = {
  thread: NavigationThreadSummary;
};

/** Sub-Agents tab: durable task-monitor cards spawned from this thread. */
export function SubAgentsPanel(props: SubAgentsPanelProps) {
  const { subAgents, loading } = useSubAgents(props.thread);
  const [detailsFor, setDetailsFor] = useState<ThreadSubAgentSummary | null>(null);

  return (
    <section className="context-panel__section">
      <h3>Sub-agents</h3>
      {loading ? (
        <p className="context-empty">Loading sub-agents…</p>
      ) : subAgents.length > 0 ? (
        <ul className="context-list context-list--cards">
          {subAgents.map((subAgent) => {
            const tone = subAgentTone(subAgent.status);
            return (
              <li key={subAgent.monitorId} className="rail-card">
                {/* Status on its own line so it never competes with the
                    title for the top row (the title pushed it off before). */}
                <p className="rail-card__status-line">
                  <RailStatusChip tone={tone} alert={tone === "error"}>
                    {subAgentStatusLabel(subAgent.status)}
                  </RailStatusChip>
                </p>
                {subAgent.agentName ? (
                  <p className="rail-card__agent-name" title={subAgent.agentName}>
                    {subAgent.agentName}
                  </p>
                ) : null}
                <p className="rail-card__title" title={subAgent.task}>
                  {subAgent.task}
                </p>
                {subAgent.preferredModel ? (
                  <p className="rail-card__model">{subAgent.preferredModel}</p>
                ) : null}
                <p className="rail-card__times">
                  <span className="rail-card__time-label">Started</span>{" "}
                  {formatTimestamp(subAgent.createdAt)}
                  {subAgent.completedAt ? (
                    <>
                      {" · "}
                      <span className="rail-card__time-label">Ended</span>{" "}
                      {formatTimestamp(subAgent.completedAt)}
                    </>
                  ) : null}
                </p>
                {subAgent.lastMessage ? (
                  <p className="rail-card__message">{subAgent.lastMessage}</p>
                ) : null}
                {subAgent.monitorUsage?.summary ? (
                  <p className="rail-card__usage">
                    {subAgent.monitorId.startsWith("review:") ? "Review" : "Monitor"} usage:{" "}
                    {subAgent.monitorUsage.summary}
                  </p>
                ) : null}
                <button
                  className="context-list__action"
                  type="button"
                  onClick={() => setDetailsFor(subAgent)}
                >
                  Details
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="context-empty">
          No sub-agents yet. Delegated monitors, reviews, and observed native
          Codex sub-agents started from this thread will appear here.
        </p>
      )}
      {detailsFor ? (
        <SubAgentDetailsModal
          subAgent={detailsFor}
          onClose={() => setDetailsFor(null)}
        />
      ) : null}
    </section>
  );
}
