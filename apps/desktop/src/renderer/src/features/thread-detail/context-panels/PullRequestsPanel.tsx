import { describeStackAutomationBlock } from "@pwragent/shared/stacks/stack-automation";
import { stackHoldForPr } from "../../stacks/stack-presentation";
import { memo, useEffect, useState } from "react";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import type { ThreadPrWatchHistoryEntry } from "@pwragent/shared/contracts/thread-pr-watches";
import type { ThreadPullRequestWatchSummary } from "@pwragent/shared/contracts/thread-tools";
import {
  buildPullRequestStatusKey,
  buildThreadIdentityKey,
  NAVIGATION_QUERY_PROTOCOL_VERSION,
  pullRequestMatchesRepositoryKey,
} from "@pwragent/shared/contracts/navigation";
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
  canManageThreadPrWatches,
  canWatchPrCi,
  resolvePrChipWatch,
  useThreadAutoFixRepository,
  useThreadPrWatchIndicatorsContext,
  useThreadPrWatches,
} from "../../pr-watches/useThreadPrWatchIndicators";
import { RailStatusChip, type RailChipTone } from "./RailStatusChip";
import { orderPullRequestSet } from "@pwragent/shared/pull-request-review";
import { isStaleStackLayer, type StackSummary } from "@pwragent/shared/stacks/stack-status";

type PullRequestsPanelProps = {
  desktopApi?: Pick<DesktopApi, "detachThreadPullRequest" | "manageThreadPrWatches" | "getNavigationSelectedDetail" | "getNavigationQueryPage">;
  onRefreshNavigation?: () => Promise<void>;
  /** Backs the Auto-fix row's Turn Off. */
  onSetThreadPrAutoDispatch?: (enabled: boolean) => Promise<void>;
  thread: NavigationThreadSummary;
};

type WatchHistoryState = {
  threadKey: string;
  /** The active watch ids it was read against; a change re-reads it. */
  source: string;
  /** Undefined when the read failed; the next expand reads again. */
  entries: readonly ThreadPrWatchHistoryEntry[] | undefined;
};

const NO_WATCHES: readonly ThreadPullRequestWatchSummary[] = [];

type CheckState = NonNullable<PrSummary["checkState"]>;

function useSelectedStackDetails({ thread, desktopApi }: PullRequestsPanelProps) {
  const target = thread.federation?.ref.target ?? readRendererFederationTarget();
  const ownerInstanceId = target?.scope === "remote" ? target.instanceId : undefined;
  const { id: threadId, source: backend } = thread;
  const source = JSON.stringify([backend, threadId, ownerInstanceId, thread.stackMemberships,
    thread.observedGitBranch, thread.prs?.map(({ number, baseRefName, headSha, lifecycleState }) =>
      [number, baseRefName, headSha, lifecycleState])]);
  const [loaded, setLoaded] = useState<{ source: string; stacks?: StackSummary[]; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  const read = desktopApi?.getNavigationSelectedDetail;
  const readLegacyRow = desktopApi?.getNavigationQueryPage;
  const needsLegacyLookup = Boolean(ownerInstanceId && thread.stackMemberships?.length && !thread.stacks?.length);
  const hasWorkspace = thread.linkedDirectories.length > 0;
  useEffect(() => {
    if (!read || !hasWorkspace) return;
    let active = true;
    const ref = { backend, threadId, ownerInstanceId };
    const federationTarget = ownerInstanceId ? { scope: "remote" as const, instanceId: ownerInstanceId } : undefined;
    void (async () => {
      const stacks = new Map<string, StackSummary>();
      const cursors = new Set<string>();
      let revision: string | undefined;
      let cursor: string | undefined;
      let bytes = 0;
      do {
        const result = await read({
          protocol: NAVIGATION_QUERY_PROTOCOL_VERSION, ref, federationTarget,
          collection: { name: "stackLayers", cursor },
        });
        if (!active) return;
        const page = result.collectionPage;
        if (result.protocol !== NAVIGATION_QUERY_PROTOCOL_VERSION || result.readiness !== "ready"
          || result.ref.backend !== backend || result.ref.threadId !== threadId || result.ref.ownerInstanceId !== ownerInstanceId
          || page?.name !== "stackLayers" || (revision !== undefined && page.revision !== revision)) {
          throw new Error("Stack details changed while loading.");
        }
        revision = page.revision;
        const layers = page.values.stackLayers ?? [];
        bytes += new TextEncoder().encode(JSON.stringify(layers)).byteLength;
        if (bytes > 8 * 1024 * 1024) {
          setLoaded({ source, error: "Stack details exceed the display limit." });
          return;
        }
        for (const { stackKey, stack, layer, position } of layers) {
          const current = stacks.get(stackKey) ?? (stack?.key === stackKey ? { ...stack, layers: [] } : undefined);
          if (!current || position !== current.layers.length + 1) throw new Error("Stack details arrived out of order.");
          current.layers.push(layer);
          stacks.set(stackKey, current);
        }
        if (page.complete) {
          setLoaded({ source, stacks: [...stacks.values()] });
          return;
        }
        cursor = page.nextCursor;
        if (!cursor || cursors.has(cursor) || !layers.length) throw new Error("Stack details did not finish loading.");
        cursors.add(cursor);
      } while (active);
    })().catch(async (error: unknown) => {
      // A mounted older owner can supply a full stack on one exact row.
      if (!active) return;
      const unsupported = error instanceof Error && error.message.includes("Unknown selected-detail collection");
      if (unsupported && !needsLegacyLookup) return;
      if (unsupported && readLegacyRow) {
        const legacy = await readLegacyRow({
          protocol: NAVIGATION_QUERY_PROTOCOL_VERSION, consumer: "main-sidebar", federationTarget,
          query: { kind: "exact", identities: [ref] }, pageSize: 1,
        }).catch(() => undefined);
        if (!active) return;
        const row = legacy?.entries.find(({ row }) => row.id === threadId && row.source === backend)?.row;
        if (row?.stacks) {
          setLoaded({ source, stacks: [...new Map(row.stacks.map(({ stack }) => [stack.key, stack])).values()] });
          return;
        }
      }
      setLoaded({ source, error: "Could not load stack details." });
    });
    return () => { active = false; };
  }, [read, readLegacyRow, needsLegacyLookup, hasWorkspace, backend, threadId, ownerInstanceId, source, attempt]);
  const current = loaded?.source === source ? loaded : undefined;
  return { stacks: current?.stacks, error: current?.error, retry: () => {
    setLoaded(undefined);
    setAttempt((value) => value + 1);
  } };
}

function StackRailCard({ stack }: { stack: StackSummary }) {
  const next = stack.layers.find((layer) => layer.pullRequest?.lifecycleState !== "merged");
  return (
    <li className={`rail-card stack-rail-card${stack.inferred ? " stack-rail-card--inferred" : ""}`}>
      <p className="rail-card__title">{stack.inferred ? "Inferred stack" : "Stack"} · {stack.name}</p>
      <ol className="stack-rail-card__layers" reversed>
        {[...stack.layers].reverse().map((layer) => {
          const merged = layer.pullRequest?.lifecycleState === "merged";
          const nextLabel = next?.pullRequest ? `#${next.pullRequest.number}` : next?.branch;
          const detail = merged ? "Merged"
            : layer.heldBy ? describeStackAutomationBlock(layer.heldBy, " · ")
            : layer === next ? [layer.pullRequest?.lifecycleState === "open" ? "Next to merge" : "First in merge order", layer.unsettled].filter(Boolean).join(" · ")
            : `Waiting for ${nextLabel} to merge`;
          return (
            <li key={layer.branch} data-stale={!layer.heldBy && isStaleStackLayer(layer.health) || undefined}
              data-held={Boolean(layer.heldBy) || undefined}>
              <span className="stack-rail-card__branch">{layer.pullRequest ? `#${layer.pullRequest.number} ` : ""}{layer.branch}</span>
              <span className="rail-card__meta">{detail}</span>
            </li>
          );
        })}
      </ol>
      <p className="rail-card__meta stack-rail-card__trunk">Trunk · {stack.trunk}</p>
    </li>
  );
}

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
  const selectedStacks = useSelectedStackDetails(props);
  const [pendingDetachPr, setPendingDetachPr] = useState<PrSummary>();
  const watchContext = useThreadPrWatchIndicatorsContext();
  const threadKey = buildThreadIdentityKey(props.thread.source, props.thread.id);
  // A peer's thread, or any thread in a federation window, runs its watches
  // on its owner, which projects them onto selected detail. The rail stops
  // and arms them there when the owner accepts it, else it reads only.
  const federationWindow = Boolean(readRendererFederationTarget());
  const ownerLabel = props.thread.federation
    ? props.thread.federation.instanceLabel
    : federationWindow
      ? "the thread's own machine"
      : undefined;
  const manageable = canManageThreadPrWatches(watchContext, props.thread);
  const peerManaged = ownerLabel !== undefined && manageable;
  const localWatches = ownerLabel === undefined && watchContext
    ? watchContext.byThreadKey.get(threadKey)?.watches ?? NO_WATCHES
    : undefined;
  // Undefined means unknown: no watch UI at all, rather than a false "none".
  // An owner that accepts control projects every watch, so none sent is none.
  const watches = ownerLabel !== undefined
    ? props.thread.activePrWatches ?? (peerManaged ? NO_WATCHES : undefined)
    : localWatches;
  const watchIds = watches?.map((watch) => watch.watchId).join(",") ?? "";
  const autoFixRepository = useThreadAutoFixRepository(props.thread);
  // The chip reads what the sidebar's chip reads, a peer owner's CI marks
  // included, so one PR wears one eye in both places.
  const chipWatches = useThreadPrWatches(props.thread);
  const canReadHistory = (localWatches !== undefined || peerManaged)
    && Boolean(props.desktopApi?.manageThreadPrWatches);
  const ownerTarget = props.thread.federation?.ref.target;
  // A string, so a detail refresh that rebuilt the target re-reads nothing.
  const ownerInstanceId = ownerTarget?.scope === "remote" ? ownerTarget.instanceId : undefined;
  const [openHistory, setOpenHistory] = useState<ReadonlySet<string>>(() => new Set());
  const [history, setHistory] = useState<WatchHistoryState>();
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const historyWanted = canReadHistory
    && [...openHistory].some((key) => key.startsWith(`${threadKey}|`));
  const historyCurrent = history?.threadKey === threadKey
    && history.source === watchIds
    && history.entries !== undefined;
  const historyFailed = history?.threadKey === threadKey && history.entries === undefined;
  useEffect(() => {
    // History is read on first expand, then again whenever a watch changes.
    if (!historyWanted || historyCurrent) return;
    let cancelled = false;
    const source = watchIds;
    void props.desktopApi!.manageThreadPrWatches!({
      action: "history",
      backend: props.thread.source,
      threadId: props.thread.id,
      ...(ownerInstanceId
        ? { federationTarget: { scope: "remote" as const, instanceId: ownerInstanceId } }
        : {}),
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
    watchIds,
    ownerInstanceId,
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
  const byRepo = new Map<string, PrSummary[]>();
  for (const pr of [...(props.thread.prs ?? [])].sort((left, right) => {
    const repoOrder = repositoryLabel(left).localeCompare(repositoryLabel(right));
    return repoOrder !== 0 ? repoOrder : right.number - left.number;
  })) {
    const label = `${pr.provider}/${repositoryLabel(pr)}`;
    const group = byRepo.get(label) ?? [];
    group.push(pr);
    byRepo.set(label, group);
  }
  const prs = [...byRepo.values()].flatMap((group) => orderPullRequestSet(group, (pr) => pr).ordered);
  const stacks = selectedStacks.stacks ?? [...new Map(props.thread.stacks?.map(({ stack }) => [stack.key, stack])).values()];
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
      {prs.length > 0 || stacks.length > 0 || selectedStacks.error ? (
        <ul className="context-list context-list--cards">
          {selectedStacks.error ? (
            <li className="rail-card">
              <p className="rail-card__meta" role="status">{selectedStacks.error}</p>
              <button className="button button--ghost" type="button" onClick={selectedStacks.retry}>Retry stack details</button>
            </li>
          ) : null}
          {stacks.map((stack) => <StackRailCard key={stack.key} stack={stack} />)}
          {prs.map((pr) => {
            const lifecycle = resolveLifecycleState(pr);
            const isOpen = lifecycle === "open";
            const checkState = resolveCheckState(pr);
            const statusKey = buildPullRequestStatusKey(pr);
            const prWatches = watches?.filter((watch) => watch.prKey === statusKey) ?? NO_WATCHES;
            const held = stackHoldForPr(props.thread, pr);
            const chipWatch = resolvePrChipWatch(chipWatches, pr, autoFixRepository);
            return (
              <li key={prKey(pr)} className="rail-card">
                <p className="rail-card__status-line">
                  <PrChip
                    pr={pr}
                    showRepoPrefix={false}
                    onOpen={openExternalUrl}
                    withStatusPills
                    statusOverride={held ? describeStackAutomationBlock(held, " · ") : undefined}
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
                  {isOpen && !held && pr.mergeState === "conflicting" ? (
                    <RailStatusChip tone="error" alert>
                      Merge conflict
                    </RailStatusChip>
                  ) : null}
                  {held ? <RailStatusChip tone="warning">{describeStackAutomationBlock(held, " · ")}</RailStatusChip> : null}
                  {isOpen && !held ? (
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
                {(isOpen || chipWatch?.mergeBuild) && watches !== undefined ? (
                  <PullRequestWatchList
                    pr={pr}
                    watches={prWatches}
                    mergeBuild={chipWatch?.mergeBuild}
                    onStopMergeBuild={manageable && watchContext?.stopMergeBuild
                      ? async (wait) => await watchContext.stopMergeBuild!(props.thread, wait)
                      : undefined}
                    autoFix={chipWatch
                      ? chipWatch.autoFix === true
                      : pullRequestMatchesRepositoryKey(pr, autoFixRepository)}
                    autoFixBlocked={chipWatch?.autoFixBlocked}
                    ownerLabel={ownerLabel}
                    onStop={manageable && watchContext?.stop
                      ? async (watch) => await watchContext.stop!(watch, props.thread)
                      : undefined}
                    onTurnOffAutoFix={props.onSetThreadPrAutoDispatch
                      ? () => void props.onSetThreadPrAutoDispatch!(false)
                      : undefined}
                    onWatchCi={manageable && watchContext?.watchCi && canWatchPrCi(props.thread, pr)
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
          prs={[pendingDetachPr]}
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
