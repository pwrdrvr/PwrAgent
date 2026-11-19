import { useId, useMemo, useState } from "react";
import { sameResearchThread, type NavigationThreadSummary, type ResearchRunSummary, type ResearchThread } from "@pwragent/shared";
import { PopoutIcon } from "../../icons";
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
import { excerpt, isResearchRunLive, researchRunPhase, researchRunView } from "./research-view-model";
import { useResearchSync } from "./useResearchSync";
import { useResearchNow } from "./useResearchNow";
import { researchErrorMessage as message, useResearchRunActions } from "./useResearchRunActions";
import { ResearchTabs } from "./ResearchTabs";
import "./research.css";

const VIEWS = [
  { id: "map", label: "Map" }, { id: "findings", label: "Findings" }, { id: "review", label: "Review" },
  { id: "items", label: "Items" }, { id: "activity", label: "Activity" },
] as const;
const DISCOVERY_VIEWS = [{ id: "discovery", label: "Discovery" }, { id: "activity", label: "Activity" }] as const;
type View = typeof VIEWS[number]["id"] | typeof DISCOVERY_VIEWS[number]["id"];

export function ResearchPanel({ desktopApi: api, thread }: { desktopApi?: DesktopApi; thread?: NavigationThreadSummary }) {
  const remote = Boolean(thread?.federation?.ref.target ?? readRendererFederationTarget());
  const identity = thread && !remote && thread.source === "codex" ? { backend: thread.source, threadId: thread.id } : undefined;
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const state = useResearchSync(api, identity, selectedRunId);
  const tabsId = useId();
  const [view, setView] = useState<View>("map");
  const [filter, setFilter] = useState("");
  const [formBusy, setBusy] = useState(false);
  const [formNotice, setNotice] = useState("");
  const [formError, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [source, setSource] = useState<"native" | "harness">("native");
  const [openItemId, setOpenItemId] = useState<string>();
  const [returnFocusId, setReturnFocusId] = useState<string>();
  const [itemsQuery, setItemsQuery] = useState<ResearchItemsQuery>(EMPTY_RESEARCH_ITEMS_QUERY);
  const runs = state.runs;
  // The run on screen is the chosen one while the thread still lists it, else the newest. Its store arrives
  // after its summary. Until that first sync finishes, show no run: another run's controls would act on a
  // run the selector no longer names.
  const summary = runs?.find((r) => r.id === selectedRunId) ?? runs?.[0];
  const store = state.store;
  const run = useMemo(() => summary && store ? researchRunView(summary, store) : undefined, [summary, store]);
  const loadingRun = Boolean(summary && !run);
  // Read the clock directly: once the request expires, the tick that hid it also stops the timer.
  const pendingLive = Boolean(state.pending && state.pending.expiresAt > Date.now());
  const now = useResearchNow(Boolean(run && isResearchRunLive(run)) || pendingLive);
  // Review, stop, finish, reconcile and evidence act on the run on screen; the forms above keep their own state.
  const actions = useResearchRunActions(api, identity, run?.id);
  const { update, reconcile, openEvidence } = actions;
  const busy = formBusy || actions.busy;
  const notice = formNotice || actions.notice;
  const error = formError || actions.error;
  const pending = state.pending && now < state.pending.expiresAt ? state.pending : undefined;
  const coordinator = Boolean(run && identity && sameResearchThread(run.coordinator, identity));
  const writable = Boolean(run && state.writableRunIds.includes(run.id));
  const live = Boolean(run && isResearchRunLive(run));
  const views = run?.harness?.source === "discovery" ? DISCOVERY_VIEWS : VIEWS;
  const currentView: View = views.some((entry) => entry.id === view) ? view : views[0]!.id;

  function selectRun(id: string) {
    setSelectedRunId(id); setFilter(""); setOpenItemId(undefined); setItemsQuery(EMPTY_RESEARCH_ITEMS_QUERY); setNotice(""); setError(""); actions.reset();
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
    setBusy(true); setError(""); setNotice(""); actions.reset();
    let prepared = false;
    try {
      const { intentId } = await api.prepareResearch({ ...identity, ...values });
      prepared = true;
      await send(identity, `Start a research run using research_start with intentId=${intentId}. Objective: ${values.objective}\nUse exactly ${values.workers} distinct approaches, ${values.minutes === undefined ? "no time limit (omit minutes)" : `minutes=${values.minutes}`}, and workspaceMode=${values.workspaceMode}. These exact limits and objective are bound to the operator's request. Workers inherit this thread's model and access. Propose and distinguish their assignments before starting; explain significant overlap. Review submissions with research_update and record revisions or acceptance. Keep informal acceptance separate from verification. Do not silently change the worker count, or add or change a time limit.`);
      setCreating(false);
      return true;
    } catch (failure) {
      // The coordinator never received the request, so it must not wait to start.
      if (prepared) await api.withdrawResearch?.(identity).catch(() => {});
      setError(message(failure)); return false;
    }
    finally { setBusy(false); }
  }
  function harnessStarted(runId: string) {
    setCreating(false); setSource("native"); selectRun(runId);
  }
  async function withdraw() {
    if (!identity || !api?.withdrawResearch) return;
    setBusy(true); setError(""); setNotice(""); actions.reset();
    try { await api.withdrawResearch(identity); setNotice("Request withdrawn. If this thread tries to start it, the start is refused."); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  if (remote) return <section className="context-panel__section"><h3>Research</h3><p className="context-empty">Open this thread on its owning instance to inspect its research runs.</p></section>;
  if (!identity) return <section className="context-panel__section"><h3>Research</h3><p className="context-empty">Research runs are available in local Codex threads.</p></section>;
  if (!api?.researchSnapshot || !api.researchChanges) return <section className="context-panel__section"><h3>Research</h3><p className="context-empty">Research is unavailable in this window.</p></section>;

  const firstRun = Boolean(runs && runs.length === 0 && !pending);
  const showForm = Boolean(runs) && (creating || firstRun);
  const harnessAvailable = Boolean(api.startResearchHarness);
  const formSource = harnessAvailable ? source : "native";
  const reviewCount = run?.unreviewed ?? 0;
  return <section className="context-panel__section research-panel" aria-label="Research">
    <div className="research-heading">
      <h3>Research</h3>
      {api.openResearchWindow && <button type="button" className="research-icon-button tooltip-target" aria-label="Open in Research window" data-tooltip="Open in Research window"
        onClick={() => { void api.openResearchWindow?.(summary ? { runId: summary.id } : undefined).catch((failure: unknown) => setError(message(failure))); }}><PopoutIcon /></button>}
      {!firstRun && runs && <button type="button" className="research-button" onClick={() => setCreating(!creating)} aria-expanded={creating}>New run</button>}
    </div>
    {showForm && harnessAvailable && <div className="research-switch" role="group" aria-label="Run source">
      <button type="button" aria-pressed={formSource === "native"} onClick={() => setSource("native")}>PwrAgent workers</button>
      <button type="button" aria-pressed={formSource === "harness"} onClick={() => setSource("harness")}>Open Math Harness</button>
    </div>}
    {showForm && formSource === "harness" && <ResearchHarnessForm api={api} thread={identity} onStarted={harnessStarted} onCancel={firstRun ? undefined : () => setCreating(false)} />}
    {showForm && formSource === "native" && <ResearchStartForm firstRun={firstRun} busy={busy} disabled={!api.submitThreadReply || !api.prepareResearch} replacesPending={Boolean(pending)}
      onSubmit={start} onCancel={firstRun ? undefined : () => setCreating(false)} />}
    {(error || state.error) && <p role="alert" className="research-error">{error || state.error}</p>}
    {notice && <p role="status" className="research-notice">{notice}</p>}
    {!runs && !state.error && <p role="status" className="context-empty">Loading research…</p>}
    {pending && <ResearchPendingCard pending={pending} busy={busy} onWithdraw={api.withdrawResearch ? () => { void withdraw(); } : undefined} />}
    {runs && runs.length > 1 && summary && <label className="research-run-select">Run
      <Select value={summary.id} onChange={selectRun} className="research-select"
        options={runs.map((r: ResearchRunSummary) => ({ value: r.id, label: excerpt(r.objective, 70), description: researchRunPhase(r).label }))} />
    </label>}
    {loadingRun && !state.error && <p role="status" className="context-empty">Loading run…</p>}
    {run && <>
      <ResearchRunCard key={run.id} run={run} now={now} coordinator={coordinator} writable={writable} busy={busy}
        onStop={() => { void update({ action: "stop", reason: "Stopped by the operator" }); }}
        onFinish={() => { void update({ action: "finish", reason: "Completed after operator review" }); }}
        onResume={() => { void update({ action: "resume" }); }}
        onReconcile={api.reconcileResearchHarness ? () => { void reconcile(); } : undefined} />
      <ResearchTabs idBase={tabsId} views={views} current={currentView} reviewCount={reviewCount} onChoose={chooseView} />
      <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${currentView}`} className="research-tabpanel">
        {(currentView === "map" || currentView === "findings" || currentView === "activity") && <input className="research-filter" type="search" aria-label="Filter this view"
          placeholder={currentView === "map" ? "Filter approaches and findings" : currentView === "findings" ? "Filter findings" : "Filter activity"} value={filter} onChange={(event) => setFilter(event.target.value)} />}
        {currentView === "discovery" && run.harness?.discovery && <ResearchDiscoveryPanel key={run.id} snapshot={run.harness.discovery} />}
        {currentView === "map" && <ResearchMapView run={run} filter={filter} onOpenItem={openItem}
          onShowApproachItems={(approachId) => { setItemsQuery({ ...EMPTY_RESEARCH_ITEMS_QUERY, approachId }); setOpenItemId(undefined); setView("items"); }} />}
        {currentView === "findings" && <ResearchFindingsView key={run.id} api={api} thread={identity} run={run} filter={filter} evidenceAvailable={Boolean(api.openResearchEvidence)} onOpenItem={openItem} onOpenEvidence={(itemId, index) => { void openEvidence(itemId, index); }} />}
        {currentView === "review" && <ResearchReviewView run={run} live={live} canReview={coordinator && writable} busy={busy} evidenceAvailable={Boolean(api.openResearchEvidence)}
          onReview={(submissionId, decision, reason) => update({ action: "review", submissionId, decision, reason })}
          onOpenItem={openItem} onOpenEvidence={(itemId, index) => { void openEvidence(itemId, index); }} />}
        {currentView === "items" && (openItemId
          ? <ResearchItemDetail key={`${run.id}:${openItemId}`} api={api} thread={identity} run={run} itemId={openItemId} writable={writable && !run.harness} coordinator={coordinator}
            onBack={() => { setReturnFocusId(openItemId); setOpenItemId(undefined); }} onOpenItem={openItem} />
          : <ResearchItemsPanel key={`${identity.backend}:${identity.threadId}:${run.id}`} api={api} thread={identity} run={run}
            query={itemsQuery} onQueryChange={setItemsQuery} onOpenItem={openItem} returnFocusId={returnFocusId} onFocusReturned={() => setReturnFocusId(undefined)} />)}
        {currentView === "activity" && <ResearchActivityView key={run.id} api={api} thread={identity} run={run} filter={filter} onOpenItem={openItem} />}
      </div>
    </>}
  </section>;
}
