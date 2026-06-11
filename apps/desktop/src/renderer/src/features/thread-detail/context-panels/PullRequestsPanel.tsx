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

  return (
    <section className="context-panel__section">
      <h3>Pull requests</h3>
      {prs.length > 0 ? (
        <ul className="context-list pr-panel-list">
          {prs.map((pr) => (
            <li key={prKey(pr)} className="pr-panel-row">
              <div className="pr-panel-row__main">
                <PrChip pr={pr} showRepoPrefix={false} onOpen={openExternalUrl} />
                <span className="pr-panel-row__details">
                  {pr.title?.trim() ? (
                    <span className="pr-panel-row__title">{pr.title.trim()}</span>
                  ) : null}
                  <span className="pr-panel-row__repo">{repositoryLabel(pr)}</span>
                </span>
              </div>
              <span className="pr-panel-row__state">{statusLabel(pr)}</span>
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
  return `${pr.provider}/${pr.org}/${pr.repo}#${pr.number}`;
}

function repositoryLabel(pr: PrSummary): string {
  return `${pr.provider}/${pr.org}/${pr.repo}`;
}

function statusLabel(pr: PrSummary): string {
  const lifecycleState = resolveLifecycleState(pr);
  const parts: string[] = [];
  if (lifecycleState === "merged") {
    parts.push("Merged");
    return parts.join(" · ");
  } else if (lifecycleState === "closed") {
    parts.push("Closed");
    return parts.join(" · ");
  } else if (pr.reviewState === "draft") {
    parts.push("Draft");
  } else {
    parts.push("Ready for review");
  }
  if (pr.mergeState === "conflicting") {
    parts.push("Merge conflict");
  }
  parts.push(checkStateLabel(resolveCheckState(pr)));
  return parts.join(" · ");
}

function resolveLifecycleState(pr: PrSummary): NonNullable<PrSummary["lifecycleState"]> {
  if (pr.lifecycleState) {
    return pr.lifecycleState;
  }
  if (pr.state === "merged" || pr.state === "closed") {
    return pr.state;
  }
  return "open";
}

function resolveCheckState(pr: PrSummary): NonNullable<PrSummary["checkState"]> {
  const state = pr.checkState ?? pr.state;
  if (
    state === "passing"
    || state === "failing"
    || state === "pending"
    || state === "unknown"
  ) {
    return state;
  }
  return "unknown";
}

function checkStateLabel(state: NonNullable<PrSummary["checkState"]>): string {
  switch (state) {
    case "passing":
      return "Checks passing";
    case "failing":
      return "Checks failing";
    case "pending":
      return "Checks pending";
    case "unknown":
      return "Status unknown";
  }
}
