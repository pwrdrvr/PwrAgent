import { useState, type FormEvent } from "react";
import { RESEARCH_MAX_WORKERS, type ResearchBoundsCommand } from "@pwragent/shared/research";
import { ResearchLimitField, researchLimitDraft, researchLimitMinutes, type ResearchLimitDraft } from "./ResearchLimitField";
import { formatResearchDuration, formatRunMoment, plural, researchWorkerMinutesUsed, type ResearchRunView } from "./research-view-model";

export type ResearchBoundsChange = Omit<ResearchBoundsCommand, "action">;

/**
 * The fields that differ from the run's bounds: a number for a new limit, null
 * for one removed. Undefined when nothing differs, or a field is not valid.
 */
export function researchBoundsChange(run: Pick<ResearchRunView, "workerLimit" | "deadlineAt" | "createdAt" | "turnMinutes" | "totalWorkerMinutes">,
  draft: { workers: number; minutes: number | undefined; turnMinutes: number | undefined; totalWorkerMinutes: number | undefined }): ResearchBoundsChange | undefined {
  if (!Number.isInteger(draft.workers) || draft.workers < 1 || draft.workers > RESEARCH_MAX_WORKERS) return undefined;
  if ([draft.minutes, draft.turnMinutes, draft.totalWorkerMinutes].some((value) => Number.isNaN(value))) return undefined;
  const minutes = run.deadlineAt === undefined ? undefined : Math.round((run.deadlineAt - run.createdAt) / 60_000);
  const change: ResearchBoundsChange = {
    ...(draft.workers !== run.workerLimit ? { workers: draft.workers } : {}),
    ...(draft.minutes !== minutes ? { minutes: draft.minutes ?? null } : {}),
    ...(draft.turnMinutes !== run.turnMinutes ? { turnMinutes: draft.turnMinutes ?? null } : {}),
    ...(draft.totalWorkerMinutes !== run.totalWorkerMinutes ? { totalWorkerMinutes: draft.totalWorkerMinutes ?? null } : {}),
  };
  return Object.keys(change).length ? change : undefined;
}

/**
 * The operator's editor for a running run's bounds, opened from its card with
 * the bounds as they stand. The time limit counts from the run's start, as on
 * the start form, so raising it extends the run. The owner refuses a time
 * limit or total that has already passed; the editor says so first.
 */
export function ResearchBoundsEditor({ run, now, busy, onSave, onCancel }: {
  run: ResearchRunView; now: number; busy: boolean; onSave: (change: ResearchBoundsChange) => Promise<boolean>; onCancel: () => void;
}) {
  const [workers, setWorkers] = useState(run.workerLimit);
  const [time, setTime] = useState<ResearchLimitDraft>(() => researchLimitDraft(run.deadlineAt === undefined ? undefined : Math.round((run.deadlineAt - run.createdAt) / 60_000), { length: 8, unit: "hours" }));
  const [turn, setTurn] = useState<ResearchLimitDraft>(() => researchLimitDraft(run.turnMinutes, { length: 1, unit: "hours" }));
  const [total, setTotal] = useState<ResearchLimitDraft>(() => researchLimitDraft(run.totalWorkerMinutes, { length: 24, unit: "hours" }));
  const minutes = researchLimitMinutes(time), turnMinutes = researchLimitMinutes(turn), totalWorkerMinutes = researchLimitMinutes(total);
  const change = researchBoundsChange(run, { workers, minutes, turnMinutes, totalWorkerMinutes });
  const endsAt = minutes === undefined || Number.isNaN(minutes) ? undefined : run.createdAt + minutes * 60_000;
  const used = researchWorkerMinutesUsed(run, now);
  const newTotal = change?.totalWorkerMinutes ?? undefined;
  const passed = typeof change?.minutes === "number" && endsAt !== undefined && endsAt <= now ? `That time limit has already passed: the run started ${formatResearchDuration(Math.floor((now - run.createdAt) / 60_000))} ago.`
    : newTotal !== undefined && newTotal <= used ? `Workers have already used ${formatResearchDuration(used)}.` : undefined;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (change && !passed && await onSave(change)) onCancel();
  }
  return <form className="research-form research-bounds" aria-label="Change the run's bounds" onSubmit={(event) => { void submit(event); }}>
    <label>Workers at once<input type="number" min={1} max={RESEARCH_MAX_WORKERS} required value={workers} onChange={(event) => setWorkers(Number(event.target.value))} /></label>
    <ResearchLimitField label={`Time limit, from the start at ${formatRunMoment(run.createdAt, now)}`} draft={time} onChange={setTime} />
    <ResearchLimitField label="Per-worker time limit" draft={turn} onChange={setTurn} />
    <ResearchLimitField label="Total worker time" draft={total} onChange={setTotal} />
    <p className="research-muted">{passed ?? <>
      {endsAt === undefined ? "The run has no time limit." : `The run ends at ${formatRunMoment(endsAt, now)}.`}
      {workers < run.activeWorkers && ` Lowering the worker count stops no one: the ${plural(run.activeWorkers, "running worker")} finish their turns, and no new one starts until fewer than ${workers} are running.`}
      {typeof change?.turnMinutes === "number" && " A worker already past the new per-worker limit is stopped."}
      {(run.totalWorkerMinutes !== undefined || totalWorkerMinutes !== undefined) && ` Workers have used ${formatResearchDuration(used)} so far.`}
    </>}</p>
    <span className="research-actions">
      <button type="submit" className="research-button research-button--primary" disabled={busy || !change || Boolean(passed)}>Save bounds</button>
      <button type="button" className="research-button research-button--ghost" onClick={onCancel}>Cancel</button>
    </span>
  </form>;
}
