import { memo, useEffect, useState } from "react";
import type {
  NavigationThreadSummary,
  PrSummary,
  ThreadPrWatchHistoryEntry,
  ThreadPullRequestWatchSummary,
} from "@pwragent/shared";
import {
  buildPullRequestStatusKey,
  buildThreadIdentityKey,
  pullRequestMatchesRepositoryKey,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { readRendererFederationTarget } from "../../../lib/federation-window";
import {
  DetachPullRequestWarning,
  shouldShowDetachPullRequestWarning,
} from "../../pr-status/DetachPullRequestWarning";
import { PrChip } from "../../pr-status/PrChip";
import { openExternalUrl } from "../../../lib/open-external-url";
import { PullRequestWatchList } from "../../pr-watches/PullRequestWatchList";
import {
  canWatchPrCi,
  resolvePrChipWatch,
  useThreadAutoFixRepository,
  useThreadPrWatchIndicatorsContext,
} from "../../pr-watches/useThreadPrWatchIndicators";
import { RailStatusChip, type RailChipTone } from "./RailStatusChip";

type PullRequestsPanelProps = {
  desktopApi?: Pick<DesktopApi, "detachThreadPullRequest" | "manageThreadPrWatches">;
  onRefreshNavigation?: () => Promise<void>;
  /** Backs the Auto-fix row's Turn Off. */
  onSetThreadPrAutoDispatch?: (enabled: boolean) => Promise<void>;
  thread: NavigationThreadSummary;
};

type WatchHistoryState = {
  threadKey: string;
  /** The active list it was read against; a change re-reads it. */
  source: readonly ThreadPullRequestWatchSummary[] | undefined;
  /** Undefined when the read failed; the next expand reads again. */
  entries: readonly ThreadPrWatchHistoryEntry[] | undefined;
};

const NO_WATCHES: readonly ThreadPullRequestWatchSummary[] = [];

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
export const PullRequestsPanel = memo(function PullRequestsPanel(props: PullRequestsPanelProps) {
  const [pendingDetachPr, setPendingDetachPr] = useState<PrSummary>();
  const watchContext = useThreadPrWatchIndicatorsContext();
  const threadKey = buildThreadIdentityKey(props.thread.source, props.thread.id);
  // A peer's thread, or any thread in a federation window, is read-only: its
  // owner runs the watches and projects them onto selected detail.
  const federationWindow = Boolean(readRendererFederationTarget());
  const ownerLabel = props.thread.federation
    ? props.thread.federation.instanceLabel
    : federationWindow
      ? "the thread's own machine"
      : undefined;
  const localWatches = ownerLabel === undefined && watchContext
    ? watchContext.byThreadKey.get(threadKey)?.watches ?? NO_WATCHES
    : undefined;
  // Undefined means unknown: no watch UI at all, rather than a false "none".
  const watches = ownerLabel !== undefined ? props.thread.activePrWatches : localWatches;
  const autoFixRepository = useThreadAutoFixRepository(props.thread);
  const canReadHistory = localWatches !== undefined && Boolean(props.desktopApi?.manageThreadPrWatches);
  const [openHistory, setOpenHistory] = useState<ReadonlySet<string>>(() => new Set());
  const [history, setHistory] = useState<WatchHistoryState>();
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const historyWanted = canReadHistory
    && [...openHistory].some((key) => key.startsWith(`${threadKey}|`));
  const historyCurrent = history?.threadKey === threadKey
    && history.source === localWatches
    && history.entries !== undefined;
  const historyFailed = history?.threadKey === threadKey && history.entries === undefined;
  useEffect(() => {
    // History is read on first expand, then again whenever a watch changes.
    if (!historyWanted || historyCurrent) return;
    let cancelled = false;
    const source = localWatches;
    void props.desktopApi!.manageThreadPrWatches!({
      action: "history",
      backend: props.thread.source,
      threadId: props.thread.id,
      limit: 20,
    }).then(
      (response) => {
        if (cancelled) return;
        setHistory({ threadKey, source, entries: response.ok ? response.history ?? [] : undefined });
      },
      () => {
        if (!cancelled) setHistory({ threadKey, source, entries: undefined });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    historyWanted,
    historyCurrent,
    historyAttempt,
    localWatches,
    props.desktopApi,
    props.thread.source,
    props.thread.id,
    threadKey,
  ]);
  const historyEntries = history?.threadKey === threadKey ? history.entries : undefined;
  const toggleHistory = (prKey: string): void => {
    const key = `${threadKey}|${prKey}`;
    // An expand after a failed read reads again.
    if (historyFailed && !openHistory.has(key)) {
      setHistory(undefined);
      setHistoryAttempt((attempt) => attempt + 1);
    }
    setOpenHistory((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
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
      // Remote threads detach on their owning instance; without the target
      // the write lands in the viewer's overlay store and reverts on the
      // next remote snapshot.
      federationTarget: props.thread.federation?.ref.target ??
        readRendererFederationTarget(),
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
            const statusKey = buildPullRequestStatusKey(pr);
            const prWatches = watches?.filter((watch) => watch.prKey === statusKey) ?? NO_WATCHES;
            const chipWatch = ownerLabel === undefined && watchContext
              ? resolvePrChipWatch(watchContext.byThreadKey.get(threadKey), pr, autoFixRepository)
              : undefined;
            return (
              <li key={prKey(pr)} className="rail-card">
                <p className="rail-card__status-line">
                  <PrChip
                    pr={pr}
                    showRepoPrefix={false}
                    onOpen={openExternalUrl}
                    withStatusPills
                    watch={chipWatch}
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
                      blink={
                        checkState === "failing"
                        && pr.checksStillRunning === true
                      }
                    >
                      {checkLabel(checkState, pr.checksStillRunning)}
                    </RailStatusChip>
                  ) : null}
                </p>
                <p className="rail-card__title" title={prTitle(pr)}>
                  {prTitle(pr)}
                </p>
                <p className="rail-card__meta">{repositoryLabel(pr)}</p>
                {isOpen && watches !== undefined ? (
                  <PullRequestWatchList
                    pr={pr}
                    watches={prWatches}
                    autoFix={chipWatch
                      ? chipWatch.autoFix === true
                      : pullRequestMatchesRepositoryKey(pr, autoFixRepository)}
                    autoFixBlocked={chipWatch?.autoFixBlocked}
                    ownerLabel={ownerLabel}
                    onStop={watchContext?.stop}
                    onTurnOffAutoFix={props.onSetThreadPrAutoDispatch
                      ? () => void props.onSetThreadPrAutoDispatch!(false)
                      : undefined}
                    onWatchCi={watchContext?.watchCi && canWatchPrCi(props.thread, pr)
                      ? async () => await watchContext.watchCi!(props.thread, pr)
                      : undefined}
                    history={historyEntries?.filter((entry) => entry.prKey === statusKey)}
                    historyFailed={historyFailed}
                    historyOpen={openHistory.has(`${threadKey}|${statusKey}`)}
                    onToggleHistory={canReadHistory ? () => toggleHistory(statusKey) : undefined}
                  />
                ) : null}
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
});

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

function checkLabel(
  state: CheckState,
  checksStillRunning: boolean | undefined,
): string {
  switch (state) {
    case "passing":
      return "Checks passing";
    case "failing":
      return checksStillRunning
        ? "Checks failing · still running"
        : "Checks failing";
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
