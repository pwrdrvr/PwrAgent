import { useEffect, useState } from "react";
import type {
  DecisionsRailBatch,
  DecisionsRailDecision,
  DecisionsRailSnapshot,
} from "@pwragent/shared/decisions-rail";
import type { DecisionProvidersReadiness } from "@pwragent/shared/decision-models";
import { SignalCount } from "../../../components/SignalCount";
import { BanIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon } from "../../../icons";
import { copyText } from "../../../lib/copy-text";
import type { DesktopApi } from "../../../lib/desktop-api";
import { DecisionBatchDetailsModal } from "./DecisionBatchDetailsModal";
import { BatchTitle } from "./DecisionBatchTitle";
import { DecisionsSetupDialog, ReadinessPill } from "./DecisionsSetupDialog";
import { decisionSetupReadiness, type DecisionSetupSettings } from "./decision-setup";
import {
  decisionBatchAsksLine,
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

export type { DecisionSetupSettings } from "./decision-setup";

type DecisionsPanelProps = {
  desktopApi?: DesktopApi;
  thread: { backend: string; threadId: string };
  snapshot?: DecisionsRailSnapshot;
  error: boolean;
  onRefresh: () => void;
  /** The profile's Settings: which providers are ready, and where keys are saved. */
  settings?: DecisionSetupSettings;
  /** Opens Settings → AI Providers, at a decision provider's screen when one is named. */
  onOpenSettings?: (focus?: string) => void;
  /** Keeps the hover rail open while the batch dialog or setup dialog is up. */
  onDetailsModalOpenChange?: (open: boolean) => void;
};

/** What the tab suggests asking once a provider is ready. */
const TRY_PROMPT = "Use a decision model to sort the open issues in this repository into bug, feature, or question, and show me the ones it was least sure about.";

/**
 * The Decisions tab: what decisions this thread can run, and the batches
 * it ran, newest first. A batch opens a dialog with its items. Registered
 * decisions and batches both come from the owner. A thread that has not
 * used decisions gets a short pitch instead, with each provider's status
 * and a setup dialog, so the tab is where the operator finds the feature.
 */
export function DecisionsPanel(props: DecisionsPanelProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [detailsFor, setDetailsFor] = useState<string>();
  const [acting, setActing] = useState<ReadonlySet<string>>(() => new Set());
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [setupOpen, setSetupOpen] = useState(false);
  const snapshot = props.snapshot;
  const readiness = decisionSetupReadiness(props.settings?.snapshot);
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
  const openSetup = (): void => {
    setSetupOpen(true);
    onDetailsModalOpenChange?.(true);
  };
  const closeSetup = (): void => {
    setSetupOpen(false);
    onDetailsModalOpenChange?.(false);
  };
  const setupDialog = setupOpen && props.settings ? (
    <DecisionsSetupDialog
      settings={props.settings}
      desktopApi={props.desktopApi}
      onOpenSettings={props.onOpenSettings}
      onClose={closeSetup}
    />
  ) : null;
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
        {/* Setup is about the profile, not this thread: it stays open across a reload. */}
        {setupDialog}
      </section>
    );
  }

  const unused = snapshot.decisions.length === 0 && snapshot.batches.length === 0;
  const anyReady = readiness?.providers.some((entry) => entry.ready) ?? false;
  // Nothing to show and nothing set up: the tab is the feature's front door.
  if (unused && readiness && !anyReady) {
    return (
      <section className="context-panel__section decisions-panel">
        {props.error ? (
          <p className="context-empty context-empty--error decisions-panel__stale" role="status">
            Couldn't refresh. Showing the last read.
          </p>
        ) : null}
        <DecisionsPitch readiness={readiness} canSetUp={Boolean(props.settings)} onSetUp={openSetup} />
        {setupDialog}
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
      <div className="decisions-panel__head">
        <h3>Decisions</h3>
        {props.settings ? (
          <button type="button" className="context-list__action decisions-panel__providers" onClick={openSetup}>
            Providers
          </button>
        ) : null}
      </div>
      {unused && readiness ? <TryCard readiness={readiness} desktopApi={props.desktopApi} /> : null}
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
            None saved. Agents save a decision with <code>decisions_register</code> to run it
            again; a one-off question runs ad hoc.
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
      {setupDialog}
    </section>
  );
}

/** The tab before decisions are set up: what they are, what they are for, and each provider's status. */
function DecisionsPitch(props: { readiness: DecisionProvidersReadiness; canSetUp: boolean; onSetUp: () => void }) {
  return (
    <div className="decisions-pitch">
      <p className="decisions-pitch__eyebrow">Decisions</p>
      <h3 className="decisions-pitch__title">Ask one typed question of hundreds of items, in seconds</h3>
      <p className="decisions-pitch__body">
        A decision model answers yes/no, pick-one, or score questions with a probability for every
        answer. It writes no text, so it is fast and cheap. Agents use it to sort, filter, and grade
        in bulk, and you review the results here.
      </p>
      <ol className="decisions-pitch__uses">
        <li><strong>Triage</strong> 300 issues into bug, feature, or question.</li>
        <li><strong>Compare</strong> two captions per screenshot and pick the better one.</li>
        <li><strong>Screen</strong> search results for relevance before reading them.</li>
      </ol>
      <h3 className="decisions-panel__heading">Providers</h3>
      <ul className="decisions-pitch__providers">
        {props.readiness.providers.map((entry) => (
          <li key={entry.provider}>
            <span>{decisionProviderSettingsName(entry.provider)}</span>
            <ReadinessPill entry={entry} />
          </li>
        ))}
      </ul>
      {props.canSetUp ? (
        <button type="button" className="button button--primary decisions-pitch__setup" onClick={props.onSetUp}>
          Set up decisions
        </button>
      ) : null}
    </div>
  );
}

/** Once a provider is ready and the thread has not used it: one thing to ask, ready to copy. */
function TryCard(props: { readiness: DecisionProvidersReadiness; desktopApi?: DesktopApi }) {
  const [copied, setCopied] = useState(false);
  const provider = props.readiness.providers.find((entry) => entry.provider === props.readiness.defaultProvider);
  if (!provider?.ready) return null;
  return (
    <div className="decisions-try">
      <p className="decisions-try__label">
        {decisionProviderSettingsName(provider.provider)} is ready. Try asking:
      </p>
      <p className="decisions-try__prompt">{TRY_PROMPT}</p>
      <button
        type="button"
        className="context-list__action decisions-try__copy"
        onClick={() => {
          void copyText(TRY_PROMPT, props.desktopApi).then(() => setCopied(true), () => setCopied(false));
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
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
      <BatchTitle batch={batch} className="rail-card__title decisions-batch__title" />
      {decisionBatchAsksLine(batch) ? <p className="decisions-batch__asks">{decisionBatchAsksLine(batch)}</p> : null}
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
          Review
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
