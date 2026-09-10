import { buildThreadPricingDisplay, type ThreadPricingDisplay } from "@pwragent/shared";
import {
  type PricingUsageLine,
  resolveUsageLineModel,
  type PricingRunningLineTotals,
  isForkBaselineLine,
  isEstimatedUsageGap,
  type PricingUsageRowData,
  type PricingSubAgent,
  type PricingGateSelection,
  buildPricingGateGroupDisplay,
  partitionPricingGateCards,
} from "@pwragent/shared";
import type {
  AppServerBackendKind,
  ThreadCompactionRecord,
  ThreadPricingSummary,
  ThreadSubAgentSummary,
  ThreadTokenMiserAccounting,
  ThreadTurnFailure,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import {
  estimateOpenAiCodexCreditUsage,
  formatTokenUsageMicrosAsUsd,
} from "@pwragent/shared";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ChipContextMenu,
  type ChipContextMenuItem,
  type ChipContextMenuPosition,
} from "../../chrome/ChipContextMenu";
import { MoreVerticalIcon } from "../../../icons";
import { formatBackendLabel } from "../../../lib/backend-label";
import { useViewportTooltip } from "../../../lib/useViewportTooltip";
import {
  formatTokenCount,
  subAgentCompletedAt,
} from "./subagent-format";
import {
  formatCompactCount,
  formatTimestamp,
  RailSummaryRow,
} from "./context-rail-shared";
import { RailStatusChip } from "./RailStatusChip";
import {
  subAgentPricingUsageTitle,
} from "./subagent-kind";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useThreadDisplayResource } from "../../../lib/useThreadDisplayResource";
import { RailCardTiming, useNowWhileActive } from "./RailCardTiming";
import { TokenMiserSavingsBreakdown } from "./TokenMiserSavingsBreakdown";
import { TokenMiserSummaryCard } from "./TokenMiserSummaryCard";
import {
  type PricingModelSpend,
  prunePricingSpendOverrides,
} from "../pricing-spend-by-model";


type PricingGateSource = Pick<Parameters<typeof useThreadDisplayResource>[0], "desktopApi" | "thread">;

type PricingPanelProps = {
  desktopApi?: DesktopApi;
  thread?: PricingGateSource["thread"];
  display?: ThreadPricingDisplay;
  onLoadMore?: () => void;
  loading?: boolean;
  activeTurnId?: string;
  displayOptions?: PricingDisplayOptions;
  /**
   * Opens the Explorer on its savings lens. The Pricing rail is where an
   * operator asks what a thread cost, so it is where the full savings
   * breakdown has to be reachable — until now that window could only be
   * opened from Tool calls, a tab the tool-accounting experiment gates off.
   */
  onOpenTokenMiserSavings?: () => void;
  onScrollToTurn?: (turnId: string, turnTimeMs?: number) => void;
  pricing?: {
    compactions?: ThreadCompactionRecord[];
    lines: ThreadUsageLineRecord[];
    summaries: ThreadPricingSummary[];
  };
  /**
   * Durable sub-agent (task-monitor) summaries for this thread, joined to
   * monitor-scope usage rows by `monitorId` === the row's `sourceItemId`.
   * Supplies each sub-agent row's name and its live/terminal status.
   */
  subAgents?: ThreadSubAgentSummary[];
  tokenMiserAccounting?: ThreadTokenMiserAccounting;
  threadReasoningEffort?: string;
  turnFailures?: readonly ThreadTurnFailure[];
};

type PricingDisplayOptions = {
  codexCredits: boolean;
  usd: boolean;
};



const DEFAULT_PRICING_DISPLAY_OPTIONS: PricingDisplayOptions = {
  codexCredits: false,
  usd: true,
};
const PRICING_USAGE_PAGE_SIZE = 20;

export const PricingPanel = memo(function PricingPanel(props: PricingPanelProps) {
  // ThreadView's scroll handler follows transcript updates. Keep card actions
  // stable while dispatching to the latest committed handler, including after
  // a thread switch. Absence still disables the action in the card.
  const scrollToTurnRef = useRef(props.onScrollToTurn);
  useLayoutEffect(() => {
    scrollToTurnRef.current = props.onScrollToTurn;
  }, [props.onScrollToTurn]);
  const scrollToTurn = useCallback((turnId: string, turnTimeMs?: number) => {
    scrollToTurnRef.current?.(turnId, turnTimeMs);
  }, []);
  const model = useMemo(() => props.display ?? buildThreadPricingDisplay({
    pricing: props.pricing, subAgents: props.subAgents, tokenMiserAccounting: props.tokenMiserAccounting,
    activeTurnId: props.activeTurnId, threadReasoningEffort: props.threadReasoningEffort, turnFailures: props.turnFailures,
  }), [props.display, props.pricing, props.subAgents, props.tokenMiserAccounting, props.activeTurnId, props.threadReasoningEffort, props.turnFailures]);
  const { summary, spendByModel, tokenMiserSummary, observedCostMicros, totals: pricingTotals } = model;
  const pricingHistoryKey = summary ? `${summary.backend}:${summary.threadId}` : "empty";
  const [usagePage, setUsagePage] = useState({ count: PRICING_USAGE_PAGE_SIZE, key: pricingHistoryKey });
  const visibleUsageRowCount = props.display ? model.rows.length : usagePage.key === pricingHistoryKey ? usagePage.count : PRICING_USAGE_PAGE_SIZE;
  const visibleRows = model.rows.slice(0, visibleUsageRowCount);
  const hiddenUsageRowCount = model.totalRows - visibleRows.length;
  const spendModelCount = spendByModel.reduce(
    (total, group) => total + group.models.length,
    0,
  );
  // Which spend rows the operator has opened, and which they have closed.
  //
  // A thread whose spend is one model has nothing to hide behind a click, so
  // that row starts open on the token volume this section replaced. `openKey`
  // names it, and is settled once — on the first render with any spend — then
  // held. Re-deriving the default from the live bucket count closed the row an
  // operator was reading the moment a reviewer, or even the thread namer,
  // billed a second model; latching a bare flag instead would have opened
  // every later row too.
  const soleSpendKey =
    spendModelCount === 1 ? spendByModel[0]?.models[0]?.key : undefined;
  const [spendExpansion, setSpendExpansion] = useState<{
    key: string;
    openKey?: string;
    overrides: Readonly<Record<string, boolean>>;
    settled: boolean;
  }>({ key: pricingHistoryKey, overrides: {}, settled: false });
  const spendKeyMatches = spendExpansion.key === pricingHistoryKey;
  // A bucket's key carries its model, so a helper whose model arrives late is
  // re-keyed and leaves its override behind. Reading through the live buckets
  // keeps a dead override from opening some later unrelated row.
  const spendOverrides = spendKeyMatches
    ? prunePricingSpendOverrides(spendExpansion.overrides, spendByModel)
    : {};
  if (!spendKeyMatches || (!spendExpansion.settled && spendModelCount > 0)) {
    setSpendExpansion({
      key: pricingHistoryKey,
      ...(soleSpendKey === undefined ? {} : { openKey: soleSpendKey }),
      overrides: spendKeyMatches ? spendOverrides : {},
      settled: spendModelCount > 0,
    });
  }
  const isSpendRowExpanded = (key: string): boolean =>
    spendOverrides[key] ?? key === spendExpansion.openKey;
  const toggleSpendRow = (key: string): void => {
    setSpendExpansion((current) => ({
      ...current,
      key: pricingHistoryKey,
      overrides: {
        ...spendOverrides,
        [key]: !isSpendRowExpanded(key),
      },
    }));
  };
  const displayOptions = props.displayOptions ?? DEFAULT_PRICING_DISPLAY_OPTIONS;
  const { id, source, federation, updatedAt } = props.thread ?? {};
  const snapshotVersion = federation?.ref.target.scope === "remote" && !federation.capabilities?.includes("event_subscriptions") ? updatedAt : undefined;
  const gateSource = useMemo<PricingGateSource>(() => ({
    desktopApi: props.desktopApi,
    thread: id !== undefined && source !== undefined ? { id, source, federation, updatedAt: snapshotVersion } : undefined,
  }), [props.desktopApi, id, source, federation, snapshotVersion]);

  return (
    <section className="context-panel__section">
      <h3>Pricing</h3>
      {summary ? (
        <>
          <div className="rail-summary-card pricing-summary-card">
            <div className="rail-summary-card__header">
              <span className="rail-summary-card__eyebrow">Pricing summary</span>
              <span className="rail-summary-card__meta">
                {summary.usageLineCount.toLocaleString()} row
                {summary.usageLineCount === 1 ? "" : "s"}
              </span>
            </div>
            <div className="rail-summary-card__headline">
              <span className="rail-summary-card__primary">
                {formatSummaryEstimates({
                  codexCreditMicros: pricingTotals.totalCreditMicros,
                  displayOptions,
                  hasEstimates: pricingTotals.hasEstimatedRows,
                  summary,
                })}
              </span>
            </div>
            <div className="rail-summary-card__caption">
              {summary.pricedUsageLineCount.toLocaleString()} priced ·{" "}
              {summary.unpricedUsageLineCount.toLocaleString()} unpriced ·{" "}
              {formatTimestamp(summary.updatedAt)}
            </div>
            {spendByModel.length > 0 ? (
              <div className="rail-summary-card__section">
                <span className="rail-summary-card__section-title">
                  Spend by model
                </span>
                <div className="pricing-spend-list">
                  {spendByModel.map((group) => {
                    // A provider earns a subtotal only when it holds more than
                    // one model AND it is not the whole bill — a lone provider's
                    // subtotal is the headline three lines above, which is the
                    // duplication this section was built to remove. Wherever no
                    // heading names the provider, the rows carry it instead, so
                    // it is never dropped entirely.
                    const showGroupHead =
                      group.models.length > 1 && spendByModel.length > 1;
                    return (
                    <div className="pricing-spend-group" key={group.key}>
                      {showGroupHead ? (
                        <div className="pricing-spend-group__head">
                          <span>
                            {formatPricingProviderLabel(group.provider)}
                          </span>
                          <span className="pricing-spend-group__total">
                            {formatSpendMoney({
                              currency: group.currency,
                              displayOptions,
                              totalCostMicros: group.totalCostMicros,
                            })}
                            {" · "}
                            {formatUsageRowCount(group.usageLineCount)}
                          </span>
                        </div>
                      ) : null}
                      {group.models.map((modelSpend) => (
                        <PricingModelSpendRow
                          displayOptions={displayOptions}
                          expanded={isSpendRowExpanded(modelSpend.key)}
                          key={modelSpend.key}
                          onToggle={() => toggleSpendRow(modelSpend.key)}
                          showProvider={!showGroupHead}
                          spend={modelSpend}
                        />
                      ))}
                    </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
          {summary.unpricedUsageLineCount > 0 ? (
            <p className="context-empty context-empty--warning">
              {summary.unpricedUsageLineCount.toLocaleString()} usage row
              {summary.unpricedUsageLineCount === 1 ? "" : "s"} could not be priced.
            </p>
          ) : null}
        </>
      ) : model.totalRows === 0 ? (
        <p className="context-empty">No usage pricing recorded yet.</p>
      ) : null}

      {/* Under the spend breakdown, above the turn rows: the gate's result is
          part of reading the bill, not a footnote to one turn of it. */}
      {tokenMiserSummary ? (
        <TokenMiserSummaryCard
          {...(props.onOpenTokenMiserSavings
            ? { onOpenSavings: props.onOpenTokenMiserSavings }
            : {})}
          {...(observedCostMicros > 0 ? { observedCostMicros } : {})}
          summary={tokenMiserSummary}
        />
      ) : null}

      {model.totalRows > 0 ? (
        <ul className="context-list context-list--cards pricing-usage-list">
          {visibleRows.map((row) => (
            <PricingUsageRow
              key={`${row.line.backend}:${row.line.threadId}:${row.line.usageLineId}`}
              row={row}
              gateSource={gateSource}
              displayOptions={displayOptions}
              onScrollToTurn={props.onScrollToTurn ? scrollToTurn : undefined}
            />
          ))}
        </ul>
      ) : null}
      {hiddenUsageRowCount > 0 ? (
        <div className="pricing-usage-list__pagination">
          <p className="pricing-usage-list__status">
            Showing latest {visibleRows.length.toLocaleString()} of{" "}
            {model.totalRows.toLocaleString()} usage rows.
          </p>
          <button
            className="button button--ghost pricing-usage-list__more"
            type="button"
            disabled={props.loading}
            onClick={() => {
              if (props.onLoadMore) { props.onLoadMore(); return; }
              setUsagePage({
                count: Math.min(
                  model.totalRows,
                  visibleUsageRowCount + PRICING_USAGE_PAGE_SIZE,
                ),
                key: pricingHistoryKey,
              });
            }}
          >
            Show{" "}
            {Math.min(
              PRICING_USAGE_PAGE_SIZE,
              hiddenUsageRowCount,
            ).toLocaleString()}{" "}
            older usage rows
          </button>
        </div>
      ) : null}
    </section>
  );
}, equalPricingData);



// Federation/IPC delivers fresh JSON objects, even for finalized history.
// The panel skips identical snapshots; each card compares only its own data
// when a snapshot changes. Include every field (including nested replay
// evidence) so late corrections cannot leave stale cards. These props contain
// JSON data and callbacks only; callbacks must retain identity to compare equal.
function equalPricingData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key)
      && equalPricingData(a[key], b[key]));
}

const PricingUsageRow = memo(function PricingUsageRowCard(props: {
  row: PricingUsageRowData;
  gateSource?: PricingGateSource;
  displayOptions: PricingDisplayOptions;
  onScrollToTurn: PricingPanelProps["onScrollToTurn"];
}) {
  const { line, lineTotals, rowCompactions, subAgent, isActive, turnFailure } = props.row;
  const { displayOptions } = props;
  const renderGroup = () => <TokenMiserTurnGroup {...props} />;
  if (props.row.orphan) {
    return (props.row.gateSummary ? props.row.gateSummary.gateCount > props.row.gateSummary.unpricedCount
      : props.row.gates.some((gate) => gate.subAgent?.tokenMiserAccounting)) ? (
      <li className="rail-card pricing-usage-row pricing-usage-row--orphan-gates">
        {renderGroup()}
      </li>
    ) : null;
  }
  const usageLineEstimate = formatUsageLineEstimates({ displayOptions, line, lineTotals });
  const runningTotal = formatUsageLineRunningTotal({ displayOptions, line, lineTotals });
  const contextReplayLines = formatContextReplayEstimate({ displayOptions, line });
  const runningTokens = formatUsageLineRunningTokens(line);
  const usageTitle = formatUsageLineTitle(line, subAgent);
  const showUsageTitle = usageTitle !== "Turn usage";
  const reasoningEffort = line.reasoningEffort
    ?? subAgent?.preferredReasoningEffort
    ?? props.row.threadReasoningEffort;
  const runtimeLabel = formatUsageLineRuntimeLabel(line, subAgent);
  const runtimeModel = resolveUsageLineModel(line, subAgent);

  return (
    <li
      key={line.usageLineId}
      className={`rail-card pricing-usage-row${
        isActive ? " pricing-usage-row--active" : ""
      }`}
    >
      <div className="pricing-usage-row__header">
        <div className="pricing-usage-row__identity">
          {showUsageTitle ? (
            <p className="rail-card__title">{usageTitle}</p>
          ) : null}
          <p className="rail-card__runtime">
            <span className="rail-card__provider-chip">
              {runtimeLabel}
            </span>
            <span className="rail-card__model">
              {runtimeModel ?? "Unknown model"}
              {reasoningEffort ? ` · ${reasoningEffort}` : ""}
              {formatServiceTierLabel(line)}
            </span>
          </p>
        </div>
        <div className="pricing-usage-row__controls">
          {isActive ? (
            <RailStatusChip tone="active">Running</RailStatusChip>
          ) : turnFailure ? (
            <RailStatusChip tone="error" alert>Failed</RailStatusChip>
          ) : null}
          <PricingUsageActions
            line={line}
            onScrollToTurn={props.onScrollToTurn}
            startedAt={
              subAgent?.createdAt ?? line.startedAt ?? line.createdAt
            }
            subAgent={subAgent}
          />
        </div>
      </div>
      {/* Under the Token Miser fold the heading already names the agent,
          and the card keeps its own title — a second "Token Miser" line on
          every nested card was one title too many. */}
      {subAgent?.agentName && !props.row.nested ? (
        <p className="rail-card__agent-name" title={subAgent.agentName}>
          {subAgent.agentName}
        </p>
      ) : null}
      {/* Cost first: it is the answer the card exists to give. Tokens,
          timing and replay estimates are the working shown under it. */}
      {usageLineEstimate ? (
        <p className="pricing-usage-row__cost">{usageLineEstimate}</p>
      ) : null}
      {turnFailure ? <p className="rail-card__error">{turnFailure.error}</p> : null}
      <p className="rail-card__usage">
        {formatTokenCount(line.uncachedInputTokens)} uncached in ·{" "}
        {formatTokenCount(line.cachedInputTokens)} cached ·{" "}
        {formatTokenCount(line.outputTokens)} out
        {line.reasoningOutputTokens > 0
          ? ` (${formatTokenCount(line.reasoningOutputTokens)} reasoning)`
          : ""}
      </p>
      <PricingUsageTimestamp
        isActive={isActive}
        line={line}
        onScrollToTurn={props.onScrollToTurn}
        subAgent={subAgent}
      />
      {contextReplayLines.map((replayLine) => (
        <p key={replayLine} className="rail-card__usage">
          {replayLine}
        </p>
      ))}
      {subAgent?.tokenMiserAccounting ? (
        <TokenMiserSavingsBreakdown
          accounting={subAgent.tokenMiserAccounting}
        />
      ) : null}
      {(props.row.gateSummary?.gateCount ?? props.row.gates.length) > 0 ? renderGroup() : null}
      {rowCompactions.length > 0 ? (
        <CompactionBreakdown compactions={rowCompactions} />
      ) : null}
      {runningTokens ? (
        <details className="pricing-running-total">
          <summary className="pricing-running-total__summary">
            {runningTotal ?? "Running total"}
          </summary>
          <p className="rail-card__usage pricing-running-total__tokens">
            {runningTokens}
          </p>
        </details>
      ) : runningTotal ? (
        <p className="rail-card__usage">{runningTotal}</p>
      ) : null}
    </li>
  );

}, (previous, next) =>
  previous.onScrollToTurn === next.onScrollToTurn
  && equalPricingData(previous.gateSource, next.gateSource)
  && equalPricingData(previous.displayOptions, next.displayOptions)
  && equalPricingData(previous.row, next.row));

/**
 * One model's share of the bill, closed by default, opening onto the token
 * volume behind it.
 *
 * Only the parent thread's volume was ever shown here, so a review that spent
 * a dollar and 1.3M tokens appeared in the rail as a dollar. The row that
 * replaced the provider split carries both.
 */
function PricingModelSpendRow(props: {
  displayOptions: PricingDisplayOptions;
  expanded: boolean;
  onToggle: () => void;
  /** True when no provider heading sits above this row to name it. */
  showProvider: boolean;
  spend: PricingModelSpend;
}) {
  const summary = props.spend.summary;
  // A bucket that is entirely unpriced is not a bucket that cost nothing, and
  // "$0.000" is what it would otherwise read as. The per-turn cards below make
  // the same distinction; this row was the one place that dropped it.
  const whollyUnpriced =
    summary.pricedUsageLineCount === 0 && summary.unpricedUsageLineCount > 0;
  const meta = [
    props.showProvider
      ? formatPricingProviderLabel(props.spend.provider)
      : undefined,
    formatUsageRowCount(summary.usageLineCount),
    !whollyUnpriced && summary.unpricedUsageLineCount > 0
      ? `${summary.unpricedUsageLineCount.toLocaleString()} unpriced`
      : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
  const cost = whollyUnpriced
    ? "Unpriced"
    : formatSpendMoney({
        currency: summary.currency,
        displayOptions: props.displayOptions,
        hasEstimates: props.spend.hasEstimatedRows,
        totalCostMicros: summary.totalCostMicros,
      });
  const origin = formatModelSpendOrigin(props.spend);
  // When helpers share this model, the token volume the operator wants is the
  // thread's own — that is the figure the turn card and Codex's context meter
  // agree with. The helpers' share is accounted for on its own line rather
  // than folded in silently.
  const volume = props.spend.threadSummary ?? summary;
  const helperTokens = props.spend.threadSummary
    ? summary.totalTokens - props.spend.threadSummary.totalTokens
    : 0;

  return (
    <div
      className="pricing-spend-row"
      data-expanded={props.expanded ? "true" : "false"}
    >
      <button
        aria-expanded={props.expanded}
        className="pricing-spend-row__summary"
        onClick={props.onToggle}
        type="button"
      >
        <span aria-hidden="true" className="pricing-spend-row__chevron">›</span>
        <span className="pricing-spend-row__label">
          {props.spend.model ?? "Unknown model"}
        </span>
        <span className="pricing-spend-row__meta">{meta}</span>
        {cost ? (
          <span className="pricing-spend-row__cost">{cost}</span>
        ) : null}
      </button>
      {props.expanded ? (
        <div className="pricing-spend-row__body">
          {origin ? <p className="pricing-spend-row__origin">{origin}</p> : null}
          <RailSummaryRow
            label="Uncached input"
            value={formatCompactCount(volume.uncachedInputTokens)}
          />
          <RailSummaryRow
            label="Cached input"
            value={formatCompactCount(volume.cachedInputTokens)}
          />
          <RailSummaryRow
            label="Output"
            value={formatCompactCount(volume.outputTokens)}
          />
          {volume.reasoningOutputTokens > 0 ? (
            <RailSummaryRow
              label="Reasoning"
              value={formatCompactCount(volume.reasoningOutputTokens)}
            />
          ) : null}
          {props.spend.threadSummary ? (
            <RailSummaryRow
              label="Helper tokens"
              value={formatCompactCount(helperTokens)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A spend figure in the units the operator asked for. Nothing at all when they
 * turned dollars off — the headline already says why, and a row that kept
 * printing them would contradict it inside one card.
 */
function formatSpendMoney(params: {
  currency: string;
  displayOptions: PricingDisplayOptions;
  hasEstimates?: boolean;
  totalCostMicros: number;
}): string | undefined {
  if (!params.displayOptions.usd) {
    return undefined;
  }
  const money = formatMoney(params.totalCostMicros, params.currency);
  return params.hasEstimates ? `${money} estimated` : money;
}

/**
 * Says where a model's rows came from, when saying it adds something. A thread
 * whose own model is also a reviewer's reads "This thread's model · 2
 * sub-agents"; a bucket that is only turn rows says so once and stops.
 *
 * Token Miser gates and the thread namer are counted apart from sub-agents.
 * They bill real money, but the operator dispatched none of them, and folding
 * them into the sub-agent count reported reviewers that never ran.
 */
function formatModelSpendOrigin(spend: PricingModelSpend): string | undefined {
  const parts = [
    spend.threadUsageLineCount > 0 ? "This thread's model" : undefined,
    spend.subAgentCount > 0
      ? `${spend.subAgentCount.toLocaleString()} sub-agent${
          spend.subAgentCount === 1 ? "" : "s"
        }`
      : undefined,
    spend.systemHelperCount > 0
      ? `${spend.systemHelperCount.toLocaleString()} system helper${
          spend.systemHelperCount === 1 ? "" : "s"
        }`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatUsageRowCount(count: number): string {
  return `${count.toLocaleString()} row${count === 1 ? "" : "s"}`;
}

/**
 * The model a usage row belongs to. A helper's row often carries none of its
 * own and the sub-agent summary holds it, so the row card and the spend bucket
 * walk the same chain rather than disagreeing about who spent the money.
 */


function formatServiceTierLabel(line: ThreadUsageLineRecord): string {
  if (line.fastMode || line.serviceTier === "priority") {
    return " · Fast";
  }
  if (!line.serviceTier || line.serviceTier === "standard") {
    return "";
  }
  return ` · ${line.serviceTier}`;
}

/**
 * Split gate rows out of the flat list and attach each to its parent turn.
 *
 * A gate whose parent turn has no row of its own — a native review's inner
 * turn, or a turn whose usage has not landed yet — stays in the flat list, so
 * it is still visible rather than silently dropped.
 */






/**
 * The turn's Token Miser story, folded under the turn it belongs to.
 *
 * The summary line sums every gate — it is what the turn saved, and it keeps
 * moving as replays are counted, until the next compaction. The expanded list
 * shows a card only for gates past the threshold; the rest are one line, so a
 * turn with twenty-five gates that each saved half a cent reads as one fact.
 */
function TokenMiserTurnGroup(props: {
  row: PricingUsageRowData;
  gateSource?: PricingGateSource;
  displayOptions: PricingDisplayOptions;
  onScrollToTurn: PricingPanelProps["onScrollToTurn"];
}) {
  const [expanded, setExpanded] = useState(false);
  const [showSmall, setShowSmall] = useState(false);
  const gates = props.row.gates.map((row) => row.line);
  const subAgentsById = new Map(props.row.gates.flatMap((row) => row.subAgent ? [[row.subAgent.monitorId, row.subAgent] as const] : []));
  const summary = props.row.gateSummary ?? buildPricingGateGroupDisplay({ gates, subAgentsById, decisions: props.row.decisions });
  const { primary, small } = partitionPricingGateCards(gates, subAgentsById);
  const cardIds = new Set([...primary, ...(showSmall ? small : [])].map((line) => line.usageLineId));
  const { savingsMicros, gateCostMicros, unpricedCount, count, helperDecisionCount,
    policyDecisionCount, helperPassThroughCount, policyPassThroughCount, smallCount, smallMicros, hasDecisions } = summary;
  const passThroughCount = helperPassThroughCount + policyPassThroughCount;
  const countLabel = hasDecisions || passThroughCount > 0
    ? count === 1 ? "decision" : "decisions"
    : count === 1 ? "gate" : "gates";
  // The verdict slot is one money phrase and nothing else. It shares the
  // header row with the label, so only a short string fits there — and early
  // in a turn, when every gate has a usage row but no accounting yet, the
  // reason there is no savings figure is what made it long. That reason is
  // detail: it goes on the counts row below, which has a full line to wrap
  // into.
  const awaitingPricing = summary.gateCount === unpricedCount;
  const verdict = awaitingPricing
    ? `${formatTokenUsageMicrosAsUsd(gateCostMicros)} evaluating`
    : savingsMicros >= 0
      ? `${formatTokenUsageMicrosAsUsd(savingsMicros)} saved`
      : `${formatTokenUsageMicrosAsUsd(Math.abs(savingsMicros))} net overhead`;

  return (
    <div className="pricing-token-miser" data-expanded={expanded ? "true" : "false"}>
      <button
        aria-expanded={expanded}
        className="pricing-token-miser__summary"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <span aria-hidden="true" className="pricing-token-miser__chevron">›</span>
        <span className="pricing-token-miser__label">Token Miser</span>
        <span
          className="pricing-token-miser__verdict"
          data-negative={!awaitingPricing && savingsMicros < 0}
          data-pending={awaitingPricing}
        >
          {verdict}
        </span>
        <span className="pricing-token-miser__count">
          {count.toLocaleString()} {countLabel}
          {hasDecisions
            ? ` · ${helperDecisionCount.toLocaleString()} Luna ${helperDecisionCount === 1 ? "evaluation" : "evaluations"}`
            : policyDecisionCount > 0
              ? ` · ${helperDecisionCount.toLocaleString()} helper · ${policyDecisionCount.toLocaleString()} policy`
            : ""}
          {hasDecisions && passThroughCount > 0
            ? ` · ${passThroughCount.toLocaleString()} ${passThroughCount === 1 ? "pass-through" : "pass-throughs"} (${helperPassThroughCount.toLocaleString()} helper · ${policyPassThroughCount.toLocaleString()} policy)`
            : ""}
          {awaitingPricing
            ? " · savings not priced yet"
            : unpricedCount > 0
              ? ` · ${unpricedCount.toLocaleString()} not priced yet`
              : ""}
        </span>
      </button>
      {expanded ? (
        <div className="pricing-token-miser__body">
          {props.row.gatesDeferred ? (
            <>
              <PricingGateCards {...props} selection={{ usageLineId: props.row.line.usageLineId, filter: "primary" }} />
              {showSmall ? <PricingGateCards {...props} selection={{ usageLineId: props.row.line.usageLineId, filter: "small" }} /> : null}
            </>
          ) : (
            <ul className="context-list context-list--cards pricing-token-miser__gates">
              {props.row.gates.filter((row) => cardIds.has(row.line.usageLineId)).map((row) => (
                <PricingUsageRow key={row.line.usageLineId} row={row} gateSource={props.gateSource}
                  displayOptions={props.displayOptions} onScrollToTurn={props.onScrollToTurn} />
              ))}
            </ul>
          )}
          {smallCount > 0 ? (
            <button
              aria-expanded={showSmall}
              className="pricing-token-miser__folded"
              onClick={() => setShowSmall((current) => !current)}
              type="button"
            >
              {showSmall ? "Hide" : "Show"}{" "}
              {smallCount.toLocaleString()} smaller{" "}
              {smallCount === 1 ? "gate" : "gates"} ·{" "}
              {formatTokenUsageMicrosAsUsd(Math.abs(smallMicros))}{" "}
              {smallMicros >= 0 ? "saved" : "overhead"} between them
            </button>
          ) : null}
          {unpricedCount > 0 ? (
            <p className="pricing-token-miser__folded">
              {unpricedCount.toLocaleString()} not priced yet
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}


/** Mounted only for an expanded gate list; closed groups have no read or event demand. */
function PricingGateCards(props: {
  gateSource?: PricingGateSource;
  selection: PricingGateSelection;
  displayOptions: PricingDisplayOptions;
  onScrollToTurn: PricingPanelProps["onScrollToTurn"];
}) {
  const page = useThreadDisplayResource({ ...props.gateSource, resource: "pricing", pricingGateGroup: props.selection });
  const unavailable = !props.gateSource?.desktopApi || !props.gateSource.thread;
  return (
    <>
      <ul className="context-list context-list--cards pricing-token-miser__gates">
        {page.data?.pricingPage?.rows.map((row) => (
          <PricingUsageRow key={row.line.usageLineId} row={row} gateSource={props.gateSource}
            displayOptions={props.displayOptions} onScrollToTurn={props.onScrollToTurn} />
        ))}
      </ul>
      {page.loading ? <p className="context-empty" role="status">Loading gate usage…</p> : null}
      {page.error || unavailable ? <p className="context-empty" role="alert">{page.error ?? "Gate usage is unavailable."}</p> : null}
      {page.error && !unavailable ? <button className="button button--ghost" type="button" onClick={() => void page.refresh()}>Retry gate usage</button> : null}
      {page.data?.nextCursor ? <button className="button button--ghost" type="button" disabled={page.loading} onClick={() => void page.loadMore()}>Show more gates</button> : null}
    </>
  );
}



/**
 * Bucket compactions by the usage row that should show them.
 *
 * A compaction whose cold replay has been claimed belongs to that exact row —
 * that request is the one that re-sent the surviving context uncached. One that
 * has not been claimed yet falls back to its turn, so a compaction observed
 * mid-turn is still visible before the request after it is priced.
 */


// A row claims its directly-attributed compactions plus any of its turn's
// still-unattributed ones. Sub-agent rows are excluded: compaction is a
// property of the parent thread's context, not of a monitor's own usage.


/**
 * What a turn's compactions cost. A compaction forces the whole surviving
 * context to be re-sent uncached on the next request, which is invisible in the
 * turn's own token counts — it reads as ordinary input.
 */
function CompactionBreakdown(props: {
  compactions: readonly ThreadCompactionRecord[];
}) {
  const count = props.compactions.length;
  const uncachedTokens = props.compactions.reduce(
    (total, entry) => total + (entry.coldUncachedTokens ?? 0),
    0,
  );
  const costMicros = props.compactions.reduce(
    (total, entry) => total + (entry.coldCostMicros ?? 0),
    0,
  );
  const measured = props.compactions.some(
    (entry) => entry.coldUsageLineId !== undefined,
  );
  return (
    <details className="pricing-compactions">
      <summary className="pricing-compactions__summary">
        Compacted {count.toLocaleString()} time{count === 1 ? "" : "s"}
        {measured
          ? ` · ${formatTokenCount(uncachedTokens)} re-read uncached`
            + (costMicros > 0
              ? ` · ${formatTokenUsageMicrosAsUsd(costMicros)}`
              : "")
          : " · cost not observed yet"}
      </summary>
      <ul className="pricing-compactions__list">
        {props.compactions.map((entry) => (
          <li key={entry.compactionId}>
            <span>{formatTimestamp(entry.observedAt)}</span>
            <span>
              {entry.coldUncachedTokens !== undefined
                ? `${formatTokenCount(entry.coldUncachedTokens)} uncached`
                  + (entry.coldCostMicros
                    ? ` · ${formatTokenUsageMicrosAsUsd(entry.coldCostMicros)}`
                    : "")
                : "awaiting the next request"}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

















function formatSummaryEstimates(params: {
  codexCreditMicros: number | undefined;
  displayOptions: PricingDisplayOptions;
  hasEstimates?: boolean;
  summary: ThreadPricingSummary;
}): string {
  const estimates: string[] = [];
  if (params.displayOptions.usd) {
    estimates.push(formatMoney(params.summary.totalCostMicros, params.summary.currency));
  }
  if (
    params.displayOptions.codexCredits &&
    params.codexCreditMicros !== undefined &&
    params.codexCreditMicros > 0
  ) {
    estimates.push(formatCodexCredits(params.codexCreditMicros));
  }
  if (estimates.length > 0) {
    return `${estimates.join(" · ")}${params.hasEstimates ? " estimated" : ""}`;
  }
  return hasSelectedEstimateUnit(params.displayOptions)
    ? "No selected estimates available"
    : "No estimate units selected";
}

function formatUsageLineEstimates(params: {
  displayOptions: PricingDisplayOptions;
  line: PricingUsageLine;
  lineTotals: PricingRunningLineTotals | undefined;
}): string | undefined {
  // Inherited fork context was billed on the parent thread — show the
  // attribution, never a dollar figure, so it reads as not-re-charged here.
  if (isForkBaselineLine(params.line)) {
    return "Inherited from parent thread — billed there, not re-charged here";
  }
  const estimates: string[] = [];
  if (params.displayOptions.usd) {
    estimates.push(
      params.line.priceStatus === "priced"
        ? `${formatMoney(params.line.totalCostMicros, params.line.currency)} ${formatUsageLineCostSuffix(params.line)}`
        : `Unpriced: ${formatUnpricedReason(params.line.priceUnavailableReason)}`,
    );
  }
  if (
    params.displayOptions.codexCredits &&
    params.lineTotals?.creditMicros !== undefined &&
    params.lineTotals.creditMicros > 0
  ) {
    const suffix = formatUsageLineCreditSuffix(params.line);
    estimates.push(
      `${formatCodexCredits(params.lineTotals.creditMicros)}${suffix ? ` ${suffix}` : ""}`,
    );
  }
  return estimates.length > 0 ? estimates.join(" · ") : undefined;
}

function formatUsageLineRunningTotal(params: {
  displayOptions: PricingDisplayOptions;
  line: PricingUsageLine;
  lineTotals: PricingRunningLineTotals | undefined;
}): string | undefined {
  // The fork-point card carries no incremental cost, so a running-total row on
  // it is noise — the attribution line already says it isn't charged here.
  if (isForkBaselineLine(params.line)) {
    return undefined;
  }
  const estimates: string[] = [];
  if (params.displayOptions.usd && params.lineTotals?.runningCostMicros !== undefined) {
    estimates.push(
      `${formatMoney(params.lineTotals.runningCostMicros, params.line.currency)} list price`,
    );
  }
  if (
    params.displayOptions.codexCredits &&
    params.lineTotals?.runningCreditMicros !== undefined &&
    params.lineTotals.runningCreditMicros > 0
  ) {
    estimates.push(formatCodexCredits(params.lineTotals.runningCreditMicros));
  }
  return estimates.length > 0
    ? `Running total: ${estimates.join(" · ")}${params.lineTotals?.runningHasEstimate ? " (includes estimates)" : ""}`
    : undefined;
}

function formatContextReplayEstimate(params: {
  displayOptions: PricingDisplayOptions;
  line: PricingUsageLine;
}): string[] {
  // Context replays are observed per turn: turn-scoped lines and sub-agent
  // ("monitor") lines both carry the tally the main process accumulated live.
  // Guarding on scope keeps total/backfill/gap rows from ever rendering replay
  // estimates even if they somehow carried the fields.
  if (
    (params.line.scope !== "turn" && params.line.scope !== "monitor") ||
    isEstimatedUsageGap(params.line) ||
    isHistoricalUsageSummary(params.line)
  ) {
    return [];
  }

  const lines: string[] = [];
  for (const label of ["cold", "hot"] as const) {
    const summary = readObservedReplaySummary(params.line, label);
    if (summary) {
      lines.push(
        formatObservedReplayLine({
          displayOptions: params.displayOptions,
          line: params.line,
          summary,
        }),
      );
    }
  }
  return lines;
}

type ObservedReplaySummary = {
  count: number;
  label: "cold" | "hot";
  tokenKind: "cached" | "uncached";
  tokens: number;
};

// Replay tallies come straight from the main-process accumulator on the usage
// line — one replay per model request in the turn, classified hot/cold from
// that request's cache split. Absent fields mean the turn was not observed
// live, so we render nothing rather than inventing a bucket estimate.
function readObservedReplaySummary(
  line: PricingUsageLine,
  label: "cold" | "hot",
): ObservedReplaySummary | undefined {
  const count =
    label === "cold" ? line.observedColdReplayCount : line.observedHotReplayCount;
  if (typeof count !== "number" || count <= 0) {
    return undefined;
  }
  const tokens =
    label === "cold"
      ? line.observedColdReplayUncachedTokens ?? 0
      : line.observedHotReplayCachedTokens ?? 0;
  return {
    count,
    label,
    tokenKind: label === "cold" ? "uncached" : "cached",
    tokens,
  };
}

function formatObservedReplayLine(params: {
  displayOptions: PricingDisplayOptions;
  line: PricingUsageLine;
  summary: ObservedReplaySummary;
}): string {
  const { count, tokenKind, tokens } = params.summary;
  const replayTokens =
    count > 1
      ? `~${formatTokenCount(Math.round(tokens / count))} ${tokenKind} avg; ${formatTokenCount(
          tokens,
        )} ${tokenKind} bucket`
      : `${formatTokenCount(tokens)} ${tokenKind}`;
  return `Estimated ${params.summary.label} context replays: ${count.toLocaleString()} (${replayTokens}${formatReplayCostEstimates(
    params,
  )})`;
}

function formatReplayCostEstimates(params: {
  displayOptions: PricingDisplayOptions;
  line: PricingUsageLine;
  summary: ObservedReplaySummary;
}): string {
  const estimates: string[] = [];
  if (params.displayOptions.usd) {
    const valueMicros = estimateReplayCostMicros(params);
    if (valueMicros > 0) {
      estimates.push(formatMoney(valueMicros, params.line.currency));
    }
  }
  if (params.displayOptions.codexCredits) {
    const credits = estimateContextReplayCodexCredits(params);
    if (credits !== undefined && credits > 0) {
      estimates.push(formatCodexCredits(credits));
    }
  }
  if (estimates.length === 0) {
    return "";
  }
  return ` · ${estimates.join(" · ")}`;
}

// Price the observed replay tokens as a fraction of the turn line's already-
// priced cached/uncached cost. The line's cached/uncached totals are the
// per-request sums across the turn, so the observed replay tokens are always a
// subset — the ratio attributes the share of the turn's input cost the replays
// account for.
function estimateReplayCostMicros(params: {
  line: PricingUsageLine;
  summary: ObservedReplaySummary;
}): number {
  const totalTokens =
    params.summary.tokenKind === "cached"
      ? params.line.cachedInputTokens
      : params.line.uncachedInputTokens;
  const totalMicros =
    params.summary.tokenKind === "cached"
      ? params.line.cachedInputCostMicros
      : params.line.uncachedInputCostMicros;
  if (totalTokens <= 0) {
    return 0;
  }
  if (params.summary.tokens >= totalTokens) {
    return totalMicros;
  }
  return Math.round((totalMicros * params.summary.tokens) / totalTokens);
}

function estimateContextReplayCodexCredits(params: {
  line: PricingUsageLine;
  summary: ObservedReplaySummary;
}): number | undefined {
  if (params.line.provider !== "openai") {
    return undefined;
  }
  const estimate = estimateOpenAiCodexCreditUsage({
    at: params.line.createdAt,
    cachedInputTokens:
      params.summary.tokenKind === "cached" ? params.summary.tokens : 0,
    fastMode: params.line.fastMode,
    model: params.line.model,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    serviceTier: params.line.serviceTier,
    uncachedInputTokens:
      params.summary.tokenKind === "uncached" ? params.summary.tokens : 0,
  });
  return estimate?.totalCreditMicros;
}

function formatUsageLineRunningTokens(line: ThreadUsageLineRecord): string | undefined {
  if (!hasCumulativeTokenBreakdown(line)) {
    return undefined;
  }
  const uncachedInputTokens = readCumulativeUncachedInputTokens(line);
  if (
    uncachedInputTokens === undefined ||
    line.cumulativeCachedInputTokens === undefined ||
    line.cumulativeOutputTokens === undefined
  ) {
    return undefined;
  }
  const tokens = [
    `${formatTokenCount(uncachedInputTokens)} uncached in`,
    `${formatTokenCount(line.cumulativeCachedInputTokens)} cached`,
    line.cumulativeReasoningOutputTokens && line.cumulativeReasoningOutputTokens > 0
      ? `${formatTokenCount(line.cumulativeOutputTokens)} out (${formatTokenCount(
          line.cumulativeReasoningOutputTokens,
        )} reasoning)`
      : `${formatTokenCount(line.cumulativeOutputTokens)} out`,
  ].join(" · ");
  return `Running tokens: ${tokens}`;
}

function hasCumulativeTokenBreakdown(line: ThreadUsageLineRecord): boolean {
  return (
    line.cumulativeCachedInputTokens !== undefined &&
    line.cumulativeOutputTokens !== undefined &&
    readCumulativeUncachedInputTokens(line) !== undefined
  );
}

function readCumulativeUncachedInputTokens(
  line: ThreadUsageLineRecord,
): number | undefined {
  if (line.cumulativeUncachedInputTokens !== undefined) {
    return line.cumulativeUncachedInputTokens;
  }
  if (
    line.cumulativeInputTokens !== undefined &&
    line.cumulativeCachedInputTokens !== undefined
  ) {
    return Math.max(0, line.cumulativeInputTokens - line.cumulativeCachedInputTokens);
  }
  return undefined;
}

function hasSelectedEstimateUnit(displayOptions: PricingDisplayOptions): boolean {
  return displayOptions.usd || displayOptions.codexCredits;
}

function formatUsageLineTitle(
  line: PricingUsageLine,
  subAgent?: PricingSubAgent,
): string {
  if (line.scope === "monitor") {
    if (subAgent) {
      return subAgentPricingUsageTitle(subAgent);
    }
    return line.sourceItemId?.startsWith("review:")
      ? "Review usage"
      : "Sub-agent usage";
  }
  if (isForkBaselineLine(line)) {
    return "Fork point";
  }
  if (isEstimatedUsageGap(line)) {
    return "Historical usage estimate";
  }
  if (isHistoricalUsageSummary(line)) {
    return "Historical usage summary";
  }
  if (line.scope === "latest-request") {
    return "Latest request usage";
  }
  return "Turn usage";
}

function formatUsageLineRuntimeLabel(
  line: PricingUsageLine,
  subAgent?: PricingSubAgent,
): string {
  if (subAgent?.backend) {
    return formatBackendLabel(subAgent.backend);
  }
  // Monitor rows are stored under their parent thread backend so its ledger
  // can aggregate them. Without a loaded sub-agent summary, the pricing
  // provider is the truthful runtime identity.
  return line.scope === "monitor"
    ? formatPricingProviderLabel(line.provider)
    : formatBackendLabel(line.backend as AppServerBackendKind);
}

function formatPricingProviderLabel(provider: string): string {
  switch (provider.toLocaleLowerCase()) {
    case "openai":
      return "OpenAI";
    case "qwen":
      return "Qwen";
    case "xai":
      return "xAI";
    default:
      return provider;
  }
}

function formatUsageLineCostSuffix(line: PricingUsageLine): string {
  if (isEstimatedUsageGap(line)) {
    return "estimated list price";
  }
  if (line.scope === "latest-request") {
    return "list price this request";
  }
  if (line.scope === "turn" && !isHistoricalUsageSummary(line)) {
    return "list price this turn";
  }
  return "list price";
}

function formatUsageLineCreditSuffix(line: PricingUsageLine): string {
  if (isEstimatedUsageGap(line)) {
    return "estimated";
  }
  if (line.scope === "latest-request") {
    return "this request";
  }
  if (line.scope === "turn" && !isHistoricalUsageSummary(line)) {
    return "this turn";
  }
  return "";
}





// A row is a whole-thread/historical summary when its scope says so, or when
// the live builder recorded that it could not attribute the usage to this turn
// (turnUsageAttributed === false) — e.g. a first observed event that carried a
// whole-thread total we couldn't decompose. Legacy rows predating the flag are
// backfilled by the state-db migration (user_version 26). No token-count guess.
function isHistoricalUsageSummary(line: ThreadUsageLineRecord): boolean {
  return (
    line.scope === "total" ||
    line.scope === "backfill" ||
    line.turnUsageAttributed === false
  );
}

// The in-progress turn: the live, still-pending turn row whose id matches the
// session's active turn. Drives the Running chip + live duration.


// A row is live if it's the main active turn OR a monitor row whose sub-agent
// is still running. Sub-agents run concurrently, so more than one row can be
// live at once (e.g. a fan-out of spawn_agent calls in a single turn).


function PricingUsageTimestamp(props: {
  isActive: boolean;
  line: ThreadUsageLineRecord;
  onScrollToTurn?: (turnId: string, turnTimeMs?: number) => void;
  subAgent?: PricingSubAgent;
}) {
  // Only this timestamp subscribes to the clock; completed cards stay static.
  const now = useNowWhileActive(props.isActive);
  const startedAt =
    props.subAgent?.createdAt ?? props.line.startedAt ?? props.line.createdAt;
  const completedAt =
    !props.isActive &&
    (isEstimatedUsageGap(props.line) || isHistoricalUsageSummary(props.line))
      ? undefined
      : props.subAgent !== undefined
        ? subAgentCompletedAt(props.subAgent)
        : props.line.completedAt;
  const timestamp = formatTimestamp(startedAt, { includeSeconds: true });
  const canScrollToTurn = Boolean(props.line.turnId && props.onScrollToTurn);

  return (
    <RailCardTiming
      completedAt={completedAt}
      now={now}
      running={props.isActive}
      startedAt={startedAt}
      {...(canScrollToTurn
        ? {
            onStartClick: () => {
              if (props.line.turnId) {
                props.onScrollToTurn?.(props.line.turnId, startedAt);
              }
            },
            startActionLabel: `Scroll the transcript to this turn (${timestamp})`,
            startActionTitle: "Scroll the transcript to this turn",
          }
        : {})}
    />
  );
}

function PricingUsageActions(props: {
  line: ThreadUsageLineRecord;
  onScrollToTurn?: (turnId: string, turnTimeMs?: number) => void;
  startedAt: number;
  subAgent?: PricingSubAgent;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<ChipContextMenuPosition>();
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const turnId = props.line.turnId ?? props.subAgent?.monitorTurnId;
  const threadId = props.line.threadId;
  const canScrollToTurn = Boolean(turnId && props.onScrollToTurn);
  const items: ChipContextMenuItem[] = [];

  if (canScrollToTurn && turnId) {
    items.push({
      action: () => props.onScrollToTurn?.(turnId, props.startedAt),
      label: "Go to Turn",
    });
  }
  if (turnId) {
    items.push({
      copyValue: turnId,
      label: "Copy Turn ID",
      separated: canScrollToTurn,
    });
  }
  items.push({
    copyValue: threadId,
    label: "Copy Thread ID",
    separated: !turnId && canScrollToTurn,
  });
  if (turnId) {
    items.push({
      copyValue: `Thread ID: ${threadId}\nTurn ID: ${turnId}`,
      label: "Copy Thread + Turn IDs",
    });
  }

  const openMenu = (): void => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }
    tooltip.hide();
    const rect = trigger.getBoundingClientRect();
    setPosition({
      anchorTop: rect.top,
      x: rect.right - 220,
      y: rect.bottom + 4,
    });
  };

  return (
    <>
      <button
        ref={triggerRef}
        aria-expanded={position !== undefined}
        aria-haspopup="menu"
        aria-label="Usage actions"
        className="pricing-usage-row__menu-trigger"
        type="button"
        onBlur={tooltip.hide}
        onClick={() => {
          if (position) {
            setPosition(undefined);
          } else {
            openMenu();
          }
        }}
        onFocus={(event) => tooltip.show(event.currentTarget, "Usage actions")}
        onMouseEnter={(event) =>
          tooltip.show(event.currentTarget, "Usage actions")
        }
        onMouseLeave={tooltip.hide}
      >
        <MoreVerticalIcon size={15} aria-hidden="true" />
      </button>
      {position && triggerRef.current ? (
        <ChipContextMenu
          items={items}
          onClose={() => setPosition(undefined)}
          position={position}
          returnFocusTo={triggerRef.current}
        />
      ) : null}
      {tooltip.tooltipNode}
    </>
  );
}



function formatMoney(valueMicros: number, currency: string): string {
  if (currency === "USD") {
    return formatTokenUsageMicrosAsUsd(valueMicros);
  }
  return `${currency} ${(valueMicros / 1_000_000).toFixed(4)}`;
}







function formatCodexCredits(valueMicros: number): string {
  if (valueMicros <= 0) {
    return "0 Codex Credits";
  }
  const value = valueMicros / 1_000_000;
  if (value < 0.05) {
    return "<0.1 Codex Credits";
  }
  if (value >= 10) {
    return `${new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 0,
    }).format(value)} Codex Credits`;
  }
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
  }).format(value)} Codex Credits`;
}

function formatUnpricedReason(
  reason: ThreadUsageLineRecord["priceUnavailableReason"],
): string {
  switch (reason) {
    case "missing-model":
      return "missing model";
    case "missing-rate":
      return "missing rate";
    case "unsupported-service-tier":
      return "unsupported service tier";
    case "insufficient-token-breakdown":
      return "insufficient token breakdown";
    default:
      return "unknown reason";
  }
}
