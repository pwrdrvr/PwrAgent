import type { KeyboardEvent } from "react";

export type ResearchTab<Id extends string> = { id: Id; label: string };

/** The run's views as an ARIA tablist: arrow keys, Home and End move between them. */
export function ResearchTabs<Id extends string>({ idBase, views, current, reviewCount, decisionsCount = 0, onChoose }: {
  idBase: string; views: ReadonlyArray<ResearchTab<Id>>; current: Id; reviewCount: number; decisionsCount?: number; onChoose: (view: Id) => void;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = views.findIndex((entry) => entry.id === current);
    const next = event.key === "ArrowRight" ? (index + 1) % views.length : event.key === "ArrowLeft" ? (index - 1 + views.length) % views.length
      : event.key === "Home" ? 0 : event.key === "End" ? views.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    onChoose(views[next]!.id);
    document.getElementById(`${idBase}-${views[next]!.id}`)?.focus();
  }
  return <div className="research-tabs" role="tablist" aria-label="Research views" onKeyDown={onKeyDown}>
    {views.map((entry) => <button type="button" role="tab" key={entry.id} id={`${idBase}-${entry.id}`} aria-selected={current === entry.id}
      aria-controls={`${idBase}-panel`} tabIndex={current === entry.id ? 0 : -1} onClick={() => onChoose(entry.id)}>
      {entry.label}{entry.id === "review" && reviewCount > 0 && <><span className="research-sr-only">,</span>{" "}<span className="research-tab-count">{reviewCount}</span>{" "}<span className="research-sr-only">to review</span></>}
      {entry.id === "decisions" && decisionsCount > 0 && <><span className="research-sr-only">,</span>{" "}<span className="research-tab-count">{decisionsCount}</span>{" "}<span className="research-sr-only">decision batches</span></>}
    </button>)}
  </div>;
}
