import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { PrChip } from "../../pr-status/PrChip";
import { openExternalUrl } from "./context-rail-shared";

type PullRequestsPanelProps = {
  thread: NavigationThreadSummary;
};

/**
 * Pull Requests tab — the GitHub PRs detected for this thread's linked
 * directories + branch. Reads the already-cached `thread.prs` snapshot
 * (populated + refreshed by the shared `usePullRequestRefresh` flow at
 * the app level), so opening this tab never kicks off its own `gh`
 * poll. Reuses the sidebar's `PrChip` for state colors + open-in-browser.
 */
export function PullRequestsPanel(props: PullRequestsPanelProps) {
  const prs = props.thread.prs ?? [];
  const multiRepo =
    new Set(prs.map((pr) => `${pr.org}/${pr.repo}`)).size > 1;

  return (
    <section className="context-panel__section">
      <h3>Pull requests</h3>
      {prs.length > 0 ? (
        <ul className="context-list pr-panel-list">
          {prs.map((pr) => (
            <li key={prKey(pr)} className="pr-panel-row">
              <PrChip pr={pr} showRepoPrefix={multiRepo} onOpen={openExternalUrl} />
              <span className="pr-panel-row__state">{stateLabel(pr)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="context-empty">
          No pull requests linked to this thread yet.
        </p>
      )}
    </section>
  );
}

function prKey(pr: PrSummary): string {
  return `${pr.org}/${pr.repo}#${pr.number}`;
}

function stateLabel(pr: PrSummary): string {
  const base = statusText(pr.state);
  if (pr.isDraft) {
    return pr.state === "unknown" ? "Draft" : `Draft · ${base}`;
  }
  return base;
}

function statusText(state: PrSummary["state"]): string {
  switch (state) {
    case "merged":
      return "Merged";
    case "passing":
      return "Checks passing";
    case "failing":
      return "Checks failing";
    case "conflicted":
      return "Merge conflict";
    case "pending":
      return "Checks pending";
    case "closed":
      return "Closed";
    case "unknown":
      return "Status unknown";
    default:
      return "Status unknown";
  }
}
