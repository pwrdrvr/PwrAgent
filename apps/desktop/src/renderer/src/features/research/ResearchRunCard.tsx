import { useState } from "react";
import type { ResearchRun } from "@pwragent/shared";
import { ResearchThreadButton } from "./ResearchThreadButton";
import { isResearchRunLive, plural, researchFinishBlocker, researchRunCounts, researchRunPhase, researchTimeLeft } from "./research-view-model";

export function ResearchRunCard({ run, now, coordinator, writable, busy, onStop, onFinish }: {
  run: ResearchRun; now: number; coordinator: boolean; writable: boolean; busy: boolean;
  onStop: () => void; onFinish: () => void;
}) {
  const [confirmingStop, setConfirmingStop] = useState(false);
  const phase = researchRunPhase(run);
  const counts = researchRunCounts(run);
  const live = isResearchRunLive(run);
  const controls = coordinator && writable && live;
  const finishBlocker = researchFinishBlocker(run);
  return <section className="research-card" aria-label="Research run summary">
    <div className="research-card__top">
      <span className={`research-chip research-chip--${phase.tone}`}>{phase.label}</span>
      <span className="research-muted">{researchTimeLeft(run, now)}</span>
    </div>
    <p className="research-objective">{run.objective}</p>
    <dl className="research-stats">
      <div><dt>Worker slots</dt><dd>{counts.slotsInUse} of {counts.workerLimit}
        <span className="research-meter" aria-hidden="true">{Array.from({ length: counts.workerLimit }, (_, index) => <i key={index} className={index < counts.slotsInUse ? "is-on" : undefined} />)}</span></dd></div>
      <div><dt>Findings</dt><dd>{counts.findings}</dd></div>
      <div><dt>{counts.unreviewed ? "Candidates to review" : "Candidates"}</dt><dd>{counts.unreviewed ? `${counts.unreviewed} of ${counts.candidates}` : counts.candidates}</dd></div>
    </dl>
    {run.reason && !live && <p className="research-muted">{run.reason}</p>}
    {!writable && (live || run.status === "interrupted") && <p className="research-muted">This run’s owner is not running in this window’s process. Its evidence is kept. Open the worker threads to inspect them before you start a new run.</p>}
    {!coordinator && <ResearchThreadButton thread={run.coordinator} title="Open coordinating thread" />}
    {controls && !confirmingStop && <div className="research-card__actions">
      {finishBlocker && <span className="research-muted">{finishBlocker}</span>}
      <span className="research-actions">
        <button type="button" className="research-button" disabled={busy || run.status === "stopping"} onClick={() => setConfirmingStop(true)}>Stop run…</button>
        <button type="button" className={`research-button${finishBlocker ? "" : " research-button--primary"}`} disabled={busy || Boolean(finishBlocker) || run.status === "stopping"} onClick={onFinish}>Finish run</button>
      </span>
    </div>}
    {controls && confirmingStop && <div className="research-confirm" role="group" aria-label="Confirm stopping the run">
      <p>{counts.slotsInUse ? `Stop ${plural(counts.slotsInUse, "active worker")} and end the run?` : "End the run?"} Its findings and candidates are kept. A stopped run cannot be resumed.</p>
      <span className="research-actions">
        <button type="button" className="research-button research-button--danger" disabled={busy} onClick={() => { setConfirmingStop(false); onStop(); }}>Stop run</button>
        <button type="button" className="research-button research-button--ghost" autoFocus onClick={() => setConfirmingStop(false)}>Keep running</button>
      </span>
    </div>}
  </section>;
}
