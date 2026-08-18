import type {
  AppServerBackendKind,
  ThreadCompactionRecord,
  ThreadPricingSummary,
  ThreadSubAgentSummary,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import {
  estimateOpenAiCodexCreditUsage,
  estimateTokenUsageCost,
  formatTokenUsageMicrosAsUsd,
} from "@pwragent/shared";
import { useMemo, useRef, useState } from "react";
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
  isTerminalSubAgent,
  subAgentCompletedAt,
} from "./subagent-format";
import {
  formatCompactCount,
  formatTimestamp,
  RailSummaryRow,
} from "./context-rail-shared";
import { RailStatusChip } from "./RailStatusChip";
import { subAgentPricingUsageTitle } from "./subagent-kind";
import { RailCardTiming, useNowWhileActive } from "./RailCardTiming";
import { TokenMiserSavingsBreakdown } from "./TokenMiserSavingsBreakdown";

type PricingPanelProps = {
  activeTurnId?: string;
  displayOptions?: PricingDisplayOptions;
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
  threadReasoningEffort?: string;
};

type PricingDisplayOptions = {
  codexCredits: boolean;
  usd: boolean;
};

type PricingUsageLine = ThreadUsageLineRecord & {
  estimatedUsageGap?: true;
};

const DEFAULT_PRICING_DISPLAY_OPTIONS: PricingDisplayOptions = {
  codexCredits: false,
  usd: true,
};
const PRICING_USAGE_PAGE_SIZE = 20;

export function PricingPanel(props: PricingPanelProps) {
  const summaries = props.pricing?.summaries ?? [];
  const lines = props.pricing?.lines ?? [];
  const allDisplayLines = buildPricingDisplayLines(lines);
  const subAgentsById = new Map(
    (props.subAgents ?? []).map((subAgent) => [subAgent.monitorId, subAgent]),
  );
  // Gate rows nest under the turn they happened in. Left in the flat list they
  // sort *above* their turn — a gate is created mid-turn, after the turn's
  // first usage flush — and each one is a full card, so a turn with 25 gates
  // pushed its own row a screen below the noise it produced.
  const { gateLinesByTurn, displayLines, orphanGroupsByAnchor } =
    partitionTokenMiserGateLines(allDisplayLines, subAgentsById);
  const pricingHistoryKey = summaries[0]
    ? `${summaries[0].backend}:${summaries[0].threadId}`
    : displayLines[0]
      ? `${displayLines[0].backend}:${displayLines[0].threadId}`
      : "empty";
  const [usagePage, setUsagePage] = useState({
    count: PRICING_USAGE_PAGE_SIZE,
    key: pricingHistoryKey,
  });
  const visibleUsageRowCount =
    usagePage.key === pricingHistoryKey
      ? usagePage.count
      : PRICING_USAGE_PAGE_SIZE;
  const visibleDisplayLines = displayLines.slice(0, visibleUsageRowCount);
  const hiddenUsageRowCount = displayLines.length - visibleDisplayLines.length;
  const estimatedLines = allDisplayLines.filter(isEstimatedUsageGap);
  const displaySummaries = addEstimatedLinesToSummaries(summaries, estimatedLines);
  const summary =
    aggregateSummaries(displaySummaries) ?? aggregateUsageLines(allDisplayLines);
  const displayOptions = props.displayOptions ?? DEFAULT_PRICING_DISPLAY_OPTIONS;
  // Totals run over every line, nested gates included: a gate's helper cost is
  // still part of the running total of every turn after it.
  const pricingTotals = buildPricingRunningTotals(allDisplayLines);
  const activeTurnId = props.activeTurnId;
  const hasActiveRow = allDisplayLines.some((line) =>
    isActiveUsageLine({ activeTurnId, line, subAgentsById }),
  );
  // Tick while any row is live — the main turn or any still-running sub-agent —
  // so completed threads render static and never spin a 1s interval.
  const now = useNowWhileActive(hasActiveRow);
  const compactionsByRow = useMemo(
    () => groupCompactionsByRow(props.pricing?.compactions ?? []),
    [props.pricing?.compactions],
  );
  // Rebuilt per render alongside the row map: rows are laid out newest-first in
  // one pass, so the first row of a turn claims that turn's pending markers.
  const claimedCompactionTurns = new Set<string>();

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
            <div className="rail-summary-card__section">
              <span className="rail-summary-card__section-title">Token volume</span>
              <RailSummaryRow
                label="Uncached input"
                value={formatCompactCount(summary.uncachedInputTokens)}
              />
              <RailSummaryRow
                label="Cached input"
                value={formatCompactCount(summary.cachedInputTokens)}
              />
              <RailSummaryRow
                label="Output"
                value={formatCompactCount(summary.outputTokens)}
              />
              {summary.reasoningOutputTokens > 0 ? (
                <RailSummaryRow
                  label="Reasoning"
                  value={formatCompactCount(summary.reasoningOutputTokens)}
                />
              ) : null}
            </div>
            {displaySummaries.length > 1 ? (
              <div className="rail-summary-card__section">
                <span className="rail-summary-card__section-title">By provider</span>
                {displaySummaries.map((providerSummary) => (
                  <RailSummaryRow
                    key={`${providerSummary.provider}:${providerSummary.currency}`}
                    label={formatPricingProviderLabel(providerSummary.provider)}
                    value={`${formatMoney(
                      providerSummary.totalCostMicros,
                      providerSummary.currency,
                    )} · ${providerSummary.usageLineCount.toLocaleString()} row${
                      providerSummary.usageLineCount === 1 ? "" : "s"
                    }`}
                  />
                ))}
              </div>
            ) : null}
          </div>
          {summary.unpricedUsageLineCount > 0 ? (
            <p className="context-empty context-empty--warning">
              {summary.unpricedUsageLineCount.toLocaleString()} usage row
              {summary.unpricedUsageLineCount === 1 ? "" : "s"} could not be priced.
            </p>
          ) : null}
          {displaySummaries.length > 1 ? (
            <ul className="context-list context-list--cards pricing-provider-list">
              {displaySummaries.map((providerSummary) => (
                <li
                  key={`${providerSummary.provider}:${providerSummary.currency}`}
                  className="rail-card pricing-provider-row"
                >
                  <p className="rail-card__title">
                    {providerSummary.provider} · {providerSummary.currency}
                  </p>
                  <p className="rail-card__usage">
                    {formatMoney(
                      providerSummary.totalCostMicros,
                      providerSummary.currency,
                    )}{" "}
                    list price · {providerSummary.usageLineCount.toLocaleString()} row
                    {providerSummary.usageLineCount === 1 ? "" : "s"}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : displayLines.length === 0 ? (
        <p className="context-empty">No usage pricing recorded yet.</p>
      ) : null}

      {displayLines.length > 0 ? (
        <ul className="context-list context-list--cards pricing-usage-list">
          {visibleDisplayLines.map((line) => {
            const orphanGroup = orphanGroupsByAnchor.get(line.usageLineId);
            if (orphanGroup) {
              // A gate with no turn to nest under is either the compact group
              // or nothing. Full cards for gates that cannot be priced were
              // pure noise — the summarizer's cost is still in the totals, and
              // the Explorer still lists every gate.
              const anyPriced = orphanGroup.some((gate) =>
                gate.sourceItemId
                && subAgentsById.get(gate.sourceItemId)?.tokenMiserAccounting,
              );
              return anyPriced ? (
                <li
                  key={line.usageLineId}
                  className="rail-card pricing-usage-row pricing-usage-row--orphan-gates"
                >
                  <TokenMiserTurnGroup
                    gates={orphanGroup}
                    subAgentsById={subAgentsById}
                  />
                </li>
              ) : null;
            }
            const lineTotals = pricingTotals.byLineId.get(line.usageLineId);
            const usageLineEstimate = formatUsageLineEstimates({
              displayOptions,
              line,
              lineTotals,
            });
            const runningTotal = formatUsageLineRunningTotal({
              displayOptions,
              line,
              lineTotals,
            });
            const contextReplayLines = formatContextReplayEstimate({
              displayOptions,
              line,
            });
            const rowCompactions = selectRowCompactions(
              compactionsByRow,
              line,
              claimedCompactionTurns,
            );
            const runningTokens = formatUsageLineRunningTokens(line);
            const subAgent =
              line.scope === "monitor" && line.sourceItemId
                ? subAgentsById.get(line.sourceItemId)
                : undefined;
            const nestedGates = line.scope !== "monitor" && line.turnId
              ? (gateLinesByTurn.get(line.turnId) ?? [])
              : [];
            const isActive = isActiveUsageLine({ activeTurnId, line, subAgentsById });
            const usageTitle = formatUsageLineTitle(line, subAgent);
            const showUsageTitle = usageTitle !== "Turn usage";
            const reasoningEffort =
              line.reasoningEffort
              ?? subAgent?.preferredReasoningEffort
              ?? (isActive && line.scope !== "monitor"
                ? props.threadReasoningEffort
                : undefined);
            const runtimeLabel = formatUsageLineRuntimeLabel(line, subAgent);
            const runtimeModel =
              line.model
              ?? subAgent?.preferredModel
              ?? subAgent?.monitorUsage?.model
              ?? subAgent?.monitorUsage?.cost?.model;

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
                {subAgent?.agentName ? (
                  <p className="rail-card__agent-name" title={subAgent.agentName}>
                    {subAgent.agentName}
                  </p>
                ) : null}
                {/* Cost first: it is the answer the card exists to give. Tokens,
                    timing and replay estimates are the working shown under it. */}
                {usageLineEstimate ? (
                  <p className="pricing-usage-row__cost">{usageLineEstimate}</p>
                ) : null}
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
                  now={now}
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
                {nestedGates.length > 0 ? (
                  <TokenMiserTurnGroup
                    gates={nestedGates}
                    subAgentsById={subAgentsById}
                  />
                ) : null}
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
          })}
        </ul>
      ) : null}
      {hiddenUsageRowCount > 0 ? (
        <div className="pricing-usage-list__pagination">
          <p className="pricing-usage-list__status">
            Showing latest {visibleDisplayLines.length.toLocaleString()} of{" "}
            {displayLines.length.toLocaleString()} usage rows.
          </p>
          <button
            className="button button--ghost pricing-usage-list__more"
            type="button"
            onClick={() => {
              setUsagePage({
                count: Math.min(
                  displayLines.length,
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
}

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
 * A gate below this saved (or cost) too little to earn its own card. Its
 * dollars still count in the turn's summary line; only the card is withheld.
 * Ten cents is where a card stops being noise: below it the equation reads as
 * rounding, above it the reader can see which term moved.
 */
const TOKEN_MISER_CARD_MIN_MICROS = 100_000;

const TOKEN_MISER_SOURCE_PREFIX = "system:token-miser:";

function isTokenMiserGateLine(line: PricingUsageLine): boolean {
  return line.scope === "monitor"
    && Boolean(line.sourceItemId?.startsWith(TOKEN_MISER_SOURCE_PREFIX));
}

/**
 * Split gate rows out of the flat list and attach each to its parent turn.
 *
 * A gate whose parent turn has no row of its own — a native review's inner
 * turn, or a turn whose usage has not landed yet — stays in the flat list, so
 * it is still visible rather than silently dropped.
 */
function partitionTokenMiserGateLines(
  lines: readonly PricingUsageLine[],
  subAgentsById: Map<string, ThreadSubAgentSummary>,
): {
  displayLines: PricingUsageLine[];
  gateLinesByTurn: Map<string, PricingUsageLine[]>;
  /**
   * Gates with no turn row to nest under — a native review's inner turn, or a
   * turn whose usage has not landed yet — grouped by parent turn and keyed by
   * the usage line they should render in place of, so the group keeps the
   * position of its newest gate rather than surfacing as N loose cards.
   */
  orphanGroupsByAnchor: Map<string, PricingUsageLine[]>;
} {
  const turnRowIds = new Set<string>();
  for (const line of lines) {
    if (!isTokenMiserGateLine(line) && line.scope !== "monitor" && line.turnId) {
      turnRowIds.add(line.turnId);
    }
  }
  const gateLinesByTurn = new Map<string, PricingUsageLine[]>();
  const orphansByTurn = new Map<string, PricingUsageLine[]>();
  const displayLines: PricingUsageLine[] = [];
  const push = (map: Map<string, PricingUsageLine[]>, key: string, line: PricingUsageLine) => {
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(line);
    } else {
      map.set(key, [line]);
    }
  };
  for (const line of lines) {
    if (!isTokenMiserGateLine(line)) {
      displayLines.push(line);
      continue;
    }
    const parentTurnId = line.sourceItemId
      ? subAgentsById.get(line.sourceItemId)?.parentTurnId
      : undefined;
    if (parentTurnId && turnRowIds.has(parentTurnId)) {
      push(gateLinesByTurn, parentTurnId, line);
      continue;
    }
    // No parent turn known at all (a gate persisted before parentTurnId
    // existed) groups under its own id, so it still gets the compact form.
    push(orphansByTurn, parentTurnId ?? `gate:${line.usageLineId}`, line);
  }
  // Lines are newest-first; the first gate seen in each orphan group is its
  // anchor. It stays in the flat list as a placeholder the renderer swaps for
  // the group.
  const orphanGroupsByAnchor = new Map<string, PricingUsageLine[]>();
  for (const gates of orphansByTurn.values()) {
    const anchor = gates[0]!;
    orphanGroupsByAnchor.set(anchor.usageLineId, gates);
    displayLines.push(anchor);
  }
  displayLines.sort(compareUsageLinesDescending);
  return { displayLines, gateLinesByTurn, orphanGroupsByAnchor };
}

/**
 * The turn's Token Miser story, folded under the turn it belongs to.
 *
 * The summary line sums every gate — it is what the turn saved, and it keeps
 * moving as replays are counted, until the next compaction. The expanded list
 * shows a card only for gates past the threshold; the rest are one line, so a
 * turn with twenty-five gates that each saved half a cent reads as one fact.
 */
function TokenMiserTurnGroup(props: {
  gates: readonly PricingUsageLine[];
  subAgentsById: Map<string, ThreadSubAgentSummary>;
}) {
  const [expanded, setExpanded] = useState(false);
  const entries = props.gates.map((line) => ({
    accounting: line.sourceItemId
      ? props.subAgentsById.get(line.sourceItemId)?.tokenMiserAccounting
      : undefined,
    line,
    startedAt: line.sourceItemId
      ? props.subAgentsById.get(line.sourceItemId)?.createdAt
      : undefined,
  }));
  const priced = entries.filter((entry) => entry.accounting !== undefined);
  const savingsMicros = priced.reduce(
    (total, entry) => total + (entry.accounting?.savingsMicros ?? 0),
    0,
  );
  const gateCostMicros = props.gates.reduce(
    (total, line) => total + line.totalCostMicros,
    0,
  );
  const carded = priced.filter((entry) =>
    Math.abs(entry.accounting?.savingsMicros ?? 0) >= TOKEN_MISER_CARD_MIN_MICROS
  );
  const foldedCount = entries.length - carded.length;
  const foldedMicros = priced
    .filter((entry) => !carded.includes(entry))
    .reduce((total, entry) => total + (entry.accounting?.savingsMicros ?? 0), 0);
  const unpricedCount = entries.length - priced.length;
  const count = props.gates.length;
  const verdict = priced.length === 0
    ? `${formatTokenUsageMicrosAsUsd(gateCostMicros)} summarizing · savings not priced yet`
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
        <span className="pricing-token-miser__count">
          {count.toLocaleString()} {count === 1 ? "gate" : "gates"}
        </span>
        <span className="pricing-token-miser__verdict" data-negative={savingsMicros < 0}>
          {verdict}
        </span>
      </button>
      {expanded ? (
        <div className="pricing-token-miser__body">
          {carded.map((entry) => (
            <div className="pricing-token-miser__gate" key={entry.line.usageLineId}>
              <p className="pricing-token-miser__gate-when">
                {entry.startedAt !== undefined
                  ? formatTimestamp(entry.startedAt)
                  : formatTimestamp(entry.line.createdAt)}
              </p>
              {entry.accounting ? (
                <TokenMiserSavingsBreakdown accounting={entry.accounting} />
              ) : null}
            </div>
          ))}
          {foldedCount > 0 || unpricedCount > 0 ? (
            <p className="pricing-token-miser__folded">
              {foldedCount > 0
                ? `${foldedCount.toLocaleString()} ${foldedCount === 1 ? "gate" : "gates"} under `
                  + `${formatTokenUsageMicrosAsUsd(TOKEN_MISER_CARD_MIN_MICROS)} each · `
                  + `${formatTokenUsageMicrosAsUsd(Math.abs(foldedMicros))} `
                  + `${foldedMicros >= 0 ? "saved" : "overhead"} between them`
                : ""}
              {foldedCount > 0 && unpricedCount > 0 ? " · " : ""}
              {unpricedCount > 0
                ? `${unpricedCount.toLocaleString()} not priced yet`
                : ""}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const COMPACTION_TURN_KEY_PREFIX = "turn:";

/**
 * Bucket compactions by the usage row that should show them.
 *
 * A compaction whose cold replay has been claimed belongs to that exact row —
 * that request is the one that re-sent the surviving context uncached. One that
 * has not been claimed yet falls back to its turn, so a compaction observed
 * mid-turn is still visible before the request after it is priced.
 */
function groupCompactionsByRow(
  compactions: readonly ThreadCompactionRecord[],
): Map<string, ThreadCompactionRecord[]> {
  const grouped = new Map<string, ThreadCompactionRecord[]>();
  for (const compaction of compactions) {
    const key = compaction.coldUsageLineId
      ?? (compaction.turnId
        ? `${COMPACTION_TURN_KEY_PREFIX}${compaction.turnId}`
        : undefined);
    if (!key) {
      continue;
    }
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(compaction);
    } else {
      grouped.set(key, [compaction]);
    }
  }
  return grouped;
}

// A row claims its directly-attributed compactions plus any of its turn's
// still-unattributed ones. Sub-agent rows are excluded: compaction is a
// property of the parent thread's context, not of a monitor's own usage.
function selectRowCompactions(
  grouped: Map<string, ThreadCompactionRecord[]>,
  line: PricingUsageLine,
  claimedTurnKeys: Set<string>,
): ThreadCompactionRecord[] {
  if (grouped.size === 0 || line.scope === "monitor") {
    return [];
  }
  const attributed = grouped.get(line.usageLineId) ?? [];
  // Unattributed markers are claimed by one row per turn, not every row in it.
  // A turn routinely has several usage lines, and showing the pending marker on
  // each of them read as several compactions rather than one.
  const turnKey = line.turnId
    ? `${COMPACTION_TURN_KEY_PREFIX}${line.turnId}`
    : undefined;
  const pending = turnKey && !claimedTurnKeys.has(turnKey)
    ? (grouped.get(turnKey) ?? [])
    : [];
  if (turnKey && pending.length > 0) {
    claimedTurnKeys.add(turnKey);
  }
  return [...attributed, ...pending];
}

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

function buildPricingDisplayLines(lines: ThreadUsageLineRecord[]): PricingUsageLine[] {
  const chronologicalLines = [...lines].sort(compareUsageLinesAscending);
  const displayLines: PricingUsageLine[] = [];
  let accountedMainTokens = emptyPricingTokenBreakdown();

  for (const line of chronologicalLines) {
    if (!isMainThreadUsageLine(line)) {
      displayLines.push(line);
      continue;
    }

    const cumulativeTokens = readCumulativeTokenBreakdown(line);
    const lineTokens = tokenBreakdownFromUsageLine(line);
    const gapTokens = cumulativeTokens
      ? subtractPricingTokenBreakdowns(
          cumulativeTokens,
          addPricingTokenBreakdowns(accountedMainTokens, lineTokens),
        )
      : emptyPricingTokenBreakdown();
    const gapLine = hasPricingTokenBreakdownValue(gapTokens)
      ? buildEstimatedHistoricalGapLine({
          anchorLine: line,
          gapTokens,
        })
      : undefined;
    if (gapLine) {
      displayLines.push(gapLine);
      accountedMainTokens = addPricingTokenBreakdowns(accountedMainTokens, gapTokens);
    }

    displayLines.push(line);
    accountedMainTokens = cumulativeTokens
      ? maxPricingTokenBreakdowns(
          addPricingTokenBreakdowns(accountedMainTokens, lineTokens),
          cumulativeTokens,
        )
      : addPricingTokenBreakdowns(accountedMainTokens, lineTokens);
  }

  return displayLines.sort(compareUsageLinesDescending);
}

function addEstimatedLinesToSummaries(
  summaries: ThreadPricingSummary[],
  estimatedLines: PricingUsageLine[],
): ThreadPricingSummary[] {
  if (summaries.length === 0 || estimatedLines.length === 0) {
    return summaries;
  }

  const byKey = new Map<string, ThreadPricingSummary>();
  for (const summary of summaries) {
    byKey.set(summaryKey(summary), { ...summary });
  }
  for (const line of estimatedLines) {
    const key = usageLineSummaryKey(line);
    const existing =
      byKey.get(key) ??
      ({
        backend: line.backend,
        cachedInputTokens: 0,
        currency: line.currency,
        inputTokens: 0,
        outputTokens: 0,
        pricedUsageLineCount: 0,
        provider: line.provider,
        reasoningOutputTokens: 0,
        threadId: line.parentThreadId ?? line.threadId,
        totalCostMicros: 0,
        totalTokens: 0,
        uncachedInputTokens: 0,
        unpricedUsageLineCount: 0,
        updatedAt: 0,
        usageLineCount: 0,
      } satisfies ThreadPricingSummary);
    byKey.set(key, addUsageLineToSummary(existing, line));
  }
  return [...byKey.values()].sort((left, right) => {
    const providerCompare = left.provider.localeCompare(right.provider);
    return providerCompare !== 0
      ? providerCompare
      : left.currency.localeCompare(right.currency);
  });
}

function aggregateUsageLines(lines: PricingUsageLine[]): ThreadPricingSummary | undefined {
  if (lines.length === 0) {
    return undefined;
  }
  const firstLine = lines[0];
  return lines.reduce<ThreadPricingSummary>(
    (summary, line) => addUsageLineToSummary(summary, line),
    {
      backend: firstLine.backend,
      cachedInputTokens: 0,
      currency: firstLine.currency,
      inputTokens: 0,
      outputTokens: 0,
      pricedUsageLineCount: 0,
      provider: firstLine.provider,
      reasoningOutputTokens: 0,
      threadId: firstLine.threadId,
      totalCostMicros: 0,
      totalTokens: 0,
      uncachedInputTokens: 0,
      unpricedUsageLineCount: 0,
      updatedAt: 0,
      usageLineCount: 0,
    },
  );
}

type PricingTokenBreakdown = {
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  uncachedInputTokens: number;
};

function addUsageLineToSummary(
  summary: ThreadPricingSummary,
  line: PricingUsageLine,
): ThreadPricingSummary {
  return {
    backend: summary.backend,
    cachedInputTokens: summary.cachedInputTokens + line.cachedInputTokens,
    currency: summary.currency,
    inputTokens: summary.inputTokens + line.inputTokens,
    outputTokens: summary.outputTokens + line.outputTokens,
    pricedUsageLineCount:
      summary.pricedUsageLineCount + (line.priceStatus === "priced" ? 1 : 0),
    provider: summary.provider,
    reasoningOutputTokens:
      summary.reasoningOutputTokens + line.reasoningOutputTokens,
    threadId: summary.threadId,
    totalCostMicros: summary.totalCostMicros + line.totalCostMicros,
    totalTokens: summary.totalTokens + line.totalTokens,
    uncachedInputTokens: summary.uncachedInputTokens + line.uncachedInputTokens,
    unpricedUsageLineCount:
      summary.unpricedUsageLineCount + (line.priceStatus === "priced" ? 0 : 1),
    updatedAt: Math.max(summary.updatedAt, line.completedAt ?? line.createdAt),
    usageLineCount: summary.usageLineCount + 1,
  };
}

function summaryKey(summary: ThreadPricingSummary): string {
  return [
    summary.backend,
    summary.threadId,
    summary.provider,
    summary.currency,
  ].join(":");
}

function usageLineSummaryKey(line: PricingUsageLine): string {
  return [
    line.backend,
    line.parentThreadId ?? line.threadId,
    line.provider,
    line.currency,
  ].join(":");
}

function compareUsageLinesAscending(
  left: ThreadUsageLineRecord,
  right: ThreadUsageLineRecord,
): number {
  const leftTimestamp = lineSortTimestamp(left);
  const rightTimestamp = lineSortTimestamp(right);
  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }
  return left.usageLineId.localeCompare(right.usageLineId);
}

function compareUsageLinesDescending(
  left: ThreadUsageLineRecord,
  right: ThreadUsageLineRecord,
): number {
  const leftTimestamp = lineSortTimestamp(left);
  const rightTimestamp = lineSortTimestamp(right);
  if (leftTimestamp !== rightTimestamp) {
    return rightTimestamp - leftTimestamp;
  }
  return right.usageLineId.localeCompare(left.usageLineId);
}

function lineSortTimestamp(line: ThreadUsageLineRecord): number {
  return line.startedAt ?? line.createdAt;
}

function emptyPricingTokenBreakdown(): PricingTokenBreakdown {
  return {
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    uncachedInputTokens: 0,
  };
}

function tokenBreakdownFromUsageLine(
  line: ThreadUsageLineRecord,
): PricingTokenBreakdown {
  return {
    cachedInputTokens: Math.max(0, line.cachedInputTokens),
    outputTokens: Math.max(0, line.outputTokens),
    reasoningOutputTokens: Math.max(0, line.reasoningOutputTokens),
    uncachedInputTokens: Math.max(0, line.uncachedInputTokens),
  };
}

function readCumulativeTokenBreakdown(
  line: ThreadUsageLineRecord,
): PricingTokenBreakdown | undefined {
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
  return {
    cachedInputTokens: Math.max(0, line.cumulativeCachedInputTokens),
    outputTokens: Math.max(0, line.cumulativeOutputTokens),
    reasoningOutputTokens: Math.max(0, line.cumulativeReasoningOutputTokens ?? 0),
    uncachedInputTokens: Math.max(0, uncachedInputTokens),
  };
}

function addPricingTokenBreakdowns(
  left: PricingTokenBreakdown,
  right: PricingTokenBreakdown,
): PricingTokenBreakdown {
  return {
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens:
      left.reasoningOutputTokens + right.reasoningOutputTokens,
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
  };
}

function subtractPricingTokenBreakdowns(
  left: PricingTokenBreakdown,
  right: PricingTokenBreakdown,
): PricingTokenBreakdown {
  return {
    cachedInputTokens: Math.max(0, left.cachedInputTokens - right.cachedInputTokens),
    outputTokens: Math.max(0, left.outputTokens - right.outputTokens),
    reasoningOutputTokens: Math.max(
      0,
      left.reasoningOutputTokens - right.reasoningOutputTokens,
    ),
    uncachedInputTokens: Math.max(
      0,
      left.uncachedInputTokens - right.uncachedInputTokens,
    ),
  };
}

function maxPricingTokenBreakdowns(
  left: PricingTokenBreakdown,
  right: PricingTokenBreakdown,
): PricingTokenBreakdown {
  return {
    cachedInputTokens: Math.max(left.cachedInputTokens, right.cachedInputTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
    reasoningOutputTokens: Math.max(
      left.reasoningOutputTokens,
      right.reasoningOutputTokens,
    ),
    uncachedInputTokens: Math.max(
      left.uncachedInputTokens,
      right.uncachedInputTokens,
    ),
  };
}

function hasPricingTokenBreakdownValue(tokens: PricingTokenBreakdown): boolean {
  return (
    tokens.cachedInputTokens > 0 ||
    tokens.outputTokens > 0 ||
    tokens.reasoningOutputTokens > 0 ||
    tokens.uncachedInputTokens > 0
  );
}

function isMainThreadUsageLine(line: ThreadUsageLineRecord): boolean {
  return line.scope !== "monitor";
}

function buildEstimatedHistoricalGapLine(params: {
  anchorLine: ThreadUsageLineRecord;
  gapTokens: PricingTokenBreakdown;
}): PricingUsageLine | undefined {
  const cost = estimateTokenUsageCost({
    at: params.anchorLine.createdAt,
    cachedInputTokens: params.gapTokens.cachedInputTokens,
    fastMode: false,
    model: params.anchorLine.model,
    outputTokens: params.gapTokens.outputTokens,
    reasoningOutputTokens: params.gapTokens.reasoningOutputTokens,
    serviceTier: "standard",
    uncachedInputTokens: params.gapTokens.uncachedInputTokens,
  });
  const inputTokens =
    params.gapTokens.cachedInputTokens + params.gapTokens.uncachedInputTokens;
  const totalTokens =
    inputTokens +
    params.gapTokens.outputTokens +
    params.gapTokens.reasoningOutputTokens;
  const priceUnavailableReason: ThreadUsageLineRecord["priceUnavailableReason"] | undefined =
    cost ? undefined : params.anchorLine.model ? "missing-rate" : "missing-model";

  return {
    backend: params.anchorLine.backend,
    cachedInputCostMicros: cost?.cachedInputCostMicros ?? 0,
    cachedInputTokens: params.gapTokens.cachedInputTokens,
    createdAt: Math.max(0, lineSortTimestamp(params.anchorLine) - 1),
    currency: cost?.currency ?? params.anchorLine.currency,
    estimatedUsageGap: true,
    inputTokens,
    model: params.anchorLine.model,
    outputCostMicros: cost?.outputCostMicros ?? 0,
    outputTokens: params.gapTokens.outputTokens,
    parentThreadId: params.anchorLine.parentThreadId,
    priceStatus: cost ? "priced" : "unpriced",
    ...(priceUnavailableReason ? { priceUnavailableReason } : {}),
    provider: cost?.provider ?? params.anchorLine.provider,
    ...(cost?.catalogId ? { pricingCatalogId: cost.catalogId } : {}),
    ...(cost?.catalogVersion ? { pricingCatalogVersion: cost.catalogVersion } : {}),
    ...(cost?.rateId ? { pricingRateId: cost.rateId } : {}),
    reasoningEffort: params.anchorLine.reasoningEffort,
    reasoningOutputTokens: params.gapTokens.reasoningOutputTokens,
    scope: "backfill",
    serviceTier: "standard",
    settingsConfidence: "fallback",
    settingsSource: "observed-settings",
    source: "backfill",
    sourceItemId: `estimated-gap:${params.anchorLine.usageLineId}`,
    status: "finalized",
    threadId: params.anchorLine.threadId,
    totalCostMicros: cost?.totalCostMicros ?? 0,
    totalTokens,
    uncachedInputCostMicros: cost?.uncachedInputCostMicros ?? 0,
    uncachedInputTokens: params.gapTokens.uncachedInputTokens,
    usageLineId: `estimated-gap:${params.anchorLine.usageLineId}`,
    usageTurnId: `estimated-gap:${params.anchorLine.usageTurnId ?? params.anchorLine.usageLineId}`,
  };
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
  subAgent?: ThreadSubAgentSummary,
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
  subAgent?: ThreadSubAgentSummary,
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

function isEstimatedUsageGap(line: ThreadUsageLineRecord): boolean {
  return "estimatedUsageGap" in line && line.estimatedUsageGap === true;
}

function isForkBaselineLine(line: ThreadUsageLineRecord): boolean {
  return line.scope === "fork-baseline";
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
function isActiveLiveTurnUsageLine(params: {
  activeTurnId?: string;
  line: PricingUsageLine;
}): boolean {
  return (
    params.line.scope === "turn" &&
    params.line.source === "live" &&
    Boolean(params.activeTurnId) &&
    params.line.turnId === params.activeTurnId
  );
}

// A row is live if it's the main active turn OR a monitor row whose sub-agent
// is still running. Sub-agents run concurrently, so more than one row can be
// live at once (e.g. a fan-out of spawn_agent calls in a single turn).
function isActiveUsageLine(params: {
  activeTurnId?: string;
  line: PricingUsageLine;
  subAgentsById: Map<string, ThreadSubAgentSummary>;
}): boolean {
  if (
    isActiveLiveTurnUsageLine({
      activeTurnId: params.activeTurnId,
      line: params.line,
    })
  ) {
    return true;
  }
  if (params.line.scope !== "monitor" || !params.line.sourceItemId) {
    return false;
  }
  const subAgent = params.subAgentsById.get(params.line.sourceItemId);
  return Boolean(subAgent && !isTerminalSubAgent(subAgent));
}

function PricingUsageTimestamp(props: {
  isActive: boolean;
  line: ThreadUsageLineRecord;
  now: number;
  onScrollToTurn?: (turnId: string, turnTimeMs?: number) => void;
  subAgent?: ThreadSubAgentSummary;
}) {
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
      now={props.now}
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
  subAgent?: ThreadSubAgentSummary;
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

function aggregateSummaries(
  summaries: ThreadPricingSummary[],
): ThreadPricingSummary | undefined {
  if (summaries.length === 0) {
    return undefined;
  }
  const [first, ...rest] = summaries;
  if (!first) {
    return undefined;
  }
  if (rest.some((summary) => summary.currency !== first.currency)) {
    return first;
  }
  return rest.reduce<ThreadPricingSummary>(
    (acc, summary) => ({
      ...acc,
      cachedInputTokens: acc.cachedInputTokens + summary.cachedInputTokens,
      inputTokens: acc.inputTokens + summary.inputTokens,
      outputTokens: acc.outputTokens + summary.outputTokens,
      pricedUsageLineCount:
        acc.pricedUsageLineCount + summary.pricedUsageLineCount,
      provider: summaries.length === 1 ? acc.provider : "multiple",
      reasoningOutputTokens:
        acc.reasoningOutputTokens + summary.reasoningOutputTokens,
      totalCostMicros: acc.totalCostMicros + summary.totalCostMicros,
      totalTokens: acc.totalTokens + summary.totalTokens,
      uncachedInputTokens:
        acc.uncachedInputTokens + summary.uncachedInputTokens,
      unpricedUsageLineCount:
        acc.unpricedUsageLineCount + summary.unpricedUsageLineCount,
      updatedAt: Math.max(acc.updatedAt, summary.updatedAt),
      usageLineCount: acc.usageLineCount + summary.usageLineCount,
    }),
    { ...first },
  );
}

function formatMoney(valueMicros: number, currency: string): string {
  if (currency === "USD") {
    return formatTokenUsageMicrosAsUsd(valueMicros);
  }
  return `${currency} ${(valueMicros / 1_000_000).toFixed(4)}`;
}

type PricingRunningLineTotals = {
  creditMicros?: number;
  runningHasEstimate?: boolean;
  runningCostMicros: number;
  runningCreditMicros?: number;
};

function buildPricingRunningTotals(lines: PricingUsageLine[]): {
  byLineId: Map<string, PricingRunningLineTotals>;
  hasEstimatedRows: boolean;
  totalCreditMicros: number;
} {
  const sortedLines = [...lines].sort(compareUsageLinesAscending);
  const byLineId = new Map<string, PricingRunningLineTotals>();
  let hasEstimatedRows = false;
  let runningCostMicros = 0;
  let runningCreditMicros = 0;
  for (const line of sortedLines) {
    const estimate = estimateCodexCreditsForLine(line);
    if (isEstimatedUsageGap(line)) {
      hasEstimatedRows = true;
    }
    if (line.priceStatus === "priced") {
      runningCostMicros += Math.max(0, line.totalCostMicros);
    }
    if (estimate) {
      runningCreditMicros += estimate.totalCreditMicros;
    }
    byLineId.set(line.usageLineId, {
      ...(estimate ? { creditMicros: estimate.totalCreditMicros } : {}),
      ...(hasEstimatedRows ? { runningHasEstimate: true } : {}),
      runningCostMicros,
      ...(runningCreditMicros > 0 ? { runningCreditMicros } : {}),
    });
  }
  return {
    byLineId,
    hasEstimatedRows,
    totalCreditMicros: runningCreditMicros,
  };
}

function estimateCodexCreditsForLine(line: PricingUsageLine):
  | {
      totalCreditMicros: number;
    }
  | undefined {
  if (line.provider !== "openai") {
    return undefined;
  }
  // Inherited fork context was billed on the parent thread; never estimate
  // (and never accumulate) credits for it on the fork.
  if (isForkBaselineLine(line)) {
    return undefined;
  }
  const estimate = estimateOpenAiCodexCreditUsage({
    at: line.createdAt,
    cachedInputTokens: line.cachedInputTokens,
    fastMode: line.fastMode,
    model: line.model,
    outputTokens: line.outputTokens,
    reasoningOutputTokens: line.reasoningOutputTokens,
    serviceTier: line.serviceTier,
    uncachedInputTokens: line.uncachedInputTokens,
  });
  return estimate ? { totalCreditMicros: estimate.totalCreditMicros } : undefined;
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
