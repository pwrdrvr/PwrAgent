import { useState } from "react";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import {
  DetachPullRequestWarning,
  shouldShowDetachPullRequestWarning,
} from "../../pr-status/DetachPullRequestWarning";
import { PrChip } from "../../pr-status/PrChip";
import { openExternalUrl } from "./context-rail-shared";
import { RailStatusChip, type RailChipTone } from "./RailStatusChip";

type PullRequestsPanelProps = {
  desktopApi?: Pick<DesktopApi, "detachThreadPullRequest">;
  onRefreshNavigation?: () => Promise<void>;
  thread: NavigationThreadSummary;
};

type CheckState = NonNullable<PrSummary["checkState"]>;

/**
 * Pull Requests tab — the GitHub PRs detected for this thread's linked
 * directories + branch. Reads the already-cached `thread.prs` snapshot
 * (populated + refreshed by the shared `usePullRequestRefresh` flow at the
 * app level — selection + a 60s tick), so opening this tab never kicks off
 * its own `gh` poll. Each PR is a shared `.rail-card`: the clickable `PrChip`
 * (#number, tooltip, status dot — identical to the sidebar) leads a row of
 * status pills (lifecycle, merge conflict, checks), above the title + repo.
 */
export function PullRequestsPanel(props: PullRequestsPanelProps) {
  const [pendingDetachPr, setPendingDetachPr] = useState<PrSummary>();
  // Newest first. `PrSummary` carries no creation timestamp, so sort by PR
  // number (monotonic with creation within a repo); for the rare multi-repo
  // thread, group by repo first so the numbers stay comparable.
  const prs = [...(props.thread.prs ?? [])].sort((left, right) => {
    const repoOrder = repositoryLabel(left).localeCompare(repositoryLabel(right));
    return repoOrder !== 0 ? repoOrder : right.number - left.number;
  });
  const detachPr = async (pr: PrSummary): Promise<void> => {
    if (!props.desktopApi?.detachThreadPullRequest) {
      return;
    }
    await props.desktopApi.detachThreadPullRequest({
      backend: props.thread.source,
      threadId: props.thread.id,
      pr,
    });
    await props.onRefreshNavigation?.();
  };
  const requestDetachPr = (pr: PrSummary): void => {
    if (shouldShowDetachPullRequestWarning()) {
      setPendingDetachPr(pr);
      return;
    }
    void detachPr(pr);
  };

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
                  <PrChip
                    pr={pr}
                    showRepoPrefix={false}
                    onOpen={openExternalUrl}
                    withStatusPills
                    onDetach={requestDetachPr}
                  />
                  {lifecycle === "merged" ? (
                    <RailStatusChip tone="merged">Merged</RailStatusChip>
                  ) : null}
                  {lifecycle === "closed" ? (
                    <RailStatusChip tone="neutral">Closed</RailStatusChip>
                  ) : null}
                  {isOpen && pr.reviewState === "draft" ? (
                    <RailStatusChip tone="neutral">Draft</RailStatusChip>
                  ) : null}
                  {isOpen && pr.mergeState === "conflicting" ? (
                    <RailStatusChip tone="error" alert>
                      Merge conflict
                    </RailStatusChip>
                  ) : null}
                  {isOpen ? (
                    <RailStatusChip
                      tone={checkTone(checkState)}
                      alert={checkState === "failing"}
                    >
                      {checkLabel(checkState)}
                    </RailStatusChip>
                  ) : null}
                </p>
                <p className="rail-card__title" title={prTitle(pr)}>
                  {prTitle(pr)}
                </p>
                <p className="rail-card__meta">{repositoryLabel(pr)}</p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="context-empty">
          No pull requests linked to this thread yet.
        </p>
      )}
      {pendingDetachPr ? (
        <DetachPullRequestWarning
          pr={pendingDetachPr}
          onCancel={() => setPendingDetachPr(undefined)}
          onConfirm={() => {
            const pr = pendingDetachPr;
            setPendingDetachPr(undefined);
            void detachPr(pr);
          }}
        />
      ) : null}
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

function checkTone(state: CheckState): RailChipTone {
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
