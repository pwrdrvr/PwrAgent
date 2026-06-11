import type { ReactElement } from "react";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { openExternalUrl } from "./context-rail-shared";

type PullRequestsPanelProps = {
  thread: NavigationThreadSummary;
};

type PrTone = "ok" | "error" | "warning" | "merged" | "neutral";
type CheckState = NonNullable<PrSummary["checkState"]>;

/**
 * Pull Requests tab — the GitHub PRs detected for this thread's linked
 * directories + branch. Reads the already-cached `thread.prs` snapshot
 * (populated + refreshed by the shared `usePullRequestRefresh` flow at the
 * app level — selection + a 60s tick), so opening this tab never kicks off
 * its own `gh` poll. Each PR is a shared `.rail-card` (matching the
 * Sub-Agents tab): a row of state pills (#number, lifecycle, a merge-conflict
 * pill, checks) above the title, repo meta, and an open-in-browser action.
 */
export function PullRequestsPanel(props: PullRequestsPanelProps) {
  const prs = props.thread.prs ?? [];

  return (
    <section className="context-panel__section">
      <h3>Pull requests</h3>
      {prs.length > 0 ? (
        <ul className="context-list context-list--cards">
          {prs.map((pr) => {
            const lifecycle = resolveLifecycleState(pr);
            const isOpen = lifecycle === "open";
            const checkState = resolveCheckState(pr);
            return (
              <li key={prKey(pr)} className="rail-card">
                <p className="rail-card__status-line">
                  <span className="rail-chip rail-chip--id">#{pr.number}</span>
                  {lifecycle === "merged" ? statusPill("merged", "Merged") : null}
                  {lifecycle === "closed" ? statusPill("neutral", "Closed") : null}
                  {isOpen && pr.reviewState === "draft"
                    ? statusPill("neutral", "Draft")
                    : null}
                  {isOpen && pr.mergeState === "conflicting"
                    ? statusPill("error", "Merge conflict")
                    : null}
                  {isOpen
                    ? statusPill(checkTone(checkState), checkLabel(checkState))
                    : null}
                </p>
                <p className="rail-card__title" title={prTitle(pr)}>
                  {prTitle(pr)}
                </p>
                <p className="rail-card__meta">{repositoryLabel(pr)}</p>
                <button
                  className="context-list__action"
                  type="button"
                  aria-label={`Open ${pr.org}/${pr.repo}#${pr.number} in browser`}
                  onClick={() => openExternalUrl(pr.url)}
                >
                  Open pull request
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="context-empty">
          No pull requests linked to this thread yet.
        </p>
      )}
    </section>
  );
}

function statusPill(tone: PrTone, label: string): ReactElement {
  return (
    <span className={`rail-chip rail-chip--${tone}`}>
      <span aria-hidden="true" className={`rail-chip__dot rail-chip__dot--${tone}`} />
      {label}
    </span>
  );
}

function prKey(pr: PrSummary): string {
  return `${pr.provider}/${pr.org}/${pr.repo}#${pr.number}`;
}

function prTitle(pr: PrSummary): string {
  return pr.title?.trim() || `Pull request #${pr.number}`;
}

function repositoryLabel(pr: PrSummary): string {
  return `${pr.provider}/${pr.org}/${pr.repo}`;
}

function checkTone(state: CheckState): PrTone {
  switch (state) {
    case "passing":
      return "ok";
    case "failing":
      return "error";
    case "pending":
      return "warning";
    case "unknown":
      return "neutral";
  }
}

function checkLabel(state: CheckState): string {
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

function resolveLifecycleState(pr: PrSummary): NonNullable<PrSummary["lifecycleState"]> {
  if (pr.lifecycleState) {
    return pr.lifecycleState;
  }
  if (pr.state === "merged" || pr.state === "closed") {
    return pr.state;
  }
  return "open";
}

function resolveCheckState(pr: PrSummary): CheckState {
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
