import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ResearchDecisionBatchSummary, ResearchFinding, ResearchThread } from "@pwragent/shared/research";
import type { DesktopApi } from "../../lib/desktop-api";
import { ResearchDecisionEvidenceList } from "./ResearchDecisionsView";
import { ResearchThreadButton } from "./ResearchThreadButton";
import { useResearchActivity } from "./useResearchActivity";
import { ResearchSourceTag } from "./ResearchSourceTag";
import { RESEARCH_FINDINGS_PAGE, useResearchFindings } from "./useResearchFindings";
import {
  approachTitle, excerpt, formatClock, plural, RESEARCH_FOCUSED_CHILD_PREFIX, researchActivityRows, researchApproachOverlap, researchApproachStateLabel, researchFindingMatches, researchFindingRelation,
  researchLabel, researchMapBranches, researchMapLeafLabel, researchMapMatches, researchMapMoreLabel, type ResearchMapBranch, type ResearchRunView,
} from "./research-view-model";

type Open = (itemId: string) => void;

/** Every approach with its newest contributions. A filter keeps the branches that show its text. */
export function ResearchMapView({ run, filter, onOpenItem, onShowApproachItems }: {
  run: ResearchRunView; filter: string; onOpenItem: Open; onShowApproachItems: (approachId: string) => void;
}) {
  const all = useMemo(() => researchMapBranches(run), [run]);
  const branches = useMemo(() => researchMapMatches(run, all, filter), [run, all, filter]);
  return <div className="research-map" aria-label="Research map">
    {branches.map((branch) => <MapBranch key={branch.approach.id} run={run} branch={branch} onOpenItem={onOpenItem} onShowApproachItems={onShowApproachItems} />)}
    {!branches.length && <p className="context-empty">{filter.trim() ? "No approaches match this filter." : "Approaches appear here once the coordinator starts the run."}</p>}
  </div>;
}

function MapBranch({ run, branch, onOpenItem, onShowApproachItems, nested = false }: {
  run: ResearchRunView; branch: ResearchMapBranch; onOpenItem: Open; onShowApproachItems: (approachId: string) => void; nested?: boolean;
}) {
  const { approach } = branch;
  const overlap = researchApproachOverlap(run, approach);
  const more = researchMapMoreLabel(branch);
  return <div className={`research-map__branch${nested ? " research-map__branch--nested" : ""}`}>
    <div className="research-map__approach">
      <button type="button" className="research-map__title" onClick={() => onOpenItem(approach.id)}>
        {nested && <span className="research-muted">{RESEARCH_FOCUSED_CHILD_PREFIX}</span>}{approach.title}
      </button>
      <span className="research-chip">{researchApproachStateLabel(approach)}</span>
      {approach.worker && <ResearchThreadButton thread={approach.worker} title="Open worker" label={`Open worker thread: ${approach.title}`} />}
    </div>
    {/* A source direction's title is its text; do not print it twice. */}
    {approach.task !== approach.title && <p className="research-muted research-clamp">{approach.task}</p>}
    {approach.note && <p className="research-muted">{approach.note}</p>}
    {overlap && <p className="research-muted">{overlap}</p>}
    {(branch.leaves.length > 0 || branch.assignments.length > 0) && <div className="research-map__children">
      {branch.leaves.map((leaf) => <div key={leaf.record.id} className="research-map__leaf">
        <button type="button" className="research-node" onClick={() => onOpenItem(leaf.record.id)}>
          <span className="research-node__meta">{researchMapLeafLabel(leaf)}</span>
          {" "}{excerpt(leaf.record.text)}
        </button>
        {leaf.children.map((child) => <MapBranch key={child.approach.id} run={run} branch={child} onOpenItem={onOpenItem} onShowApproachItems={onShowApproachItems} nested />)}
      </div>)}
      {more && <button type="button" className="research-link" onClick={() => onShowApproachItems(approach.id)}>{more}</button>}
      {branch.assignments.map((child) => <MapBranch key={child.approach.id} run={run} branch={child} onOpenItem={onOpenItem} onShowApproachItems={onShowApproachItems} nested />)}
    </div>}
  </div>;
}

/**
 * Newest first, a page at a time. Unfiltered, the owner's search pages the
 * list and each card's record comes from the run's store. A filter matches
 * what the cards show, across every finding of the run, in the window.
 */
export function ResearchFindingsView({ api, thread, run, filter, evidenceAvailable, batchesById, onOpenBatch, onOpenItem, onOpenEvidence }: {
  api: DesktopApi; thread: ResearchThread; run: ResearchRunView; filter: string; evidenceAvailable: boolean;
  batchesById?: ReadonlyMap<string, ResearchDecisionBatchSummary>;
  onOpenBatch?: (batchId: string) => void;
  onOpenItem: Open; onOpenEvidence: (itemId: string, pathIndex: number) => void;
}) {
  const query = filter.trim().toLowerCase();
  const paged = useResearchFindings(api, thread, run.id, run.findings);
  const matches = useMemo(() => query ? researchFindingMatches(run, query) : undefined, [run, query]);
  // How many matches are drawn. A new filter starts again from one page.
  const [drawn, setDrawn] = useState({ query, count: RESEARCH_FINDINGS_PAGE });
  const count = drawn.query === query ? drawn.count : RESEARCH_FINDINGS_PAGE;
  const shown = matches
    ? matches.slice(0, count)
    // A hit read just ahead of the store draws once its item arrives.
    : paged.loaded.hits.flatMap((hit) => { const item = run.items.get(hit.id); return item?.type === "finding" ? [item.record] : []; });
  const total = matches ? matches.length : paged.loaded.total;
  const more = matches ? count < matches.length : paged.loaded.next !== undefined;
  const loaded = Boolean(matches) || paged.loaded.loaded;
  const loadingOlder = !matches && paged.loadingOlder;
  const error = matches ? "" : paged.error;
  const list = useRef<HTMLDivElement>(null);
  // Show more disappears with the last page; keep focus in the list instead of dropping it to the page.
  // The click is forgotten once its page is drawn: a filter that hides the button later must not take focus from the filter box.
  const requestedMore = useRef(false);
  useEffect(() => {
    if (!requestedMore.current || loadingOlder) return;
    requestedMore.current = false;
    if (!more) list.current?.focus();
  }, [more, shown.length, loadingOlder]);
  const showMore = () => {
    requestedMore.current = true;
    if (matches) setDrawn({ query, count: count + RESEARCH_FINDINGS_PAGE });
    else paged.showOlder();
  };
  const noun = matches ? "matching finding" : "finding";
  return <div ref={list} tabIndex={-1} className="research-list" aria-label="Shared findings">
    {error && <p role="alert" className="research-error">{error}</p>}
    {shown.map((finding) => <FindingCard key={finding.id} run={run} finding={finding} evidenceAvailable={evidenceAvailable} batchesById={batchesById} onOpenBatch={onOpenBatch} onOpenItem={onOpenItem} onOpenEvidence={onOpenEvidence} />)}
    {!matches && !paged.available && <p className="context-empty">Findings are unavailable in this window.</p>}
    {!matches && paged.available && !loaded && !error && <p role="status" className="context-empty">Loading findings…</p>}
    {loaded && !run.findings && <p className="context-empty">Findings appear here as workers share evidence.</p>}
    {matches && run.findings > 0 && !shown.length && <p className="context-empty">No findings match this filter.</p>}
    {shown.length > 0 && <div className="research-activity__footer">
      <span className="research-muted">{more ? `Showing the latest ${shown.length} of ${total} ${noun}s.` : `All ${plural(shown.length, noun)}.`}</span>
      {more && <button type="button" className="research-button" disabled={loadingOlder} onClick={showMore}>
        {loadingOlder ? "Loading…" : "Show more"}
      </button>}
    </div>}
  </div>;
}

function FindingCard({ run, finding, evidenceAvailable, batchesById, onOpenBatch, onOpenItem, onOpenEvidence }: {
  run: ResearchRunView; finding: ResearchFinding; evidenceAvailable: boolean;
  batchesById?: ReadonlyMap<string, ResearchDecisionBatchSummary>;
  onOpenBatch?: (batchId: string) => void;
  onOpenItem: Open; onOpenEvidence: (itemId: string, pathIndex: number) => void;
}) {
  const relation = researchFindingRelation(run, finding);
  return <article className="research-entry" aria-label={`${researchLabel(finding.kind)} from ${approachTitle(run, finding.approachId)}`}>
    <div className="research-entry__meta"><span className="research-chip">{researchLabel(finding.kind)}</span><span>{approachTitle(run, finding.approachId)}</span></div>
    <button type="button" className="research-entry__open" onClick={() => onOpenItem(finding.id)}>{finding.text}</button>
    {run.harness && <ResearchSourceTag run={run} itemId={finding.id} />}
    {relation && <button type="button" className="research-link" onClick={() => onOpenItem(finding.relatesTo!)}>{relation}</button>}
    {finding.paths.length > 0 && <EvidenceList paths={finding.paths} available={evidenceAvailable} onOpen={(index) => onOpenEvidence(finding.id, index)} />}
    <ResearchDecisionEvidenceList text={finding.text} paths={finding.paths} batchesById={batchesById} onOpenBatch={onOpenBatch} />
    {finding.author && <ResearchThreadButton thread={finding.author} title="Open source thread" label={`Open source thread: ${approachTitle(run, finding.approachId)}`} />}
  </article>;
}

export function EvidenceList({ paths, available, onOpen }: { paths: string[]; available: boolean; onOpen: (index: number) => void }) {
  return <ul className="research-evidence-list" aria-label="Evidence">
    {paths.map((path, index) => <li key={`${index}:${path}`}><button className="research-evidence" type="button" disabled={!available} onClick={() => onOpen(index)}>{path}</button></li>)}
  </ul>;
}

/** Newest first. The journal is read in pages; the filter covers what is loaded. */
export function ResearchActivityView({ api, thread, run, filter, onOpenItem }: {
  api: DesktopApi; thread: ResearchThread; run: ResearchRunView; filter: string; onOpenItem: Open;
}) {
  const activity = useResearchActivity(api, thread, run.id, run.revision);
  const query = filter.trim().toLowerCase();
  const loaded = activity.loaded.events;
  const allRows = useMemo(() => researchActivityRows(run, loaded), [run, loaded]);
  const rows = query ? allRows.filter((row) => `${row.kind} ${row.actor} ${row.text}`.toLowerCase().includes(query)) : allRows;
  // A head read can land before the board that announced it.
  const total = Math.max(run.revision, loaded[0]?.seq ?? 0);

  const older = activity.loaded.nextBeforeSeq !== undefined;
  const list = useRef<HTMLOListElement>(null);
  // Move focus in the same commit that removes Show older on the last page.
  const requestedOlder = useRef(false);
  useLayoutEffect(() => {
    if (older || !requestedOlder.current) return;
    requestedOlder.current = false;
    list.current?.focus();
  }, [older]);
  return <div className="research-activity-panel">
    {activity.error && <p role="alert" className="research-error">{activity.error}</p>}
    <ol ref={list} tabIndex={-1} className="research-activity" aria-label="Research activity" reversed>
      {rows.map((row) => <li key={row.seq}>
        <span className="research-activity__meta"><time dateTime={new Date(row.at).toISOString()}>{formatClock(row.at)}</time> · {row.actor} · {row.kind}</span>
        {row.itemId && run.items.has(row.itemId)
          ? <button type="button" className="research-activity__text" onClick={() => onOpenItem(row.itemId!)}>{row.text}</button>
          : <p className="research-activity__text">{row.text}</p>}
      </li>)}
    </ol>
    {!activity.available && <p className="context-empty">Activity is unavailable in this window.</p>}
    {activity.available && !loaded.length && !activity.error && <p role="status" className="context-empty">Loading activity…</p>}
    {loaded.length > 0 && query && !rows.length && <p className="context-empty">No loaded activity matches this filter.</p>}
    {loaded.length > 0 && <div className="research-activity__footer">
      <span className="research-muted">{older ? `Showing the latest ${loaded.length} of ${total} events.` : `All ${plural(loaded.length, "event")}.`}</span>
      {older && <button type="button" className="research-button" disabled={activity.loadingOlder || !activity.available} onClick={() => { requestedOlder.current = true; activity.showOlder(); }}>
        {activity.loadingOlder ? "Loading…" : "Show older"}
      </button>}
    </div>}
  </div>;
}
