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
import {
  subAgentOriginSentence,
  subAgentUsageLabel,
} from "./subagent-kind";
import type { DesktopApi } from "../../../lib/desktop-api";

type SubAgentsPanelProps = {
  desktopApi?: DesktopApi;
  onRefreshNavigation?: () => Promise<void>;
  pricingDisplayOptions?: PricingDisplayOptions;
  thread: NavigationThreadSummary;
};

/** Sub-Agents tab: durable task-monitor cards spawned from this thread. */
export function SubAgentsPanel(props: SubAgentsPanelProps) {
  const { subAgents, loading } = useSubAgents(props.thread);
  const [detailsFor, setDetailsFor] = useState<ThreadSubAgentSummary | null>(null);
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(() => new Set());
  const [stopErrors, setStopErrors] = useState<Record<string, string>>({});

  const stopSubAgent = async (subAgent: ThreadSubAgentSummary): Promise<void> => {
    if (!props.desktopApi?.stopSubAgent) {
      return;
    }
    setStopErrors((current) => {
      const next = { ...current };
      delete next[subAgent.monitorId];
      return next;
    });
    setStoppingIds((current) => new Set(current).add(subAgent.monitorId));
    try {
      await props.desktopApi.stopSubAgent({
        backend: props.thread.source,
        threadId: props.thread.id,
        monitorId: subAgent.monitorId,
      });
      await props.onRefreshNavigation?.();
    } catch (error) {
      setStopErrors((current) => ({
        ...current,
        [subAgent.monitorId]:
          error instanceof Error ? error.message : "Could not stop sub-agent.",
      }));
    } finally {
      setStoppingIds((current) => {
        const next = new Set(current);
        next.delete(subAgent.monitorId);
        return next;
      });
    }
  };

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
            const stopping = stoppingIds.has(subAgent.monitorId);
            const canStop =
              (subAgent.status === "running" || subAgent.status === "blocked")
              && Boolean(subAgent.monitorThreadId)
              && Boolean(subAgent.monitorTurnId)
              && Boolean(props.desktopApi?.stopSubAgent);
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
                <div className="context-list__actions rail-card__actions">
                  <button
                    className="context-list__action rail-card__details-action"
                    type="button"
                    onClick={() => setDetailsFor(subAgent)}
                  >
                    Details
                  </button>
                  {canStop ? (
                    <button
                      className="context-list__action context-list__action--danger"
                      type="button"
                      disabled={stopping}
                      onClick={() => void stopSubAgent(subAgent)}
                    >
                      {stopping ? "Stopping…" : "Stop"}
                    </button>
                  ) : null}
                </div>
                {stopErrors[subAgent.monitorId] ? (
                  <p className="rail-card__error" role="alert">
                    {stopErrors[subAgent.monitorId]}
                  </p>
                ) : null}
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
          defaultBackend={props.thread.source}
          pricingDisplayOptions={props.pricingDisplayOptions}
          subAgent={detailsFor}
          onClose={() => setDetailsFor(null)}
        />
      ) : null}
    </section>
  );
}
