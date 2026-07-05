import { useState } from "react";
import type {
  NavigationThreadSummary,
  ThreadSubAgentSummary,
} from "@pwragent/shared";
import { formatBackendLabel } from "../../../lib/backend-label";
import { useSubAgents } from "./useSubAgents";
import { formatTimestamp } from "./context-rail-shared";
import {
  formatSubAgentUsageSummary,
  type PricingDisplayOptions,
  subAgentStatusLabel,
  subAgentTone,
} from "./subagent-format";
import { RailStatusChip } from "./RailStatusChip";
import { SubAgentDetailsModal } from "./SubAgentDetailsModal";
import { subAgentOriginSentence, subAgentUsageLabel } from "./subagent-kind";

type SubAgentsPanelProps = {
  pricingDisplayOptions?: PricingDisplayOptions;
  thread: NavigationThreadSummary;
};

/** Sub-Agents tab: durable task-monitor cards spawned from this thread. */
export function SubAgentsPanel(props: SubAgentsPanelProps) {
  const { subAgents, loading } = useSubAgents(props.thread);
  const [detailsFor, setDetailsFor] = useState<ThreadSubAgentSummary | null>(
    null,
  );

  return (
    <section className="context-panel__section">
      <h3>Sub-agents</h3>
      {loading ? (
        <p className="context-empty">Loading sub-agents…</p>
      ) : subAgents.length > 0 ? (
        <ul className="context-list context-list--cards">
          {subAgents.map((subAgent) => {
            const tone = subAgentTone(subAgent.status);
            const originSentence = subAgentOriginSentence(subAgent);
            const backend = subAgent.backend ?? props.thread.source;
            const latestMessage =
              subAgent.lastMessage && subAgent.lastMessage !== originSentence
                ? subAgent.lastMessage
                : undefined;
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
                  <p
                    className="rail-card__agent-name"
                    title={subAgent.agentName}
                  >
                    {subAgent.agentName}
                  </p>
                ) : null}
                <p className="rail-card__title" title={subAgent.task}>
                  {subAgent.task}
                </p>
                <p className="rail-card__runtime">
                  <span className="rail-card__provider-chip">
                    {formatBackendLabel(backend)}
                  </span>
                  {subAgent.preferredModel ? (
                    <span className="rail-card__model">
                      {subAgent.preferredModel}
                    </span>
                  ) : null}
                </p>
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
                {originSentence ? (
                  <p className="rail-card__message">{originSentence}</p>
                ) : null}
                {latestMessage ? (
                  <p className="rail-card__message">{latestMessage}</p>
                ) : null}
                {subAgent.monitorUsage?.summary ? (
                  <p className="rail-card__usage">
                    {subAgentUsageLabel(subAgent)} usage:{" "}
                    {formatSubAgentUsageSummary({
                      displayOptions: props.pricingDisplayOptions,
                      model: subAgent.preferredModel,
                      usage: subAgent.monitorUsage,
                    })}
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
          pricingDisplayOptions={props.pricingDisplayOptions}
          subAgent={detailsFor}
          onClose={() => setDetailsFor(null)}
        />
      ) : null}
    </section>
  );
}
