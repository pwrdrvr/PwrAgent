import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { openExternalUrl } from "./context-rail-shared";

type PullRequestsPanelProps = {
  thread: NavigationThreadSummary;
};

type PrTone = "ok" | "error" | "warning" | "merged" | "neutral";

/**
 * Pull Requests tab — the GitHub PRs detected for this thread's linked
 * directories + branch. Reads the already-cached `thread.prs` snapshot
 * (populated + refreshed by the shared `usePullRequestRefresh` flow at the
 * app level), so opening this tab never kicks off its own `gh` poll. Each
 * PR renders as a shared `.rail-card` (matching the Sub-Agents tab): a state
 * dot + status on their own line, the title on its own row, repo + number
 * meta, and an open-in-browser action.
 */
export function PullRequestsPanel(props: PullRequestsPanelProps) {
  const prs = props.thread.prs ?? [];

  return (
    <section className="context-panel__section">
      <h3>Pull requests</h3>
      {prs.length > 0 ? (
        <ul className="context-list context-list--cards">
          {prs.map((pr) => {
            const tone = prTone(prChipState(pr));
            return (
              <li key={prKey(pr)} className="rail-card">
                <p className="rail-card__status-line">
                  <span
                    aria-hidden="true"
                    className={`rail-card__dot rail-card__dot--${tone}`}
                  />
                  <span className="rail-card__status">{statusLabel(pr)}</span>
                </p>
                <p className="rail-card__title" title={prTitle(pr)}>
                  {prTitle(pr)}
                </p>
                <p className="rail-card__meta">
                  {repositoryLabel(pr)} · #{pr.number}
                </p>
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

function prKey(pr: PrSummary): string {
  return `${pr.provider}/${pr.org}/${pr.repo}#${pr.number}`;
}

function prTitle(pr: PrSummary): string {
  return pr.title?.trim() || `Pull request #${pr.number}`;
}

function repositoryLabel(pr: PrSummary): string {
  return `${pr.provider}/${pr.org}/${pr.repo}`;
}

function statusLabel(pr: PrSummary): string {
  const lifecycleState = resolveLifecycleState(pr);
  if (lifecycleState === "merged") {
    return "Merged";
  }
  if (lifecycleState === "closed") {
    return "Closed";
  }
  const parts: string[] = [pr.reviewState === "draft" ? "Draft" : "Ready for review"];
  if (pr.mergeState === "conflicting") {
    parts.push("Merge conflict");
  }
  parts.push(checkStateLabel(resolveCheckState(pr)));
  return parts.join(" · ");
}

/** The single dominant state, mirroring the sidebar PrChip's dot. */
function prChipState(
  pr: PrSummary,
): NonNullable<PrSummary["checkState"]> | "merged" | "closed" {
  const lifecycleState = resolveLifecycleState(pr);
  if (lifecycleState === "merged" || lifecycleState === "closed") {
    return lifecycleState;
  }
  return resolveCheckState(pr);
}

function prTone(state: ReturnType<typeof prChipState>): PrTone {
  switch (state) {
    case "passing":
      return "ok";
    case "failing":
      return "error";
    case "pending":
      return "warning";
    case "merged":
      return "merged";
    case "closed":
    case "unknown":
      return "neutral";
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
