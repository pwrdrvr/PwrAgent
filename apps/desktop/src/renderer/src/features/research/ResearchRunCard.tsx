import { useState } from "react";
import { RESEARCH_HARNESS_RECONCILABLE } from "@pwragent/shared";
import { ResearchThreadButton } from "./ResearchThreadButton";
import { formatClock, isResearchRunLive, plural, researchFinishBlocker, researchHarnessOutcome, researchHarnessTime, researchRunCounts, researchRunPhase, researchTimeLeft, type ResearchRunView } from "./research-view-model";

export function ResearchRunCard({ run, now, coordinator, writable, busy, onStop, onFinish, onReconcile }: {
  run: ResearchRunView; now: number; coordinator: boolean; writable: boolean; busy: boolean;
  onStop: () => void; onFinish: () => void; onReconcile?: () => void;
}) {
  const [confirmingStop, setConfirmingStop] = useState(false);
  const phase = researchRunPhase(run);
  const counts = researchRunCounts(run);
  const live = isResearchRunLive(run);
  const harness = run.harness;
  const controls = coordinator && writable && (live || (run.status !== "completed" && harness && ["ended", "imported"].includes(harness.state)));
  const finishBlocker = researchFinishBlocker(run);
  const outcome = researchHarnessOutcome(run);
  // The owner refuses a reconcile it cannot do; offering it only where it can succeed keeps the action honest.
  const reconcile = onReconcile && coordinator && harness && harness.source !== "discovery" && RESEARCH_HARNESS_RECONCILABLE.includes(harness.state)
    && (!live || writable) && run.status !== "completed" ? onReconcile : undefined;
  return <section className="research-card" aria-label="Research run summary">
    <div className="research-card__top">
      <span className={`research-chip research-chip--${phase.tone}`}>{phase.label}</span>
      <span className="research-muted">{harness ? researchHarnessTime(run, now) : researchTimeLeft(run, now)}</span>
    </div>
    <p className="research-objective">{run.objective}</p>
    {harness?.source === "discovery"
      ? <p className="research-muted">Read-only discovery snapshot from <code className="research-code">{harness.project} / {harness.swarm}</code>.</p>
      : <dl className="research-stats">
        <div><dt>{harness ? "Members" : "Worker slots"}</dt><dd>{harness ? `${harness.members.length} of ${counts.workerLimit}` : `${counts.slotsInUse} of ${counts.workerLimit}`}
          {!harness && <span className="research-meter" aria-hidden="true">{Array.from({ length: counts.workerLimit }, (_, index) => <i key={index} className={index < counts.slotsInUse ? "is-on" : undefined} />)}</span>}</dd></div>
        <div><dt>Findings</dt><dd>{counts.findings}</dd></div>
        <div><dt>{counts.unreviewed ? "Candidates to review" : "Candidates"}</dt><dd>{counts.unreviewed ? `${counts.unreviewed} of ${counts.candidates}` : counts.candidates}</dd></div>
      </dl>}
    {outcome && <div className="research-callout" role="group" aria-label="Unresolved source outcome">
      <strong>{outcome.title}</strong>
      <p className="research-muted">{outcome.body}</p>
      {reconcile && <span className="research-actions"><button type="button" className="research-button research-button--primary" disabled={busy} onClick={reconcile}>Reconcile from source</button></span>}
    </div>}
    {harness && !outcome && harness.state === "reconciling" && <p className="research-muted" role="status">{harness.note}</p>}
    {harness && !outcome && reconcile && harness.state !== "reconciling" && <span className="research-actions">
      <button type="button" className="research-button" disabled={busy} onClick={reconcile}>{harness.state === "imported" ? "Import newer records" : "Reconcile from source"}</button>
    </span>}
    {harness && <details className="research-details">
      <summary>Source details</summary>
      <dl className="research-dl" aria-label="Harness provenance">
        <dt>Source</dt><dd>Open Math Harness {harness.source === "discovery" ? "discovery run" : "swarm"} · {harness.mode === "execute" ? "execution" : "read-only import"}</dd>
        <dt>IDs</dt><dd><code className="research-code">{harness.source === "discovery" ? `${harness.project} / ${harness.swarm}${harness.problem ? ` / ${harness.problem}` : ""}` : `${harness.project} / ${harness.session} / ${harness.swarm}`}</code></dd>
        {harness.source !== "discovery" && <><dt>Records</dt><dd>{harness.cursor ? `${plural(harness.cursor, "record")}, through #${harness.cursor}` : "None yet"}</dd></>}
        {harness.observedAt && <><dt>Observed</dt><dd>{formatClock(harness.observedAt)}</dd></>}
        {harness.model && <><dt>Model</dt><dd><code className="research-code">{harness.model}</code> at <code className="research-code">{harness.endpointOrigin}</code></dd></>}
        {harness.source !== "discovery" && <><dt>Usage</dt><dd>{harness.calls === undefined ? "Model calls not reported" : `${plural(harness.calls, "model call")} reported by the source`} · tokens and dollars unknown · no hard spend cap</dd></>}
        <dt>Evidence</dt><dd><code className="research-code">{harness.workspace}</code></dd>
        <dt>Protocol</dt><dd>v{harness.version} · upstream <code className="research-code">{harness.upstreamRevision.slice(0, 7)}</code></dd>
        {!outcome && harness.state !== "reconciling" && <><dt>Last note</dt><dd>{harness.note}</dd></>}
      </dl>
    </details>}
    {!harness && run.reason && !live && <p className="research-muted">{run.reason}</p>}
    {!harness && !writable && (live || run.status === "interrupted") && <p className="research-muted">This run’s owner is not running in this window’s process. Its evidence is kept. Open the worker threads to inspect them before you start a new run.</p>}
    {harness && !writable && live && !outcome && <p className="research-muted">This run’s owner is another PwrAgent process. Its records are kept here as they arrive.</p>}
    {!coordinator && <ResearchThreadButton thread={run.coordinator} title="Open coordinating thread" />}
    {controls && !confirmingStop && <div className="research-card__actions">
      {finishBlocker && <span className="research-muted">{finishBlocker}</span>}
      <span className="research-actions">
        {live && <button type="button" className="research-button" disabled={busy || run.status === "stopping"} onClick={() => setConfirmingStop(true)}>{harness?.mode === "import" ? "Stop observing…" : "Stop run…"}</button>}
        <button type="button" className={`research-button${finishBlocker ? "" : " research-button--primary"}`} disabled={busy || Boolean(finishBlocker) || run.status === "stopping"} onClick={onFinish}>Finish run</button>
      </span>
    </div>}
    {controls && confirmingStop && <div className="research-confirm" role="group" aria-label="Confirm stopping the run">
      <p>{harness ? harness.mode === "import" ? "Stop observing? Source work is not affected; it may continue." : "Ask the bridge to cancel this swarm? It is stopped only when the bridge confirms. A model call in flight may still bill."
        : counts.slotsInUse ? `Stop ${plural(counts.slotsInUse, "active worker")} and end the run?` : "End the run?"} Its findings and candidates are kept. A stopped run cannot be resumed.</p>
      <span className="research-actions">
        <button type="button" className="research-button research-button--danger" disabled={busy} onClick={() => { setConfirmingStop(false); onStop(); }}>{harness?.mode === "import" ? "Stop observing" : "Stop run"}</button>
        <button type="button" className="research-button research-button--ghost" autoFocus onClick={() => setConfirmingStop(false)}>Keep running</button>
      </span>
    </div>}
  </section>;
}
