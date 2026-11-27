import { Fragment, useMemo, useState } from "react";
import {
  decisionRunProviderName,
  readyDecisionProviders,
  type DecisionProvidersReadiness,
} from "@pwragent/shared/decision-models";
import type {
  DecisionsRailBatchActionRequest,
  DecisionsRailBatchRequest,
  DecisionsRailDecision,
  DecisionsRailOpenResultsRequest,
} from "@pwragent/shared/decisions-rail";
import {
  extractDecisionBatchIds,
  type ResearchDecisionBatchSummary,
  type ResearchDecisionsSnapshot,
  type ResearchThread,
} from "@pwragent/shared/research";
import type { DesktopApi } from "../../lib/desktop-api";
import { DecisionBatchDetailsModal } from "../thread-detail/context-panels/DecisionBatchDetailsModal";
import {
  decisionBatchAsksLine,
  decisionBatchStatusLabel,
  decisionBatchTimingLine,
  decisionBatchTone,
  decisionInputSchemaSummary,
  decisionProviderLabel,
  decisionProviderSettingsName,
  decisionQuestionKind,
  decisionSummaryLine,
  isDecisionBatchRunning,
} from "../thread-detail/context-panels/decisions-format";
import { ResearchThreadButton } from "./ResearchThreadButton";
import { approachTitle, excerpt, plural, type ResearchRunView } from "./research-view-model";

/**
 * Compact provider readiness strip shown in ResearchStartForm and the
 * Research Decisions tab. Never displays raw secrets or placeholder text.
 */
export function ResearchDecisionsReadinessBanner({
  readiness,
  onOpenSettings,
  compact = false,
}: {
  readiness?: DecisionProvidersReadiness;
  onOpenSettings?: (focus?: string) => void;
  compact?: boolean;
}) {
  if (!readiness) return null;
  const ready = readyDecisionProviders(readiness);
  const anyReady = ready.length > 0;
  return (
    <div className="research-decisions-readiness" aria-label="Decision models readiness">
      <div className="research-decisions-readiness__top">
        <span className={`research-chip${anyReady ? " research-chip--done" : ""}`}>
          {anyReady ? "Decisions ready" : "Decisions not configured"}
        </span>
        {onOpenSettings && (
          <button
            type="button"
            className="research-link"
            onClick={() => onOpenSettings("openai-decisions")}
          >
            {anyReady ? "Configure" : "Set up Decisions"}
          </button>
        )}
      </div>
      <p className="research-muted">
        {anyReady
          ? compact
            ? `${ready.map(decisionRunProviderName).join(" · ")}`
            : `${ready.map(decisionRunProviderName).join(", ")}. Coordinator and workers can share run-scoped rubrics and run batch evaluations.`
          : "Configure OpenAI Decisions, TypeSafe Jev, or local Clef to let research workers score and triage candidates in batch."}
      </p>
    </div>
  );
}

/**
 * Clickable chips linking a finding or submission to decision batch evidence
 * cited in its text or evidence paths.
 */
export function ResearchDecisionEvidenceList({
  text,
  paths,
  batchesById,
  onOpenBatch,
}: {
  text: string;
  paths: readonly string[];
  batchesById?: ReadonlyMap<string, ResearchDecisionBatchSummary>;
  onOpenBatch?: (batchId: string) => void;
}) {
  const batchIds = useMemo(() => extractDecisionBatchIds(text, paths), [text, paths]);
  if (batchIds.length === 0) return null;
  return (
    <ul className="research-evidence-list" aria-label="Decision batch evidence">
      {batchIds.map((batchId) => {
        const batch = batchesById?.get(batchId);
        const label = batch
          ? `${batch.adHoc ? "Ad hoc decision" : `${batch.name} v${batch.version}`} · ${batch.succeeded}/${batch.count} (${batchId})`
          : batchId;
        return (
          <li key={batchId}>
            {batch && onOpenBatch ? (
              <button
                type="button"
                className="research-evidence"
                onClick={() => onOpenBatch(batchId)}
              >
                Decision batch: {label}
              </button>
            ) : (
              <span className="research-muted">
                Decision batch: <code className="research-code">{batchId}</code>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The Decisions tab inside ResearchPanel and ResearchWindow: provider
 * readiness, run-scoped registered decisions, and every decision batch run
 * across the coordinator and all workers of the run.
 */
export function ResearchDecisionsView({
  api,
  thread,
  run,
  snapshot,
  readiness,
  error,
  onRefresh,
  onOpenItem,
  onOpenDecisionSettings,
  selectedBatchId,
  onSelectBatchId,
}: {
  api: DesktopApi;
  thread: ResearchThread;
  run: ResearchRunView;
  snapshot?: ResearchDecisionsSnapshot;
  readiness?: DecisionProvidersReadiness;
  error: boolean;
  onRefresh: () => void;
  onOpenItem: (itemId: string) => void;
  onOpenDecisionSettings?: (focus?: string) => void;
  selectedBatchId?: string;
  onSelectBatchId: (batchId?: string) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [acting, setActing] = useState<ReadonlySet<string>>(() => new Set());
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const effectiveReadiness = snapshot?.readiness ?? readiness;
  const now = snapshot?.now ?? Date.now();
  const decisions = snapshot?.decisions ?? [];
  const batches = snapshot?.batches ?? [];
  const activeBatch = selectedBatchId
    ? batches.find((entry) => entry.batchId === selectedBatchId)
    : undefined;

  /** Map each batchId to the findings and submissions in this run that cite it. */
  const citationsByBatch = useMemo(() => {
    const map = new Map<string, Array<{ id: string; label: string }>>();
    for (const item of run.items.values()) {
      if (item.type === "approach") continue;
      const ids = extractDecisionBatchIds(item.record.text, item.record.paths);
      for (const batchId of ids) {
        const list = map.get(batchId) ?? [];
        const label = item.type === "finding"
          ? `${approachTitle(run, item.approachId)}: ${excerpt(item.record.text, 50)}`
          : `Candidate (${approachTitle(run, item.approachId)}): ${excerpt(item.record.text, 50)}`;
        list.push({ id: item.id, label });
        map.set(batchId, list);
      }
    }
    return map;
  }, [run]);

  const modalApi = useMemo(() => ({
    ...(api.readResearchDecisionBatch
      ? {
          readDecisionsRailBatch: (request: DecisionsRailBatchRequest) =>
            api.readResearchDecisionBatch!({
              backend: thread.backend,
              threadId: thread.threadId,
              runId: run.id,
              batchId: request.batchId,
              status: request.status,
              from: request.from,
              limit: request.limit,
            }),
        }
      : {}),
    ...(api.actOnResearchDecisionBatch
      ? {
          actOnDecisionsRailBatch: (request: DecisionsRailBatchActionRequest) =>
            api.actOnResearchDecisionBatch!({
              backend: thread.backend,
              threadId: thread.threadId,
              runId: run.id,
              batchId: request.batchId,
              action: request.action,
            }),
        }
      : {}),
    ...(api.openResearchDecisionResults
      ? {
          openDecisionsRailResults: (request: DecisionsRailOpenResultsRequest) =>
            api.openResearchDecisionResults!({
              backend: thread.backend,
              threadId: thread.threadId,
              runId: run.id,
              batchId: request.batchId,
            }),
        }
      : {}),
  }), [api, run.id, thread.backend, thread.threadId]);

  const toggleDecision = (decisionId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(decisionId)) next.delete(decisionId);
      else next.add(decisionId);
      return next;
    });
  };

  const stopBatch = async (batch: ResearchDecisionBatchSummary) => {
    const act = api.actOnResearchDecisionBatch;
    if (!act) return;
    setActing((current) => new Set(current).add(batch.batchId));
    setActionErrors(({ [batch.batchId]: _cleared, ...rest }) => rest);
    try {
      await act({
        backend: thread.backend,
        threadId: thread.threadId,
        runId: run.id,
        batchId: batch.batchId,
        action: "stop",
      });
    } catch (failure) {
      setActionErrors((current) => ({
        ...current,
        [batch.batchId]: failure instanceof Error ? failure.message : "Could not stop the batch.",
      }));
    } finally {
      setActing((current) => {
        const next = new Set(current);
        next.delete(batch.batchId);
        return next;
      });
      onRefresh();
    }
  };

  return (
    <div className="research-decisions" aria-label="Research decisions">
      <ResearchDecisionsReadinessBanner
        readiness={effectiveReadiness}
        onOpenSettings={onOpenDecisionSettings}
      />
      {error && (
        <p role="alert" className="research-error">
          Could not refresh decision activity for this run.
        </p>
      )}
      <section aria-label="Run-scoped decisions">
        <h4 className="research-group">Run-scoped decisions · {decisions.length}</h4>
        {decisions.length > 0 ? (
          <ul className="research-item-results">
            {decisions.map((decision) => (
              <RunDecisionRow
                key={decision.decisionId}
                decision={decision}
                expanded={expanded.has(decision.decisionId)}
                onToggle={() => toggleDecision(decision.decisionId)}
              />
            ))}
          </ul>
        ) : (
          <p className="research-muted">
            No run-scoped decisions yet. The coordinator or a worker can register one with{" "}
            <code className="research-code">decisions_register</code> (scope{" "}
            <code className="research-code">research_run</code>) to share it across this run.
          </p>
        )}
      </section>
      <section aria-label="Decision batches across run">
        <h4 className="research-group">Batches across run · {batches.length}</h4>
        {batches.length > 0 ? (
          <ul className="research-item-results">
            {batches.map((batch) => (
              <RunBatchCard
                key={batch.batchId}
                batch={batch}
                now={now}
                citations={citationsByBatch.get(batch.batchId) ?? []}
                stopping={acting.has(batch.batchId)}
                canReview={Boolean(api.readResearchDecisionBatch)}
                canStop={Boolean(api.actOnResearchDecisionBatch)}
                error={actionErrors[batch.batchId]}
                onReview={() => onSelectBatchId(batch.batchId)}
                onStop={() => { void stopBatch(batch); }}
                onOpenItem={onOpenItem}
              />
            ))}
          </ul>
        ) : (
          <p className="research-muted">
            No decision batches have run in this research run yet.
          </p>
        )}
      </section>
      {activeBatch && (
        <DecisionBatchDetailsModal
          batch={activeBatch}
          desktopApi={modalApi}
          now={now}
          thread={activeBatch.caller}
          onChanged={onRefresh}
          onClose={() => onSelectBatchId(undefined)}
        />
      )}
    </div>
  );
}

function RunDecisionRow({
  decision,
  expanded,
  onToggle,
}: {
  decision: DecisionsRailDecision;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="research-entry">
      <div className="research-entry__meta">
        <button
          type="button"
          className="research-map__title"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {decision.name}
        </button>
        <span className="research-chip">
          {decisionProviderLabel(decision.provider)}
          {decision.providerDisabled ? " · off" : ""}
        </span>
        <span className="research-chip">v{decision.version}</span>
      </div>
      <p className="research-muted">{decisionSummaryLine(decision)}</p>
      {expanded && (
        <dl className="research-dl">
          {decision.providerDisabled && (
            <>
              <dt>Status</dt>
              <dd>{decisionProviderSettingsName(decision.provider)} is turned off in Settings.</dd>
            </>
          )}
          {decision.questions.map((question, index) => (
            <Fragment key={`${question.name ?? question.type}:${index}`}>
              <dt>{question.name ?? `Question ${index + 1}`}</dt>
              <dd>{decisionQuestionKind(question)}</dd>
            </Fragment>
          ))}
          <dt>Input</dt>
          <dd><code className="research-code">{decisionInputSchemaSummary(decision.inputSchema)}</code></dd>
        </dl>
      )}
    </li>
  );
}

function RunBatchCard({
  batch,
  now,
  citations,
  stopping,
  canReview,
  canStop,
  error,
  onReview,
  onStop,
  onOpenItem,
}: {
  batch: ResearchDecisionBatchSummary;
  now: number;
  citations: ReadonlyArray<{ id: string; label: string }>;
  stopping: boolean;
  canReview: boolean;
  canStop: boolean;
  error?: string;
  onReview: () => void;
  onStop: () => void;
  onOpenItem: (itemId: string) => void;
}) {
  const running = isDecisionBatchRunning(batch);
  const tone = decisionBatchTone(batch);
  const chipTone = running
    ? " research-chip--live"
    : tone === "ok"
      ? " research-chip--done"
      : tone === "error"
        ? " research-chip--problem"
        : "";
  const ownerLabel = batch.role === "coordinator"
    ? "Coordinator"
    : batch.approachTitle
      ? `Worker: ${batch.approachTitle}`
      : "Worker";
  const asks = decisionBatchAsksLine(batch);

  return (
    <li className="research-entry" aria-label={`Decision batch ${batch.adHoc ? "Ad hoc decision" : batch.name}`}>
      <div className="research-entry__meta">
        <span className={`research-chip${chipTone}`}>{decisionBatchStatusLabel(batch)}</span>
        <span className="research-chip">{decisionProviderLabel(batch.provider)}</span>
        {batch.background && <span className="research-chip">background</span>}
        <span>{ownerLabel}</span>
      </div>
      <div className="research-decisions__batch-title">
        <strong>{batch.adHoc ? "Ad hoc decision" : `${batch.name} v${batch.version}`}</strong>
        <code className="research-code">{batch.batchId}</code>
      </div>
      {asks && <p className="research-muted">{asks}</p>}
      <p className="research-muted">
        {batch.finished}/{batch.count} done · {batch.succeeded} succeeded · {batch.failed} failed
        {batch.skipped > 0 ? ` · ${batch.skipped} skipped` : ""} · {decisionBatchTimingLine(batch, now)}
      </p>
      {citations.length > 0 && (
        <div className="research-decisions__citations">
          <span className="research-muted">Cited in {plural(citations.length, "item")}:</span>
          {citations.map((citation) => (
            <button
              key={citation.id}
              type="button"
              className="research-link"
              onClick={() => onOpenItem(citation.id)}
            >
              {citation.label}
            </button>
          ))}
        </div>
      )}
      <div className="research-actions">
        {canReview && (
          <button type="button" className="research-button" onClick={onReview}>
            Review batch
          </button>
        )}
        {running && canStop && (
          <button
            type="button"
            className="research-button research-button--danger"
            disabled={stopping || batch.stopping}
            onClick={onStop}
          >
            {stopping || batch.stopping ? "Stopping…" : "Stop batch"}
          </button>
        )}
        <ResearchThreadButton
          thread={batch.caller}
          title={batch.role === "coordinator" ? "Open coordinating thread" : "Open worker thread"}
          label={`Open source thread for ${ownerLabel}`}
        />
      </div>
      {error && <p role="alert" className="research-error">{error}</p>}
    </li>
  );
}
