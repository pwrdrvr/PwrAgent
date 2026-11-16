import { useEffect, useId, useState, type FormEvent } from "react";
import { RESEARCH_FINDING_KINDS, RESEARCH_WORK_STATES, RESEARCH_WORK_TRANSITIONS, type ResearchItemContext, type ResearchRun, type ResearchSearchPage, type ResearchSearchQuery, type ResearchThread, type ResearchWorkCommand } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { ResearchThreadButton } from "./ResearchThreadButton";

export function ResearchItemsPanel({ api, thread, run, writable, coordinator }: {
  api: DesktopApi; thread: ResearchThread; run: ResearchRun; writable: boolean; coordinator: boolean;
}) {
  const filterId = useId();
  const [text, setText] = useState("");
  const [type, setType] = useState("");
  const [kind, setKind] = useState("");
  const [state, setState] = useState("");
  const [review, setReview] = useState("");
  const [filters, setFilters] = useState<ResearchSearchQuery>({ limit: 10 });
  const [cursor, setCursor] = useState<ResearchSearchQuery["cursor"]>();
  const [page, setPage] = useState<ResearchSearchPage>();
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<ResearchItemContext>();
  const [reason, setReason] = useState("");
  const [task, setTask] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const runId = run.id;
  const revision = run.revision;
  const backend = thread.backend;
  const threadId = thread.threadId;
  const currentCursor = cursor?.revision === revision ? cursor : undefined;
  useEffect(() => {
    let disposed = false;
    setError("");
    if (!api.searchResearch) return;
    void api.searchResearch({ backend, threadId, runId, query: { ...filters, cursor: currentCursor } }).then((result) => {
      if (!disposed) setPage(result);
    }, (failure: unknown) => { if (!disposed) setError(message(failure)); });
    return () => { disposed = true; };
  }, [api, backend, threadId, runId, revision, filters, currentCursor, refresh]);
  useEffect(() => {
    let disposed = false;
    setDetail(undefined);
    if (!selected || !api.readResearchItem) return;
    void api.readResearchItem({ backend, threadId, runId, itemId: selected }).then((result) => {
      if (!disposed) setDetail(result);
    }, (failure: unknown) => { if (!disposed) setError(message(failure)); });
    return () => { disposed = true; };
  }, [api, backend, threadId, runId, revision, selected, refresh]);

  function search(event: FormEvent) {
    event.preventDefault();
    setCursor(undefined);
    setFilters({ query: text, type: type as ResearchSearchQuery["type"] || undefined, kind: kind as ResearchSearchQuery["kind"] || undefined,
      state: state as ResearchSearchQuery["state"] || undefined, review: review as ResearchSearchQuery["review"] || undefined, limit: 10 });
    setRefresh((value) => value + 1);
  }
  async function update(next: ResearchWorkCommand["state"]) {
    if (!detail || !reason.trim() || !api.updateResearchItem) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api.updateResearchItem({ backend, threadId, runId, requestId: crypto.randomUUID(),
        command: { action: "work", itemId: detail.item.id, expectedVersion: detail.item.version, state: next, reason: reason.trim() } });
      setDetail(result); setReason(""); setCursor(undefined); setRefresh((value) => value + 1);
      setNotice(result.item.work.state === "cancel_requested" ? "Cancellation requested. The worker’s outcome is not yet confirmed." : "Item progress saved.");
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  async function assign() {
    if (!detail || !task.trim() || !api.submitThreadReply) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const receipt = await api.submitThreadReply({ ...run.coordinator, input: [{ type: "text", text:
        `Assign one research item using research_assign. runId=${runId}; itemId=${detail.item.id}; expectedVersion=${detail.item.version}. Task: ${task.trim()}\nRead the item again if its version changed. Preserve the original worker limit, workspace and deadline. If no slot is free, report that and wait; do not start a child outside research assignment.` }] });
      if (!receipt) throw new Error("The coordinator did not accept the assignment request");
      setNotice(receipt.queueStatus === "queued" ? "Assignment request queued in the coordinating thread." : "Assignment request accepted by the coordinating thread.");
      setTask("");
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  async function evidence(pathIndex: number) {
    if (!detail || !api.openResearchEvidence) return;
    try {
      const result = await api.openResearchEvidence({ backend, threadId, runId, itemId: detail.item.id, pathIndex });
      if (!result.opened) throw new Error(result.error ?? "Evidence could not be opened");
    } catch (failure) { setError(message(failure)); }
  }
  if (!api.searchResearch || !api.readResearchItem) return <p className="context-empty">Item search is unavailable in this window.</p>;
  const active = writable && (run.status === "running" || (coordinator && run.status === "exhausted"));
  const assignable = writable && coordinator && ["running", "exhausted"].includes(run.status) && Date.now() < run.deadlineAt;
  const item = detail?.item;
  const record = item?.record;
  return <div className="research-items" aria-label="Research items">
    <form className="research-form" onSubmit={search}>
      <label>Search items<input type="search" value={text} maxLength={300} onChange={(event) => setText(event.target.value)} placeholder="Text or item ID" /></label>
      <div className="research-item-filters">
        <div><label htmlFor={`${filterId}-type`}>Item type</label><select id={`${filterId}-type`} value={type} onChange={(event) => setType(event.target.value)}><option value="">All types</option>{["approach", "finding", "submission"].map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></div>
        <div><label htmlFor={`${filterId}-kind`}>Finding kind</label><select id={`${filterId}-kind`} value={kind} onChange={(event) => setKind(event.target.value)}><option value="">All kinds</option>{RESEARCH_FINDING_KINDS.map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></div>
        <div><label htmlFor={`${filterId}-state`}>Work state</label><select id={`${filterId}-state`} value={state} onChange={(event) => setState(event.target.value)}><option value="">All work</option>{RESEARCH_WORK_STATES.map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></div>
        <div><label htmlFor={`${filterId}-review`}>Candidate review</label><select id={`${filterId}-review`} value={review} onChange={(event) => setReview(event.target.value)}><option value="">All decisions</option>{["unreviewed", "accepted", "revision_requested", "rejected"].map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></div>
      </div>
      <button type="submit" className="research-button">Search</button>
    </form>
    {error && <p role="alert" className="research-error">{error} <button type="button" className="research-link" onClick={() => { setCursor(undefined); setRefresh((value) => value + 1); }}>Refresh items</button></p>}
    {notice && <p role="status" className="research-muted">{notice}</p>}
    {page && <>
      <p className="research-muted">{page.total} matching items · showing {page.items.length}</p>
      <div className="research-item-results">{page.items.map((hit) => <button type="button" className="research-node research-node--finding" key={hit.id} aria-pressed={selected === hit.id} onClick={() => { setSelected(hit.id); setNotice(""); setReason(""); }}><span>{label(hit.type)} · {label(hit.state)}</span>{" "}{hit.excerpt}</button>)}</div>
      {page.total === 0 && <p className="context-empty">No items match these filters.</p>}
      <div className="research-actions">{currentCursor && <button type="button" className="research-button" onClick={() => setCursor(undefined)}>First page</button>}{page.nextCursor && <button type="button" className="research-button" onClick={() => setCursor(page.nextCursor)}>Next items</button>}</div>
    </>}
    {item && record && <article className="research-entry" aria-label="Selected research item">
      <div className="research-entry__meta">{label(item.type)} · {label(item.work.state)} · version {item.version}</div>
      <code className="research-item-id">{item.id}</code>
      {"title" in record && <strong>{record.title}</strong>}<p>{"text" in record ? record.text : record.task}</p>
      {item.work.note && <p className="research-muted">{item.work.note}</p>}
      {item.work.assignee && <ResearchThreadButton thread={item.work.assignee} title="Open assigned thread" />}
      {"author" in record && record.author && <ResearchThreadButton thread={record.author} title="Open source thread" />}
      {detail?.assignment && <p className="research-muted">Assignment: {detail.assignment.task} · {label(detail.assignment.state)}</p>}
      {"paths" in record && record.paths.map((path, index) => <button className="research-evidence" type="button" key={path} onClick={() => { void evidence(index); }}>{path}</button>)}
      <p className="research-muted">Work completion records progress. Candidate review and formal verification remain separate.</p>
      {active && api.updateResearchItem && <>
        <label className="research-review-reason">Work update reason<textarea rows={2} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
        <div className="research-actions">{RESEARCH_WORK_TRANSITIONS[item.work.state].filter((value) => coordinator || !["open", "cancelled"].includes(value)).map((value) => <button type="button" className="research-button" key={value} disabled={busy || !reason.trim()} onClick={() => { void update(value as ResearchWorkCommand["state"]); }}>{value === "open" ? "Release / reopen" : value === "claimed" ? "Claim" : value === "cancelled" ? "Cancel item" : label(value)}</button>)}</div>
      </>}
      {assignable && ["open", "blocked"].includes(item.work.state) && !item.work.assignee && <>
        <label className="research-review-reason">Task for child<textarea rows={2} maxLength={2000} value={task} onChange={(event) => setTask(event.target.value)} /></label>
        <p className="research-muted">Uses a free slot within this run’s {run.workerLimit}-worker limit and original deadline.</p>
        <button type="button" className="research-button" disabled={busy || !task.trim() || !api.submitThreadReply} onClick={() => { void assign(); }}>Request child for this item</button>
      </>}
    </article>}
  </div>;
}
function label(value: string) { return value.replaceAll("_", " ").replace(/^./, (s) => s.toUpperCase()); }
function message(error: unknown) { return error instanceof Error ? error.message : "Research item operation failed"; }
