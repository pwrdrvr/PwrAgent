import { useEffect, useState } from "react";
import type {
  NavigationThreadSummary,
  ThreadSubAgentSummary,
} from "@pwragent/shared";
import { formatBackendLabel } from "../../../lib/backend-label";
import { readRendererFederationTarget } from "../../../lib/federation-window";
import { useSubAgents } from "./useSubAgents";
import {
  formatSubAgentUsageSummary,
  isTerminalSubAgent,
  type PricingDisplayOptions,
  subAgentCompletedAt,
  subAgentStatusLabel,
  subAgentTone,
} from "./subagent-format";
import { RailStatusChip } from "./RailStatusChip";
import { RailCardTiming, useNowWhileActive } from "./RailCardTiming";
import { SubAgentDetailsModal } from "./SubAgentDetailsModal";
import {
  type SubAgentLens,
  subAgentLens,
  subAgentOriginSentence,
  subAgentUsageLabel,
} from "./subagent-kind";
import type { DesktopApi } from "../../../lib/desktop-api";
import { TokenMiserSavingsBreakdown } from "./TokenMiserSavingsBreakdown";

type SubAgentsPanelProps = {
  desktopApi?: DesktopApi;
  onDetailsModalOpenChange?: (open: boolean) => void;
  onRefreshNavigation?: () => Promise<void>;
  pricingDisplayOptions?: PricingDisplayOptions;
  thread: NavigationThreadSummary;
};

const SUB_AGENT_LENSES: Array<{
  id: SubAgentLens;
  label: string;
}> = [
  { id: "harness", label: "Harness" },
  { id: "token-miser", label: "Token Miser" },
  { id: "pwragent", label: "PwrAgent" },
];

/** Sub-Agents tab: durable task-monitor cards spawned from this thread. */
export function SubAgentsPanel(props: SubAgentsPanelProps) {
  const { subAgents, loading } = useSubAgents(props.thread);
  const { onDetailsModalOpenChange } = props;
  const [requestedLens, setRequestedLens] = useState<SubAgentLens>("harness");
  const lensCounts = SUB_AGENT_LENSES.reduce<Record<SubAgentLens, number>>(
    (counts, lens) => ({
      ...counts,
      [lens.id]: subAgents.filter(
        (subAgent) => subAgentLens(subAgent) === lens.id,
      ).length,
    }),
    {
      harness: 0,
      "token-miser": 0,
      pwragent: 0,
    },
  );
  const availableLenses = SUB_AGENT_LENSES.filter(
    (lens) => lensCounts[lens.id] > 0,
  );
  const preferredLens =
    availableLenses.find((lens) => lens.id === "harness")?.id
    ?? availableLenses.find((lens) => lens.id === "pwragent")?.id
    ?? availableLenses[0]?.id
    ?? "harness";
  const activeLens = lensCounts[requestedLens] > 0
    ? requestedLens
    : preferredLens;
  const visibleSubAgents = subAgents.filter(
    (subAgent) => subAgentLens(subAgent) === activeLens,
  );
  // Track the open dialog by id, not by the summary object: the snapshot the
  // Details button was clicked with goes stale the moment the sub-agent
  // streams another update, and the dialog would sit on frozen status, timing,
  // and usage until it was closed and reopened.
  const [detailsForId, setDetailsForId] = useState<string | null>(null);
  const detailsFor =
    subAgents.find((subAgent) => subAgent.monitorId === detailsForId) ?? null;
  const hasRunningSubAgent = subAgents.some(
    (subAgent) => !isTerminalSubAgent(subAgent),
  );
  const now = useNowWhileActive(hasRunningSubAgent);
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(() => new Set());
  const [stopErrors, setStopErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    return () => onDetailsModalOpenChange?.(false);
  }, [onDetailsModalOpenChange]);

  // The tracked sub-agent can leave the list under us (thread switch, overlay
  // rewrite). Release the rail's pinned-open state rather than stranding it.
  const detailsMissing = detailsForId !== null && detailsFor === null;
  useEffect(() => {
    if (!detailsMissing) {
      return;
    }
    setDetailsForId(null);
    onDetailsModalOpenChange?.(false);
  }, [detailsMissing, onDetailsModalOpenChange]);

  const openDetails = (subAgent: ThreadSubAgentSummary): void => {
    onDetailsModalOpenChange?.(true);
    setDetailsForId(subAgent.monitorId);
  };

  const closeDetails = (): void => {
    setDetailsForId(null);
    onDetailsModalOpenChange?.(false);
  };

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
        ...(props.thread.federation?.ref.target
          ? { federationTarget: props.thread.federation.ref.target }
          : {}),
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
        <>
          {availableLenses.length > 1 ? (
            <div
              aria-label="Sub-agent ownership"
              className="subagent-lens-switch"
              role="tablist"
            >
              {availableLenses.map((lens) => (
                <button
                  aria-label={`${lens.label} ${lensCounts[lens.id]}`}
                  aria-controls="subagent-lens-panel"
                  aria-selected={activeLens === lens.id}
                  className="subagent-lens-switch__button"
                  id={`subagent-lens-${lens.id}`}
                  key={lens.id}
                  role="tab"
                  type="button"
                  onClick={() => setRequestedLens(lens.id)}
                >
                  <span>{lens.label}</span>
                  <span className="subagent-lens-switch__count">
                    {lensCounts[lens.id]}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          <ul
            aria-labelledby={
              availableLenses.length > 1
                ? `subagent-lens-${activeLens}`
                : undefined
            }
            className="context-list context-list--cards"
            id="subagent-lens-panel"
            role={availableLenses.length > 1 ? "tabpanel" : undefined}
          >
          {visibleSubAgents.map((subAgent) => {
            const tone = subAgentTone(subAgent.status);
            const originSentence = subAgentOriginSentence(subAgent);
            const backend = subAgent.backend ?? props.thread.source;
            const running = !isTerminalSubAgent(subAgent);
            const model =
              subAgent.preferredModel
              ?? subAgent.monitorUsage?.model
              ?? subAgent.monitorUsage?.cost?.model;
            const runtimeDetails = [
              model,
              subAgent.preferredReasoningEffort,
              subAgent.preferredFastMode ? "Fast" : undefined,
            ].filter((value): value is string => Boolean(value));
            const latestMessage =
              subAgent.lastMessage && subAgent.lastMessage !== originSentence
                ? subAgent.lastMessage
                : undefined;
            const stopping = stoppingIds.has(subAgent.monitorId);
            const canStop =
              (subAgent.status === "pending"
                || subAgent.status === "running"
                || subAgent.status === "blocked")
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
                  {runtimeDetails.length > 0 ? (
                    <span className="rail-card__model">
                      {runtimeDetails.join(" · ")}
                    </span>
                  ) : null}
                </p>
                <RailCardTiming
                  completedAt={subAgentCompletedAt(subAgent)}
                  now={now}
                  running={running}
                  startedAt={subAgent.createdAt}
                />
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
                {subAgent.tokenMiserAccounting ? (
                  <TokenMiserSavingsBreakdown
                    accounting={subAgent.tokenMiserAccounting}
                  />
                ) : null}
                <div className="context-list__actions rail-card__actions">
                  <button
                    className="context-list__action rail-card__details-action"
                    type="button"
                    onClick={() => openDetails(subAgent)}
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
        </>
      ) : (
        <p className="context-empty">
          No sub-agents yet. Delegated monitors, reviews, and observed native
          Codex sub-agents started from this thread will appear here.
        </p>
      )}
      {detailsFor ? (
        <SubAgentDetailsModal
          defaultBackend={props.thread.source}
          federationTarget={
            props.thread.federation?.ref.target
            ?? readRendererFederationTarget()
          }
          parentThreadId={props.thread.id}
          pricingDisplayOptions={props.pricingDisplayOptions}
          subAgent={detailsFor}
          onClose={closeDetails}
        />
      ) : null}
    </section>
  );
}
