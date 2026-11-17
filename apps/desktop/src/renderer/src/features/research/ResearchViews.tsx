import { useEffect, useRef } from "react";
import type { ResearchApproach, ResearchFinding, ResearchRunBoard, ResearchThread } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { ResearchThreadButton } from "./ResearchThreadButton";
import { useResearchActivity } from "./useResearchActivity";
import { approachTitle, excerpt, formatClock, plural, researchActivityRows, researchLabel, researchMapBranches, type ResearchMapBranch } from "./research-view-model";

type Open = (itemId: string) => void;

function approachState(approach: ResearchApproach): string {
  return researchLabel(approach.directionState === "abandoned" ? "abandoned" : approach.state);
}

export function ResearchMapView({ run, filter, onOpenItem, onShowApproachItems }: {
  run: ResearchRunBoard; filter: string; onOpenItem: Open; onShowApproachItems: (approachId: string) => void;
}) {
  const query = filter.trim().toLowerCase();
  const branches = researchMapBranches(run).filter((branch) => !query || branchText(branch).includes(query));
  return <div className="research-map" aria-label="Research map">
    {branches.map((branch) => <MapBranch key={branch.approach.id} run={run} branch={branch} onOpenItem={onOpenItem} onShowApproachItems={onShowApproachItems} />)}
    {!branches.length && <p className="context-empty">{query ? "No approaches match this filter." : "Approaches appear here once the coordinator starts the run."}</p>}
  </div>;
}

function branchText(branch: ResearchMapBranch): string {
  return [branch.approach.title, branch.approach.task, branch.approach.state, branch.approach.note ?? "",
    ...branch.leaves.flatMap((leaf) => [leaf.record.text, ...leaf.children.map(branchText)]), ...branch.assignments.map(branchText)].join(" ").toLowerCase();
}

function MapBranch({ run, branch, onOpenItem, onShowApproachItems, nested = false }: {
  run: ResearchRunBoard; branch: ResearchMapBranch; onOpenItem: Open; onShowApproachItems: (approachId: string) => void; nested?: boolean;
}) {
  const { approach } = branch;
  return <div className={`research-map__branch${nested ? " research-map__branch--nested" : ""}`}>
    <div className="research-map__approach">
      <button type="button" className="research-map__title" onClick={() => onOpenItem(approach.id)}>
        {nested && <span className="research-muted">Focused child · </span>}{approach.title}
      </button>
      <span className="research-chip">{approachState(approach)}</span>
      {approach.worker && <ResearchThreadButton thread={approach.worker} title="Open worker" label={`Open worker thread: ${approach.title}`} />}
    </div>
    <p className="research-muted research-clamp">{approach.task}</p>
    {approach.note && <p className="research-muted">{approach.note}</p>}
    {approach.overlapsApproachId && <p className="research-muted">Overlaps {approachTitle(run, approach.overlapsApproachId)}</p>}
    {(branch.leaves.length > 0 || branch.assignments.length > 0) && <div className="research-map__children">
      {branch.leaves.map((leaf) => <div key={leaf.record.id} className="research-map__leaf">
        <button type="button" className="research-node" onClick={() => onOpenItem(leaf.record.id)}>
          <span className="research-node__meta">{leaf.type === "finding" ? researchLabel(leaf.record.kind) : `Candidate · ${leaf.record.review ? researchLabel(leaf.record.review.decision) : "Awaiting review"}`}</span>
          {" "}{excerpt(leaf.record.text)}
        </button>
        {leaf.children.map((child) => <MapBranch key={child.approach.id} run={run} branch={child} onOpenItem={onOpenItem} onShowApproachItems={onShowApproachItems} nested />)}
      </div>)}
      {branch.hidden > 0 && <button type="button" className="research-link" onClick={() => onShowApproachItems(approach.id)}>{branch.hidden} more from {approach.title}</button>}
      {branch.assignments.map((child) => <MapBranch key={child.approach.id} run={run} branch={child} onOpenItem={onOpenItem} onShowApproachItems={onShowApproachItems} nested />)}
    </div>}
  </div>;
}

export function ResearchFindingsView({ run, filter, evidenceAvailable, onOpenItem, onOpenEvidence }: {
  run: ResearchRunBoard; filter: string; evidenceAvailable: boolean; onOpenItem: Open; onOpenEvidence: (itemId: string, pathIndex: number) => void;
}) {
  const query = filter.trim().toLowerCase();
  const findings = [...run.findings].reverse().filter((f) => !query || `${f.kind} ${f.text} ${approachTitle(run, f.approachId)} ${f.paths.join(" ")}`.toLowerCase().includes(query));
  return <div className="research-list" aria-label="Shared findings">
    {findings.map((finding) => <FindingCard key={finding.id} run={run} finding={finding} evidenceAvailable={evidenceAvailable} onOpenItem={onOpenItem} onOpenEvidence={onOpenEvidence} />)}
    {!run.findings.length && <p className="context-empty">Findings appear here as workers share evidence.</p>}
    {run.findings.length > 0 && !findings.length && <p className="context-empty">No findings match this filter.</p>}
  </div>;
}

function FindingCard({ run, finding, evidenceAvailable, onOpenItem, onOpenEvidence }: {
  run: ResearchRunBoard; finding: ResearchFinding; evidenceAvailable: boolean; onOpenItem: Open; onOpenEvidence: (itemId: string, pathIndex: number) => void;
}) {
  const related = finding.relatesTo ? run.findings.find((other) => other.id === finding.relatesTo) : undefined;
  return <article className="research-entry" aria-label={`${researchLabel(finding.kind)} from ${approachTitle(run, finding.approachId)}`}>
    <div className="research-entry__meta"><span className="research-chip">{researchLabel(finding.kind)}</span><span>{approachTitle(run, finding.approachId)}</span></div>
    <button type="button" className="research-entry__open" onClick={() => onOpenItem(finding.id)}>{finding.text}</button>
    {finding.relatesTo && <button type="button" className="research-link" onClick={() => onOpenItem(finding.relatesTo!)}>
      {researchLabel(finding.relation ?? "related")}: {related ? excerpt(related.text, 80) : "an earlier finding"}
    </button>}
    {finding.paths.length > 0 && <EvidenceList paths={finding.paths} available={evidenceAvailable} onOpen={(index) => onOpenEvidence(finding.id, index)} />}
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
  api: DesktopApi; thread: ResearchThread; run: ResearchRunBoard; filter: string; onOpenItem: Open;
}) {
  const activity = useResearchActivity(api, thread, run.id, run.revision);
  const query = filter.trim().toLowerCase();
  const loaded = activity.loaded.events;
  const rows = researchActivityRows(run, loaded).filter((row) => !query || `${row.kind} ${row.actor} ${row.text}`.toLowerCase().includes(query));
  const known = new Set(run.items.map((item) => item.id));
  const older = activity.loaded.nextBeforeSeq !== undefined;
  const list = useRef<HTMLOListElement>(null);
  // Show older disappears with the last page; keep focus in the list instead of dropping it to the page.
  const requestedOlder = useRef(false);
  useEffect(() => {
    if (older || !requestedOlder.current) return;
    requestedOlder.current = false;
    list.current?.focus();
  }, [older]);
  return <div className="research-activity-panel">
    {activity.error && <p role="alert" className="research-error">{activity.error}</p>}
    <ol ref={list} tabIndex={-1} className="research-activity" aria-label="Research activity" reversed>
      {rows.map((row) => <li key={row.seq}>
        <span className="research-activity__meta"><time dateTime={new Date(row.at).toISOString()}>{formatClock(row.at)}</time> · {row.actor} · {row.kind}</span>
        {row.itemId && known.has(row.itemId)
          ? <button type="button" className="research-activity__text" onClick={() => onOpenItem(row.itemId!)}>{row.text}</button>
          : <p className="research-activity__text">{row.text}</p>}
      </li>)}
    </ol>
    {!loaded.length && !activity.error && <p role="status" className="context-empty">Loading activity…</p>}
    {loaded.length > 0 && query && !rows.length && <p className="context-empty">No loaded activity matches this filter.</p>}
    {loaded.length > 0 && <div className="research-activity__footer">
      <span className="research-muted" role="status">{older ? `Showing the latest ${loaded.length} of ${run.revision} events.` : `All ${plural(loaded.length, "event")}.`}</span>
      {older && <button type="button" className="research-button" disabled={activity.loadingOlder || !activity.available} onClick={() => { requestedOlder.current = true; activity.showOlder(); }}>
        {activity.loadingOlder ? "Loading…" : "Show older"}
      </button>}
    </div>}
  </div>;
}
