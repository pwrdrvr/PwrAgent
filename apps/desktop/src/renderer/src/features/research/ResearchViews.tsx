import type { ResearchApproach, ResearchFinding, ResearchRun } from "@pwragent/shared";
import { ResearchThreadButton } from "./ResearchThreadButton";
import { approachTitle, excerpt, formatClock, researchActivityRows, researchLabel, researchMapBranches, type ResearchMapBranch } from "./research-view-model";

type Open = (itemId: string) => void;

function approachState(approach: ResearchApproach): string {
  return researchLabel(approach.directionState === "abandoned" ? "abandoned" : approach.state);
}

export function ResearchMapView({ run, filter, onOpenItem, onShowApproachItems }: {
  run: ResearchRun; filter: string; onOpenItem: Open; onShowApproachItems: (approachId: string) => void;
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
  run: ResearchRun; branch: ResearchMapBranch; onOpenItem: Open; onShowApproachItems: (approachId: string) => void; nested?: boolean;
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
  run: ResearchRun; filter: string; evidenceAvailable: boolean; onOpenItem: Open; onOpenEvidence: (itemId: string, pathIndex: number) => void;
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
  run: ResearchRun; finding: ResearchFinding; evidenceAvailable: boolean; onOpenItem: Open; onOpenEvidence: (itemId: string, pathIndex: number) => void;
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

export function ResearchActivityView({ run, filter, onOpenItem }: { run: ResearchRun; filter: string; onOpenItem: Open }) {
  const query = filter.trim().toLowerCase();
  const rows = researchActivityRows(run).filter((row) => !query || `${row.kind} ${row.actor} ${row.text}`.toLowerCase().includes(query));
  const known = new Set(run.items.map((item) => item.id));
  return <ol className="research-activity" aria-label="Research activity" reversed>
    {rows.map((row) => <li key={row.seq}>
      <span className="research-activity__meta"><time dateTime={new Date(row.at).toISOString()}>{formatClock(row.at)}</time> · {row.actor} · {row.kind}</span>
      {row.itemId && known.has(row.itemId)
        ? <button type="button" className="research-activity__text" onClick={() => onOpenItem(row.itemId!)}>{row.text}</button>
        : <p className="research-activity__text">{row.text}</p>}
    </li>)}
    {run.events.length > 100 && !query && <li className="research-muted">Showing the latest 100 of {run.events.length} events.</li>}
  </ol>;
}
