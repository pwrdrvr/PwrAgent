import { useEffect, useState } from "react";
import type {
  DecisionsRailBatch,
  DecisionsRailDecision,
  DecisionsRailSnapshot,
} from "@pwragent/shared";
import { SignalCount } from "../../../components/SignalCount";
import { BanIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon } from "../../../icons";
import type { DesktopApi } from "../../../lib/desktop-api";
import { DecisionBatchDetailsModal } from "./DecisionBatchDetailsModal";
import {
  decisionBatchCountsLabel,
  decisionBatchStatusLabel,
  decisionBatchTimingLine,
  decisionBatchTone,
  decisionInputSchemaSummary,
  decisionProviderLabel,
  decisionProviderSettingsName,
  decisionQuestionKind,
  decisionSummaryLine,
  isDecisionBatchRunning,
} from "./decisions-format";
import { RailStatusChip } from "./RailStatusChip";
import "./decisions-panel.css";

type DecisionsPanelProps = {
  desktopApi?: Pick<DesktopApi, "readDecisionsRailBatch" | "actOnDecisionsRailBatch" | "openDecisionsRailResults">;
  thread: { backend: string; threadId: string };
  snapshot?: DecisionsRailSnapshot;
  error: boolean;
  onRefresh: () => void;
  /** Keeps the hover rail open while the batch dialog is up. */
  onDetailsModalOpenChange?: (open: boolean) => void;
};

/**
 * The Decisions tab: what decisions this thread can run, and the batches
 * it ran, newest first. A batch opens a dialog with its items. Registered
 * decisions and batches both come from the owner; the tab writes nothing.
 */
export function DecisionsPanel(props: DecisionsPanelProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [detailsFor, setDetailsFor] = useState<string>();
  const [acting, setActing] = useState<ReadonlySet<string>>(() => new Set());
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const snapshot = props.snapshot;
  const now = snapshot?.now ?? Date.now();
  const detailsBatch = detailsFor ? snapshot?.batches.find((batch) => batch.batchId === detailsFor) : undefined;
  const onDetailsModalOpenChange = props.onDetailsModalOpenChange;

  useEffect(() => {
    return () => onDetailsModalOpenChange?.(false);
  }, [onDetailsModalOpenChange]);

  // The open batch can leave the snapshot under the dialog (a thread
  // switch, the tab hiding). Release the rail's pinned-open state rather
  // than stranding it.
  const detailsMissing = detailsFor !== undefined && detailsBatch === undefined;
  useEffect(() => {
    if (!detailsMissing) return;
    setDetailsFor(undefined);
    onDetailsModalOpenChange?.(false);
  }, [detailsMissing, onDetailsModalOpenChange]);

  const toggle = (decisionId: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(decisionId)) next.delete(decisionId);
      else next.add(decisionId);
      return next;
    });
  };
  const openDetails = (batchId: string): void => {
    setDetailsFor(batchId);
    onDetailsModalOpenChange?.(true);
  };
  const closeDetails = (): void => {
    setDetailsFor(undefined);
    onDetailsModalOpenChange?.(false);
  };
  const stop = async (batch: DecisionsRailBatch): Promise<void> => {
    const act = props.desktopApi?.actOnDecisionsRailBatch;
    if (!act) return;
    setActing((current) => new Set(current).add(batch.batchId));
    setActionErrors(({ [batch.batchId]: _cleared, ...rest }) => rest);
    try {
      await act({ ...props.thread, batchId: batch.batchId, action: "stop" });
    } catch (error) {
      setActionErrors((current) => ({
        ...current,
        [batch.batchId]: error instanceof Error ? error.message : "Could not stop the batch.",
      }));
    } finally {
      setActing((current) => {
        const next = new Set(current);
        next.delete(batch.batchId);
        return next;
      });
      props.onRefresh();
    }
  };

  if (!snapshot) {
    return (
      <section className="context-panel__section decisions-panel">
        <h3>Decisions</h3>
        <p className={`context-empty${props.error ? " context-empty--error" : ""}`}>
          {props.error ? "Couldn't read this thread's decisions." : "Loading decisions…"}
        </p>
      </section>
    );
  }

  return (
    <section className="context-panel__section decisions-panel">
      {props.error ? (
        <p className="context-empty context-empty--error decisions-panel__stale" role="status">
          Couldn't refresh. Showing the last read.
        </p>
      ) : null}
      <div className="decisions-panel__group">
        <h3 className="decisions-panel__heading">
          Registered{" "}
          <span className="decisions-panel__count">{snapshot.decisions.length}</span>
        </h3>
        {snapshot.decisions.length > 0 ? (
          <ul className="decisions-panel__decisions">
            {snapshot.decisions.map((decision) => (
              <DecisionRow
                key={decision.decisionId}
                decision={decision}
                expanded={expanded.has(decision.decisionId)}
                onToggle={() => toggle(decision.decisionId)}
              />
            ))}
          </ul>
        ) : (
          <p className="decisions-panel__empty">
            No decisions are visible to this thread. Agents register them with{" "}
            <code>decisions_register</code>.
          </p>
        )}
      </div>
      <div className="decisions-panel__group">
        <h3 className="decisions-panel__heading">
          Batches{" "}
          <span className="decisions-panel__count">{snapshot.batches.length}</span>
        </h3>
        {snapshot.batches.length > 0 ? (
          <ul className="context-list context-list--cards decisions-panel__batches">
            {snapshot.batches.map((batch) => (
              <BatchCard
                key={batch.batchId}
                batch={batch}
                now={now}
                stopping={acting.has(batch.batchId)}
                canStop={Boolean(props.desktopApi?.actOnDecisionsRailBatch)}
                error={actionErrors[batch.batchId]}
                onDetails={() => openDetails(batch.batchId)}
                onStop={() => void stop(batch)}
              />
            ))}
          </ul>
        ) : (
          <p className="decisions-panel__empty">This thread has not run a decision batch.</p>
        )}
      </div>
      {detailsBatch ? (
        <DecisionBatchDetailsModal
          batch={detailsBatch}
          desktopApi={props.desktopApi}
          now={now}
          thread={props.thread}
          onChanged={props.onRefresh}
          onClose={closeDetails}
        />
      ) : null}
    </section>
  );
}

function DecisionRow(props: { decision: DecisionsRailDecision; expanded: boolean; onToggle: () => void }) {
  const { decision } = props;
  const detailsId = `decision-details-${decision.decisionId}`;
  const Chevron = props.expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <li className="decisions-panel__decision">
      <button
        type="button"
        className="decisions-panel__decision-toggle"
        aria-expanded={props.expanded}
        aria-controls={detailsId}
        onClick={props.onToggle}
      >
        <Chevron size={14} aria-hidden="true" className="decisions-panel__chevron" />
        <span className="decisions-panel__decision-name">{decision.name}</span>
        <span className="decisions-panel__decision-meta">
          <span
            className={`rail-card__provider-chip decisions-panel__provider${
              decision.providerDisabled ? " decisions-panel__provider--off" : ""
            }`}
          >
            {decisionProviderLabel(decision.provider)}
            {decision.providerDisabled ? " · off" : ""}
          </span>
          <span className="decisions-panel__tag">v{decision.version}</span>
          <span className="decisions-panel__tag">{decision.scope}</span>
        </span>
      </button>
      <p className="decisions-panel__summary">{decisionSummaryLine(decision)}</p>
      {props.expanded ? (
        <div className="decisions-panel__decision-details" id={detailsId}>
          {decision.providerDisabled ? (
            <p className="decisions-panel__off-note">
              {decisionProviderSettingsName(decision.provider)} is turned off in Settings → AI Providers.
              Agents can't run this decision until it is on.
            </p>
          ) : null}
          <dl className="decisions-panel__questions">
            {decision.questions.map((question, index) => (
              <div key={`${question.name ?? question.type}:${index}`}>
                <dt>{question.name ?? `Question ${index + 1}`}</dt>
                <dd>{decisionQuestionKind(question)}</dd>
              </div>
            ))}
            <div>
              <dt>input</dt>
              <dd className="decisions-panel__schema">{decisionInputSchemaSummary(decision.inputSchema)}</dd>
            </div>
          </dl>
        </div>
      ) : null}
    </li>
  );
}

function BatchCard(props: {
  batch: DecisionsRailBatch;
  now: number;
  stopping: boolean;
  canStop: boolean;
  error?: string;
  onDetails: () => void;
  onStop: () => void;
}) {
  const { batch } = props;
  const running = isDecisionBatchRunning(batch);
  const tone = decisionBatchTone(batch);
  return (
    <li className="rail-card decisions-batch">
      <p className="rail-card__status-line">
        <RailStatusChip tone={tone} alert={tone === "error"} blink={running && !batch.stopping}>
          {decisionBatchStatusLabel(batch)}
        </RailStatusChip>
        {batch.background ? <span className="decisions-panel__tag">background</span> : null}
      </p>
      <p className="rail-card__title decisions-batch__title">
        <span>{batch.name}</span>
        <span className="decisions-panel__tag">v{batch.version}</span>
        <span className="rail-card__provider-chip">{decisionProviderLabel(batch.provider)}</span>
      </p>
      <p className="decisions-batch__counts">
        <span className="decisions-panel__sr">
          {`${batch.finished} of ${batch.count} items done: ${decisionBatchCountsLabel(batch)}`}
        </span>
        <span className="decisions-batch__progress" aria-hidden="true">
          {batch.finished}/{batch.count}
        </span>
        <SignalCount ariaHidden count={batch.succeeded} tone="idle" indicator={<CheckIcon size={12} />} />
        <SignalCount ariaHidden count={batch.failed} tone="idle" indicator={<CloseIcon size={12} />} />
        <SignalCount ariaHidden count={batch.skipped} tone="idle" indicator={<BanIcon size={12} />} />
      </p>
      <p className="rail-card__message decisions-batch__timing">{decisionBatchTimingLine(batch, props.now)}</p>
      <div className="context-list__actions rail-card__actions">
        <button className="context-list__action rail-card__details-action" type="button" onClick={props.onDetails}>
          Details
        </button>
        {running && props.canStop ? (
          <button
            className="context-list__action context-list__action--danger"
            type="button"
            disabled={props.stopping || batch.stopping}
            onClick={props.onStop}
          >
            {props.stopping || batch.stopping ? "Stopping…" : "Stop"}
          </button>
        ) : null}
      </div>
      {props.error ? <p className="rail-card__error" role="alert">{props.error}</p> : null}
    </li>
  );
}
