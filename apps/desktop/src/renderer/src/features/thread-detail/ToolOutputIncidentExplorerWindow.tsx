import type { ReactNode } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AppServerBackendKind,
  FederationInstanceId,
  FederationTarget,
  AppServerReadThreadResponse,
  AppServerThreadActivityDetail,
  ThreadToolAccounting,
  ThreadToolAnalysisCoverage,
  ThreadCompactionRecord,
  ThreadTokenMiserSavings,
  ThreadToolInvocationRecord,
  ThreadUsageLineRecord,
  ToolOutputIncidentExplorerLens,
} from "@pwragent/shared";
import {
  buildThreadToolIncidentPrompt,
  DESKTOP_TOOL_OUTPUT_ALERT_POLICY_DEFAULT,
  isFlaggedToolInvocation,
  toolOutputWarningChars,
} from "@pwragent/shared";
import { formatBackendLabel } from "../../lib/backend-label";
import { useDesktopApi } from "../../lib/desktop-api";
import { useDesktopSettings } from "../settings/useDesktopSettings";
import { ThreadChip } from "./ThreadChip";
import { detailMatchesInvocationItem } from "./tool-call-details";
import {
  clampDetailsHeight,
  readStoredSavingsLayout,
  SAVINGS_DETAILS_MIN_HEIGHT,
  SAVINGS_RESULTS_MIN_HEIGHT,
  writeStoredSavingsLayout,
} from "./token-miser-savings-layout";
import type { SavingsSectionKey } from "./token-miser-savings-layout";
import {
  describeSameTrajectoryCostChange,
  TOKEN_MISER_PENDING_PRICING_CAPTION,
} from "./token-miser-savings-summary";
import type {
  CategoryShare,
  IncidentSortMode,
  RefinedToolCategory,
  TurnCostRow,
  TurnCostStrip,
  TurnStripScope,
  TokenMiserContextComparison,
  TokenMiserGateEntry,
  TokenMiserGateOutcome,
} from "./tool-output-incident-insights";
import {
  buildCategoryComposition,
  buildTokenMiserContextComparison,
  buildTokenMiserGateEntries,
  buildTurnCostStrip,
  capMeterWidth,
  countRepeatedCommands,
  formatCapShare,
  formatCategoryLabel,
  formatCompactTokens,
  formatInvocationIdentity,
  formatMicrosCurrency,
  formatTurnWhen,
  invocationStatusTone,
  isOverOutputCap,
  matchTokenMiserInvocations,
  refineToolCategory,
  repeatCountFor,
  sortIncidentCases,
  summarizeIncidents,
} from "./tool-output-incident-insights";

const HISTORY_PAGE_LIMIT = 100;
const DEFAULT_MODEL_VISIBLE_TOOL_OUTPUT_CAP_CHARACTERS = 40_000;

export function ToolOutputIncidentExplorerWindow() {
  const desktopApi = useDesktopApi();
  const settings = useDesktopSettings(desktopApi);
  const [route, setRoute] = useState(readIncidentRoute);
  const [accounting, setAccounting] = useState<ThreadToolAccounting>();
  const [latest, setLatest] = useState<AppServerReadThreadResponse>();
  const [selectedId, setSelectedId] = useState<string>();
  const [category, setCategory] = useState<RefinedToolCategory | "all" | "other">("all");
  const [turnFilter, setTurnFilter] = useState<string>();
  const [turnScope, setTurnScope] = useState<TurnStripScope>("flagged");
  const [sortMode, setSortMode] = useState<IncidentSortMode>("largest");
  const [search, setSearch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [identityExpanded, setIdentityExpanded] = useState(false);
  const [output, setOutput] = useState<string>();
  const [outputSearch, setOutputSearch] = useState("");
  const [status, setStatus] = useState<string>();
  const [statusTone, setStatusTone] = useState<"error" | "info">("info");
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [lensChoice, setLens] =
    useState<ToolOutputIncidentExplorerLens>(route?.lens ?? "incidents");
  /* Whether the opening lens has been chosen. Declared with the state it
     guards rather than beside the latch below, because the refresh effect
     sets it too. A route that named a lens has already chosen. */
  const lensLatched = useRef(route?.lens !== undefined);

  /* Stable identity: `refresh` depends on it, and a refresh that changed every
     render would re-run the effect that calls it on every render. */
  const reportError = useCallback((error: unknown) => {
    setStatusTone("error");
    setStatus(error instanceof Error ? error.message : String(error));
  }, []);

  const refresh = useCallback(async () => {
    if (!route || !desktopApi?.readThread) return;
    setLoading(true);
    setStatus(undefined);
    try {
      const response = await desktopApi.readThread({
        backend: route.backend,
        ...(route.federationTarget
          ? { federationTarget: route.federationTarget }
          : {}),
        includeAllToolInvocations: true,
        limit: HISTORY_PAGE_LIMIT,
        threadId: route.threadId,
        viewOnly: true,
      });
      setLatest(response);
      setAccounting(response.toolAccounting);
    } catch (error) {
      reportError(error);
    } finally {
      setLoading(false);
    }
  }, [desktopApi, reportError, route]);

  useEffect(() => {
    document.title = route ? `Tool-output incidents — ${route.title}` : "Tool-output incidents";
    void refresh();
  }, [refresh, route]);

  useEffect(() => {
    if (!desktopApi?.onToolOutputIncidentExplorerRefresh) return;
    return desktopApi.onToolOutputIncidentExplorerRefresh((request) => {
      if (request) {
        setRoute({
          backend: request.backend,
          /* A viewer's explorer reads the peer's thread. Dropping the target
             here would send the next refresh at the local registry, which
             does not have this thread. */
          ...(request.federationTarget
            ? { federationTarget: request.federationTarget }
            : {}),
          projectLabel: request.projectLabel,
          threadId: request.threadId,
          title: request.title,
        });
        /* A window already open keeps the lens it is on, so an operator who
           clicks "Token Miser Savings" on the Pricing rail and gets a focused
           window still sitting on incidents got the wrong screen. Honor the
           request, and stop the opening latch from overruling it. */
        if (request.lens) {
          lensLatched.current = true;
          setLens(request.lens);
        }
      }
      void refresh();
    });
  }, [desktopApi, refresh]);

  useEffect(() => {
    if (!desktopApi?.onAgentEvent || !route) return;
    return desktopApi.onAgentEvent((event) => {
      if (event.backend !== route.backend) {
        return;
      }
      const notification = event.notification;
      if (notification.method === "thread/pricing/updated") {
        // Only the pricing half is refreshed. Calling refresh() here replaced
        // `latest` wholesale, and the selection effect keyed on that identity
        // reset the operator's typed steering text mid-turn.
        // Same shape as the read response's pricing by contract; the union
        // narrowing does not survive into the callback.
        const pricing = notification.params
          .pricing as AppServerReadThreadResponse["pricing"];
        if (notification.params.threadId === route.threadId && pricing) {
          setLatest((current) => current ? { ...current, pricing } : current);
        }
        return;
      }
      if (notification.method !== "thread/toolAccounting/updated") {
        return;
      }
      if (!notification.params || typeof notification.params !== "object") {
        return;
      }
      const params = notification.params as {
        threadId?: unknown;
        toolAccounting?: ThreadToolAccounting;
      };
      if (params.threadId !== route.threadId || !params.toolAccounting) {
        return;
      }
      // The event payload is capped at the newest 200 invocations while this
      // window loaded every one of them, so adopting it wholesale shrank the
      // case list mid-session. Take the Token Miser accounting, which is
      // thread-wide, and keep the fuller invocation set already loaded.
      const live = params.toolAccounting;
      setAccounting((current) => {
        if (!current) {
          return live;
        }
        return current.invocations.length > live.invocations.length
          ? { ...current, ...live, invocations: current.invocations }
          : live;
      });
    });
  }, [desktopApi, refresh, route]);

  const allInvocations = useMemo(
    () => accounting?.invocations ?? [],
    [accounting?.invocations],
  );
  const largeOutputThresholdChars = toolOutputWarningChars(
    settings.snapshot?.general.toolOutputAlerts
      ?.repeatedLargeOutputMinimumPercent.value
      ?? DESKTOP_TOOL_OUTPUT_ALERT_POLICY_DEFAULT
        .repeatedLargeOutputMinimumPercent,
  );
  const flagged = useMemo(
    () => allInvocations.filter((invocation) =>
      isFlaggedToolInvocation(invocation, largeOutputThresholdChars)
    ),
    [allInvocations, largeOutputThresholdChars],
  );
  const summary = useMemo(
    () => summarizeIncidents(allInvocations, { largeOutputThresholdChars }),
    [allInvocations, largeOutputThresholdChars],
  );
  const usageLines = latest?.pricing?.lines;
  const tokenMiser = accounting?.tokenMiser;
  const activeTokenMiser = tokenMiser && (
    tokenMiser.interceptionCount > 0
    || (tokenMiser.codeMode?.callCount ?? 0) > 0
  )
    ? tokenMiser
    : undefined;
  const totalEstimatedParentTokensSaved = activeTokenMiser
    ? activeTokenMiser.estimatedParentTokensSaved
      + (activeTokenMiser.estimatedCachedReplayTokensSaved ?? 0)
    : 0;
  const tokenMiserEnabled =
    settings.snapshot?.experimental.tokenMiserEnabled.value ?? false;
  const tokenMiserComparison = useMemo(
    () => buildTokenMiserContextComparison(allInvocations, activeTokenMiser),
    [activeTokenMiser, allInvocations],
  );
  const gateEntries = useMemo(
    () => buildTokenMiserGateEntries(allInvocations, activeTokenMiser),
    [activeTokenMiser, allInvocations],
  );
  // The savings lens only exists where gating is part of the story. With the
  // feature off and nothing ever gated, this stays the single-lens screen it
  // was rather than growing a tab that can only say "nothing happened".
  const showSavingsLens = tokenMiserEnabled || Boolean(activeTokenMiser);
  // Latch the opening lens the first time accounting arrives, then leave it
  // alone. Re-deriving it from `activeTokenMiser` would yank the operator out
  // of the case they are reading the moment a gate lands mid-turn.
  //
  // Adjusted during render rather than in an effect: an effect commits one
  // painted frame on the incidents lens before switching, so a thread that
  // gated would open on the wrong lens and visibly flip. React discards this
  // render and re-runs before painting.
  if (!lensLatched.current && accounting) {
    lensLatched.current = true;
    if (
      (accounting.tokenMiser?.interceptionCount ?? 0) > 0
      || (accounting.tokenMiser?.codeMode?.callCount ?? 0) > 0
    ) {
      setLens("savings");
    }
  }
  const lens: ToolOutputIncidentExplorerLens =
    showSavingsLens ? lensChoice : "incidents";
  const tokenMiserUsageLines = useMemo(
    () => (usageLines ?? []).filter((line) =>
      line.scope === "monitor"
      && line.sourceItemId?.startsWith("system:token-miser:"),
    ),
    [usageLines],
  );
  const tokenMiserGateTokens = tokenMiserUsageLines.reduce(
    (total, line) => total + line.totalTokens,
    0,
  );
  const tokenMiserGateCostMicros = tokenMiserUsageLines.reduce(
    (total, line) => total + line.totalCostMicros,
    0,
  );
  // The thread's own billed total, for "cost X, would have cost Y". Provider
  // summaries are the same rows the Pricing rail totals.
  const threadCostMicros = latest?.pricing?.summaries.reduce(
    (total, provider) => total + provider.totalCostMicros,
    0,
  ) ?? 0;
  const turnStrip = useMemo(
    () => buildTurnCostStrip(allInvocations, {
      largeOutputThresholdChars,
      scope: turnScope,
      ...(usageLines ? { usageLines } : {}),
    }),
    [allInvocations, largeOutputThresholdChars, turnScope, usageLines],
  );
  const compactionsByTurn = useMemo(
    () => countCompactionsByTurn(
      latest?.pricing?.compactions ?? [],
      usageLines ?? [],
    ),
    [latest?.pricing?.compactions, usageLines],
  );
  const currency = usageLines?.[0]?.currency;
  const contextWindowSummary = useMemo(
    () => buildContextWindowSummary(usageLines ?? []),
    [usageLines],
  );
  const composition = useMemo(() => buildCategoryComposition(flagged), [flagged]);
  /* Which refined categories the active legend entry stands for. "Other" is a
     real set, not a leftover, so selecting it filters to its members. */
  const selectedCategories = useMemo(() => {
    if (category === "all") return undefined;
    const entry = composition.find((share) => share.category === category);
    /* A refresh can retire the selected category. Showing everything is the
       safer failure than an unexplained empty list. */
    return entry ? new Set<RefinedToolCategory>(entry.members) : undefined;
  }, [category, composition]);
  /* Counted over every recorded call, not just flagged ones: a command that
     ran eight times and tripped the size test five times repeated eight. */
  const repeatedCommands = useMemo(
    () => countRepeatedCommands(allInvocations),
    [allInvocations],
  );
  /* Every turn, not just the rows the strip had room for — a case in a turn
     that fell below the row limit still belongs to that turn. */
  const turnLabels = turnStrip.labelsByKey;

  const invocations = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return sortIncidentCases(
      flagged.filter((invocation) =>
        (!selectedCategories || selectedCategories.has(refineToolCategory(invocation)))
        && (turnFilter === undefined || (invocation.turnId ?? "") === turnFilter)
        && (
          !normalizedSearch
          || (invocation.normalizedCommand ?? invocation.toolName)
            .toLowerCase()
            .includes(normalizedSearch)
          || invocation.noisyReason?.toLowerCase().includes(normalizedSearch)
        )
      ),
      sortMode,
    );
  }, [flagged, search, selectedCategories, sortMode, turnFilter]);
  const selected = invocations.find((invocation) => invocation.invocationId === selectedId)
    ?? invocations[0];
  const selectedTokenMiser = selected
    ? matchTokenMiserInvocations(
        allInvocations,
        tokenMiser?.interceptions ?? [],
      ).get(selected.invocationId)
    : undefined;

  useEffect(() => {
    setPrompt(selected
      ? selected.suggestedPrompt ?? buildThreadToolIncidentPrompt({
          invocation: selected,
          reason: selected.noisyReason ?? "large tool output",
        })
      : "");
    setIdentityExpanded(false);
    setOutput(undefined);
    setOutputSearch("");
    if (!selected || !latest || !desktopApi?.readThread || !route) return;
    let cancelled = false;
    void readInvocationOutput({
      backend: route.backend,
      desktopApi,
      ...(route.federationTarget
        ? { federationTarget: route.federationTarget }
        : {}),
      initial: latest,
      invocation: selected,
      threadId: route.threadId,
    }).then((value) => {
      if (!cancelled) setOutput(value);
    }).catch((error) => {
      if (!cancelled) reportError(error);
    });
    return () => {
      cancelled = true;
    };
  }, [desktopApi, latest, reportError, route, selected]);

  if (!route) {
    return <p className="incident-explorer__error">Invalid incident explorer route.</p>;
  }

  const activeTurnId = findActiveTurnId(latest);
  const canSteerSelected = Boolean(
    selected?.turnId
    && selected.turnId === activeTurnId
    && desktopApi?.steerTurn,
  );
  const canSendAsNewTurn = Boolean(!activeTurnId && desktopApi?.startTurn);
  const visibleOutputLines = filterOutputLines(output, outputSearch);
  const laterTripsInTurn = selected ? countLaterTripsInTurn(allInvocations, selected) : 0;
  /* One clock read per render, shared by every turn row. */
  const renderedAt = Date.now();

  const analyze = async (): Promise<void> => {
    if (!desktopApi?.analyzeThreadToolHistory) return;
    setAnalyzing(true);
    setStatusTone("info");
    /* The scan pages through the whole thread 100 entries at a time, which on
       a long thread is tens of seconds of silence. Say so up front rather
       than leaving a disabled button as the only feedback. */
    setStatus("Scanning this thread's history…");
    try {
      const response = await desktopApi.analyzeThreadToolHistory({
        backend: route.backend,
        ...(route.federationTarget
          ? { federationTarget: route.federationTarget }
          : {}),
        threadId: route.threadId,
      });
      setAccounting(response.accounting);
      /* Analysis persisted new rows and new output availability; re-read so
         the transcript pages backing captured-output retrieval match the
         findings now on screen. */
      void refresh();
      setStatusTone(response.coverage.completeness === "complete" ? "info" : "error");
      setStatus(
        response.coverage.completeness === "complete"
          ? describeAnalysisCoverage({
              coverage: response.coverage,
              knownInvocationCount: response.accounting.invocations.length,
            })
          : response.coverage.explanation ?? "Analysis is incomplete.",
      );
    } catch (error) {
      reportError(error);
    } finally {
      setAnalyzing(false);
    }
  };

  const sendPrompt = async (): Promise<void> => {
    if (!selected || !prompt.trim()) return;
    setStatus(undefined);
    try {
      if (canSteerSelected && selected.turnId) {
        await desktopApi?.steerTurn?.({
          backend: route.backend,
          /* Steering a peer's turn has to reach the peer, the same way this
             window's reads do. */
          ...(route.federationTarget
            ? { federationTarget: route.federationTarget }
            : {}),
          expectedTurnId: selected.turnId,
          input: [{ type: "text", text: prompt.trim() }],
          requestId: `tool-output-incident:${selected.invocationId}:${Date.now()}`,
          threadId: route.threadId,
        });
        setStatusTone("info");
        setStatus("Steering delivered to the exact active turn.");
      } else if (canSendAsNewTurn) {
        await desktopApi?.startTurn?.({
          backend: route.backend,
          ...(route.federationTarget
            ? { federationTarget: route.federationTarget }
            : {}),
          input: [{ type: "text", text: prompt.trim() }],
          threadId: route.threadId,
        });
        setStatusTone("info");
        setStatus("Prompt sent as a new turn.");
      }
    } catch (error) {
      reportError(error);
    }
  };

  const breadcrumbCurrent = showSavingsLens && lens === "savings"
    ? "Token Miser Savings"
    : "Tool Output Incidents";

  return (
    <div className="incident-explorer">
      <header className="activity-titlebar">
        <p className="activity-titlebar__brand">
          Pwr<span className="activity-titlebar__brand-accent">Agent</span>
        </p>
        <div
          aria-label={[
            route.projectLabel,
            route.title,
            breadcrumbCurrent,
          ].filter(Boolean).join(" > ")}
          className="activity-titlebar__breadcrumb"
        >
          {route.projectLabel ? (
            <>
              <span className="activity-titlebar__crumb" title={route.projectLabel}>
                {route.projectLabel}
              </span>
              <span aria-hidden="true" className="activity-titlebar__separator">›</span>
            </>
          ) : null}
          <ThreadChip
            link={{
              backend: route.backend,
              inThreadList: true,
              threadId: route.threadId,
              title: route.title,
            }}
            onOpen={() => {
              /* No federation target: this explorer is opened for a local
                 thread, and the main-process handler routes back to its
                 owning main window. */
              void desktopApi?.showThreadFromToolOutputIncidentExplorer?.({
                backend: route.backend,
                threadId: route.threadId,
              }).catch((error: unknown) => {
                reportError(error);
              });
            }}
          />
          <span aria-hidden="true" className="activity-titlebar__separator">›</span>
          <span className="activity-titlebar__current">{breadcrumbCurrent}</span>
        </div>
        <span className="chip chip--backend">
          {formatBackendLabel(route.backend)}
        </span>
        <div className="activity-titlebar__spacer" />
        <div className="incident-explorer__actions">
          <button
            className="incident-explorer__button"
            type="button"
            onClick={() => void analyze()}
            disabled={analyzing}
          >
            {analyzing
              ? "Analyzing…"
              : accounting?.analysis ? "Refresh analysis" : "Analyze history"}
          </button>
          <button
            className="incident-explorer__button incident-explorer__button--ghost"
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
          >
            Refresh
          </button>
        </div>
      </header>

      {showSavingsLens ? (
        <div className="incident-explorer__lenses" role="tablist" aria-label="Tool output lens">
          <button
            aria-selected={lens === "savings"}
            className="incident-explorer__lens"
            onClick={() => setLens("savings")}
            role="tab"
            type="button"
          >
            Savings
            <span>
              {activeTokenMiser
                ? formatCompactTokens(
                    totalEstimatedParentTokensSaved,
                  ) + " avoided"
                : "nothing gated"}
            </span>
          </button>
          <button
            aria-selected={lens === "incidents"}
            className="incident-explorer__lens"
            onClick={() => setLens("incidents")}
            role="tab"
            type="button"
          >
            Incidents
            <span>
              {summary.caseCount.toLocaleString()}{" "}
              {summary.caseCount === 1 ? "case" : "cases"}
            </span>
          </button>
        </div>
      ) : null}

      {lens === "savings" ? (
        <TokenMiserSavingsLens
          comparison={tokenMiserComparison}
          compactions={latest?.pricing?.compactions ?? []}
          contextWindow={contextWindowSummary}
          {...(currency ? { currency } : {})}
          gateCostMicros={tokenMiserGateCostMicros}
          gateTokens={tokenMiserGateTokens}
          gates={gateEntries}
          invocations={allInvocations}
          threadCostMicros={threadCostMicros}
          tokenMiser={activeTokenMiser}
          usageLines={usageLines ?? []}
        />
      ) : (
      <>
      <div className="incident-explorer__summary" aria-label="Incident metrics">
        <div className="incident-explorer__headline">
          <p className="incident-explorer__eyebrow">Raw output from flagged calls</p>
          <p className="incident-explorer__hero">
            <strong>{formatCompactTokens(summary.incidentTokens)}</strong>
            <span>
              tokens · {Math.round(summary.share * 100)}% of all tool output
            </span>
          </p>
          <span
            aria-hidden="true"
            className="incident-explorer__meter"
          >
            <i style={{ width: `${Math.round(summary.share * 100)}%` }} />
          </span>
          <p className="incident-explorer__caption">
            <b>{summary.caseCount}</b> {summary.caseCount === 1 ? "case" : "cases"}
            {" · "}{summary.turnCount} {summary.turnCount === 1 ? "turn" : "turns"}
            {" · "}{summary.incidentChars.toLocaleString()} chars
            {" · worst "}{summary.worstChars.toLocaleString()}
          </p>
        </div>
        <div className="incident-explorer__composition-group" role="group" aria-label="Filter by category">
          <p className="incident-explorer__eyebrow">Where it went</p>
          <CompositionBar composition={composition} />
          <div className="incident-explorer__legend">
            <button
              aria-pressed={category === "all"}
              className="incident-explorer__legend-item"
              onClick={() => setCategory("all")}
              type="button"
            >
              <i className="incident-explorer__swatch incident-explorer__swatch--all" />
              All categories
              <em>{formatCompactTokens(summary.incidentTokens)}</em>
            </button>
            {composition.map((entry, index) => (
              <button
                aria-pressed={category === entry.category}
                className="incident-explorer__legend-item"
                key={entry.category}
                onClick={() => setCategory(
                  category === entry.category ? "all" : entry.category,
                )}
                title={entry.category === "other"
                  ? entry.members.map(formatCategoryLabel).join(", ")
                  : undefined}
                type="button"
              >
                <i
                  className="incident-explorer__swatch"
                  data-rank={Math.min(index + 1, 5)}
                />
                {entry.label}
                <em>
                  {formatCompactTokens(entry.estimatedOutputTokens)}
                  {" · "}{Math.round(entry.share * 100)}%
                </em>
              </button>
            ))}
          </div>
          <TurnTimeline
            compactionsByTurn={compactionsByTurn}
            {...(currency ? { currency } : {})}
            now={renderedAt}
            onSelect={(row) => setTurnFilter(
              turnFilter === row.key ? undefined : row.key,
            )}
            selectedKey={turnFilter}
            timeline={turnStrip.timeline}
          />
        </div>
      </div>

      {/* One line, never the headline: the incidents lens is about raw output,
          and gating is a cross-reference from it rather than its subject. */}
      {showSavingsLens ? (
        <div
          className="incident-explorer__token-miser-strip"
          data-state={activeTokenMiser ? "active" : "inactive"}
        >
          <span aria-hidden="true" className="incident-explorer__token-miser-dot" />
          <span>
            {activeTokenMiser
              ? describeTokenMiserReach({
                  gatedCount: activeTokenMiser.interceptionCount,
                  passThroughCount: activeTokenMiser.passThroughCount ?? 0,
                  ...(activeTokenMiser.codeMode
                    ? {
                        codeModeCallCount: activeTokenMiser.codeMode.callCount,
                        directCount: activeTokenMiser.codeMode.directCount,
                        retrievalCount: activeTokenMiser.codeMode.retrievalCount,
                      }
                    : {}),
                  savedTokens: totalEstimatedParentTokensSaved,
                  toolCallCount: allInvocations.length,
                })
              : "No historical Token Miser observations were recorded for this thread."}
          </span>
          <span className="incident-explorer__token-miser-spacer" />
          <button
            className="incident-explorer__token-miser-link"
            onClick={() => setLens("savings")}
            type="button"
          >
            See the breakdown →
          </button>
        </div>
      ) : null}

      <TurnStrip
        compactionsByTurn={compactionsByTurn}
        {...(currency ? { currency } : {})}
        now={renderedAt}
        onScopeChange={setTurnScope}
        showCost={turnStrip.rows.some((row) => row.costMicros !== undefined)}
        onSelect={(row) => setTurnFilter(
          turnFilter === row.key ? undefined : row.key,
        )}
        selectedKey={turnFilter}
        strip={turnStrip}
      />

      {accounting?.analysis?.completeness === "partial" ? (
        <p className="incident-explorer__coverage" role="status">
          Partial coverage: {accounting.analysis.explanation}
        </p>
      ) : null}
      {status ? (
        <p
          className="incident-explorer__status"
          data-tone={statusTone}
          role="status"
        >
          {status}
        </p>
      ) : null}

      <div className="incident-explorer__body">
        <aside className="incident-explorer__list" aria-label="Incident cases">
          <div className="incident-explorer__filters">
            <input
              aria-label="Filter incident cases"
              onChange={(event) => setSearch(event.currentTarget.value)}
              placeholder="Filter cases"
              type="search"
              value={search}
            />
            <select
              aria-label="Sort cases"
              onChange={(event) => setSortMode(event.currentTarget.value as IncidentSortMode)}
              value={sortMode}
            >
              <option value="largest">Largest first</option>
              <option value="newest">Newest first</option>
              <option value="turn">By turn</option>
            </select>
          </div>
          {turnFilter !== undefined || category !== "all" ? (
            <div className="incident-explorer__active-filters">
              <span>
                Showing {invocations.length.toLocaleString()} of {flagged.length.toLocaleString()} cases
              </span>
              <button
                className="incident-explorer__button incident-explorer__button--ghost"
                onClick={() => {
                  setCategory("all");
                  setTurnFilter(undefined);
                }}
                type="button"
              >
                Clear filters
              </button>
            </div>
          ) : null}
          {groupCases(invocations, sortMode, turnLabels).map((group) => (
            <section className="incident-explorer__group" key={group.key}>
              {group.label ? <h3>{group.label}</h3> : null}
              {group.invocations.map((invocation) => (
                <CaseRow
                  invocation={invocation}
                  key={invocation.invocationId}
                  now={renderedAt}
                  onSelect={() => setSelectedId(invocation.invocationId)}
                  repeatCount={repeatCountFor(invocation, repeatedCommands)}
                  selected={invocation.invocationId === selected?.invocationId}
                />
              ))}
            </section>
          ))}
          {!loading && invocations.length === 0 ? (
            <p className="incident-explorer__empty">
              {flagged.length > 0
                ? "No findings match these filters."
                : allInvocations.length === 0
                  ? "No tool calls are recorded for this thread yet."
                  : `None of this thread's ${allInvocations.length.toLocaleString()} recorded tool calls returned at least ${largeOutputThresholdChars.toLocaleString()} characters.`}
            </p>
          ) : null}
        </aside>

        <main className="incident-explorer__detail">
          {selected ? (
            <>
              <section className="incident-explorer__evidence">
                <div className="incident-explorer__section-heading">
                  <h2>Selected invocation</h2>
                  <button
                    className="incident-explorer__button incident-explorer__button--ghost"
                    onClick={() => void desktopApi?.copyText?.(
                      selected.normalizedCommand ?? selected.toolName,
                    )}
                    type="button"
                  >
                    Copy command
                  </button>
                </div>
                <div
                  className="incident-explorer__identity"
                  data-expanded={identityExpanded}
                >
                  <code>{selected.normalizedCommand ?? selected.toolName}</code>
                  <button
                    className="incident-explorer__button incident-explorer__button--ghost"
                    onClick={() => setIdentityExpanded((value) => !value)}
                    type="button"
                  >
                    {identityExpanded ? "Collapse" : "Expand"}
                  </button>
                </div>
                <div className="incident-explorer__facts">
                  <Fact
                    label={selected.status}
                    tone={invocationStatusTone(selected)}
                    value={selected.exitCode !== undefined ? `exit ${selected.exitCode}` : "—"}
                  />
                  <Fact
                    label={formatCategoryLabel(refineToolCategory(selected))}
                    value={turnLabels.get(selected.turnId ?? "") ?? "No turn"}
                  />
                  {repeatCountFor(selected, repeatedCommands) > 1 ? (
                    <Fact
                      label="repeated"
                      tone="warning"
                      value={`${repeatCountFor(selected, repeatedCommands)}× in this thread`}
                    />
                  ) : null}
                  <Fact label="observed" value={formatTimestamp(selected.observedAt)} />
                  <Fact
                    label="telemetry"
                    tone={selected.outputState === "available" ? undefined : "warning"}
                    value={describeAvailability(selected)}
                  />
                  <Fact label="source" value={selected.source ?? "live"} />
                </div>

                <div className="incident-explorer__budget">
                  <div className="incident-explorer__budget-head">
                    <strong>
                      {selected.estimatedOutputTokens.toLocaleString()} raw-output tokens
                    </strong>
                    <span>{formatCapShare(selected.outputChars)}</span>
                  </div>
                  <span aria-hidden="true" className="incident-explorer__meter">
                    <i
                      data-critical={isOverOutputCap(selected.outputChars)}
                      style={{ width: `${capMeterWidth(selected.outputChars) * 100}%` }}
                    />
                  </span>
                  {selectedTokenMiser
                    && selectedTokenMiser.disposition !== "passed_through" ? (
                      <>
                        <p className="incident-explorer__caption">
                          Emitted {selected.outputChars.toLocaleString()} raw characters;
                          {" Token Miser revealed "}
                          {(selectedTokenMiser.replacementCharacters
                            ?? selectedTokenMiser.replacementTokens * 4)
                            .toLocaleString()} characters.
                        </p>
                        <p className="incident-explorer__caption">
                          Raw output would otherwise have replayed across{" "}
                          {(selectedTokenMiser.cachedReplayCount ?? 0).toLocaleString()}
                          {" later parent "}
                          {(selectedTokenMiser.cachedReplayCount ?? 0) === 1
                            ? "request."
                            : "requests."}
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="incident-explorer__caption">
                          Raw emitted: {selected.outputChars.toLocaleString()} characters.
                          {" Estimated parent-visible payload after the standard cap: up to "}
                          {Math.min(
                            selected.outputChars,
                            DEFAULT_MODEL_VISIBLE_TOOL_OUTPUT_CAP_CHARACTERS,
                          ).toLocaleString()} characters, before the outer status envelope.
                        </p>
                        <p className="incident-explorer__caption">
                          {laterTripsInTurn.toLocaleString()} later recorded tool invocations.
                          {" This is not parent-request replay or billing evidence."}
                        </p>
                      </>
                    )}
                  <p className="incident-explorer__reason">
                    {selected.noisyReason ?? "large output"}
                  </p>
                </div>
                {selectedTokenMiser ? (
                  <div className="incident-explorer__token-miser-call">
                    <div>
                      <span>Gated by Token Miser</span>
                      <strong>
                        {formatCompactTokens(selectedTokenMiser.baselineParentTokens)} baseline
                        {" → "}
                        {formatCompactTokens(selectedTokenMiser.replacementTokens)} summary
                      </strong>
                    </div>
                    <p>
                      {describeTokenMiserOutcome(
                        selectedTokenMiser.estimatedParentTokensSaved,
                      )}
                      {selectedTokenMiser.retrievedTokens > 0
                        ? ` · ${formatCompactTokens(selectedTokenMiser.retrievedTokens)} retrieved later`
                        : " · nothing retrieved later"}
                    </p>
                  </div>
                ) : null}
              </section>

              <section className="incident-explorer__prompt">
                <details className="incident-explorer__steer">
                  <summary>Proposed steering</summary>
                  <textarea
                    aria-label="Editable proposed steering prompt"
                    onChange={(event) => setPrompt(event.currentTarget.value)}
                    rows={8}
                    value={prompt}
                  />
                </details>
                <div className="incident-explorer__prompt-actions">
                  <button
                    className="incident-explorer__button incident-explorer__primary"
                    disabled={!prompt.trim() || (!canSendAsNewTurn && !canSteerSelected)}
                    onClick={() => void sendPrompt()}
                    type="button"
                  >
                    {canSteerSelected ? "Steer exact active turn" : "Send next turn"}
                  </button>
                  <button
                    className="incident-explorer__button"
                    onClick={() => void desktopApi?.copyText?.(prompt)}
                    type="button"
                  >
                    Copy
                  </button>
                  {!canSteerSelected && activeTurnId ? (
                    <p>The selected finding belongs to another turn. It cannot steer the active turn; send it after that turn ends.</p>
                  ) : null}
                </div>
              </section>

              <section className="incident-explorer__output">
                <div className="incident-explorer__section-heading">
                  <h2>Captured output</h2>
                  {output !== undefined ? (
                    <input
                      aria-label="Search captured output"
                      onChange={(event) => setOutputSearch(event.currentTarget.value)}
                      placeholder="Search output"
                      type="search"
                      value={outputSearch}
                    />
                  ) : null}
                </div>
                {output !== undefined ? (
                  <ol className="incident-explorer__output-lines">
                    {visibleOutputLines.map((line) => (
                      <li key={line.number} value={line.number}>
                        <code>{line.text || " "}</code>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="incident-explorer__unavailable">
                    <b>Not retained by normalized replay</b>
                    {selected.outputState === "compacted"
                      ? `The ${selected.outputChars.toLocaleString()} characters this call returned were compacted out. Size and category come from tool accounting, recorded when the call ran.`
                      : selected.outputState === "truncated"
                        ? "Only the truncated output retained by normalized replay is available."
                        : "Output is unavailable in the currently available normalized replay."}
                  </p>
                )}
              </section>
            </>
          ) : null}
        </main>
      </div>
      </>
      )}
    </div>
  );
}

/**
 * How much of the thread the gate actually caught.
 *
 * The denominator is every tool call, not the flagged ones: flagging uses the
 * alert threshold while gating uses Token Miser's own, much lower one, so gated
 * calls are not a subset of flagged calls — pairing them produced "gated 25 of
 * 7 flagged calls". When the counts still cannot be reconciled (accounting that
 * does not list every gated call), report the gated count alone rather than a
 * ratio that cannot be true.
 */
function describeTokenMiserReach(params: {
  codeModeCallCount?: number;
  directCount?: number;
  gatedCount: number;
  passThroughCount: number;
  retrievalCount?: number;
  savedTokens: number;
  toolCallCount: number;
}): string {
  const kept =
    `kept ${formatCompactTokens(params.savedTokens)} out of the parent's context.`;
  if (params.codeModeCallCount !== undefined) {
    const summarized = params.gatedCount - params.passThroughCount;
    return `Token Miser observed ${params.codeModeCallCount.toLocaleString()} Code Mode `
      + `${params.codeModeCallCount === 1 ? "result" : "results"}: `
      + `${summarized.toLocaleString()} summarized, `
      + `${params.passThroughCount.toLocaleString()} passed through, `
      + `${(params.directCount ?? 0).toLocaleString()} stayed direct, and `
      + `${(params.retrievalCount ?? 0).toLocaleString()} `
      + `${(params.retrievalCount ?? 0) === 1 ? "retrieval" : "retrievals"} ran. It ${kept}`;
  }
  if (params.passThroughCount > 0) {
    return `Token Miser made ${params.gatedCount.toLocaleString()} `
      + `${params.gatedCount === 1 ? "decision" : "decisions"}, passed `
      + `${params.passThroughCount.toLocaleString()} through, and ${kept}`;
  }
  if (params.toolCallCount < params.gatedCount || params.toolCallCount === 0) {
    return `Token Miser gated ${params.gatedCount.toLocaleString()} `
      + `${params.gatedCount === 1 ? "call" : "calls"} and ${kept}`;
  }
  return `Token Miser gated ${params.gatedCount.toLocaleString()} of `
    + `${params.toolCallCount.toLocaleString()} tool `
    + `${params.toolCallCount === 1 ? "call" : "calls"} and ${kept}`;
}

function describeTokenMiserOutcome(estimatedTokensSaved: number): string {
  return estimatedTokensSaved >= 0
    ? `${formatCompactTokens(estimatedTokensSaved)} estimated parent-context footprint avoided`
    : `${formatCompactTokens(Math.abs(estimatedTokensSaved))} estimated net parent-context token overhead`;
}

/**
 * What gating bought, and where it did not.
 *
 * Costs are reported in tokens rather than dollars because this window only
 * has the gate's own priced usage lines — pricing the avoided footprint needs
 * the parent model's rates, which live with the thread's pricing ledger. The
 * gate's compute cost is real money and is shown as such.
 */
/**
 * How much of the replay count was actually observed.
 *
 * Directly-observed replays were counted at a request boundary. Reconstructed
 * ones were inferred from later tool invocations on pre-v2 gates, which cannot
 * see cross-turn replays or compaction boundaries — a floor, not a count. The
 * distinction has to survive into the UI, because the two are summed into one
 * savings figure and only one of them is exact.
 *
 * The count is payload replays, not model requests: it sums each gate against
 * the requests that followed it, so 25 gates over 65 requests is on the order
 * of a thousand. Calling those "replays tracked at the request boundary" read
 * as a request count and produced "902 of 902" on a single-turn thread.
 */
function SavingsConfidence(props: { savings: ThreadTokenMiserSavings }) {
  const { directlyObservedReplayCount, reconstructedReplayCount } = props.savings;
  const total = directlyObservedReplayCount + reconstructedReplayCount;
  const reconstructed = reconstructedReplayCount > 0;
  const unpriced = props.savings.gateCount - props.savings.pricedGateCount;
  const gates = props.savings.gateCount;
  const passThroughs = props.savings.passThroughCount ?? 0;
  const decisionLabel = passThroughs > 0
    ? `${gates.toLocaleString()} decisions (${passThroughs.toLocaleString()} pass-through)`
    : `${gates.toLocaleString()} ${gates === 1 ? "gate" : "gates"}`;
  return (
    <p
      className="incident-explorer__confidence"
      data-kind={reconstructed ? "reconstructed" : "observed"}
    >
      <span aria-hidden="true" />
      {reconstructed
        ? `Partly reconstructed · ${reconstructedReplayCount.toLocaleString()} of `
          + `${total.toLocaleString()} payload replays inferred from later tool calls`
        : `Directly observed · ${total.toLocaleString()} payload `
          + `${total === 1 ? "replay" : "replays"} across ${decisionLabel}, `
          + "each counted at a request boundary"}
      {unpriced > 0
        ? ` · ${unpriced.toLocaleString()} ${unpriced === 1 ? "gate is" : "gates are"} not priced yet`
        : ""}
    </p>
  );
}

type SavingsSplit = {
  avoided: number;
  gate: number;
  revealed: number;
  /**
   * The caption's whole percents. The last term absorbs the rounding instead
   * of being rounded itself: three shares of one whole, each rounded on its
   * own, read as "51% · 3% · 47%" often enough to invite the reader to notice
   * that the decomposition under the bar does not close.
   */
  rounded: { avoided: number; gate: number; revealed: number };
};

/**
 * The three terms as shares of the unfiltered cost.
 *
 * Only drawn when the gate came out ahead. With negative savings the parts sum
 * past the whole, and a bar overflowing its own track reads as a rendering
 * fault rather than as an overspend — that case states itself in words above.
 */
function buildSavingsSplit(
  savings: ThreadTokenMiserSavings,
): SavingsSplit | undefined {
  const whole = savings.withoutGateCostMicros;
  if (whole <= 0 || savings.savingsMicros <= 0) return undefined;
  const avoided = savings.savingsMicros / whole * 100;
  const gate = savings.gateCostMicros / whole * 100;
  const roundedAvoided = Math.round(avoided);
  const roundedGate = Math.round(gate);
  return {
    avoided,
    gate,
    revealed: savings.revealedCostMicros / whole * 100,
    rounded: {
      avoided: roundedAvoided,
      gate: roundedGate,
      revealed: Math.max(0, 100 - roundedAvoided - roundedGate),
    },
  };
}

type SavingsDetailMeasurement = {
  /**
   * The height the two panes share: the detail stack plus the results list,
   * measured rather than derived. Deliberately not the lens container, which
   * also holds the hero, the grip, and the gaps between them — sizing the
   * clamp against that lets a dragged height be stored hundreds of pixels
   * past anything the window can honour.
   */
  availableHeight: number;
  detailsHeight: number;
};

/** The results list, whose floor the grip must never cross. */
const SAVINGS_RESULTS_SELECTOR = ".incident-explorer__gates";

const EMPTY_SAVINGS_MEASUREMENT: SavingsDetailMeasurement = {
  availableHeight: 0,
  detailsHeight: 0,
};

/**
 * Per-machine view state for the lens: which reference rows are unfolded, and
 * how tall the operator dragged the detail stack.
 *
 * Called before this component's early returns so the hook order never depends
 * on whether a thread has gate decisions.
 */
function useSavingsLayout() {
  const [layout, setLayout] = useState(readStoredSavingsLayout);
  const [measurement, setMeasurement] = useState(EMPTY_SAVINGS_MEASUREMENT);
  /* Mount reads; only a change writes. Persisting on mount would create the
     key for every operator who merely opened the lens, and leave the stored
     state unable to say whether anyone ever moved the split. */
  const persisted = useRef(false);
  useEffect(() => {
    if (!persisted.current) {
      persisted.current = true;
      return;
    }
    writeStoredSavingsLayout(layout);
  }, [layout]);
  const toggleSection = useCallback(
    (key: SavingsSectionKey, open: boolean) => {
      setLayout((current) => ({
        ...current,
        openSections: open
          ? current.openSections.includes(key)
            ? current.openSections
            : [...current.openSections, key]
          : current.openSections.filter((entry) => entry !== key),
      }));
    },
    [],
  );
  const resizeDetails = useCallback((height: number, available: number) => {
    setLayout((current) => ({
      ...current,
      detailsHeight: clampDetailsHeight(height, available),
    }));
  }, []);
  /* The stack measures itself after every render, so this has to return the
     identical object when nothing moved — a fresh object each time would
     re-render, re-measure, and never settle. */
  const measure = useCallback((next: SavingsDetailMeasurement) => {
    setMeasurement((current) =>
      current.availableHeight === next.availableHeight
        && current.detailsHeight === next.detailsHeight
        ? current
        : next);
  }, []);
  return { layout, measure, measurement, resizeDetails, toggleSection };
}

/**
 * The folding reference rows, above the results list.
 *
 * `flex-shrink` is load-bearing: the operator's dragged height is a preference,
 * not a floor, so a short window still gives the results list its three rows
 * and lets this stack scroll instead.
 */
function SavingsDetailStack(props: {
  children: ReactNode;
  height: number | undefined;
  onMeasure: (measurement: SavingsDetailMeasurement) => void;
}) {
  const stackRef = useRef<HTMLDivElement>(null);
  const onMeasure = props.onMeasure;
  useLayoutEffect(() => {
    const node = stackRef.current;
    if (!node) return;
    const list = node.parentElement?.querySelector(SAVINGS_RESULTS_SELECTOR);
    const measureNow = () => {
      const stackHeight = node.getBoundingClientRect().height;
      const listHeight = list?.getBoundingClientRect().height ?? 0;
      onMeasure({
        availableHeight: stackHeight + listHeight,
        detailsHeight: stackHeight,
      });
    };
    measureNow();
    /* Observed rather than re-measured on every render. A render-time
       measurement forces two layout flushes per poll and still misses the one
       change that matters most — the operator resizing the window, which moves
       the list without re-rendering the lens at all. */
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureNow);
    observer.observe(node);
    if (list) observer.observe(list);
    return () => observer.disconnect();
  }, [onMeasure]);
  return (
    <div
      className="incident-explorer__savings-details"
      ref={stackRef}
      style={props.height === undefined
        ? undefined
        : { height: `${props.height}px` }}
    >
      {props.children}
    </div>
  );
}

/** How far the operator dragged the split, as the 0–100 a separator reports. */
function savingsSplitShare(measurement: SavingsDetailMeasurement): number {
  const ceiling = measurement.availableHeight - SAVINGS_RESULTS_MIN_HEIGHT;
  const span = ceiling - SAVINGS_DETAILS_MIN_HEIGHT;
  if (span <= 0) return 0;
  const share =
    (measurement.detailsHeight - SAVINGS_DETAILS_MIN_HEIGHT) / span * 100;
  return Math.round(Math.min(100, Math.max(0, share)));
}

const SAVINGS_GRIP_KEY_STEP = 24;

/**
 * The handle between the reference rows and the results list.
 *
 * Reported as a percentage rather than pixels because a focusable separator
 * with no `aria-valuemax` is read against the default 0–100, and the pixel
 * ceiling moves with the window.
 */
function SavingsSplitGrip(props: {
  measurement: SavingsDetailMeasurement;
  onResize: (height: number, available: number) => void;
}) {
  const dragRef = useRef<
    { pointerId: number; startHeight: number; startY: number }
  >(undefined);
  const measurement = props.measurement;
  const onResize = props.onResize;
  return (
    <div
      aria-label="Resize the Token Miser detail rows"
      aria-orientation="horizontal"
      aria-valuenow={savingsSplitShare(measurement)}
      className="incident-explorer__savings-grip"
      onKeyDown={(event) => {
        const step = event.key === "ArrowUp"
          ? -SAVINGS_GRIP_KEY_STEP
          : event.key === "ArrowDown"
            ? SAVINGS_GRIP_KEY_STEP
            : undefined;
        if (step === undefined) return;
        event.preventDefault();
        onResize(
          measurement.detailsHeight + step,
          measurement.availableHeight,
        );
      }}
      /* Capture can end without a pointerup — a gesture the OS takes over, a
         window that loses focus mid-drag. Clearing only on pointerup leaves
         the drag armed, and every later hover across the handle then resizes
         the split with no button held. */
      onLostPointerCapture={() => {
        dragRef.current = undefined;
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        /* preventDefault stops the drag from selecting the text either side
           of the grip, and takes the default focus action with it. Focus has
           to be restored by hand, or the keyboard resize this separator
           advertises is reachable only by tabbing to it. */
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          pointerId: event.pointerId,
          startHeight: measurement.detailsHeight,
          startY: event.clientY,
        };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        onResize(
          drag.startHeight + (event.clientY - drag.startY),
          measurement.availableHeight,
        );
      }}
      onPointerUp={(event) => {
        dragRef.current = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      role="separator"
      tabIndex={0}
    >
      <span aria-hidden="true" />
    </div>
  );
}

/** One headline number on a folded row: bright value, muted label. */
type SavingsFact = {
  label: string;
  value: string;
  /**
   * Dimmed, never hidden. A zero here is an answer — no compactions, nothing
   * read back — and dropping the row would read as a missing measurement.
   */
  zero?: boolean;
};

type SavingsFigure = SavingsFact & { detail?: string };

/**
 * A reference section: one scannable line folded, a labelled grid unfolded.
 *
 * Built from the same disclosure primitive as the result rows below rather
 * than `<details>`, so both stacks on this screen open the same way.
 */
function SavingsDetailSection(props: {
  children?: ReactNode;
  facts: SavingsFact[];
  label: string;
  onToggle: (key: SavingsSectionKey, open: boolean) => void;
  open: boolean;
  sectionKey: SavingsSectionKey;
}) {
  return (
    <section
      aria-label={props.label}
      className="incident-explorer__savings-section"
      data-open={props.open}
    >
      <button
        aria-expanded={props.open}
        className="incident-explorer__savings-section-row"
        onClick={() => props.onToggle(props.sectionKey, !props.open)}
        type="button"
      >
        <span aria-hidden="true" className="incident-explorer__savings-chevron" />
        <span className="incident-explorer__savings-section-label">
          {props.label}
        </span>
        <span className="incident-explorer__savings-facts">
          {props.facts.map((fact) => (
            <span data-zero={fact.zero === true} key={fact.label}>
              <b>{fact.value}</b> {fact.label}
            </span>
          ))}
        </span>
      </button>
      {props.open ? props.children : null}
    </section>
  );
}

/**
 * One term of the savings equation.
 *
 * The basis — the token counts, the cached split, the model whose rates were
 * applied — was visible text under each term before this layout compacted the
 * equation into a single line. `title` restores it for a mouse, and nothing
 * else: it is not focusable, several screen readers ignore it, and this window
 * is not covered by the a11y gate. So the same string also renders as text
 * that is clipped rather than absent, and the accessible reading of the
 * equation stays what it was.
 */
function SavingsTerm(props: {
  basis?: string;
  label: string;
  result?: boolean;
  value: string;
}) {
  return (
    <div
      className="incident-explorer__savings-term"
      data-result={props.result === true ? "true" : undefined}
      title={props.basis}
    >
      <dt>{props.label}</dt>
      <dd>
        {props.value}
        {props.basis ? (
          <span className="incident-explorer__savings-basis">
            {" · "}{props.basis}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

function SavingsFigureGrid(props: { figures: SavingsFigure[] }) {
  return (
    <dl className="incident-explorer__savings-figures">
      {props.figures.map((figure) => (
        <div data-zero={figure.zero === true} key={figure.label}>
          <dt>{figure.label}</dt>
          <dd>
            {figure.value}
            {figure.detail ? <span>{figure.detail}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
function TokenMiserSavingsLens(props: {
  comparison?: TokenMiserContextComparison;
  compactions: readonly ThreadCompactionRecord[];
  contextWindow?: TokenMiserContextWindowSummary;
  currency?: string;
  gateCostMicros: number;
  gateTokens: number;
  gates: TokenMiserGateEntry[];
  invocations: ThreadToolInvocationRecord[];
  threadCostMicros: number;
  tokenMiser?: ThreadToolAccounting["tokenMiser"];
  usageLines: readonly ThreadUsageLineRecord[];
}) {
  const { layout, measure, measurement, resizeDetails, toggleSection } =
    useSavingsLayout();
  const tokenMiser = props.tokenMiser;
  if (!tokenMiser) {
    return (
      <div className="incident-explorer__savings">
        <p className="incident-explorer__savings-empty">
          No Token Miser observations were recorded for this thread. Current
          profile activation does not establish its historical turn setting.
        </p>
      </div>
    );
  }
  if (!props.comparison) {
    return (
      <div className="incident-explorer__savings">
        <div className="incident-explorer__savings-hero">
          <p className="incident-explorer__savings-empty">
            No reducer decision was recorded.
          </p>
          <TokenMiserContextTimeline
            compactions={props.compactions}
            usageLines={props.usageLines}
          />
        </div>
        {/* Code Mode is the stack's only child here, and it always renders on
            this branch: the window hands the lens `activeTokenMiser`, which
            exists only when the thread gated or made a Code Mode call, and a
            missing comparison means it did not gate. */}
        <SavingsDetailStack height={layout.detailsHeight} onMeasure={measure}>
          <TokenMiserCodeModeStats
            onToggle={toggleSection}
            open={layout.openSections.includes("code-mode")}
            tokenMiser={tokenMiser}
          />
        </SavingsDetailStack>
        <SavingsSplitGrip measurement={measurement} onResize={resizeDetails} />
        <TokenMiserResultList entries={props.gates} tokenMiser={tokenMiser} />
      </div>
    );
  }
  const savings = tokenMiser.savings;
  const cachedReplayTokens = tokenMiser.estimatedCachedReplayTokensSaved ?? 0;
  const cachedReplayCount = tokenMiser.cachedReplayCount ?? 0;
  const cachedRevealedTokens = tokenMiser.cachedRevealedTokens ?? 0;
  const cachedBaselineTokens = tokenMiser.cachedBaselineTokens
    ?? cachedRevealedTokens + cachedReplayTokens;
  const revealedTokens =
    (tokenMiser.replacementTokens ?? 0)
    + (tokenMiser.retrievedTokens ?? 0);
  const hasCompleteDispositionBreakdown =
    tokenMiser.interceptions?.length === tokenMiser.interceptionCount;
  const summarizedReplacementTokens = hasCompleteDispositionBreakdown
    ? tokenMiser.interceptions?.reduce(
        (total, interception) => interception.disposition === "passed_through"
          ? total
          : total + interception.replacementTokens,
        0,
      ) ?? 0
    : 0;
  const passedThroughReplacementTokens = hasCompleteDispositionBreakdown
    ? tokenMiser.interceptions?.reduce(
        (total, interception) => interception.disposition === "passed_through"
          ? total + interception.replacementTokens
          : total,
        0,
      ) ?? 0
    : 0;
  const partialPricingPrefix = savings
    && savings.pricedGateCount < savings.gateCount
    ? "All gates · "
    : "";
  const sameTrajectoryCostChange = savings
    ? describeSameTrajectoryCostChange(
        props.threadCostMicros,
        savings.savingsMicros,
      )
    : undefined;
  const split = savings ? buildSavingsSplit(savings) : undefined;
  const summarizedCount = tokenMiser.interceptionCount
    - (tokenMiser.passThroughCount ?? 0);
  return (
    <div className="incident-explorer__savings">
      <div className="incident-explorer__savings-hero">
        <div className="incident-explorer__savings-headline">
          {savings ? (
            <>
              <p className="incident-explorer__eyebrow">
                {savings.savingsMicros >= 0
                  ? "Estimated same-trajectory savings"
                  : "Estimated same-trajectory overhead"}
              </p>
              <p className="incident-explorer__savings-figure">
                <strong>
                  {formatMicrosCurrency(
                    Math.abs(savings.savingsMicros),
                    savings.currency,
                  )}
                </strong>
                {sameTrajectoryCostChange ? (
                  <span>{sameTrajectoryCostChange.sentence}</span>
                ) : null}
              </p>
              <dl className="incident-explorer__savings-equation">
                <SavingsTerm
                  basis={`${partialPricingPrefix}`
                    + `${formatCompactTokens(tokenMiser.baselineParentTokens)} uncached`
                    + (cachedBaselineTokens > 0
                      ? ` + ${formatCompactTokens(cachedBaselineTokens)} cached`
                      : "")
                    + ` at ${savings.parentModel ?? "the parent model"} rates`}
                  label="Without the gate"
                  value={formatMicrosCurrency(
                    savings.withoutGateCostMicros,
                    savings.currency,
                  )}
                />
                <span aria-hidden="true" className="incident-explorer__savings-operator">
                  −
                </span>
                <SavingsTerm
                  basis={`${formatCompactTokens(props.gateTokens)} charged by `
                    + `${savings.gateModel ?? "the helper"}`}
                  label="Gate compute"
                  value={formatMicrosCurrency(
                    savings.gateCostMicros,
                    savings.currency,
                  )}
                />
                <span aria-hidden="true" className="incident-explorer__savings-operator">
                  −
                </span>
                <SavingsTerm
                  basis={`${partialPricingPrefix}`
                    + `${formatCompactTokens(revealedTokens)} uncached`
                    + (cachedRevealedTokens > 0
                      ? ` + ${formatCompactTokens(cachedRevealedTokens)} cached`
                      : "")
                    + (tokenMiser.passThroughCount
                      ? " · summaries, retrievals, and deliberate pass-throughs"
                      : " · summaries and retrievals")}
                  label="Revealed to parent"
                  value={formatMicrosCurrency(
                    savings.revealedCostMicros,
                    savings.currency,
                  )}
                />
                <span aria-hidden="true" className="incident-explorer__savings-operator">
                  =
                </span>
                <SavingsTerm
                  label={savings.savingsMicros >= 0 ? "Saved" : "Overhead"}
                  result
                  value={formatMicrosCurrency(
                    Math.abs(savings.savingsMicros),
                    savings.currency,
                  )}
                />
              </dl>
              {split ? (
                <>
                  <span
                    aria-hidden="true"
                    className="incident-explorer__savings-split"
                  >
                    <i data-part="avoided" style={{ width: `${split.avoided}%` }} />
                    <i data-part="gate" style={{ width: `${split.gate}%` }} />
                    <i data-part="revealed" style={{ width: `${split.revealed}%` }} />
                  </span>
                  <p className="incident-explorer__savings-split-caption">
                    <span>
                      <b>{split.rounded.avoided}%</b> avoided
                      {" · "}<b>{split.rounded.gate}%</b> gate
                      {" · "}<b>{split.rounded.revealed}%</b> revealed
                    </span>
                    {props.threadCostMicros > 0 ? (
                      <span>
                        observed{" "}
                        <b>
                          {formatMicrosCurrency(
                            props.threadCostMicros,
                            savings.currency,
                          )}
                        </b>
                        {" · unfiltered "}
                        <b>
                          {formatMicrosCurrency(
                            props.threadCostMicros + savings.savingsMicros,
                            savings.currency,
                          )}
                        </b>
                      </span>
                    ) : null}
                  </p>
                </>
              ) : props.threadCostMicros > 0 ? (
                <p className="incident-explorer__savings-compare">
                  Observed thread cost{" "}
                  <b>
                    {formatMicrosCurrency(props.threadCostMicros, savings.currency)}
                  </b>
                  {" · estimated same-trajectory cost without filtering "}
                  <b>
                    {formatMicrosCurrency(
                      props.threadCostMicros + savings.savingsMicros,
                      savings.currency,
                    )}
                  </b>
                </p>
              ) : null}
              <SavingsConfidence savings={savings} />
            </>
          ) : (
            <>
              <p className="incident-explorer__eyebrow">
                Kept out of the parent's context
              </p>
              <p className="incident-explorer__savings-figure">
                <strong>
                  {formatCompactTokens(props.comparison.avoidedParentTokens)}
                </strong>
                <span>
                  tokens, once · {formatCompactTokens(cachedReplayTokens)} more across{" "}
                  {cachedReplayCount.toLocaleString()}{" "}
                  {cachedReplayCount === 1 ? "replay" : "replays"}
                </span>
              </p>
              <dl className="incident-explorer__savings-tokens">
                <div>
                  <dt>Without the gate</dt>
                  <dd>{formatCompactTokens(tokenMiser.baselineParentTokens)}</dd>
                </div>
                <div>
                  <dt>Actual parent context</dt>
                  <dd>{formatCompactTokens(revealedTokens)}</dd>
                </div>
                <div>
                  <dt>Gate compute</dt>
                  <dd>
                    {props.gateTokens > 0
                      ? formatCompactTokens(props.gateTokens)
                      : "—"}
                    <span>
                      {props.gateCostMicros > 0
                        ? formatMicrosCurrency(
                            props.gateCostMicros,
                            props.currency ?? "USD",
                          )
                        : "awaiting the pricing ledger"}
                    </span>
                  </dd>
                </div>
              </dl>
              <p className="incident-explorer__savings-compare">
                {TOKEN_MISER_PENDING_PRICING_CAPTION}
              </p>
            </>
          )}
        </div>
        <TokenMiserContextTimeline
          compactions={props.compactions}
          usageLines={props.usageLines}
        />
      </div>

      <SavingsDetailStack height={layout.detailsHeight} onMeasure={measure}>
        <SavingsDetailSection
          facts={[
            { label: "decisions", value: tokenMiser.interceptionCount.toLocaleString() },
            { label: "summarized", value: summarizedCount.toLocaleString() },
            ...(tokenMiser.passThroughCount
              ? [{
                  label: "passed through",
                  value: tokenMiser.passThroughCount.toLocaleString(),
                }]
              : []),
            {
              label: "kept out of parent",
              value: formatCompactTokens(props.comparison.avoidedParentTokens),
            },
            {
              label: "read back",
              value: formatCompactTokens(tokenMiser.retrievedTokens),
              zero: tokenMiser.retrievedTokens === 0,
            },
          ]}
          label="Decisions"
          onToggle={toggleSection}
          open={layout.openSections.includes("decisions")}
          sectionKey="decisions"
        >
          <SavingsFigureGrid
            figures={[
              {
                detail: tokenMiser.passThroughCount
                  ? hasCompleteDispositionBreakdown
                    ? `${formatCompactTokens(summarizedReplacementTokens)} of summaries`
                    : `${formatCompactTokens(tokenMiser.replacementTokens)} revealed before retrieval`
                  : `${formatCompactTokens(tokenMiser.replacementTokens)} of summaries`,
                label: "Summarized",
                value: summarizedCount.toLocaleString(),
              },
              {
                detail: [
                  ...((tokenMiser.policyPassThroughCount ?? 0)
                    + (tokenMiser.helperPassThroughCount ?? 0) > 0
                    ? [`${(tokenMiser.policyPassThroughCount ?? 0).toLocaleString()} policy`
                      + ` · ${(tokenMiser.helperPassThroughCount ?? 0).toLocaleString()} helper`]
                    : []),
                  ...(hasCompleteDispositionBreakdown && tokenMiser.passThroughCount
                    ? [`${formatCompactTokens(passedThroughReplacementTokens)} tokens`]
                    : []),
                ].join(" · ") || undefined,
                label: "Passed through",
                value: (tokenMiser.passThroughCount ?? 0).toLocaleString(),
                zero: (tokenMiser.passThroughCount ?? 0) === 0,
              },
              {
                label: "Luna evaluations",
                value: (tokenMiser.helperDecisionCount ?? 0).toLocaleString(),
                zero: (tokenMiser.helperDecisionCount ?? 0) === 0,
              },
              {
                detail: `${partialPricingPrefix}`
                  + `${formatCompactTokens(tokenMiser.baselineParentTokens)} uncached`
                  + (cachedBaselineTokens > 0
                    ? ` · ${formatCompactTokens(cachedBaselineTokens)} cached`
                    : ""),
                label: "Kept out of parent",
                value: formatCompactTokens(props.comparison.avoidedParentTokens),
              },
              {
                detail: `${partialPricingPrefix}`
                  + `${formatCompactTokens(revealedTokens)} uncached`
                  + (cachedRevealedTokens > 0
                    ? ` · ${formatCompactTokens(cachedRevealedTokens)} cached`
                    : ""),
                label: "Revealed to parent",
                value: formatCompactTokens(revealedTokens),
              },
              {
                detail: tokenMiser.retrievedTokens > 0
                  ? undefined
                  : "nothing read back later",
                label: "Read back later",
                value: formatCompactTokens(tokenMiser.retrievedTokens),
                zero: tokenMiser.retrievedTokens === 0,
              },
              ...(savings?.parentModel
                ? [{ label: "Parent rates", value: savings.parentModel }]
                : []),
              ...(savings?.gateModel
                ? [{ label: "Gate model", value: savings.gateModel }]
                : []),
            ]}
          />
        </SavingsDetailSection>

        <TokenMiserCompactionStats
          compactions={props.compactions}
          contextWindow={props.contextWindow}
          currency={props.currency}
          onToggle={toggleSection}
          open={layout.openSections.includes("boundaries")}
        />

        <TokenMiserCodeModeStats
          onToggle={toggleSection}
          open={layout.openSections.includes("code-mode")}
          tokenMiser={tokenMiser}
        />
      </SavingsDetailStack>

      <SavingsSplitGrip measurement={measurement} onResize={resizeDetails} />

      <TokenMiserResultList entries={props.gates} tokenMiser={tokenMiser} />
    </div>
  );
}

type TokenMiserContextTurn = {
  compactionCount: number;
  finalContextTokens: number | undefined;
  key: string;
  label: string;
  modelContextWindow: number | undefined;
  observedAt: number;
  peakContextTokens: number | undefined;
  turnId: string | undefined;
};

/**
 * Parent-context history is the Token Miser verification chart. It is built
 * from pricing turns rather than tool invocations so a compaction remains
 * visible even when that turn made no tool call or its tool history no longer
 * survives replay.
 */
function TokenMiserContextTimeline(props: {
  compactions: readonly ThreadCompactionRecord[];
  usageLines: readonly ThreadUsageLineRecord[];
}) {
  const turns = useMemo(
    () => buildTokenMiserContextTurns(props.usageLines, props.compactions),
    [props.compactions, props.usageLines],
  );
  if (turns.length === 0) {
    return null;
  }
  const compactionCount = turns.reduce(
    (total, turn) => total + turn.compactionCount,
    0,
  );
  const measuredTurnCount = turns.filter((turn) =>
    turn.finalContextTokens !== undefined
    && turn.modelContextWindow !== undefined
  ).length;
  const parentTurnCount = turns.filter((turn) => turn.turnId !== undefined).length;
  const unassignedBoundaryCount = turns.length - parentTurnCount;
  return (
    <section
      aria-label="Token Miser context by turn"
      className="incident-explorer__context-turns"
    >
      <div className="incident-explorer__context-turns-head">
        <p className="incident-explorer__eyebrow">Context by turn</p>
        <p className="incident-explorer__context-turns-legend">
          <span aria-hidden="true" data-kind="final" /> final
          <span aria-hidden="true" data-kind="peak" /> peak
          <span aria-hidden="true" data-kind="compaction" /> compaction boundary
        </p>
      </div>
      <div
        aria-label="Parent context per turn, in order"
        className="incident-explorer__context-turns-chart"
        role="group"
      >
        {turns.map((turn) => {
          const peakPercent = contextWindowPercent(
            turn.peakContextTokens,
            turn.modelContextWindow,
          );
          const finalPercent = contextWindowPercent(
            turn.finalContextTokens,
            turn.modelContextWindow,
          );
          const description = [
            turn.label,
            new Date(turn.observedAt).toLocaleString(),
            ...(turn.finalContextTokens !== undefined
              && turn.modelContextWindow !== undefined
              ? [`final context ${formatContextWindowPoint(
                  turn.finalContextTokens,
                  turn.modelContextWindow,
                )}`]
              : ["final context not observed"]),
            ...(turn.peakContextTokens !== undefined
              && turn.modelContextWindow !== undefined
              ? [`peak context ${formatContextWindowPoint(
                  turn.peakContextTokens,
                  turn.modelContextWindow,
                )}`]
              : []),
            ...(turn.compactionCount > 0
              ? [`context compacted ${turn.compactionCount.toLocaleString()} ${turn.compactionCount === 1 ? "time" : "times"}`]
              : []),
          ].join(" · ");
          return (
            <span
              aria-label={description}
              className="incident-explorer__context-turn"
              data-compaction={turn.compactionCount > 0}
              key={turn.key}
              role="img"
              title={description}
            >
              <span
                aria-hidden="true"
                className="incident-explorer__context-turn-track"
              >
                <i style={{ height: `${peakPercent}%` }} />
                <b style={{ height: `${finalPercent}%` }} />
              </span>
            </span>
          );
        })}
      </div>
      <p className="incident-explorer__savings-caption">
        {parentTurnCount.toLocaleString()} parent turn
        {parentTurnCount === 1 ? "" : "s"}
        {" · "}{measuredTurnCount.toLocaleString()} with context measurements
        {" · "}{compactionCount.toLocaleString()} compaction boundar
        {compactionCount === 1 ? "y" : "ies"}
        {unassignedBoundaryCount > 0
          ? ` · ${unassignedBoundaryCount.toLocaleString()} without a turn id`
          : ""}
      </p>
    </section>
  );
}

function buildTokenMiserContextTurns(
  usageLines: readonly ThreadUsageLineRecord[],
  compactions: readonly ThreadCompactionRecord[],
): TokenMiserContextTurn[] {
  const byTurn = new Map<string, Omit<TokenMiserContextTurn, "label">>();
  const turnByUsageLine = new Map<string, string>();
  for (const line of usageLines) {
    if (line.scope !== "turn" || !line.turnId) {
      continue;
    }
    turnByUsageLine.set(line.usageLineId, line.turnId);
    const observedAt = line.completedAt ?? line.startedAt ?? line.createdAt;
    const existing = byTurn.get(line.turnId);
    const lineIsNewer = !existing || observedAt >= existing.observedAt;
    byTurn.set(line.turnId, {
      compactionCount: existing?.compactionCount ?? 0,
      finalContextTokens: lineIsNewer
        ? line.finalContextTokens ?? existing?.finalContextTokens
        : existing.finalContextTokens,
      key: `turn:${line.turnId}`,
      modelContextWindow: lineIsNewer
        ? line.modelContextWindow ?? existing?.modelContextWindow
        : existing.modelContextWindow,
      observedAt: Math.max(observedAt, existing?.observedAt ?? observedAt),
      peakContextTokens: Math.max(
        line.peakContextTokens ?? 0,
        existing?.peakContextTokens ?? 0,
      ) || undefined,
      turnId: line.turnId,
    });
  }
  const unassigned: Array<Omit<TokenMiserContextTurn, "label">> = [];
  for (const compaction of compactions) {
    const turnId = compaction.turnId
      ?? (compaction.coldUsageLineId
        ? turnByUsageLine.get(compaction.coldUsageLineId)
        : undefined);
    if (!turnId) {
      unassigned.push({
        compactionCount: 1,
        finalContextTokens: undefined,
        key: `compaction:${compaction.compactionId}`,
        modelContextWindow: undefined,
        observedAt: compaction.observedAt,
        peakContextTokens: undefined,
        turnId: undefined,
      });
      continue;
    }
    const existing = byTurn.get(turnId);
    byTurn.set(turnId, {
      compactionCount: (existing?.compactionCount ?? 0) + 1,
      finalContextTokens: existing?.finalContextTokens,
      key: `turn:${turnId}`,
      modelContextWindow: existing?.modelContextWindow,
      observedAt: existing?.observedAt ?? compaction.observedAt,
      peakContextTokens: existing?.peakContextTokens,
      turnId,
    });
  }
  const ordered = [...byTurn.values(), ...unassigned].sort(
    (left, right) =>
      left.observedAt - right.observedAt
      || left.key.localeCompare(right.key),
  );
  let ordinal = 0;
  return ordered.map((turn) => ({
    ...turn,
    label: turn.turnId ? `Turn ${(ordinal += 1)}` : "Unassigned boundary",
  }));
}

function contextWindowPercent(
  tokens: number | undefined,
  modelContextWindow: number | undefined,
): number {
  if (
    tokens === undefined
    || modelContextWindow === undefined
    || modelContextWindow <= 0
  ) {
    return 0;
  }
  const percent = tokens / modelContextWindow * 100;
  return Math.min(100, Math.max(tokens > 0 ? 2 : 0, percent));
}

function TokenMiserCompactionStats(props: {
  compactions: readonly ThreadCompactionRecord[];
  contextWindow?: TokenMiserContextWindowSummary;
  currency?: string;
  onToggle: (key: SavingsSectionKey, open: boolean) => void;
  open: boolean;
}) {
  const coldReplayTokens = props.compactions.reduce(
    (total, entry) => total + (entry.coldUncachedTokens ?? 0),
    0,
  );
  const coldReplayCostMicros = props.compactions.reduce(
    (total, entry) => total + (entry.coldCostMicros ?? 0),
    0,
  );
  const currency = props.currency ?? "USD";
  const contextWindow = props.contextWindow;
  const nearLimit = contextWindow !== undefined
    && contextWindow.peakModelContextWindow > 0
    && contextWindow.peakTokens / contextWindow.peakModelContextWindow >= 0.85;
  return (
    <SavingsDetailSection
      facts={[
        {
          label: props.compactions.length === 1 ? "compaction" : "compactions",
          value: props.compactions.length.toLocaleString(),
          zero: props.compactions.length === 0,
        },
        ...(contextWindow
          ? [
              {
                label: "peak of window",
                value: formatContextWindowShare(
                  contextWindow.peakTokens,
                  contextWindow.peakModelContextWindow,
                ),
              },
              {
                label: "final",
                value: formatCompactTokens(contextWindow.finalTokens),
              },
            ]
          : []),
        {
          label: "cold replay",
          value: formatMicrosCurrency(coldReplayCostMicros, currency),
          zero: coldReplayCostMicros === 0,
        },
      ]}
      label="Context boundaries"
      onToggle={props.onToggle}
      open={props.open}
      sectionKey="boundaries"
    >
      <SavingsFigureGrid
        figures={[
          {
            label: "Parent compactions",
            value: props.compactions.length.toLocaleString(),
            zero: props.compactions.length === 0,
          },
          {
            detail: formatMicrosCurrency(coldReplayCostMicros, currency),
            label: "Cold replay tokens",
            value: formatCompactTokens(coldReplayTokens),
            zero: coldReplayTokens === 0,
          },
          ...(contextWindow
            ? [
                {
                  detail: formatContextWindowPoint(
                    contextWindow.peakTokens,
                    contextWindow.peakModelContextWindow,
                  ),
                  label: "Peak context",
                  value: formatContextWindowShare(
                    contextWindow.peakTokens,
                    contextWindow.peakModelContextWindow,
                  ),
                },
                {
                  detail: formatContextWindowPoint(
                    contextWindow.finalTokens,
                    contextWindow.finalModelContextWindow,
                  ),
                  label: "Final context",
                  value: formatContextWindowShare(
                    contextWindow.finalTokens,
                    contextWindow.finalModelContextWindow,
                  ),
                },
              ]
            : []),
        ]}
      />
      <p className="incident-explorer__savings-note">
        Token Miser replay savings stop at each recorded compaction boundary.
        {contextWindow
          ? ""
          : " Peak and final context were not observed by this PwrAgent version."}
        {nearLimit ? " Warning: this thread approached the context limit." : ""}
      </p>
    </SavingsDetailSection>
  );
}

type TokenMiserContextWindowSummary = {
  finalModelContextWindow: number;
  finalTokens: number;
  peakModelContextWindow: number;
  peakTokens: number;
};

function buildContextWindowSummary(
  lines: NonNullable<AppServerReadThreadResponse["pricing"]>["lines"],
): TokenMiserContextWindowSummary | undefined {
  const observed = lines.filter((line) =>
    line.scope === "turn"
    && typeof line.finalContextTokens === "number"
    && typeof line.peakContextTokens === "number"
    && typeof line.modelContextWindow === "number"
    && line.modelContextWindow > 0
  );
  if (observed.length === 0) {
    return undefined;
  }
  const latest = [...observed].sort(
    (left, right) =>
      (right.completedAt ?? right.createdAt)
      - (left.completedAt ?? left.createdAt),
  )[0]!;
  const peak = [...observed].sort(
    (left, right) =>
      right.peakContextTokens! / right.modelContextWindow!
      - left.peakContextTokens! / left.modelContextWindow!,
  )[0]!;
  return {
    finalModelContextWindow: latest.modelContextWindow!,
    finalTokens: latest.finalContextTokens!,
    peakModelContextWindow: peak.modelContextWindow!,
    peakTokens: peak.peakContextTokens!,
  };
}

/**
 * Just the share, for a folded row that has no space for the fraction.
 *
 * Whole percent rather than the one decimal `formatContextWindowPoint` keeps:
 * this is the scannable landmark, and the exact figure sits beside it the
 * moment the row is unfolded.
 */
function formatContextWindowShare(tokens: number, window: number): string {
  if (window <= 0) return "—";
  return `${Math.round(tokens / window * 100)}%`;
}

function formatContextWindowPoint(tokens: number, window: number): string {
  return `${formatCompactTokens(tokens)} / ${formatCompactTokens(window)} (${(
    tokens / window * 100
  ).toFixed(1)}%)`;
}

function TokenMiserCodeModeStats(props: {
  onToggle: (key: SavingsSectionKey, open: boolean) => void;
  open: boolean;
  tokenMiser: NonNullable<ThreadToolAccounting["tokenMiser"]>;
}) {
  const codeMode = props.tokenMiser.codeMode;
  if (!codeMode || codeMode.callCount === 0) return null;
  const commandCells = codeMode.commandCellCount ?? 0;
  const nestedCommands = codeMode.nestedCommandInvocationCount ?? 0;
  const dispatchClusters = codeMode.dispatchClusterCount ?? 0;
  const multiInvocation = codeMode.multiInvocationClusterCount ?? 0;
  /* Gated and direct decompose callCount, which is why both belong on this
     row. Gated's own halves are one unfold away below, and the reducer's
     thread-wide totals live on Decisions and are not repeated here. */
  const gatedCount = codeMode.summarizedCount + codeMode.passThroughCount;
  return (
    <SavingsDetailSection
      facts={[
        {
          label: codeMode.callCount === 1 ? "call" : "calls",
          value: codeMode.callCount.toLocaleString(),
        },
        {
          label: "gated",
          value: gatedCount.toLocaleString(),
          zero: gatedCount === 0,
        },
        {
          label: "direct",
          value: codeMode.directCount.toLocaleString(),
          zero: codeMode.directCount === 0,
        },
        {
          label: "command cells",
          value: commandCells.toLocaleString(),
          zero: commandCells === 0,
        },
        {
          label: "dispatch clusters",
          value: dispatchClusters.toLocaleString(),
          zero: dispatchClusters === 0,
        },
      ]}
      label="Code Mode"
      onToggle={props.onToggle}
      open={props.open}
      sectionKey="code-mode"
    >
      <SavingsFigureGrid
        figures={[
          {
            label: "Summarized",
            value: codeMode.summarizedCount.toLocaleString(),
            zero: codeMode.summarizedCount === 0,
          },
          {
            label: "Explicit pass-through",
            value: codeMode.passThroughCount.toLocaleString(),
            zero: codeMode.passThroughCount === 0,
          },
          {
            detail: `${nestedCommands.toLocaleString()} nested · `
              + `${commandCells > 0
                ? (nestedCommands / commandCells).toFixed(2)
                : "0.00"} per cell`,
            label: "Command-bearing cells",
            value: commandCells.toLocaleString(),
            zero: commandCells === 0,
          },
          {
            detail: `${multiInvocation.toLocaleString()} multi-invocation`
              + (multiInvocation > 0
                ? ` · largest ${(codeMode.largestDispatchCluster ?? 0).toLocaleString()}`
                : ""),
            label: "Dispatch clusters",
            value: dispatchClusters.toLocaleString(),
            zero: dispatchClusters === 0,
          },
          {
            label: "Direct command cells",
            value: (codeMode.directCommandCellCount ?? 0).toLocaleString(),
            zero: (codeMode.directCommandCellCount ?? 0) === 0,
          },
          {
            label: "Patch cells",
            value: (codeMode.patchCellCount ?? 0).toLocaleString(),
            zero: (codeMode.patchCellCount ?? 0) === 0,
          },
          {
            label: "Other cells",
            value: (codeMode.otherCellCount ?? 0).toLocaleString(),
            zero: (codeMode.otherCellCount ?? 0) === 0,
          },
          {
            label: "Retrieval cells",
            value: codeMode.retrievalCount.toLocaleString(),
            zero: codeMode.retrievalCount === 0,
          },
          {
            label: "Polling cells",
            value: (codeMode.pollingCellCount ?? 0).toLocaleString(),
            zero: (codeMode.pollingCellCount ?? 0) === 0,
          },
        ]}
      />
    </SavingsDetailSection>
  );
}

type TokenMiserResultFilter = "all" | TokenMiserGateOutcome | "direct";

const RESULT_FILTERS: Array<{
  key: TokenMiserResultFilter;
  label: string;
}> = [
  { key: "all", label: "All" },
  { key: "win", label: "Wins" },
  { key: "miss", label: "Misses" },
  { key: "big-miss", label: "Big misses" },
  { key: "pass-through", label: "Pass-throughs" },
  { key: "direct", label: "Direct" },
];

/**
 * Every observed result in one filterable list.
 *
 * Gated entries carry the summary the parent actually got; direct entries carry
 * the ordinary result preview. Keeping both populations behind one filter makes
 * "All" truthful and avoids spending a second section on a single outcome.
 */
function TokenMiserResultList(props: {
  entries: TokenMiserGateEntry[];
  tokenMiser: NonNullable<ThreadToolAccounting["tokenMiser"]>;
}) {
  const [filter, setFilter] = useState<TokenMiserResultFilter>("all");
  const [expanded, setExpanded] = useState<string>();
  const direct = props.tokenMiser.codeMode?.observations.filter(
    (entry) => entry.disposition === "direct",
  ) ?? [];
  const counts = props.entries.reduce(
    (totals, entry) => ({ ...totals, [entry.outcome]: totals[entry.outcome] + 1 }),
    { "big-miss": 0, miss: 0, "pass-through": 0, win: 0 } as Record<TokenMiserGateOutcome, number>,
  );
  const visibleGates = filter === "all"
    ? props.entries
    : filter === "direct"
      ? []
      : props.entries.filter((entry) => entry.outcome === filter);
  const visibleDirect = filter === "all" || filter === "direct" ? direct : [];

  return (
    <section className="incident-explorer__gates" aria-label="Tool output results">
      <div className="incident-explorer__gates-head">
        <p className="incident-explorer__eyebrow">Tool output results</p>
        <div className="incident-explorer__gate-filters" role="group" aria-label="Filter tool output results by outcome">
          {RESULT_FILTERS.map((option) => {
            const count = option.key === "all"
              ? props.entries.length + direct.length
              : option.key === "direct"
                ? direct.length
                : counts[option.key];
            return (
              <button
                aria-pressed={filter === option.key}
                className="incident-explorer__gate-filter"
                disabled={count === 0 && option.key !== "all"}
                key={option.key}
                onClick={() => setFilter(option.key)}
                type="button"
              >
                {option.label}
                <em>{count.toLocaleString()}</em>
              </button>
            );
          })}
        </div>
      </div>

      {visibleGates.length === 0 && visibleDirect.length === 0 ? (
        <p className="incident-explorer__edges-empty">
          No results in this group.
        </p>
      ) : (
        <ul className="incident-explorer__gate-list">
          {visibleGates.map((entry) => {
            const isOpen = expanded === entry.interception.objectId;
            const saved = entry.interception.estimatedParentTokensSaved;
            return (
              <li
                className="incident-explorer__gate"
                data-outcome={entry.outcome}
                key={entry.interception.objectId}
              >
                <span aria-hidden="true" className="incident-explorer__edge-stripe" />
                <button
                  aria-expanded={isOpen}
                  className="incident-explorer__gate-row"
                  onClick={() => setExpanded(isOpen ? undefined : entry.interception.objectId)}
                  type="button"
                >
                  <span className="incident-explorer__gate-identity">
                    <code>{entry.command}</code>
                    <span>
                      {entry.edge
                        ? entry.edge.label
                        : entry.interception.disposition === "passed_through"
                          ? `${formatCompactTokens(entry.interception.baselineParentTokens)} passed through unchanged`
                        : `${formatCompactTokens(entry.interception.baselineParentTokens)} → `
                          + `${formatCompactTokens(entry.interception.replacementTokens)} summary`}
                    </span>
                  </span>
                  <span className="incident-explorer__gate-verdict">
                    {entry.interception.disposition === "passed_through"
                      ? "unchanged"
                      : `${saved >= 0 ? "+" : "−"}${formatCompactTokens(Math.abs(saved))}`}
                  </span>
                </button>
                {isOpen ? (
                  <div className="incident-explorer__gate-detail">
                    {entry.edge ? <p>{entry.edge.detail}</p> : null}
                    {entry.interception.summary ? (
                      <>
                        <p className="incident-explorer__gate-summary">
                          {entry.interception.summary.summary}
                        </p>
                        {entry.interception.summary.usefulDetails.length > 0 ? (
                          <ul>
                            {entry.interception.summary.usefulDetails.map((detail) => (
                              <li key={detail}>{detail}</li>
                            ))}
                          </ul>
                        ) : null}
                        {entry.interception.summary.suggestedNextStep ? (
                          <p className="incident-explorer__gate-next">
                            <b>Legacy suggested next step</b>{" "}
                            {entry.interception.summary.suggestedNextStep}
                          </p>
                        ) : null}
                      </>
                    ) : (
                      <p className="incident-explorer__gate-summary">
                        No summary was recorded for this gate.
                      </p>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
          {visibleDirect.map((entry) => {
            const expandedKey = `direct:${entry.observationId}`;
            const isOpen = expanded === expandedKey;
            return (
              <li
                className="incident-explorer__gate"
                data-outcome="direct"
                key={expandedKey}
              >
                <span aria-hidden="true" className="incident-explorer__edge-stripe" />
                <button
                  aria-expanded={isOpen}
                  className="incident-explorer__gate-row"
                  onClick={() => setExpanded(isOpen ? undefined : expandedKey)}
                  type="button"
                >
                  <span className="incident-explorer__gate-identity">
                    <code>Code Mode</code>
                    <span>{entry.outputCharacters.toLocaleString()} characters</span>
                  </span>
                  <span className="incident-explorer__gate-verdict">direct</span>
                </button>
                {isOpen ? (
                  <div className="incident-explorer__gate-detail">
                    <p>
                      No reducer replacement was selected; the ordinary result
                      reached the parent directly.
                    </p>
                    {entry.script ? <pre><code>{entry.script}</code></pre> : null}
                    {entry.outputPreview ? (
                      <pre><code>
                        {entry.outputPreview}
                        {entry.outputPreviewTruncated ? "\n… preview truncated" : ""}
                      </code></pre>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function CompositionBar(props: { composition: CategoryShare[] }) {
  if (props.composition.length === 0) return null;
  return (
    <span aria-hidden="true" className="incident-explorer__composition">
      {props.composition.map((entry, index) => (
        <i
          data-rank={Math.min(index + 1, 5)}
          key={entry.category}
          style={{ width: `${entry.share * 100}%` }}
        />
      ))}
    </span>
  );
}

function countCompactionsByTurn(
  compactions: readonly ThreadCompactionRecord[],
  usageLines: readonly ThreadUsageLineRecord[],
): Map<string, number> {
  const turnByUsageLine = new Map(
    usageLines.flatMap((line) =>
      line.turnId ? [[line.usageLineId, line.turnId] as const] : []
    ),
  );
  const counts = new Map<string, number>();
  for (const compaction of compactions) {
    const turnId = compaction.turnId
      ?? (compaction.coldUsageLineId
        ? turnByUsageLine.get(compaction.coldUsageLineId)
        : undefined);
    if (!turnId) {
      continue;
    }
    counts.set(turnId, (counts.get(turnId) ?? 0) + 1);
  }
  return counts;
}

/**
 * The second cost driver. A solid bar reads as volume, a tick rail reads as
 * discrete events — deliberately different marks, because a turn that is long
 * on trips and short on tokens is a different problem than the reverse, and
 * the two need to be told apart at a glance.
 */
function TurnStrip(props: {
  compactionsByTurn: ReadonlyMap<string, number>;
  currency?: string;
  /* Captured once by the caller so every row in a render measures "ago"
     against the same instant. */
  now: number;
  showCost: boolean;
  onScopeChange: (scope: TurnStripScope) => void;
  onSelect: (row: TurnCostRow) => void;
  selectedKey?: string;
  strip: TurnCostStrip;
}) {
  if (props.strip.totalTurnCount === 0) return null;
  const strip = props.strip;
  return (
    <section className="incident-explorer__turns" aria-label="Cost by turn">
      <div className="incident-explorer__turns-head">
        <p className="incident-explorer__eyebrow">
          {strip.ordering === "cost"
            ? strip.rankedBy === "billed"
              ? "Costliest turns · by billed cost"
              : "Costliest turns · by output × round trips"
            : "Tool-output estimate · billed cost"}
        </p>
        <div
          aria-label="Turn scope"
          className="incident-explorer__turns-scope"
          role="group"
        >
          <button
            aria-pressed={strip.scope === "flagged"}
            onClick={() => props.onScopeChange("flagged")}
            type="button"
          >
            Flagged ({strip.flaggedTurnCount.toLocaleString()})
          </button>
          <button
            aria-pressed={strip.scope === "all"}
            onClick={() => props.onScopeChange("all")}
            type="button"
          >
            All with tool calls ({strip.totalTurnCount.toLocaleString()})
          </button>
        </div>
        <p className="incident-explorer__turns-legend">
          <span className="incident-explorer__turns-key" data-kind="tokens" /> estimated tool-output tokens
          {" · "}
          <span className="incident-explorer__turns-key" data-kind="trips" /> round trips
        </p>
      </div>
      {props.strip.rows.map((row) => {
        const compactionCount = row.turnId
          ? (props.compactionsByTurn.get(row.turnId) ?? 0)
          : 0;
        return (
          <button
            aria-pressed={props.selectedKey === row.key}
            className="incident-explorer__turn"
            data-cost={props.showCost}
            key={row.key}
            onClick={() => props.onSelect(row)}
            type="button"
          >
            <span className="incident-explorer__turn-label">
              {row.label}
              <span title={new Date(row.firstObservedAt).toLocaleString()}>
                {` · ${formatTurnWhen(row.firstObservedAt, props.now)}`}
              </span>
              {compactionCount > 0 ? (
                <span
                  className="incident-explorer__turn-compaction"
                  title={`Context compacted ${compactionCount.toLocaleString()} ${compactionCount === 1 ? "time" : "times"} during this turn`}
                >
                  {` · compacted${compactionCount === 1 ? "" : ` ×${compactionCount.toLocaleString()}`}`}
                </span>
              ) : null}
            </span>
            <span aria-hidden="true" className="incident-explorer__turn-bar">
              <i
                data-critical={row.overCapCount > 0}
                style={{ width: `${scaleWidth(row.estimatedOutputTokens, props.strip.maxTokens)}%` }}
              />
            </span>
            <span
              className="incident-explorer__turn-number"
              title={`${formatCompactTokens(row.estimatedOutputTokens)} estimated tool-output tokens; this is not provider-billed usage`}
            >
              {formatCompactTokens(row.estimatedOutputTokens)} est.
            </span>
            <span aria-hidden="true" className="incident-explorer__turn-trips">
              <i style={{ width: `${scaleWidth(row.callCount, props.strip.maxCallCount)}%` }} />
            </span>
            <span className="incident-explorer__turn-number">
              {row.callCount.toLocaleString()} {row.callCount === 1 ? "call" : "calls"}
            </span>
            {props.showCost ? (
              <span
                className="incident-explorer__turn-cost"
                title={row.costMicros !== undefined
                  ? `Billed cost from provider-reported usage: ${formatMicrosCurrency(row.costMicros, props.currency)}`
                  : undefined}
              >
                {row.costMicros !== undefined
                  ? formatMicrosCurrency(row.costMicros, props.currency)
                  : "—"}
              </span>
            ) : null}
          </button>
        );
      })}
      {strip.hiddenTurnCount > 0 || strip.scope === "flagged" ? (
        <p className="incident-explorer__turns-note">
          {strip.hiddenTurnCount > 0
            ? `${strip.hiddenTurnCount.toLocaleString()} lower-cost ${strip.hiddenTurnCount === 1 ? "turn is" : "turns are"} not shown. `
            : ""}
          {strip.scope === "flagged"
            ? `${(strip.totalTurnCount - strip.flaggedTurnCount).toLocaleString()} turns made only small tool calls; turns with no tool calls are never listed.`
            : "Turns with no tool calls are never listed."}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The whole thread, one column per turn, in time order. Tokens above, round
 * trips below on a shared axis — a long poll is a stretch of trip spikes with
 * no matching output, which no ranked list can show because ranking discards
 * adjacency. Hover carries the numbers; click filters cases to the turn.
 */
function TurnTimeline(props: {
  compactionsByTurn: ReadonlyMap<string, number>;
  currency?: string;
  now: number;
  onSelect: (row: TurnCostRow) => void;
  selectedKey?: string;
  timeline: TurnCostRow[];
}) {
  if (props.timeline.length < 2) return null;
  const maxTokens = props.timeline.reduce(
    (max, row) => Math.max(max, row.estimatedOutputTokens),
    0,
  );
  const maxCalls = props.timeline.reduce(
    (max, row) => Math.max(max, row.callCount),
    0,
  );
  const hasCompactions = props.timeline.some((row) =>
    row.turnId && (props.compactionsByTurn.get(row.turnId) ?? 0) > 0
  );
  return (
    <div className="incident-explorer__timeline-block">
      <div className="incident-explorer__timeline-head">
        <p className="incident-explorer__eyebrow">When it went</p>
        {hasCompactions ? (
          <p className="incident-explorer__timeline-legend">
            <span aria-hidden="true" /> compaction boundary
          </p>
        ) : null}
      </div>
      <div
        aria-label="Tool cost per turn, in order"
        className="incident-explorer__timeline"
        role="group"
      >
        {props.timeline.map((row) => {
          const compactionCount = row.turnId
            ? (props.compactionsByTurn.get(row.turnId) ?? 0)
            : 0;
          const description = [
            row.label,
            formatTurnWhen(row.firstObservedAt, props.now),
            `${formatCompactTokens(row.estimatedOutputTokens)} estimated tool-output tokens`,
            `${row.callCount.toLocaleString()} ${row.callCount === 1 ? "call" : "calls"}`,
            ...(row.costMicros !== undefined
              ? [`billed cost ${formatMicrosCurrency(row.costMicros, props.currency)}`]
              : []),
            ...(compactionCount > 0
              ? [`context compacted ${compactionCount.toLocaleString()} ${compactionCount === 1 ? "time" : "times"}`]
              : []),
          ].join(" · ");
          return (
            <button
              aria-label={description}
              aria-pressed={props.selectedKey === row.key}
              className="incident-explorer__timeline-turn"
              data-compaction={compactionCount > 0}
              key={row.key}
              onClick={() => props.onSelect(row)}
              title={description}
              type="button"
            >
              <span aria-hidden="true" className="incident-explorer__timeline-tokens">
                <i
                  data-critical={row.overCapCount > 0}
                  style={{ height: `${scaleWidth(row.estimatedOutputTokens, maxTokens, 0)}%` }}
                />
              </span>
              <span aria-hidden="true" className="incident-explorer__timeline-trips">
                <i style={{ height: `${scaleWidth(row.callCount, maxCalls, 0)}%` }} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CaseRow(props: {
  invocation: ThreadToolInvocationRecord;
  now: number;
  onSelect: () => void;
  repeatCount: number;
  selected: boolean;
}) {
  const invocation = props.invocation;
  const command = invocation.normalizedCommand ?? invocation.toolName;
  const identity = formatInvocationIdentity(command);
  const critical = isOverOutputCap(invocation.outputChars);
  return (
    <button
      aria-current={props.selected}
      className="incident-explorer__case"
      data-selected={props.selected}
      onClick={props.onSelect}
      title={`${command}\n${new Date(invocation.observedAt).toLocaleString()}`}
      type="button"
    >
      <span className="incident-explorer__case-top">
        <span className="incident-explorer__case-id">
          <b>{identity.lead}</b>
          {identity.detail ? <span>{` ${identity.detail}`}</span> : null}
        </span>
        <span className="incident-explorer__case-tokens">
          {props.repeatCount > 1 ? (
            /* Re-running the identical read is its own finding: the turn
               either lost the earlier result or the file keeps changing. */
            <b
              className="incident-explorer__repeat"
              title={`This exact command ran ${props.repeatCount} times in this thread`}
            >
              {props.repeatCount}×
            </b>
          ) : null}
          {formatCompactTokens(invocation.estimatedOutputTokens)}
        </span>
      </span>
      <span aria-hidden="true" className="incident-explorer__meter">
        <i
          data-critical={critical}
          style={{ width: `${capMeterWidth(invocation.outputChars) * 100}%` }}
        />
      </span>
      <span className="incident-explorer__case-sub">
        {formatCapShare(invocation.outputChars, { short: true })}
        {" · "}{invocation.outputChars.toLocaleString()} chars
        {" · "}{formatTurnWhen(invocation.observedAt, props.now)}
      </span>
    </button>
  );
}

function Fact(props: {
  label: string;
  tone?: "error" | "ok" | "warning";
  value: string;
}) {
  return (
    <span className="incident-explorer__fact" data-tone={props.tone}>
      <b>{props.label}</b>
      {props.value}
    </span>
  );
}

/**
 * Strip bars floor at 2% so a small-but-real value stays visible and the row
 * stays readable. `floor: 0` is for the spark, where a turn with genuinely no
 * output must paint nothing — a floored bar there would read as low activity
 * instead of none, blurring the contrast the polling band depends on.
 */
/**
 * What the scan reached, measured against what the thread already knows.
 *
 * "Complete" means the scan read the whole retained replay — not that it saw
 * the whole thread. On a long thread most tool calls were recorded live and
 * their transcript entries have since been compacted away, so the scan
 * legitimately finds a fraction of them. Reporting only its own count reads
 * as a contradiction next to a case list holding several times more: one real
 * thread scanned 202 calls and listed 575 cases on the same screen.
 */
function describeAnalysisCoverage(params: {
  coverage: ThreadToolAnalysisCoverage;
  knownInvocationCount: number;
}): string {
  const scanned = params.coverage.invocationCount;
  const pages = params.coverage.pageCount;
  const scannedText = `Scanned ${scanned.toLocaleString()} tool call${scanned === 1 ? "" : "s"} still in replay across ${pages.toLocaleString()} page${pages === 1 ? "" : "s"}.`;
  const older = params.knownInvocationCount - scanned;
  return older > 0
    ? `${scannedText} ${older.toLocaleString()} older call${older === 1 ? "" : "s"} recorded earlier remain accounted, but their output is no longer in the transcript.`
    : scannedText;
}

function scaleWidth(value: number, max: number, floor = 2): number {
  if (max <= 0) return 0;
  if (value <= 0) return floor === 0 ? 0 : floor;
  return Math.max(floor, Math.round(value / max * 100));
}

function describeAvailability(invocation: ThreadToolInvocationRecord): string {
  if (invocation.outputTruncated || invocation.outputState === "truncated") {
    return "truncated size recorded";
  }
  if (invocation.outputState === "available") {
    return "size recorded";
  }
  if (invocation.outputState === "compacted") {
    return "compacted size recorded";
  }
  return "size unavailable";
}

/**
 * Round trips after this call inside the same turn. Every one of them replays
 * this output, which is what makes a single large result compound.
 */
function countLaterTripsInTurn(
  invocations: ThreadToolInvocationRecord[],
  selected: ThreadToolInvocationRecord,
): number {
  /* A full-history analyze pass can stamp several of a turn's calls with the
     same millisecond, so "later" falls back to persisted order rather than
     dropping every tie and understating the replay count. */
  const selectedIndex = invocations.indexOf(selected);
  return invocations.filter((invocation, index) =>
    (invocation.turnId ?? "") === (selected.turnId ?? "")
    && (
      invocation.observedAt > selected.observedAt
      || (invocation.observedAt === selected.observedAt && index > selectedIndex)
    )
  ).length;
}

function readIncidentRoute(): {
  backend: AppServerBackendKind;
  federationTarget?: FederationTarget;
  lens?: ToolOutputIncidentExplorerLens;
  projectLabel?: string;
  threadId: string;
  title: string;
} | undefined {
  const [kind, backend, threadId, title, projectLabel, lens, instanceId] =
    window.location.hash.replace(/^#/, "").split("/");
  if (kind !== "tool-output-incidents" || !backend || !threadId) return undefined;
  const owner = instanceId ? decodeURIComponent(instanceId) : "";
  const requestedLens = lens ? decodeURIComponent(lens) : "";
  return {
    backend: decodeURIComponent(backend) as AppServerBackendKind,
    /* Present only for a peer's thread; a local thread carries no target and
       every read stays on this instance. */
    ...(owner
      ? {
          federationTarget: {
            scope: "remote" as const,
            instanceId: owner as FederationInstanceId,
          },
        }
      : {}),
    /* Present only when the click that opened this window named a lens. An
       unrecognized value is treated as no preference rather than as a lens
       nothing renders. */
    ...(requestedLens === "incidents" || requestedLens === "savings"
      ? { lens: requestedLens }
      : {}),
    ...(projectLabel
      ? { projectLabel: decodeURIComponent(projectLabel) }
      : {}),
    threadId: decodeURIComponent(threadId),
    title: title ? decodeURIComponent(title) : "Thread",
  };
}

function findActiveTurnId(response: AppServerReadThreadResponse | undefined): string | undefined {
  const entries = response?.replay.entries ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const turn = entries[index]?.turn;
    if (turn?.status === "in_progress") return turn.id;
  }
  return undefined;
}

function groupCases(
  invocations: ThreadToolInvocationRecord[],
  sortMode: IncidentSortMode,
  turnLabels: Map<string, string>,
) {
  if (sortMode !== "turn") {
    return [{ invocations, key: "all", label: "" }];
  }
  const groups = new Map<string, {
    invocations: ThreadToolInvocationRecord[];
    key: string;
    label: string;
  }>();
  for (const invocation of invocations) {
    const key = invocation.turnId ?? "";
    const group = groups.get(key) ?? {
      invocations: [],
      key,
      label: turnLabels.get(key) ?? "Unassigned",
    };
    group.invocations.push(invocation);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    label: `${group.label} · ${group.invocations.length} ${group.invocations.length === 1 ? "case" : "cases"}`,
  }));
}

async function readInvocationOutput(params: {
  backend: AppServerBackendKind;
  desktopApi: NonNullable<ReturnType<typeof useDesktopApi>>;
  federationTarget?: FederationTarget;
  initial: AppServerReadThreadResponse;
  invocation: ThreadToolInvocationRecord;
  threadId: string;
}): Promise<string | undefined> {
  let response = params.initial;
  const seen = new Set<string>();
  for (;;) {
    const detail = findInvocationDetail(response, params.invocation);
    if (detail?.command?.output !== undefined) return detail.command.output;
    const cursor = response.replay.pagination.previousCursor;
    if (
      !response.replay.pagination.hasPreviousPage
      || !cursor
      || seen.has(cursor)
      || !params.desktopApi.readThread
    ) return undefined;
    seen.add(cursor);
    response = await params.desktopApi.readThread({
      backend: params.backend,
      ...(params.federationTarget
        ? { federationTarget: params.federationTarget }
        : {}),
      before: cursor,
      limit: HISTORY_PAGE_LIMIT,
      threadId: params.threadId,
      viewOnly: true,
    });
  }
}

function findInvocationDetail(
  response: AppServerReadThreadResponse,
  invocation: ThreadToolInvocationRecord,
): AppServerThreadActivityDetail | undefined {
  let matched: AppServerThreadActivityDetail | undefined;
  for (const entry of response.replay.entries) {
    if (entry.type !== "activity") continue;
    const entryCommandDetails = entry.details.filter((detail) => detail.command);
    if (entry.id === invocation.itemId) {
      return entryCommandDetails.find((detail) =>
        detail.command?.rawCommand === invocation.normalizedCommand
        || detail.command?.displayCommand === invocation.normalizedCommand
      )
        ?? entryCommandDetails.find((detail) =>
          detail.command?.output?.length === invocation.outputChars
        )
        ?? entryCommandDetails.find((detail) =>
          detail.command?.output !== undefined
        )
        ?? entryCommandDetails[0];
    }
    for (const detail of entry.details) {
      if (
        !detail.command
        || !detailMatchesInvocationItem(detail.id, invocation.itemId)
      ) continue;
      if (detail.command.output !== undefined) return detail;
      matched ??= detail;
    }
  }
  return matched;
}

function filterOutputLines(output: string | undefined, query: string) {
  if (output === undefined) return [];
  const normalizedQuery = query.trim().toLowerCase();
  return output.split(/\r\n|\r|\n/).map((text, index) => ({
    number: index + 1,
    text,
  })).filter((line) => !normalizedQuery || line.text.toLowerCase().includes(normalizedQuery));
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}
