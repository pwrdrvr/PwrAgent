import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { RESEARCH_FINDING_KINDS, RESEARCH_WORK_STATES, type ResearchSearchHit, type ResearchSearchPage, type ResearchSearchQuery, type ResearchThread } from "@pwragent/shared";
import { Select, type SelectOption } from "../../components/Select";
import type { DesktopApi } from "../../lib/desktop-api";
import { approachTitle, plural, researchLabel, type ResearchRunView } from "./research-view-model";

/** Item search filters. Kept by the panel so a detail view or another tab does not reset them. */
export type ResearchItemsQuery = {
  text: string;
  type: "" | NonNullable<ResearchSearchQuery["type"]>;
  kind: "" | NonNullable<ResearchSearchQuery["kind"]>;
  state: "" | NonNullable<ResearchSearchQuery["state"]>;
  review: "" | NonNullable<ResearchSearchQuery["review"]>;
  approachId?: string;
  cursor?: ResearchSearchQuery["cursor"];
};
export const EMPTY_RESEARCH_ITEMS_QUERY: ResearchItemsQuery = { text: "", type: "", kind: "", state: "", review: "" };
const PAGE_SIZE = 10;

const TYPE_OPTIONS: SelectOption<ResearchItemsQuery["type"]>[] = [
  { value: "", label: "All types" }, { value: "approach", label: "Approaches" }, { value: "finding", label: "Findings" }, { value: "submission", label: "Candidates" },
];
const KIND_OPTIONS: SelectOption<ResearchItemsQuery["kind"]>[] = [{ value: "", label: "All kinds" }, ...RESEARCH_FINDING_KINDS.map((value) => ({ value, label: researchLabel(value) }))];
const STATE_OPTIONS: SelectOption<ResearchItemsQuery["state"]>[] = [{ value: "", label: "Any progress" }, ...RESEARCH_WORK_STATES.map((value) => ({ value, label: researchLabel(value) }))];
const REVIEW_OPTIONS: SelectOption<ResearchItemsQuery["review"]>[] = [
  { value: "", label: "Any decision" }, { value: "unreviewed", label: "Awaiting review" }, { value: "accepted", label: "Accepted" },
  { value: "revision_requested", label: "Revision requested" }, { value: "rejected", label: "Rejected" },
];

export function ResearchItemsPanel({ api, thread, run, query, onQueryChange, onOpenItem, returnFocusId, onFocusReturned }: {
  api: DesktopApi; thread: ResearchThread; run: ResearchRunView; query: ResearchItemsQuery;
  onQueryChange: (query: ResearchItemsQuery) => void; onOpenItem: (itemId: string) => void;
  /** Focus this result once it renders, as Back from its detail, then report it so later refreshes leave focus alone. */
  returnFocusId?: string; onFocusReturned?: () => void;
}) {
  const id = useId();
  const [text, setText] = useState(query.text);
  const [result, setResult] = useState<{ key: string; page?: ResearchSearchPage; error?: string }>({ key: "" });
  const [retry, setRetry] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const { backend, threadId } = thread;
  const runId = run.id;
  const revision = run.revision;
  // A board change invalidates cursors, so a stale page restarts at the first page.
  const cursor = query.cursor?.revision === revision ? query.cursor : undefined;
  const { text: queryText, type, kind, state, review, approachId } = query;
  const key = JSON.stringify([runId, revision, queryText, type, kind, state, review, approachId, cursor, retry]);
  const searchResearch = api.searchResearch;
  useEffect(() => {
    let disposed = false;
    if (!searchResearch) return;
    const search: ResearchSearchQuery = { query: queryText || undefined, type: type || undefined, kind: kind || undefined,
      state: state || undefined, review: review || undefined, approachId, limit: PAGE_SIZE, cursor };
    void searchResearch({ backend, threadId, runId, query: search }).then((page) => {
      if (!disposed) setResult({ key, page });
    }, (failure: unknown) => { if (!disposed) setResult({ key, error: failure instanceof Error ? failure.message : "Research items could not be searched" }); });
    return () => { disposed = true; };
  }, [searchResearch, backend, threadId, runId, key, queryText, type, kind, state, review, approachId, cursor]);
  useEffect(() => {
    if (!returnFocusId || !result.page) return;
    listRef.current?.querySelector<HTMLButtonElement>(`[data-item-id="${CSS.escape(returnFocusId)}"]`)?.focus();
    onFocusReturned?.();
  }, [returnFocusId, result.page, onFocusReturned]);

  if (!api.searchResearch || !api.readResearchItem) return <p className="context-empty">Item search is unavailable in this window.</p>;
  const current = result.key === key ? result : undefined;
  const page = current?.page;
  const update = (patch: Partial<ResearchItemsQuery>) => onQueryChange({ ...query, ...patch, cursor: undefined });
  const submit = (event: FormEvent) => { event.preventDefault(); update({ text: text.trim() }); };
  const filtered = Boolean(query.text || query.type || query.kind || query.state || query.review || query.approachId);
  return <div className="research-items" aria-label="Research items">
    <form className="research-items__search" role="search" onSubmit={submit}>
      <label htmlFor={`${id}-text`} className="research-sr-only">Search items</label>
      <input id={`${id}-text`} type="search" value={text} maxLength={300} onChange={(event) => setText(event.target.value)} placeholder="Search text or item ID" />
      <button type="submit" className="research-button">Search</button>
    </form>
    <div className="research-item-filters">
      <label>Type<Select value={query.type} options={TYPE_OPTIONS} onChange={(type) => update({ type })} className="research-select" /></label>
      <label>Finding kind<Select value={query.kind} options={KIND_OPTIONS} onChange={(kind) => update({ kind })} className="research-select" /></label>
      <label>Progress<Select value={query.state} options={STATE_OPTIONS} onChange={(state) => update({ state })} className="research-select" /></label>
      <label>Review<Select value={query.review} options={REVIEW_OPTIONS} onChange={(review) => update({ review })} className="research-select" /></label>
    </div>
    {(query.approachId || filtered) && <div className="research-actions">
      {query.approachId && <button type="button" className="research-chip research-chip--removable" aria-label={`Remove approach filter: ${approachTitle(run, query.approachId)}`} onClick={() => update({ approachId: undefined })}>From {approachTitle(run, query.approachId)} ×</button>}
      {filtered && <button type="button" className="research-link" onClick={() => { setText(""); onQueryChange(EMPTY_RESEARCH_ITEMS_QUERY); }}>Clear filters</button>}
    </div>}
    {current?.error && <p role="alert" className="research-error">{current.error} <button type="button" className="research-link" onClick={() => { update({}); setRetry((value) => value + 1); }}>Try again</button></p>}
    {!current && <p role="status" className="research-muted">Searching…</p>}
    {page && <>
      <p className="research-muted" role="status">{page.total === 0 ? "No items match." : `${plural(page.total, "item")}${page.total > page.items.length ? ` · showing ${page.items.length}` : ""}`}</p>
      <ul className="research-item-results" ref={listRef}>{page.items.map((hit) => <li key={hit.id}>
        <button type="button" className="research-node" data-item-id={hit.id} onClick={() => onOpenItem(hit.id)}>
          <span className="research-node__meta">{hitLabels(hit).join(" · ")}</span>{" "}{hit.excerpt}
        </button>
      </li>)}</ul>
      {(cursor || page.nextCursor) && <div className="research-actions">
        {cursor && <button type="button" className="research-button" onClick={() => onQueryChange({ ...query, cursor: undefined })}>First page</button>}
        {page.nextCursor && <button type="button" className="research-button" onClick={() => onQueryChange({ ...query, cursor: page.nextCursor })}>Next {PAGE_SIZE}</button>}
      </div>}
    </>}
  </div>;
}

/** Type and the state that matters for it: a worker's execution, a finding's kind, a candidate's review. */
export function hitLabels(hit: ResearchSearchHit): string[] {
  const labels = hit.type === "approach" ? ["Approach", researchLabel(hit.executionState ?? "unknown")]
    : hit.type === "finding" ? [researchLabel(hit.kind ?? "finding")]
      : ["Candidate", hit.review === "unreviewed" || !hit.review ? "Awaiting review" : researchLabel(hit.review)];
  if (hit.state !== "open") labels.push(researchLabel(hit.state));
  return labels;
}
