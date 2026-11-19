import { useId, useState, type FormEvent } from "react";
import { RESEARCH_MAX_MINUTES, RESEARCH_MAX_WORKERS, type ResearchPendingRequest } from "@pwragent/shared";
import { Select } from "../../components/Select";
import { formatClock, formatResearchDuration, plural, researchTimeLimitLabel } from "./research-view-model";

export type ResearchStartValues = { objective: string; workers: number; minutes?: number; workspaceMode: "new_worktree" | "none" };

const UNITS = [{ value: "minutes", label: "Minutes", minutes: 1 }, { value: "hours", label: "Hours", minutes: 60 }, { value: "days", label: "Days", minutes: 1440 }] as const;
type Unit = typeof UNITS[number]["value"];

/**
 * The operator's request. How many workers and whether the run has a time
 * limit are theirs to choose: the form proposes three workers and no limit,
 * and says what an unlimited run means for spend.
 */
export function ResearchStartForm({ firstRun, busy, disabled, replacesPending, onSubmit, onCancel }: {
  firstRun: boolean; busy: boolean; disabled: boolean; replacesPending: boolean;
  onSubmit: (values: ResearchStartValues) => Promise<boolean>; onCancel?: () => void;
}) {
  const id = useId();
  const [objective, setObjective] = useState("");
  const [workers, setWorkers] = useState(3);
  const [limited, setLimited] = useState(false);
  const [length, setLength] = useState(8);
  const [unit, setUnit] = useState<Unit>("hours");
  const [workspaceMode, setWorkspaceMode] = useState<ResearchStartValues["workspaceMode"]>("new_worktree");
  const minutes = limited ? length * UNITS.find((entry) => entry.value === unit)!.minutes : undefined;
  const validLimit = minutes === undefined || (Number.isInteger(length) && length >= 1 && minutes <= RESEARCH_MAX_MINUTES);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!objective.trim() || !validLimit) return;
    if (await onSubmit({ objective: objective.trim(), workers, ...(minutes !== undefined ? { minutes } : {}), workspaceMode })) setObjective("");
  }
  return <form onSubmit={(event) => { void submit(event); }} className="research-form" aria-label="New research run">
    {firstRun && <p className="research-intro">Split one objective across several Codex workers. They share findings here. This thread coordinates: it proposes approaches, reviews candidates and finishes the run.</p>}
    <label>Objective<textarea value={objective} onChange={(event) => setObjective(event.target.value)} maxLength={8000} rows={3} required placeholder="What should the workers find out?" /></label>
    <label>Workers at once<input type="number" min={1} max={RESEARCH_MAX_WORKERS} required value={workers} onChange={(event) => setWorkers(Number(event.target.value))} /></label>
    <div className="research-field">
      <span id={`${id}-limit`}>Time limit</span>
      <div className="research-switch" role="group" aria-labelledby={`${id}-limit`}>
        <button type="button" aria-pressed={!limited} onClick={() => setLimited(false)}>No limit</button>
        <button type="button" aria-pressed={limited} onClick={() => setLimited(true)}>Set a limit</button>
      </div>
      {limited && <div className="research-form__row">
        <label>Length<input type="number" min={1} required value={length} onChange={(event) => setLength(Number(event.target.value))} /></label>
        <label>Unit<Select value={unit} onChange={(value) => setUnit(value as Unit)} className="research-select" options={UNITS.map((entry) => ({ value: entry.value, label: entry.label }))} /></label>
      </div>}
    </div>
    <div className="research-field">
      <span id={`${id}-workspaces`}>Worker workspaces</span>
      <div className="research-switch" role="group" aria-labelledby={`${id}-workspaces`}>
        <button type="button" aria-pressed={workspaceMode === "new_worktree"} onClick={() => setWorkspaceMode("new_worktree")}>Isolated worktrees</button>
        <button type="button" aria-pressed={workspaceMode === "none"} onClick={() => setWorkspaceMode("none")}>Scratch</button>
      </div>
    </div>
    <p className="research-muted">Workers use this thread’s model and access, and starting spends model budget. {minutes === undefined
      ? "With no time limit, workers keep going until you stop or finish the run."
      : validLimit ? `The run stops after ${formatResearchDuration(minutes)}.` : "Enter a whole number for the limit."} At most {plural(workers, "worker")} run at once. There is no token or dollar cap.</p>
    {replacesPending && <p className="research-muted">This replaces the request that is waiting to start.</p>}
    <div className="research-actions">
      <button className="research-button research-button--primary" type="submit" disabled={busy || disabled || !objective.trim() || !validLimit}>Request research</button>
      {onCancel && <button className="research-button research-button--ghost" type="button" onClick={onCancel}>Cancel</button>}
    </div>
  </form>;
}

export function ResearchPendingCard({ pending, busy, onWithdraw }: { pending: ResearchPendingRequest; busy: boolean; onWithdraw?: () => void }) {
  return <section className="research-card research-card--pending" aria-label="Research request waiting to start">
    <div className="research-card__top"><span className="research-chip research-chip--attention">Waiting to start</span><span className="research-muted">Expires {formatClock(pending.expiresAt)}</span></div>
    <p className="research-objective">{pending.objective}</p>
    <p className="research-muted">{plural(pending.workers, "worker")} · {researchTimeLimitLabel(pending.minutes)} · {pending.workspaceMode === "new_worktree" ? "isolated worktrees" : "scratch workspaces"}. This thread proposes approaches, then starts the run.</p>
    {onWithdraw && <div className="research-actions"><button type="button" className="research-button" disabled={busy} onClick={onWithdraw}>Withdraw request</button></div>}
  </section>;
}
