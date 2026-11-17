import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { sameResearchThread, type NavigationThreadSummary, type ResearchCommand, type ResearchRun, type ResearchThread } from "@pwragent/shared";
import { Select } from "../../components/Select";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { ResearchItemDetail } from "./ResearchItemDetail";
import { ResearchHarnessForm } from "./ResearchHarnessForm";
import { ResearchDiscoveryPanel } from "./ResearchDiscoveryPanel";
import { EMPTY_RESEARCH_ITEMS_QUERY, ResearchItemsPanel, type ResearchItemsQuery } from "./ResearchItemsPanel";
import { ResearchReviewView } from "./ResearchReviewView";
import { ResearchRunCard } from "./ResearchRunCard";
import { ResearchPendingCard, ResearchStartForm, type ResearchStartValues } from "./ResearchStartForm";
import { ResearchActivityView, ResearchFindingsView, ResearchMapView } from "./ResearchViews";
import { excerpt, isResearchRunLive, researchRunPhase, unreviewedCandidates } from "./research-view-model";
import { useResearchSnapshot } from "./useResearchSnapshot";
import "./research.css";

const VIEWS = [
  { id: "map", label: "Map" }, { id: "findings", label: "Findings" }, { id: "review", label: "Review" },
  { id: "items", label: "Items" }, { id: "activity", label: "Activity" },
] as const;
const DISCOVERY_VIEWS = [{ id: "discovery", label: "Discovery" }, { id: "activity", label: "Activity" }] as const;
type View = typeof VIEWS[number]["id"] | typeof DISCOVERY_VIEWS[number]["id"];

/** Wall-clock time for countdowns, ticking only while something on screen is live. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

export function ResearchPanel({ desktopApi: api, thread }: { desktopApi?: DesktopApi; thread?: NavigationThreadSummary }) {
  const remote = Boolean(thread?.federation?.ref.target ?? readRendererFederationTarget());
  const identity = thread && !remote && thread.source === "codex" ? { backend: thread.source, threadId: thread.id } : undefined;
  const state = useResearchSnapshot(api, identity);
  const tabsId = useId();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [view, setView] = useState<View>("map");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [harnessForm, setHarnessForm] = useState(false);
  const [openItemId, setOpenItemId] = useState<string>();
  const [returnFocusId, setReturnFocusId] = useState<string>();
  const [itemsQuery, setItemsQuery] = useState<ResearchItemsQuery>(EMPTY_RESEARCH_ITEMS_QUERY);
  const snapshot = state.snapshot;
  const run = snapshot?.runs.find((r) => r.id === selectedRunId) ?? snapshot?.runs[0];
  const views = run?.harness?.discovery ? DISCOVERY_VIEWS : VIEWS;
  const currentView = views.some((entry) => entry.id === view) ? view : views[0].id;
  // Read the clock directly: once the request expires, the tick that hid it also stops the timer.
  const pendingLive = Boolean(snapshot?.pending && snapshot.pending.expiresAt > Date.now());
  const now = useNow(Boolean(run && isResearchRunLive(run)) || pendingLive);
  const pending = snapshot?.pending && now < snapshot.pending.expiresAt ? snapshot.pending : undefined;
  const coordinator = Boolean(run && identity && sameResearchThread(run.coordinator, identity));
  const writable = Boolean(run && snapshot?.writableRunIds.includes(run.id));
  const live = Boolean(run && isResearchRunLive(run));

  function selectRun(id: string) {
    setSelectedRunId(id); setFilter(""); setOpenItemId(undefined); setItemsQuery(EMPTY_RESEARCH_ITEMS_QUERY); setNotice(""); setError("");
  }
  function openItem(itemId: string) {
    setOpenItemId(itemId); setReturnFocusId(undefined); setView("items");
  }
  function chooseView(next: View) {
    setView(next); setFilter("");
    if (next !== "items") setOpenItemId(undefined);
  }
  async function send(target: ResearchThread, text: string) {
    if (!api?.submitThreadReply) throw new Error("Thread replies are unavailable");
    const receipt = await api.submitThreadReply({ ...target, input: [{ type: "text", text }] });
    if (!receipt) throw new Error("The coordinating thread did not accept this request");
    setNotice(receipt.queueStatus === "queued" ? "Request queued. This thread starts the run after its current turn." : "Request sent. This thread is proposing approaches.");
  }
  async function start(values: ResearchStartValues): Promise<boolean> {
    if (!identity || !api?.prepareResearch) return false;
    setBusy(true); setError(""); setNotice("");
    let prepared = false;
    try {
      const { intentId } = await api.prepareResearch({ ...identity, ...values });
      prepared = true;
      await send(identity, `Start a research run using research_start with intentId=${intentId}. Objective: ${values.objective}\nUse exactly ${values.workers} distinct approaches, a ${values.minutes}-minute deadline, and workspaceMode=${values.workspaceMode}. These exact limits and objective are bound to the operator's request. Workers inherit this thread's model and access. Propose and distinguish their assignments before starting; explain significant overlap. Review submissions with research_update and record revisions or acceptance. Keep informal acceptance separate from verification. Do not silently increase the worker count or deadline.`);
      setCreating(false);
      return true;
    } catch (failure) {
      // The coordinator never received the request, so it must not wait to start.
      if (prepared) await api.withdrawResearch?.(identity).catch(() => {});
      setError(message(failure)); return false;
    }
    finally { setBusy(false); }
  }
  async function withdraw() {
    if (!identity || !api?.withdrawResearch) return;
    setBusy(true); setError(""); setNotice("");
    try { await api.withdrawResearch(identity); setNotice("Request withdrawn. If this thread tries to start it, the start is refused."); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  async function update(command: ResearchCommand): Promise<boolean> {
    if (!run || !identity || !api?.updateResearch) return false;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api.updateResearch({ ...identity, runId: run.id, requestId: crypto.randomUUID(), command });
      if (command.action === "review" && command.decision === "revision_requested") {
        const delivery = result.deliveries.at(-1);
        setNotice(delivery?.state === "queued" ? "Revision feedback is queued for the worker." : delivery?.state === "started" ? "The worker received the revision feedback." : "The revision is recorded, but delivery to the worker was not confirmed. Check Activity before you send it again.");
      } else if (command.action === "review") setNotice(`Decision recorded: ${command.decision === "accepted" ? "accepted" : "rejected"}.`);
      return true;
    } catch (failure) { setError(message(failure)); return false; }
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
  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = views.findIndex((entry) => entry.id === currentView);
    const next = event.key === "ArrowRight" ? (index + 1) % views.length : event.key === "ArrowLeft" ? (index - 1 + views.length) % views.length
      : event.key === "Home" ? 0 : event.key === "End" ? views.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    chooseView(views[next]!.id);
    document.getElementById(`${tabsId}-${views[next]!.id}`)?.focus();
  }

  if (remote) return <section className="context-panel__section"><h3>Research</h3><p className="context-empty">Open this thread on its owning instance to inspect its research runs.</p></section>;
  if (!identity) return <section className="context-panel__section"><h3>Research</h3><p className="context-empty">Research runs are available in local Codex threads.</p></section>;
  if (!api?.researchSnapshot) return <section className="context-panel__section"><h3>Research</h3><p className="context-empty">Research is unavailable in this window.</p></section>;

  const firstRun = Boolean(snapshot && snapshot.runs.length === 0 && !pending);
  const showForm = !harnessForm && Boolean(snapshot) && (creating || firstRun);
  const reviewCount = run ? unreviewedCandidates(run).length : 0;
  return <section className="context-panel__section research-panel" aria-label="Research">
    <div className="research-heading">
      <h3>Research</h3>
      {!firstRun && snapshot && <button type="button" className="research-button" onClick={() => { setCreating(!creating); setHarnessForm(false); }} aria-expanded={creating}>New run</button>}
      {snapshot && <button type="button" className="research-button" onClick={() => { setHarnessForm(!harnessForm); setCreating(false); }} aria-expanded={harnessForm}>Harness</button>}
    </div>
    {harnessForm && <ResearchHarnessForm api={api} thread={identity} onStarted={() => setHarnessForm(false)} />}
    {showForm && <ResearchStartForm firstRun={firstRun} busy={busy} disabled={!api.submitThreadReply || !api.prepareResearch} replacesPending={Boolean(pending)}
      onSubmit={start} onCancel={firstRun ? undefined : () => setCreating(false)} />}
    {(error || state.error) && <p role="alert" className="research-error">{error || state.error}</p>}
    {notice && <p role="status" className="research-notice">{notice}</p>}
    {!snapshot && !state.error && <p role="status" className="context-empty">Loading research…</p>}
    {pending && <ResearchPendingCard pending={pending} busy={busy} onWithdraw={api.withdrawResearch ? () => { void withdraw(); } : undefined} />}
    {snapshot && snapshot.runs.length > 1 && run && <label className="research-run-select">Run
      <Select value={run.id} onChange={selectRun} className="research-select"
        options={snapshot.runs.map((r: ResearchRun) => ({ value: r.id, label: excerpt(r.objective, 70), description: researchRunPhase(r).label }))} />
    </label>}
    {run && <>
      <ResearchRunCard key={run.id} run={run} now={now} coordinator={coordinator} writable={writable} busy={busy}
        onStop={() => { void update({ action: "stop", reason: "Stopped by the operator" }); }}
        onFinish={() => { void update({ action: "finish", reason: "Completed after operator review" }); }} />
      <div className="research-tabs" role="tablist" aria-label="Research views" onKeyDown={onTabKeyDown}>
        {views.map((entry) => <button type="button" role="tab" key={entry.id} id={`${tabsId}-${entry.id}`} aria-selected={currentView === entry.id}
          aria-controls={`${tabsId}-panel`} tabIndex={currentView === entry.id ? 0 : -1} onClick={() => chooseView(entry.id)}>
          {entry.label}{entry.id === "review" && reviewCount > 0 && <><span className="research-sr-only">,</span>{" "}<span className="research-tab-count">{reviewCount}</span>{" "}<span className="research-sr-only">to review</span></>}
        </button>)}
      </div>
      <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${currentView}`} className="research-tabpanel">
        {(currentView === "map" || currentView === "findings" || currentView === "activity") && <input className="research-filter" type="search" aria-label="Filter this view"
          placeholder={currentView === "map" ? "Filter approaches and findings" : currentView === "findings" ? "Filter findings" : "Filter activity"} value={filter} onChange={(event) => setFilter(event.target.value)} />}
        {currentView === "discovery" && run.harness?.discovery && <ResearchDiscoveryPanel key={run.id} snapshot={run.harness.discovery} />}
        {currentView === "map" && <ResearchMapView run={run} filter={filter} onOpenItem={openItem}
          onShowApproachItems={(approachId) => { setItemsQuery({ ...EMPTY_RESEARCH_ITEMS_QUERY, approachId }); setOpenItemId(undefined); setView("items"); }} />}
        {currentView === "findings" && <ResearchFindingsView run={run} filter={filter} evidenceAvailable={Boolean(api.openResearchEvidence)} onOpenItem={openItem} onOpenEvidence={(itemId, index) => { void openEvidence(itemId, index); }} />}
        {currentView === "review" && <ResearchReviewView run={run} live={live} canReview={coordinator && writable} busy={busy} evidenceAvailable={Boolean(api.openResearchEvidence)}
          onReview={(submissionId, decision, reason) => update({ action: "review", submissionId, decision, reason })}
          onOpenItem={openItem} onOpenEvidence={(itemId, index) => { void openEvidence(itemId, index); }} />}
        {currentView === "items" && (openItemId
          ? <ResearchItemDetail key={`${run.id}:${openItemId}`} api={api} thread={identity} run={run} itemId={openItemId} writable={writable && !run.harness} coordinator={coordinator}
            onBack={() => { setReturnFocusId(openItemId); setOpenItemId(undefined); }} onOpenItem={openItem} />
          : <ResearchItemsPanel key={`${identity.backend}:${identity.threadId}:${run.id}`} api={api} thread={identity} run={run}
            query={itemsQuery} onQueryChange={setItemsQuery} onOpenItem={openItem} returnFocusId={returnFocusId} onFocusReturned={() => setReturnFocusId(undefined)} />)}
        {currentView === "activity" && <ResearchActivityView run={run} filter={filter} onOpenItem={openItem} />}
      </div>
    </>}
  </section>;
}

function message(error: unknown): string { return error instanceof Error ? error.message : "Research operation failed"; }
