import { useId, useState, type FormEvent } from "react";
import { RESEARCH_MAX_WORKERS, type ResearchPendingRequest } from "@pwragent/shared/research";
import { ResearchLimitField, researchLimitDraft, researchLimitMinutes, type ResearchLimitDraft } from "./ResearchLimitField";
import { formatClock, formatResearchDuration, plural, researchLimitsLabel, type ResearchLimits } from "./research-view-model";

export type ResearchStartValues = ResearchLimits & { objective: string; workers: number; workspaceMode: "new_worktree" | "none" };

/**
 * The operator's request. How many workers and which limits the run has are
 * theirs to choose: the form proposes three workers and no limits, and says
 * what each limit set, or left unset, means for spend.
 */
export function ResearchStartForm({ firstRun, busy, disabled, replacesPending, onSubmit, onCancel }: {
  firstRun: boolean; busy: boolean; disabled: boolean; replacesPending: boolean;
  onSubmit: (values: ResearchStartValues) => Promise<boolean>; onCancel?: () => void;
}) {
  const id = useId();
  const [objective, setObjective] = useState("");
  const [workers, setWorkers] = useState(3);
  const [time, setTime] = useState<ResearchLimitDraft>(() => researchLimitDraft(undefined, { length: 8, unit: "hours" }));
  const [turn, setTurn] = useState<ResearchLimitDraft>(() => researchLimitDraft(undefined, { length: 1, unit: "hours" }));
  const [total, setTotal] = useState<ResearchLimitDraft>(() => researchLimitDraft(undefined, { length: 24, unit: "hours" }));
  const [workspaceMode, setWorkspaceMode] = useState<ResearchStartValues["workspaceMode"]>("new_worktree");
  const minutes = researchLimitMinutes(time), turnMinutes = researchLimitMinutes(turn), totalWorkerMinutes = researchLimitMinutes(total);
  const validLimits = ![minutes, turnMinutes, totalWorkerMinutes].some((value) => Number.isNaN(value));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!objective.trim() || !validLimits) return;
    if (await onSubmit({ objective: objective.trim(), workers, ...(minutes !== undefined ? { minutes } : {}), ...(turnMinutes !== undefined ? { turnMinutes } : {}),
      ...(totalWorkerMinutes !== undefined ? { totalWorkerMinutes } : {}), workspaceMode })) setObjective("");
  }
  return <form onSubmit={(event) => { void submit(event); }} className="research-form" aria-label="New research run">
    {firstRun && <p className="research-intro">Split one objective across several workers. They share findings here. This thread coordinates: it proposes approaches, reviews candidates and finishes the run.</p>}
    <label>Objective<textarea value={objective} onChange={(event) => setObjective(event.target.value)} maxLength={8000} rows={3} required placeholder="What should the workers find out?" /></label>
    <label>Workers at once<input type="number" min={1} max={RESEARCH_MAX_WORKERS} required value={workers} onChange={(event) => setWorkers(Number(event.target.value))} /></label>
    <ResearchLimitField label="Time limit" draft={time} onChange={setTime} />
    <ResearchLimitField label="Per-worker time limit" draft={turn} onChange={setTurn} />
    <ResearchLimitField label="Total worker time" draft={total} onChange={setTotal} />
    <div className="research-field">
      <span id={`${id}-workspaces`}>Worker workspaces</span>
      <div className="research-switch" role="group" aria-labelledby={`${id}-workspaces`}>
        <button type="button" aria-pressed={workspaceMode === "new_worktree"} onClick={() => setWorkspaceMode("new_worktree")}>Isolated worktrees</button>
        <button type="button" aria-pressed={workspaceMode === "none"} onClick={() => setWorkspaceMode("none")}>Scratch</button>
      </div>
    </div>
    <p className="research-muted">Workers use this thread’s model and access, and starting spends model budget. {!validLimits ? "Enter a whole number for each limit you set." : <>
      {minutes === undefined ? "With no time limit, workers keep going until you stop or finish the run." : `The run stops after ${formatResearchDuration(minutes)}.`}
      {turnMinutes !== undefined && ` A worker whose turn runs past ${formatResearchDuration(turnMinutes)} is stopped; the run continues.`}
      {totalWorkerMinutes !== undefined && ` The run ends once its workers’ turns add up to ${formatResearchDuration(totalWorkerMinutes)}.`}
    </>} At most {plural(workers, "worker")} run at once. There is no token or dollar cap.</p>
    {replacesPending && <p className="research-muted">This replaces the request that is waiting to start.</p>}
    <div className="research-actions">
      <button className="research-button research-button--primary" type="submit" disabled={busy || disabled || !objective.trim() || !validLimits}>Request research</button>
      {onCancel && <button className="research-button research-button--ghost" type="button" onClick={onCancel}>Cancel</button>}
    </div>
  </form>;
}

export function ResearchPendingCard({ pending, busy, onWithdraw }: { pending: ResearchPendingRequest; busy: boolean; onWithdraw?: () => void }) {
  return <section className="research-card research-card--pending" aria-label="Research request waiting to start">
    <div className="research-card__top"><span className="research-chip research-chip--attention">Waiting to start</span><span className="research-muted">Expires {formatClock(pending.expiresAt)}</span></div>
    <p className="research-objective">{pending.objective}</p>
    <p className="research-muted">{plural(pending.workers, "worker")} · {researchLimitsLabel(pending)} · {pending.workspaceMode === "new_worktree" ? "isolated worktrees" : "scratch workspaces"}. This thread proposes approaches, then starts the run.</p>
    {onWithdraw && <div className="research-actions"><button type="button" className="research-button" disabled={busy} onClick={onWithdraw}>Withdraw request</button></div>}
  </section>;
}
