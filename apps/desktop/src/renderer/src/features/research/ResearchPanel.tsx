import { useState, type FormEvent } from "react";
import { sameResearchThread, type NavigationThreadSummary, type ResearchCommand, type ResearchRun, type ResearchThread } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { ResearchThreadButton } from "./ResearchThreadButton";
import { ResearchItemsPanel } from "./ResearchItemsPanel";
import { ResearchHarnessForm } from "./ResearchHarnessForm";
import { useResearchSnapshot } from "./useResearchSnapshot";
import "./research.css";

type View = "graph" | "board" | "review" | "activity" | "items";

export function ResearchPanel({ desktopApi: api, thread }: { desktopApi?: DesktopApi; thread?: NavigationThreadSummary }) {
  const remote = Boolean(thread?.federation?.ref.target ?? readRendererFederationTarget());
  const identity = thread && !remote && thread.source === "codex" ? { backend: thread.source, threadId: thread.id } : undefined;
  const state = useResearchSnapshot(api, identity);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [view, setView] = useState<View>("graph");
  const [filter, setFilter] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [harnessForm, setHarnessForm] = useState(false);
  const [objective, setObjective] = useState("");
  const [workers, setWorkers] = useState(3);
  const [minutes, setMinutes] = useState(30);
  const [workspaceMode, setWorkspaceMode] = useState<"new_worktree" | "none">("new_worktree");
  const run = state.snapshot?.runs.find((r) => r.id === selectedRunId) ?? state.snapshot?.runs[0];
  const coordinator = Boolean(run && identity && sameResearchThread(run.coordinator, identity));
  const writable = Boolean(run && state.snapshot?.writableRunIds.includes(run.id));
  const active = run?.status === "running" || run?.status === "stopping";
  const canReview = coordinator && writable;
  const awaitingReview = run?.status === "running" && run.approaches.every((a) => ["ended", "failed", "stopped"].includes(a.state)) && run.submissions.length > 0;

  async function send(target: ResearchThread, text: string) {
    if (!api?.submitThreadReply) throw new Error("Thread replies are unavailable");
    const receipt = await api.submitThreadReply({ ...target, input: [{ type: "text", text }] });
    if (!receipt) throw new Error("The owner did not accept this request");
    setNotice(receipt.queueStatus === "queued" ? "Request queued in the coordinating thread." : "Request accepted by the coordinating thread.");
  }
  async function start(event: FormEvent) {
    event.preventDefault();
    if (!identity || !objective.trim() || !api?.prepareResearch) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const prepared = await api.prepareResearch({ ...identity, objective: objective.trim(), workers, minutes, workspaceMode });
      await send(identity, `Start a research run using research_start with intentId=${prepared.intentId}. Objective: ${objective.trim()}\nUse exactly ${workers} distinct approaches, a ${minutes}-minute deadline, and workspaceMode=${workspaceMode}. These exact limits and objective are bound to the operator's request. Workers inherit this thread's model and access. Propose and distinguish their assignments before starting; explain significant overlap. Review submissions with research_update and record revisions or acceptance. Keep informal acceptance separate from verification. Do not silently increase the worker count or deadline.`);
      setCreating(false); setObjective("");
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  async function update(command: ResearchCommand) {
    if (!run || !identity || !api?.updateResearch) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api.updateResearch({ ...identity, runId: run.id, requestId: crypto.randomUUID(), command });
      if (command.action === "review" && command.decision === "revision_requested") {
        const delivery = result.deliveries.at(-1);
        setNotice(delivery?.state === "queued" ? "Revision feedback is queued for the worker." : delivery?.state === "started" ? "Revision feedback was accepted by the worker’s owner." : "Revision is recorded; feedback delivery was not confirmed. Inspect Activity before sending it again.");
      }
      setReason("");
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  async function openEvidence(itemId: string, pathIndex: number) {
    if (!identity || !run || !api?.openResearchEvidence) return;
    setError("");
    try {
      const result = await api.openResearchEvidence({ ...identity, runId: run.id, itemId, pathIndex });
      if (!result.opened) throw new Error(result.error ?? "Evidence could not be opened");
    } catch (failure) { setError(message(failure)); }
  }
  const matches = (text: string) => text.toLowerCase().includes(filter.toLowerCase());
  const titleFor = (id: string) => run?.approaches.find((a) => a.id === id)?.title ?? id;

  if (remote) return <section className="context-panel__section"><h3>Research</h3><p className="context-empty">Open this thread on its owning instance to inspect its research runs.</p></section>;
  if (!identity) return <section className="context-panel__section"><h3>Research</h3><p className="context-empty">Research runs are available in local Codex threads.</p></section>;
  if (!api?.researchSnapshot) return <section className="context-panel__section"><h3>Research</h3><p className="context-empty">Research is unavailable in this window.</p></section>;

  return <section className="context-panel__section research-panel" aria-label="Research">
    <div className="research-heading"><h3>Research</h3><button type="button" className="research-button" onClick={() => { setCreating(!creating); setHarnessForm(false); }} aria-expanded={creating}>New run</button>
      <button type="button" className="research-button" onClick={() => { setHarnessForm(!harnessForm); setCreating(false); }} aria-expanded={harnessForm}>Harness</button></div>
    {harnessForm && <ResearchHarnessForm api={api} thread={identity} onStarted={() => setHarnessForm(false)} />}
    {!harnessForm && (creating || (state.snapshot?.runs.length === 0)) && <form onSubmit={(event) => { void start(event); }} className="research-form">
      <label>Objective<textarea value={objective} onChange={(event) => setObjective(event.target.value)} maxLength={8000} rows={3} required /></label>
      <label>Workers<input type="number" min={1} max={8} required value={workers} onChange={(event) => setWorkers(Number(event.target.value))} /></label>
      <label>Deadline in minutes<input type="number" min={1} max={120} required value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label>
      <div className="research-switch" role="group" aria-label="Worker workspaces">
        <button type="button" aria-pressed={workspaceMode === "new_worktree"} onClick={() => setWorkspaceMode("new_worktree")}>Isolated worktrees</button>
        <button type="button" aria-pressed={workspaceMode === "none"} onClick={() => setWorkspaceMode("none")}>Scratch</button>
      </div>
      <p className="research-muted">Workers inherit this thread’s model and access. Starting spends model budget. The worker count and deadline are enforced; token and dollar limits are unavailable.</p>
      <p className="research-muted">The request expires if it has not started within five minutes.</p>
      <button className="research-button research-button--primary" type="submit" disabled={busy || !objective.trim() || !api.submitThreadReply || !api.prepareResearch}>Request research</button>
    </form>}
    {(error || state.error) && <p role="alert" className="research-error">{error || state.error}</p>}
    {notice && <p role="status" className="research-muted">{notice}</p>}
    {!state.snapshot && !state.error && <p role="status" className="context-empty">Loading research…</p>}
    {state.snapshot && state.snapshot.runs.length > 1 && <div className="research-runs" aria-label="Research runs">
      {state.snapshot.runs.map((r) => <button type="button" key={r.id} aria-pressed={r.id === run?.id} onClick={() => { setSelectedRunId(r.id); setFilter(""); }}>{r.objective}</button>)}
    </div>}
    {run && <>
      <div className="research-summary"><strong>{run.objective}</strong><span className="research-state">{awaitingReview ? "Awaiting review" : label(run.status)}</span></div>
      <p className="research-muted">{run.harness ? `${run.harness.members.length} source members` : `${run.approaches.filter((a) => !["ended", "failed", "stopped"].includes(a.state)).length} active · ${run.approaches.length} total workers`} · limit {run.workerLimit} · deadline {new Date(run.deadlineAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
      <p className="research-muted">{run.findings.length} findings · {run.submissions.length} submissions{run.harness ? "" : " · usage in each worker’s Pricing panel"}</p>
      {run.harness && <div aria-label="Harness provenance">
        <p className="research-muted">Open Math Harness · protocol v{run.harness.version} · {label(run.harness.mode)} · {label(run.harness.state)}</p>
        <p className="research-muted">{run.harness.project} / {run.harness.session} / {run.harness.swarm} · source cursor {run.harness.cursor} · revision {run.harness.upstreamRevision.slice(0, 12)}</p>
        <p className="research-muted">{run.harness.note}</p>
        {run.harness.model && <p className="research-muted">Execution model: {run.harness.model} · endpoint: {run.harness.endpointOrigin}</p>}
        <p className="research-muted">{run.harness.calls === undefined ? "Model calls unknown" : `${run.harness.calls} source model calls reported`} · token and dollar usage unknown · no hard spend cap</p>
      </div>}
      {run.reason && <p className="research-muted">{run.reason}</p>}
      {!writable && (active || run.status === "interrupted") && <p className="research-muted">{run.harness
        ? "This run’s owner is unavailable in this process. Evidence is retained. Reconcile source records before requesting a new run."
        : "This run’s owner is unavailable in this process. Evidence is retained. Inspect the worker threads before requesting a new run."}</p>}
      {!coordinator && <ResearchThreadButton thread={run.coordinator} title="Open coordinating thread" />}
      {coordinator && writable && (active || (run.harness && ["ended", "imported"].includes(run.harness.state))) && run.status !== "completed" && <div className="research-actions">
        {active && <button type="button" className="research-button" disabled={busy} onClick={() => { void update({ action: "stop", reason: "Stopped by the operator" }); }}>Stop run</button>}
        <button type="button" className="research-button" disabled={busy || !run.submissions.some((s) => s.review?.decision === "accepted")} onClick={() => { void update({ action: "finish", reason: "Completed after operator review" }); }}>Finish run</button>
      </div>}
      <div className="research-switch" role="group" aria-label="Research view">{(["graph", "items", "board", "review", "activity"] as const).map((v) => <button type="button" key={v} aria-pressed={view === v} onClick={() => { setView(v); setFilter(""); }}>{label(v)}</button>)}</div>
      {view !== "items" && <input className="research-filter" type="search" aria-label="Filter research by approach, finding, or state" placeholder="Filter approaches, findings, states…" value={filter} onChange={(event) => setFilter(event.target.value)} />}
      {view === "items" && <ResearchItemsPanel key={`${identity.backend}:${identity.threadId}:${run.id}`} api={api} thread={identity} run={run} writable={writable && !run.harness} coordinator={coordinator} />}
      {view === "graph" && <div className="research-graph" aria-label="Recorded research graph">
        <div className="research-graph__root">{run.objective}</div>
        {run.approaches.filter((a, index) => (!run.harness || index < run.harness.members.length) && matches(`${a.title} ${a.state} ${a.note ?? ""}`)).map((a) => <div className="research-graph__branch" key={a.id}>
          <div className="research-node"><strong>{a.title}</strong><span>{label(a.directionState === "abandoned" ? "abandoned" : a.state)}</span>{a.worker && <ResearchThreadButton thread={a.worker} title="Open worker" />}</div>
          <p className="research-muted">{a.task}</p>{a.note && <p className="research-muted">{a.note}</p>}
          {a.overlapsApproachId && <p className="research-muted">Overlaps: {titleFor(a.overlapsApproachId)}</p>}
          <div className="research-graph__children">{run.findings.filter((f) => f.approachId === a.id).slice(-6).map((f) => <button type="button" className="research-node research-node--finding" key={f.id} onClick={() => { setView("board"); setFilter(f.text.slice(0, 40)); }}><span>{label(f.kind)}</span>{excerpt(f.text)}</button>)}
            {run.submissions.filter((s) => s.approachId === a.id).slice(-6).map((s) => <button type="button" className="research-node research-node--finding" key={s.id} onClick={() => { setView("review"); setFilter(s.text.slice(0, 40)); }}><span>Candidate · {s.review ? label(s.review.decision) : "Awaiting review"}</span>{excerpt(s.text)}</button>)}
          </div>
        </div>)}
        <p className="research-muted">Connections show recorded assignments and contributions. The board preserves supporting and contradicting evidence.</p>
      </div>}
      {view === "board" && <div className="research-board" aria-label="Shared findings">
        {run.findings.filter((f) => matches(`${f.id} ${f.kind} ${f.text} ${titleFor(f.approachId)}`)).map((f) => <article key={f.id} className="research-entry">
          <div className="research-entry__meta">{label(f.kind)} · {titleFor(f.approachId)}</div><p>{f.text}</p>
          {f.author && <ResearchThreadButton thread={f.author} title="Open source thread" />}
          {run.harness && <p className="research-muted">{sourceLabel(run, f.id)}</p>}
          {f.relatesTo && <button type="button" className="research-link" onClick={() => setFilter(run.findings.find((other) => other.id === f.relatesTo)?.text.slice(0, 40) ?? "")}>{label(f.relation ?? "related")} {run.findings.find((other) => other.id === f.relatesTo)?.text.slice(0, 80) ?? "earlier finding"}</button>}
          {f.paths.map((path, index) => <button key={path} className="research-evidence" type="button" disabled={!api.openResearchEvidence} onClick={() => { void openEvidence(f.id, index); }}>{path}</button>)}
        </article>)}
        {!run.findings.length && <p className="context-empty">Findings will appear here as workers share evidence.</p>}
      </div>}
      {view === "review" && <div aria-label="Research submissions">
        <p className="research-muted">Acceptance records a reviewer’s judgment. Formal verification has not been performed.</p>
        {run.harness && <p className="research-muted">Source records retain their original content. PwrAgent records acceptance or rejection; revision feedback requires the source service.</p>}
        {canReview && <label className="research-review-reason">Review reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000} rows={2} /></label>}
        {run.submissions.filter((s) => matches(`${s.id} ${s.text} ${titleFor(s.approachId)} ${s.review?.decision ?? "awaiting review"}`)).map((s) => <article className="research-entry" key={s.id}>
          <div className="research-entry__meta">{titleFor(s.approachId)} · {s.review ? label(s.review.decision) : "Awaiting review"}</div><p>{s.text}</p>
          {s.author && <ResearchThreadButton thread={s.author} title="Open source thread" />}
          {run.harness && <p className="research-muted">{sourceLabel(run, s.id)}</p>}
          {s.paths.map((path, index) => <button key={path} className="research-evidence" type="button" disabled={!api.openResearchEvidence} onClick={() => { void openEvidence(s.id, index); }}>{path}</button>)}
          {s.review && <p className="research-muted">{s.review.actor.kind === "operator" ? "Operator" : "Coordinator"}: {s.review.reason}</p>}
          {canReview && <div className="research-actions">{(["accepted", "revision_requested", "rejected"] as const).map((decision) => <button key={decision} type="button" className="research-button" disabled={busy || !reason.trim() || (decision === "revision_requested" && (!active || Boolean(run.harness)))} onClick={() => { void update({ action: "review", submissionId: s.id, decision, reason: reason.trim() }); }}>{decision === "accepted" ? "Accept" : decision === "revision_requested" ? "Request revision" : "Reject"}</button>)}</div>}
        </article>)}
        {!run.submissions.length && <p className="context-empty">No candidates have been submitted.</p>}
      </div>}
      {view === "activity" && <ol className="research-activity" aria-label="Research activity">{run.events.slice(-100).filter((event) => matches(`${event.data.type} ${JSON.stringify(event.data)}`)).map((event) => <li key={event.seq}><span>{event.seq} · {label(event.data.type)} · {new Date(event.at).toLocaleTimeString()}</span><p>{eventDescription(event.data)}</p></li>)}</ol>}
    </>}
  </section>;
}

function label(value: string): string { return value.replaceAll("_", " ").replace(/^./, (s) => s.toUpperCase()); }
function excerpt(text: string): string { return text.length > 100 ? `${text.slice(0, 100)}…` : text; }
function message(error: unknown): string { return error instanceof Error ? error.message : "Research operation failed"; }
function eventDescription(data: ResearchRun["events"][number]["data"]): string {
  switch (data.type) {
    case "created": return data.objective;
    case "worker": return `${data.approachId}: ${label(data.state)}${data.note ? ` · ${data.note}` : ""}`;
    case "finding": return data.finding.text;
    case "submission": return data.submission.text;
    case "review": return `${label(data.decision)}: ${data.reason}`;
    case "abandoned": return `${data.approachId}: ${data.reason}`;
    case "direction": return `${data.approachId}: ${data.title} · ${data.reason}`;
    case "status": return `${label(data.status)}: ${data.reason}`;
    case "delivery_failed": return `Message delivery was not confirmed: ${data.reason}`;
    case "delivery": return `Revision feedback ${label(data.delivery.state)}`;
    case "assignment": return `Assigned item ${data.itemId}: ${data.task}`;
    case "item_work": return `${data.itemId}: ${label(data.work.state)} · ${data.work.note ?? ""}`;
    case "harness": return data.state.note;
    case "harness_observation": return `Harness ${data.event}: ${data.text}`;
  }
}

function sourceLabel(run: ResearchRun, itemId: string): string {
  const source = run.events.find((e) => (e.data.type === "finding" && e.data.finding.id === itemId) || (e.data.type === "submission" && e.data.submission.id === itemId))?.provenance;
  return source ? `Source ${source.member ?? "service"} · record ${source.seq} · SHA-256 ${source.digest.slice(0, 12)}` : "Source provenance unavailable";
}
