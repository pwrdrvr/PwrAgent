import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { RESEARCH_WORK_TRANSITIONS, researchApproachOccupiesSlot, researchApproachResumable, researchDeadlinePassed, type ResearchItemContext, type ResearchThread, type ResearchWorkCommand } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { ResearchThreadButton } from "./ResearchThreadButton";
import { EvidenceList } from "./ResearchViews";
import { approachTitle, excerpt, formatClock, RESEARCH_FOCUSED_CHILD_PREFIX, researchApproachStateLabel, researchItemText, researchLabel, researchReviewStatusLabel, type ResearchRunView } from "./research-view-model";
import { ResearchSourceTag } from "./ResearchSourceTag";

const WORK_ACTION_LABELS: Partial<Record<ResearchWorkCommand["state"], string>> = {
  open: "Release / reopen", claimed: "Claim", in_progress: "In progress", blocked: "Blocked", completed: "Completed", cancelled: "Cancel item",
};

export function ResearchItemDetail({ api, thread, run, itemId, writable, coordinator, onBack, onOpenItem, backLabel, children }: {
  api: DesktopApi; thread: ResearchThread; run: ResearchRunView; itemId: string; writable: boolean; coordinator: boolean;
  onBack: () => void; onOpenItem: (itemId: string) => void;
  /** What leaving this detail is called where it does not replace a result list. */
  backLabel?: string;
  /** Drawn after the item's evidence: the Research window puts a candidate's decision here. */
  children?: ReactNode;
}) {
  const id = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [detail, setDetail] = useState<{ key: string; context?: ResearchItemContext; error?: string }>({ key: "" });
  const [reason, setReason] = useState("");
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const { backend, threadId } = thread;
  const runId = run.id;
  const key = `${runId}:${itemId}:${run.revision}:${refresh}`;
  const readResearchItem = api.readResearchItem;
  useEffect(() => {
    let disposed = false;
    if (!readResearchItem) return;
    void readResearchItem({ backend, threadId, runId, itemId }).then((context) => {
      if (!disposed) setDetail({ key, context });
    }, (failure: unknown) => { if (!disposed) setDetail({ key, error: failure instanceof Error ? failure.message : "This item could not be read" }); });
    return () => { disposed = true; };
  }, [readResearchItem, backend, threadId, runId, itemId, key]);
  useEffect(() => { headingRef.current?.focus(); setReason(""); setTask(""); setNotice(""); setError(""); }, [itemId]);

  // Keep showing the last read of this item while a newer revision loads.
  const context = detail.context?.item.id === itemId ? detail.context : undefined;
  async function update(next: ResearchWorkCommand["state"]) {
    if (!context || !reason.trim() || !api.updateResearchItem) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api.updateResearchItem({ backend, threadId, runId, requestId: crypto.randomUUID(),
        command: { action: "work", itemId: context.item.id, expectedVersion: context.item.version, state: next, reason: reason.trim() } });
      setDetail({ key, context: result }); setReason("");
      setNotice(result.item.work.state === "cancel_requested" ? "Cancellation requested. The worker’s outcome is not confirmed yet." : "Progress saved.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Progress could not be saved"); }
    finally { setBusy(false); }
  }
  async function resume() {
    if (!context || !api.updateResearch) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api.updateResearch({ backend, threadId, runId, requestId: crypto.randomUUID(), command: { action: "resume", approachIds: [context.item.id] } });
      setRefresh((value) => value + 1);
      setNotice("Resume sent. The worker takes its slot back when its turn starts.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The worker could not be resumed"); }
    finally { setBusy(false); }
  }
  async function assign() {
    if (!context || !task.trim() || !api.submitThreadReply) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const receipt = await api.submitThreadReply({ ...run.coordinator, input: [{ type: "text", text:
        `Assign one research item using research_assign. runId=${runId}; itemId=${context.item.id}; expectedVersion=${context.item.version}. Task: ${task.trim()}\nRead the item again if its version changed. Preserve the original worker limit, workspace and deadline. If no slot is free, report that and wait; do not start a child outside research assignment.` }] });
      if (!receipt) throw new Error("The coordinating thread did not accept the assignment request");
      setNotice(receipt.queueStatus === "queued" ? "Assignment request queued in the coordinating thread." : "Assignment request sent to the coordinating thread.");
      setTask("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The assignment could not be requested"); }
    finally { setBusy(false); }
  }
  async function openEvidence(pathIndex: number) {
    if (!api.openResearchEvidence) return;
    setError("");
    try {
      const result = await api.openResearchEvidence({ backend, threadId, runId, itemId, pathIndex });
      if (!result.opened) throw new Error(result.error ?? "Evidence could not be opened");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Evidence could not be opened"); }
  }

  const item = context?.item;
  const record = item?.record;
  const workActive = writable && (run.status === "running" || (coordinator && run.status === "exhausted"));
  const assignable = writable && coordinator && ["running", "exhausted"].includes(run.status) && !researchDeadlinePassed(run, Date.now()) && api.submitThreadReply;
  // Resuming goes to the owner directly; it needs no reply to the coordinating thread.
  const resumable = writable && coordinator && run.status === "running" && !researchDeadlinePassed(run, Date.now()) && Boolean(api.updateResearch);
  const related = record && "relatesTo" in record && record.relatesTo ? run.items.get(record.relatesTo) : undefined;
  const source = record && "itemId" in record && record.itemId ? run.items.get(record.itemId) : undefined;
  const transitions = item ? RESEARCH_WORK_TRANSITIONS[item.work.state].filter((value) => coordinator || !["open", "cancelled"].includes(value)) as ResearchWorkCommand["state"][] : [];
  return <article className="research-detail" aria-labelledby={`${id}-heading`}>
    <button type="button" className="research-link research-detail__back" onClick={onBack}>{backLabel ?? "← Back to results"}</button>
    <h4 id={`${id}-heading`} ref={headingRef} tabIndex={-1} className="research-detail__heading">
      {item ? item.type === "approach" ? item.record.title : item.type === "finding" ? `${researchLabel(item.record.kind)} from ${approachTitle(run, item.approachId)}` : `Candidate from ${approachTitle(run, item.approachId)}` : "Research item"}
    </h4>
    {detail.key === key && detail.error && <p role="alert" className="research-error">{detail.error} <button type="button" className="research-link" onClick={() => setRefresh((value) => value + 1)}>Try again</button></p>}
    {!context && !(detail.key === key && detail.error) && <p role="status" className="research-muted">Loading item…</p>}
    {item && record && <>
      <div className="research-entry__meta">
        {item.type === "approach" && <span className="research-chip">{researchApproachStateLabel(item.record)}</span>}
        {item.type === "submission" && <span className={`research-chip${item.record.review ? "" : " research-chip--attention"}`}>{researchReviewStatusLabel(item.record.review?.decision)}</span>}
        {item.work.state !== "open" && <span className={`research-chip${["in_progress", "claimed", "assigned"].includes(item.work.state) ? " research-chip--live" : ""}`}>Progress: {researchLabel(item.work.state)}</span>}
      </div>
      <p className="research-detail__text">{item.type === "approach" ? item.record.task : item.record.text}</p>
      {run.harness && item.type !== "approach" && <ResearchSourceTag run={run} itemId={item.id} />}
      {item.work.note && <p className="research-muted">{item.work.note}</p>}
      {related && "relation" in record && <button type="button" className="research-link" onClick={() => onOpenItem(related.id)}>{researchLabel(record.relation ?? "related")}: {excerpt(researchItemText(related), 80)}</button>}
      {source && <button type="button" className="research-link" onClick={() => onOpenItem(source.id)}>Investigates: {excerpt(researchItemText(source), 80)}</button>}
      {item.type !== "approach" && item.approachId !== item.id && <button type="button" className="research-link" onClick={() => onOpenItem(item.approachId)}>Approach: {approachTitle(run, item.approachId)}</button>}
      {"paths" in record && record.paths.length > 0 && <EvidenceList paths={record.paths} available={Boolean(api.openResearchEvidence)} onOpen={(index) => { void openEvidence(index); }} />}
      {item.type === "approach" && item.record.worker && <ResearchThreadButton thread={item.record.worker} title="Open worker thread" />}
      {"author" in record && record.author && <ResearchThreadButton thread={record.author} title="Open source thread" />}
      {item.type === "approach" && researchApproachResumable(item.record, (itemId) => run.items.get(itemId)) && resumable && <div className="research-actions">
        <button type="button" className="research-button" disabled={busy} onClick={() => { void resume(); }}>Resume worker</button>
      </div>}
      {context.assignment && <div className="research-node research-node--static">
        <span className="research-node__meta">{RESEARCH_FOCUSED_CHILD_PREFIX}{researchLabel(context.assignment.state)}</span>
        {" "}{context.assignment.task}
        <span className="research-actions">
          <button type="button" className="research-link" onClick={() => onOpenItem(context.assignment!.id)}>Open assignment</button>
          {item.work.assignee && <ResearchThreadButton thread={item.work.assignee} title="Open child thread" />}
        </span>
      </div>}
      {children}
      {notice && <p role="status" className="research-muted">{notice}</p>}
      {error && <p role="alert" className="research-error">{error}</p>}
      {workActive && api.updateResearchItem && transitions.length > 0 && <div className="research-review-form">
        <label htmlFor={`${id}-reason`}>Progress note</label>
        <textarea id={`${id}-reason`} rows={2} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} aria-describedby={`${id}-reason-hint`} />
        <p id={`${id}-reason-hint`} className="research-muted">Required. Recording progress is separate from candidate review and verification.</p>
        <div className="research-actions">{transitions.map((value) => <button type="button" className="research-button" key={value} disabled={busy || !reason.trim()} onClick={() => { void update(value); }}>{WORK_ACTION_LABELS[value] ?? researchLabel(value)}</button>)}</div>
      </div>}
      {assignable && ["open", "blocked"].includes(item.work.state) && !item.work.assignee && !(item.type === "approach" && researchApproachOccupiesSlot(item.record)) && <div className="research-review-form">
        <label htmlFor={`${id}-task`}>Task for a focused child</label>
        <textarea id={`${id}-task`} rows={2} maxLength={2000} value={task} onChange={(event) => setTask(event.target.value)} aria-describedby={`${id}-task-hint`} />
        <p id={`${id}-task-hint`} className="research-muted">Uses a free slot within this run’s {run.workerLimit}-worker limit{run.deadlineAt === undefined ? "" : " and its time limit"}.</p>
        <div className="research-actions"><button type="button" className="research-button" disabled={busy || !task.trim()} onClick={() => { void assign(); }}>Request focused child</button></div>
      </div>}
      <p className="research-detail__footer">Updated {formatClock(item.updatedAt)} · <code>{item.id}</code></p>
    </>}
  </article>;
}
