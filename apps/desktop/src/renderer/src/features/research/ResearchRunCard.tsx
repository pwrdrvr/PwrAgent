import { useState } from "react";
import { RESEARCH_HARNESS_RECONCILABLE, researchHarnessEffectiveState } from "@pwragent/shared";
import { ResearchThreadButton } from "./ResearchThreadButton";
import { ResearchBoundsEditor, type ResearchBoundsChange } from "./ResearchBoundsEditor";
import { formatClock, formatResearchDuration, isResearchRunLive, plural, researchWorkerMinutesUsed, researchCutOffWorkers, researchFinishBlocker, researchHarnessOutcome, researchHarnessTime, researchRunCounts, researchRunPhase, researchTimeLeft, type ResearchRunView } from "./research-view-model";

export function ResearchRunCard({ run, now, coordinator, writable, busy, onStop, onFinish, onReconcile, onResume, onChangeBounds }: {
  run: ResearchRunView; now: number; coordinator: boolean; writable: boolean; busy: boolean;
  onStop: () => void; onFinish: () => void; onReconcile?: () => void; onResume?: () => void;
  /** The operator's change to a running run's bounds. Resolves true once the owner records it. */
  onChangeBounds?: (change: ResearchBoundsChange) => Promise<boolean>;
}) {
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [editingBounds, setEditingBounds] = useState(false);
  const phase = researchRunPhase(run);
  const counts = researchRunCounts(run);
  const live = isResearchRunLive(run);
  const harness = run.harness;
  // A run that ended without being finished can still be completed once a candidate is accepted:
  // a settled Harness run, or a PwrAgent run that was interrupted or ran out of workers.
  const finishableRetired = harness ? run.status !== "completed" && ["ended", "imported"].includes(harness.state)
    : ["interrupted", "exhausted"].includes(run.status) && run.accepted > 0;
  const controls = coordinator && writable && (live || finishableRetired);
  // Bounds are the operator's to change, on a running PwrAgent run this process holds. A Harness run takes its own from the bridge.
  const changeBounds = controls && !harness && run.status === "running" ? onChangeBounds : undefined;
  const editing = Boolean(changeBounds) && editingBounds;
  const workerUsed = run.totalWorkerMinutes === undefined ? 0 : researchWorkerMinutesUsed(run, now);
  const finishBlocker = researchFinishBlocker(run);
  const outcome = researchHarnessOutcome(run);
  // Quitting ends the turns in flight, never the run. Nothing restarts until the operator asks.
  const cutOff = !harness && run.status === "running" ? researchCutOffWorkers(run).length : 0;
  // The owner refuses a reconcile it cannot do; offering it only where it can succeed keeps the action honest.
  const reconcile = onReconcile && coordinator && harness && harness.source !== "discovery" && RESEARCH_HARNESS_RECONCILABLE.includes(researchHarnessEffectiveState(run.status, harness))
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
        <div><dt>{harness ? "Members" : "Worker slots"}</dt><dd>{harness ? harness.mode === "execute" ? `${harness.members.length} of ${counts.workerLimit}` : harness.members.length : `${counts.slotsInUse} of ${counts.workerLimit}`}
          {/* One segment per slot reads at a glance for a handful of workers; past that, one proportional bar. */}
          {!harness && (counts.workerLimit <= 12
            ? <span className="research-meter" aria-hidden="true">{Array.from({ length: counts.workerLimit }, (_, index) => <i key={index} className={index < counts.slotsInUse ? "is-on" : undefined} />)}</span>
            : <span className="research-bar research-bar--wide" aria-hidden="true"><i style={{ width: `${Math.round(counts.slotsInUse / counts.workerLimit * 100)}%` }} /></span>)}</dd></div>
        <div><dt>Findings</dt><dd>{counts.findings}</dd></div>
        <div><dt>{counts.unreviewed ? "Candidates to review" : "Candidates"}</dt><dd>{counts.unreviewed ? `${counts.unreviewed} of ${counts.candidates}` : counts.candidates}</dd></div>
      </dl>}
    {!harness && (run.turnMinutes !== undefined || run.totalWorkerMinutes !== undefined) && <dl className="research-stats" aria-label="Worker limits">
      {run.turnMinutes !== undefined && <div><dt>Each worker</dt><dd>{formatResearchDuration(run.turnMinutes)}</dd></div>}
      {run.totalWorkerMinutes !== undefined && <div><dt>Worker time</dt><dd>{formatResearchDuration(workerUsed)} of {formatResearchDuration(run.totalWorkerMinutes)}
        <span className="research-bar research-bar--wide" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.round(workerUsed / run.totalWorkerMinutes * 100))}%` }} /></span></dd></div>}
    </dl>}
    {outcome && <div className="research-callout" role="group" aria-label="Unresolved source outcome">
      <strong>{outcome.title}</strong>
      <p className="research-muted">{outcome.body}</p>
      {reconcile && <span className="research-actions"><button type="button" className="research-button research-button--primary" disabled={busy} onClick={reconcile}>Reconcile from source</button></span>}
    </div>}
    {cutOff > 0 && <div className="research-callout" role="group" aria-label="Workers to resume">
      <strong>{cutOff === 1 ? "1 worker was" : `${cutOff} workers were`} cut off when PwrAgent closed</strong>
      <p className="research-muted">Their threads, findings and candidates are kept. Resuming sends each one a message to continue; nothing has been sent yet.</p>
      {onResume && coordinator && writable && <span className="research-actions">
        <button type="button" className="research-button research-button--primary" disabled={busy} onClick={onResume}>Resume {plural(cutOff, "worker")}</button>
      </span>}
    </div>}
    {harness && !outcome && harness.state === "reconciling" && <p className="research-muted" role="status">{harness.note}</p>}
    {harness && !outcome && reconcile && <span className="research-actions">
      {/* A reconcile its owner abandoned stays "reconciling"; the owner refuses a second one only while the first still runs. */}
      <button type="button" className="research-button" disabled={busy} onClick={reconcile}>{harness.state === "imported" ? "Import newer records" : harness.state === "reconciling" ? "Reconcile again" : "Reconcile from source"}</button>
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
    {!writable && run.status !== "completed" && !outcome && <p className="research-muted">Another running PwrAgent process owns this run. Its records are kept here as they arrive; review and finish it from that process.</p>}
    {!coordinator && <ResearchThreadButton thread={run.coordinator} title="Open coordinating thread" />}
    {editing && changeBounds && <ResearchBoundsEditor run={run} now={now} busy={busy} onSave={changeBounds} onCancel={() => setEditingBounds(false)} />}
    {controls && !confirmingStop && !editing && <div className="research-card__actions">
      {finishBlocker && <span className="research-muted">{finishBlocker}</span>}
      <span className="research-actions">
        {changeBounds && <button type="button" className="research-button" disabled={busy} onClick={() => setEditingBounds(true)}>Change bounds…</button>}
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
