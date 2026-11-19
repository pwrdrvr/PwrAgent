import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { RESEARCH_RUN_ATTENTION_ORDER, type ResearchProfileRun, type ResearchRunAttention, type ResearchThread } from "@pwragent/shared";
import { useDesktopApi, type DesktopApi } from "../../lib/desktop-api";
import { BrandLockup } from "../chrome/BrandLockup";
import { ResearchDiscoveryPanel } from "./ResearchDiscoveryPanel";
import { ResearchItemDetail } from "./ResearchItemDetail";
import { EMPTY_RESEARCH_ITEMS_QUERY, ResearchItemsPanel, type ResearchItemsQuery } from "./ResearchItemsPanel";
import { CandidateDecision, ResearchReviewView } from "./ResearchReviewView";
import { ResearchRunCard } from "./ResearchRunCard";
import { ResearchTabs } from "./ResearchTabs";
import { ResearchThreadOpener } from "./ResearchThreadButton";
import { ResearchActivityView, ResearchFindingsView, ResearchMapView } from "./ResearchViews";
import { formatRunWhen, isResearchRunLive, researchRunPhase, researchRunView } from "./research-view-model";
import { useResearchNow } from "./useResearchNow";
import { useResearchProfileRuns } from "./useResearchProfileRuns";
import { useResearchRunActions } from "./useResearchRunActions";
import { useResearchSync } from "./useResearchSync";
import "./research.css";

const VIEWS = [
  { id: "map", label: "Map" }, { id: "findings", label: "Findings" }, { id: "review", label: "Review" },
  { id: "items", label: "Items" }, { id: "activity", label: "Activity" },
] as const;
const DISCOVERY_VIEWS = [{ id: "discovery", label: "Discovery" }, { id: "activity", label: "Activity" }] as const;
type View = typeof VIEWS[number]["id"] | typeof DISCOVERY_VIEWS[number]["id"];
type Source = "all" | "native" | "harness";
const GROUP_LABELS: Record<ResearchRunAttention, string> = { needs_you: "Needs you", live: "Live", retained: "Retained" };

/** The run a new window was opened on: `#research?run=<id>`. */
function runFromHash(): string | undefined {
  const query = window.location.hash.split("?")[1];
  return query ? new URLSearchParams(query).get("run") ?? undefined : undefined;
}

/**
 * Every research run this profile owns, with one selected. The thread's
 * context panel stays the quick, thread-scoped view; this window is for
 * supervising several runs and for views that need width. Each run is read
 * and acted on as its coordinating thread, through the same owner contract.
 */
export function ResearchWindow({ desktopApi }: { desktopApi?: DesktopApi }) {
  const windowApi = useDesktopApi();
  const api = desktopApi ?? windowApi;
  const id = useId();
  const [source, setSource] = useState<Source>("all");
  const [search, setSearch] = useState("");
  const [text, setText] = useState("");
  const [selectedId, setSelectedId] = useState(runFromHash);
  useEffect(() => { document.title = "Research"; }, []);
  // The owner reads the list for each filter; wait for a pause in typing.
  useEffect(() => { const timer = window.setTimeout(() => setText(search.trim()), 200); return () => window.clearTimeout(timer); }, [search]);
  const subscribeSelect = api?.onResearchWindowSelect;
  useEffect(() => subscribeSelect?.((runId) => { setSelectedId(runId); setSource("all"); setSearch(""); setText(""); }), [subscribeSelect]);
  const list = useResearchProfileRuns(api, { ...(source === "all" ? {} : { source }), ...(text ? { text } : {}) });
  const selected = list.runs?.find((run) => run.id === selectedId) ?? list.runs?.[0];
  const now = useResearchNow(list.counts.needs_you + list.counts.live > 0);
  const openThread = useCallback((thread: ResearchThread) => { void api?.openThreadInMainWindow?.({ backend: thread.backend, threadId: thread.threadId }); }, [api]);
  const filtered = source !== "all" || Boolean(text);

  return <div className="messaging-activity-window research-window"><section aria-label="Research" className="activity-screen">
    <header className="activity-titlebar">
      <BrandLockup variant="activity-titlebar" />
      <div className="activity-titlebar__breadcrumb"><span className="activity-titlebar__eyebrow">Research</span>
        {selected && <><span aria-hidden="true" className="activity-titlebar__separator">›</span>
          <span className="activity-titlebar__current">{selected.objective}</span></>}</div>
      <div className="activity-titlebar__spacer" />
      {selected && api?.openThreadInMainWindow && <button type="button" className="research-button" onClick={() => openThread(selected.coordinator)}>Open coordinating thread</button>}
    </header>
    <ResearchThreadOpener.Provider value={api?.openThreadInMainWindow ? openThread : undefined}>
      <div className="research-window__body">
        <nav className="research-window__rail research-panel" aria-label="Research runs">
          <input className="research-filter" type="search" aria-label="Search runs" placeholder="Search objectives" value={search} onChange={(event) => setSearch(event.target.value)} />
          <div className="research-switch" role="group" aria-label="Run source">
            {(["all", "native", "harness"] as const).map((value) => <button key={value} type="button" aria-pressed={source === value} onClick={() => setSource(value)}>
              {value === "all" ? "All" : value === "native" ? "PwrAgent" : "Harness"}</button>)}
          </div>
          {list.error && <p role="alert" className="research-error">{list.error}</p>}
          {!list.runs && !list.error && <p role="status" className="context-empty">Loading research…</p>}
          {list.runs && !list.runs.length && <p className="context-empty">{filtered ? "No runs match."
            : "No research runs yet. A run starts from a thread: open the thread’s Research panel and choose New run."}</p>}
          {RESEARCH_RUN_ATTENTION_ORDER.map((group) => {
            const runs = list.runs?.filter((run) => run.attention === group) ?? [];
            if (!runs.length) return null;
            return <section key={group} aria-labelledby={`${id}-${group}`}>
              <h2 id={`${id}-${group}`} className="research-group research-window__group">{GROUP_LABELS[group]}
                <span className={group === "needs_you" ? "research-tab-count" : "research-window__count"}>{list.counts[group]}</span></h2>
              <ul className="research-window__runs">{runs.map((run) => <li key={run.id}>
                <RunRow run={run} now={now} selected={run.id === selected?.id} onSelect={() => setSelectedId(run.id)} />
              </li>)}</ul>
            </section>;
          })}
          {list.more && <button type="button" className="research-button" onClick={list.loadMore}>Show more runs</button>}
        </nav>
        {api && selected
          ? <ResearchWindowRun key={selected.id} api={api} listed={selected} />
          : <main className="research-window__main research-panel" aria-label="Research run">
            {list.runs && <p className="context-empty">{list.runs.length ? "Choose a run." : "Runs appear here once a thread starts or imports one."}</p>}
          </main>}
      </div>
    </ResearchThreadOpener.Provider>
  </section></div>;
}

function RunRow({ run, now, selected, onSelect }: { run: ResearchProfileRun; now: number; selected: boolean; onSelect: () => void }) {
  const phase = researchRunPhase(run);
  return <button type="button" className="research-window__run" aria-current={selected ? "true" : undefined} onClick={onSelect}>
    <span className="research-window__run-top">
      <span className={`research-chip research-chip--${phase.tone}`}>{phase.label}</span>
      {run.harness && <span className="research-window__tag">Harness</span>}
    </span>
    <span className="research-window__run-title">{run.objective}</span>
    <span className="research-window__run-meta">{run.thread ? run.thread.title : "Thread unavailable"}{run.thread?.project ? ` · ${run.thread.project}` : ""} · {formatRunWhen(run.createdAt, now)}</span>
  </button>;
}

/** One run at full width: its card and views, with the selected item in an inspector beside them. */
function ResearchWindowRun({ api, listed }: { api: DesktopApi; listed: ResearchProfileRun }) {
  const { backend, threadId } = listed.coordinator;
  const identity = useMemo(() => ({ backend, threadId }), [backend, threadId]);
  const tabsId = useId();
  const state = useResearchSync(api, identity, listed.id);
  const summary = state.runs?.find((entry) => entry.id === listed.id);
  const run = useMemo(() => summary && state.store ? researchRunView(summary, state.store) : undefined, [summary, state.store]);
  const live = Boolean(run && isResearchRunLive(run));
  const now = useResearchNow(live);
  const actions = useResearchRunActions(api, identity, run?.id);
  const [view, setView] = useState<View>("map");
  const [filter, setFilter] = useState("");
  const [itemsQuery, setItemsQuery] = useState<ResearchItemsQuery>(EMPTY_RESEARCH_ITEMS_QUERY);
  const [inspected, setInspected] = useState<string>();
  const writable = Boolean(run && state.writableRunIds.includes(run.id));
  const views = run?.harness?.source === "discovery" ? DISCOVERY_VIEWS : VIEWS;
  const currentView: View = views.some((entry) => entry.id === view) ? view : views[0]!.id;
  const inspectedItem = inspected && run ? run.items.get(inspected) : undefined;
  const submission = inspectedItem?.type === "submission" ? run?.submissions.find((entry) => entry.id === inspectedItem.id) : undefined;
  const openEvidence = (itemId: string, index: number) => { void actions.openEvidence(itemId, index); };

  return <>
    <main className="research-window__main research-panel" aria-label="Research run">
      {state.error && <p role="alert" className="research-error">{state.error}</p>}
      {actions.error && <p role="alert" className="research-error">{actions.error}</p>}
      {actions.notice && <p role="status" className="research-notice">{actions.notice}</p>}
      {!run && !state.error && <p role="status" className="context-empty">{state.runs && !summary ? "This run is no longer among its thread’s runs." : "Loading run…"}</p>}
      {run && <>
        <ResearchRunCard run={run} now={now} coordinator writable={writable} busy={actions.busy}
          onStop={() => { void actions.update({ action: "stop", reason: "Stopped by the operator" }); }}
          onFinish={() => { void actions.update({ action: "finish", reason: "Completed after operator review" }); }}
          onReconcile={api.reconcileResearchHarness ? () => { void actions.reconcile(); } : undefined} />
        <ResearchTabs idBase={tabsId} views={views} current={currentView} reviewCount={run.unreviewed} onChoose={(next) => { setView(next); setFilter(""); }} />
        <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${currentView}`} className="research-tabpanel">
          {(currentView === "map" || currentView === "findings" || currentView === "activity") && <input className="research-filter" type="search" aria-label="Filter this view"
            placeholder={currentView === "map" ? "Filter approaches and findings" : currentView === "findings" ? "Filter findings" : "Filter activity"} value={filter} onChange={(event) => setFilter(event.target.value)} />}
          {currentView === "discovery" && run.harness?.discovery && <ResearchDiscoveryPanel snapshot={run.harness.discovery} />}
          {currentView === "map" && <ResearchMapView run={run} filter={filter} onOpenItem={setInspected}
            onShowApproachItems={(approachId) => { setItemsQuery({ ...EMPTY_RESEARCH_ITEMS_QUERY, approachId }); setView("items"); }} />}
          {currentView === "findings" && <ResearchFindingsView api={api} thread={identity} run={run} filter={filter} evidenceAvailable={Boolean(api.openResearchEvidence)} onOpenItem={setInspected} onOpenEvidence={openEvidence} />}
          {currentView === "review" && <ResearchReviewView run={run} live={live} canReview={writable} busy={actions.busy} evidenceAvailable={Boolean(api.openResearchEvidence)}
            onReview={(submissionId, decision, reason) => actions.update({ action: "review", submissionId, decision, reason })} onOpenItem={setInspected} onOpenEvidence={openEvidence} />}
          {currentView === "items" && <ResearchItemsPanel api={api} thread={identity} run={run} query={itemsQuery} onQueryChange={setItemsQuery} onOpenItem={setInspected} />}
          {currentView === "activity" && <ResearchActivityView api={api} thread={identity} run={run} filter={filter} onOpenItem={setInspected} />}
        </div>
      </>}
    </main>
    {run && inspected && <aside className="research-window__inspector research-panel" aria-label="Selected item"
      onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); setInspected(undefined); } }}>
      <ResearchItemDetail key={`${run.id}:${inspected}`} api={api} thread={identity} run={run} itemId={inspected} writable={writable && !run.harness} coordinator
        onBack={() => setInspected(undefined)} backLabel="Close" onOpenItem={setInspected}>
        {submission && <CandidateDecision run={run} submission={submission} live={live} canReview={writable} busy={actions.busy}
          blocked="Another running PwrAgent process owns this run. Record the decision from that process."
          onReview={(submissionId, decision, reason) => actions.update({ action: "review", submissionId, decision, reason })} />}
      </ResearchItemDetail>
    </aside>}
  </>;
}
