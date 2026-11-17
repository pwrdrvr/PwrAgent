import { useId, useState, type FormEvent } from "react";
import type { ResearchPendingRequest } from "@pwragent/shared";
import { formatClock } from "./research-view-model";

export type ResearchStartValues = { objective: string; workers: number; minutes: number; workspaceMode: "new_worktree" | "none" };

export function ResearchStartForm({ firstRun, busy, disabled, replacesPending, onSubmit, onCancel }: {
  firstRun: boolean; busy: boolean; disabled: boolean; replacesPending: boolean;
  onSubmit: (values: ResearchStartValues) => Promise<boolean>; onCancel?: () => void;
}) {
  const id = useId();
  const [objective, setObjective] = useState("");
  const [workers, setWorkers] = useState(3);
  const [minutes, setMinutes] = useState(30);
  const [workspaceMode, setWorkspaceMode] = useState<ResearchStartValues["workspaceMode"]>("new_worktree");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!objective.trim()) return;
    if (await onSubmit({ objective: objective.trim(), workers, minutes, workspaceMode })) setObjective("");
  }
  return <form onSubmit={(event) => { void submit(event); }} className="research-form" aria-label="New research run">
    {firstRun && <p className="research-intro">Split one objective across several Codex workers. They share findings here. This thread coordinates: it proposes approaches, reviews candidates and finishes the run.</p>}
    <label>Objective<textarea value={objective} onChange={(event) => setObjective(event.target.value)} maxLength={8000} rows={3} required placeholder="What should the workers find out?" /></label>
    <div className="research-form__row">
      <label>Workers (1–8)<input type="number" min={1} max={8} required value={workers} onChange={(event) => setWorkers(Number(event.target.value))} /></label>
      <label>Deadline (minutes)<input type="number" min={1} max={120} required value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label>
    </div>
    <div className="research-field">
      <span id={`${id}-workspaces`}>Worker workspaces</span>
      <div className="research-switch" role="group" aria-labelledby={`${id}-workspaces`}>
        <button type="button" aria-pressed={workspaceMode === "new_worktree"} onClick={() => setWorkspaceMode("new_worktree")}>Isolated worktrees</button>
        <button type="button" aria-pressed={workspaceMode === "none"} onClick={() => setWorkspaceMode("none")}>Scratch</button>
      </div>
    </div>
    <p className="research-muted">Workers use this thread’s model and access, and starting spends model budget. The worker count and deadline are enforced. Token and dollar limits are not.</p>
    {replacesPending && <p className="research-muted">This replaces the request that is waiting to start.</p>}
    <div className="research-actions">
      <button className="research-button research-button--primary" type="submit" disabled={busy || disabled || !objective.trim()}>Request research</button>
      {onCancel && <button className="research-button research-button--ghost" type="button" onClick={onCancel}>Cancel</button>}
    </div>
  </form>;
}

export function ResearchPendingCard({ pending, busy, onWithdraw }: { pending: ResearchPendingRequest; busy: boolean; onWithdraw?: () => void }) {
  return <section className="research-card research-card--pending" aria-label="Research request waiting to start">
    <div className="research-card__top"><span className="research-chip research-chip--attention">Waiting to start</span><span className="research-muted">Expires {formatClock(pending.expiresAt)}</span></div>
    <p className="research-objective">{pending.objective}</p>
    <p className="research-muted">{pending.workers} {pending.workers === 1 ? "worker" : "workers"} · {pending.minutes} min · {pending.workspaceMode === "new_worktree" ? "isolated worktrees" : "scratch workspaces"}. This thread proposes approaches, then starts the run.</p>
    {onWithdraw && <div className="research-actions"><button type="button" className="research-button" disabled={busy} onClick={onWithdraw}>Withdraw request</button></div>}
  </section>;
}
