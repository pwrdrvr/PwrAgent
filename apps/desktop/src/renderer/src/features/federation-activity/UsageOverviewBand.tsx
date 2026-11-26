import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { usageBucketLabel, usageCount, usageMoney } from "./usage-activity-presentation";
import {
  buildUsageActivityOverview,
  type FilterMode,
  type OverviewMetric,
  type OverviewTrendPoint,
  type TriStateFilter,
} from "./usage-activity-overview";
import type { UsageGroup } from "./usage-activity-summary";

const DEFAULT_VISIBLE_BREAKDOWN = 8;

type Point2D = { x: number; y: number };
type CubicSegment = { cp1: Point2D; cp2: Point2D; end: Point2D };

const HOUR_MS = 3_600_000;

function formatShare(share: number): string {
  const pct = share * 100;
  if (pct === 0) return "0%";
  if (pct < 0.1) return "<0.1%";
  return `${pct.toFixed(1)}%`;
}

function formatTooltipShare(value: number, total: number): string {
  if (total <= 0 || value <= 0) return "";
  const pct = (value / total) * 100;
  if (pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

function formatTooltipTime(point: OverviewTrendPoint, span: number, to: number): string {
  if (span <= 36 * HOUR_MS) return usageBucketLabel(point, to);
  const day = new Date(point.from).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  if (point.to - point.from >= 23 * HOUR_MS) return day;
  const clock = (at: number) => {
    const d = new Date(at);
    return d.toLocaleTimeString(undefined, d.getMinutes() ? { hour: "numeric", minute: "2-digit" } : { hour: "numeric" });
  };
  return `${day} · ${clock(point.from)}–${clock(point.to)}`;
}

/**
 * Fritsch-Carlson monotone cubic segments: never overshoots flat segments
 * (like zero baselines) and lets adjacent stacked bands share bit-identical
 * boundary curves when traversed in reverse.
 */
function monotoneSegments(points: readonly Point2D[]): CubicSegment[] {
  const n = points.length;
  if (n < 2) return [];
  const dx: number[] = [];
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const step = points[i + 1].x - points[i].x;
    dx.push(step);
    slopes.push(step > 0 ? (points[i + 1].y - points[i].y) / step : 0);
  }
  const tangents = Array<number>(n).fill(0);
  tangents[0] = slopes[0];
  tangents[n - 1] = slopes[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    tangents[i] = slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2;
  }
  for (let i = 0; i < n - 1; i += 1) {
    if (slopes[i] === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = tangents[i] / slopes[i];
    const b = tangents[i + 1] / slopes[i];
    const norm = a * a + b * b;
    if (norm > 9) {
      const scale = 3 / Math.sqrt(norm);
      tangents[i] = scale * a * slopes[i];
      tangents[i + 1] = scale * b * slopes[i];
    }
  }
  const segments: CubicSegment[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const third = dx[i] / 3;
    segments.push({
      cp1: { x: points[i].x + third, y: Math.min(100, Math.max(0, points[i].y + tangents[i] * third)) },
      cp2: { x: points[i + 1].x - third, y: Math.min(100, Math.max(0, points[i + 1].y - tangents[i + 1] * third)) },
      end: points[i + 1],
    });
  }
  return segments;
}

function forwardPath(points: readonly Point2D[], segments: readonly CubicSegment[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  return [
    `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`,
    ...segments.map((seg) =>
      `C ${seg.cp1.x.toFixed(2)} ${seg.cp1.y.toFixed(2)}, ${seg.cp2.x.toFixed(2)} ${seg.cp2.y.toFixed(2)}, ${seg.end.x.toFixed(2)} ${seg.end.y.toFixed(2)}`),
  ].join(" ");
}

function activeLinePath(
  points: readonly Point2D[],
  segments: readonly CubicSegment[],
  values: readonly number[],
): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    return values[0] > 0 ? `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}` : "";
  }
  const parts: string[] = [];
  let penOpen = false;
  for (let i = 0; i < segments.length; i += 1) {
    if (values[i] > 0 || values[i + 1] > 0) {
      if (!penOpen) {
        parts.push(`M ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}`);
        penOpen = true;
      }
      const seg = segments[i];
      parts.push(
        `C ${seg.cp1.x.toFixed(2)} ${seg.cp1.y.toFixed(2)}, ${seg.cp2.x.toFixed(2)} ${seg.cp2.y.toFixed(2)}, ${seg.end.x.toFixed(2)} ${seg.end.y.toFixed(2)}`,
      );
    } else {
      penOpen = false;
    }
  }
  return parts.join(" ");
}

/** Closed polygon between `upper` (left→right) and `lower` (right→left) along exact shared cubic edges. */
function stackedBandPolygon(
  upper: readonly Point2D[],
  lower: readonly Point2D[],
  values: readonly number[],
): { line: string; area: string } {
  if (upper.length === 0 || values.every((value) => value <= 0)) return { line: "", area: "" };
  const upperSegs = monotoneSegments(upper);
  const upperPath = forwardPath(upper, upperSegs);
  if (upper.length === 1) {
    const top = upper[0];
    const bot = lower[0];
    const w = 14;
    return {
      line: `M ${(top.x - w).toFixed(2)} ${top.y.toFixed(2)} L ${(top.x + w).toFixed(2)} ${top.y.toFixed(2)}`,
      area: `M ${(top.x - w).toFixed(2)} ${top.y.toFixed(2)} L ${(top.x + w).toFixed(2)} ${top.y.toFixed(2)} L ${(bot.x + w).toFixed(2)} ${bot.y.toFixed(2)} L ${(bot.x - w).toFixed(2)} ${bot.y.toFixed(2)} Z`,
    };
  }
  const lowerSegs = monotoneSegments(lower);
  const reverseLower: string[] = [`L ${lower.at(-1)!.x.toFixed(2)} ${lower.at(-1)!.y.toFixed(2)}`];
  for (let i = lowerSegs.length - 1; i >= 0; i -= 1) {
    const seg = lowerSegs[i];
    const start = lower[i];
    reverseLower.push(
      `C ${seg.cp2.x.toFixed(2)} ${seg.cp2.y.toFixed(2)}, ${seg.cp1.x.toFixed(2)} ${seg.cp1.y.toFixed(2)}, ${start.x.toFixed(2)} ${start.y.toFixed(2)}`,
    );
  }
  return { line: activeLinePath(upper, upperSegs, values), area: `${upperPath} ${reverseLower.join(" ")} Z` };
}

function axisTicks(trend: readonly OverviewTrendPoint[]): Array<{ index: number; text: string; edge?: "start" | "end" }> {
  if (trend.length === 0) return [];
  if (trend.length === 1) return [{ index: 0, text: trend[0].label, edge: "start" }];
  const maxTicks = Math.min(5, trend.length);
  const ticks: Array<{ index: number; text: string; edge?: "start" | "end" }> = [];
  for (let slot = 0; slot < maxTicks; slot += 1) {
    const index = Math.round(slot * (trend.length - 1) / (maxTicks - 1));
    if (ticks.some((tick) => tick.index === index)) continue;
    ticks.push({
      index,
      text: trend[index].label,
      ...(index === 0 ? { edge: "start" } : index === trend.length - 1 ? { edge: "end" } : {}),
    });
  }
  return ticks;
}

function filterTooltip(label: string, mode: FilterMode | undefined, hasAnyInclude: boolean): string {
  if (mode === "include") return `Included ${label}. Click again to exclude`;
  if (mode === "exclude") return `Excluded ${label}. Click again to clear`;
  return hasAnyInclude ? `Click to add ${label} to filter` : `Click to show only ${label}`;
}

/**
 * `aria-pressed` reports include alone. An excluded row is a third state that
 * removes its turns from every total, and "mixed" would announce it as
 * partially pressed, so the exclusion is stated in the row's accessible name.
 */
function ExcludedName({ mode }: { mode: FilterMode | undefined }) {
  return mode === "exclude" ? <span className="usage-sr-only">, excluded</span> : null;
}

export function UsageOverviewBand({
  groups,
  from,
  to,
  providerFilters,
  onToggleProvider,
  onRemoveProviderFilter,
  modelFilters,
  onToggleModel,
  onRemoveModelFilter,
  onClearModelFilters,
  onClearFilters,
  readable = true,
}: {
  groups: readonly UsageGroup[];
  from: number;
  to: number;
  /** Tri-state provider filters keyed by provider label (e.g. "OpenAI"). */
  providerFilters: TriStateFilter;
  onToggleProvider: (providerLabel: string) => void;
  onRemoveProviderFilter: (providerLabel: string) => void;
  /** Tri-state model filters keyed by `overviewRowModelKey` ("GPT-5.4 · OpenAI"). */
  modelFilters: TriStateFilter;
  onToggleModel: (modelKey: string) => void;
  onRemoveModelFilter: (modelKey: string) => void;
  onClearModelFilters: () => void;
  onClearFilters: () => void;
  /** False when no instance returned data, so an empty period is unknown, not zero. */
  readable?: boolean;
}) {
  const [metric, setMetric] = useState<OverviewMetric>("tokens");
  const [breakdownTab, setBreakdownTab] = useState<"model" | "day">("model");
  const [expandedBreakdown, setExpandedBreakdown] = useState(false);
  const [hoveredBucket, setHoveredBucket] = useState<number>();
  const [hoveredProvider, setHoveredProvider] = useState<string>();
  const bucketButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const tooltipId = useId();

  const overview = useMemo(
    () => buildUsageActivityOverview({ groups, from, to, metric, providerFilters, modelFilters }),
    [groups, from, to, metric, providerFilters, modelFilters],
  );

  const { totals, providers, models, days, trend, stackedBands, stackedPeak } = overview;
  const formatPrimary = (tokens: number, costMicros: number) =>
    metric === "tokens" ? usageCount(tokens) : usageMoney(costMicros);

  const yMax = Math.max(1, stackedPeak);
  const xFor = (index: number) => trend.length > 1 ? index / (trend.length - 1) * 100 : 50;
  // Full height, so the axis labels (yMax at the top, yMax / 2 at the midline) read true.
  const yFor = (value: number) => 100 - Math.min(1, value / yMax) * 100;

  const bandGeometry = useMemo(() => {
    return stackedBands.map((band) => {
      const upper = band.upper.map((value, index) => ({ x: xFor(index), y: yFor(value) }));
      const lower = band.lower.map((value, index) => ({ x: xFor(index), y: yFor(value) }));
      const { line, area } = stackedBandPolygon(upper, lower, band.values);
      return { band, upper, lower, line, area };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stackedBands, trend.length, yMax]);

  const ticks = useMemo(() => axisTicks(trend), [trend]);
  // Spans of 36 hours or less chart clock-aligned sub-day buckets.
  const daily = to - from > 36 * HOUR_MS;
  const activePoint = hoveredBucket !== undefined ? trend[hoveredBucket] : undefined;

  const onBucketKey = (event: KeyboardEvent, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const last = trend.length - 1;
    const next = event.key === "ArrowRight" ? Math.min(last, index + 1)
      : event.key === "ArrowLeft" ? Math.max(0, index - 1)
      : event.key === "Home" ? 0 : last;
    if (next === index) return;
    setHoveredBucket(next);
    bucketButtons.current[next]?.focus();
  };

  // An empty period still states its zero total; nothing below it has rows.
  if (groups.length === 0) {
    return <section className="usage-overview" aria-label="Usage overview">
      <div className="usage-overview__head"><span className="usage-eyebrow">Overview</span></div>
      <div className="usage-overview__hero-figure">
        <strong>{readable ? formatPrimary(0, 0) : "Unavailable"}</strong>
        <span>{readable ? `0 threads · 0 turns · ${usageMoney(0)} API-eq.` : "No instance could be read for this period."}</span>
      </div>
    </section>;
  }

  const tokenTypeSegments = [
    { key: "input", label: "Input", tokens: totals.plainInputTokens, className: "is-input" },
    { key: "cache-read", label: "Cache read", tokens: totals.cachedInputTokens, className: "is-cache-read" },
    { key: "cache-write", label: "Cache write", tokens: totals.cacheWriteInputTokens, className: "is-cache-write" },
    { key: "output", label: "Output", tokens: totals.outputTokens, className: "is-output" },
  ];
  // The ranked metric sits beside Share, so the percentage reads as a share of
  // the column next to it; the other metric moves to the left.
  const metricCells = (tokens: number, costMicros: number, share: number) => <>
    <span className="usage-overview__num">{metric === "tokens" ? usageMoney(costMicros) : usageCount(tokens)}</span>
    <span className="usage-overview__num">{metric === "tokens" ? usageCount(tokens) : usageMoney(costMicros)}</span>
    <span className="usage-overview__num usage-overview__share">{formatShare(share)}</span>
  </>;
  const visibleModels = expandedBreakdown ? models : models.slice(0, DEFAULT_VISIBLE_BREAKDOWN);
  const visibleDays = expandedBreakdown ? days : days.slice(0, DEFAULT_VISIBLE_BREAKDOWN);

  const hoveredItems = hoveredBucket !== undefined
    ? stackedBands
      .map((band) => ({
        key: band.key,
        label: band.label,
        seriesIndex: band.seriesIndex,
        value: band.values[hoveredBucket] ?? 0,
      }))
      .filter((item) => item.value > 0)
      .sort((a, b) => (b.value - a.value) || a.label.localeCompare(b.label))
    : [];
  const hoveredTotal = activePoint
    ? (metric === "tokens" ? activePoint.totalTokens : activePoint.totalCostMicros)
    : 0;
  const hoveredX = hoveredBucket !== undefined ? xFor(hoveredBucket) : 0;
  const hoveredTimeLabel = activePoint ? formatTooltipTime(activePoint, to - from, to) : "";

  const providerFilterEntries = Object.entries(providerFilters);
  const modelFilterEntries = Object.entries(modelFilters);
  const hasActiveFilters = providerFilterEntries.length > 0 || modelFilterEntries.length > 0;
  const hasAnyProviderInclude = providerFilterEntries.some(([, mode]) => mode === "include");
  const hasAnyModelInclude = modelFilterEntries.some(([, mode]) => mode === "include");

  return <section className="usage-overview" aria-label="Usage overview">
    <div className="usage-overview__head">
      <span className="usage-eyebrow">Overview</span>
      {providerFilterEntries.map(([label, mode]) => (
        <button key={`provider:${label}`} type="button"
          className={`usage-chip${mode === "exclude" ? " is-excluded" : " is-included"}`}
          aria-label={mode === "exclude" ? `Remove ${label} provider exclusion` : `Remove ${label} provider filter`}
          onClick={() => onRemoveProviderFilter(label)}>
          <i className="usage-chip__sign" aria-hidden="true">{mode === "include" ? "+" : "−"}</i>
          {label}
          <span aria-hidden="true">×</span>
        </button>
      ))}
      {modelFilterEntries.map(([name, mode]) => (
        <button key={`model:${name}`} type="button"
          className={`usage-chip${mode === "exclude" ? " is-excluded" : " is-included"}`}
          aria-label={mode === "exclude" ? `Remove ${name} model exclusion` : `Remove ${name} model filter`}
          onClick={() => onRemoveModelFilter(name)}>
          <i className="usage-chip__sign" aria-hidden="true">{mode === "include" ? "+" : "−"}</i>
          {name}
          <span aria-hidden="true">×</span>
        </button>
      ))}
      {hasActiveFilters ? (
        <button type="button" className="usage-link usage-overview__clear" onClick={onClearFilters}>Clear filters</button>
      ) : null}
      <span className="usage-overview__spacer" />
      <div className="usage-segmented usage-timeline__dimension" role="group" aria-label="Overview metric">
        <button type="button" aria-pressed={metric === "tokens"} onClick={() => setMetric("tokens")}>Tokens</button>
        <button type="button" aria-pressed={metric === "cost"} onClick={() => setMetric("cost")}>Cost</button>
      </div>
    </div>

    <div className="usage-overview__hero">
      <div className="usage-overview__summary">
        <div className="usage-overview__hero-figure">
          <strong>{formatPrimary(totals.processedTokens, totals.costMicros)}</strong>
          <span>
            {totals.threads.toLocaleString()} {totals.threads === 1 ? "thread" : "threads"}
            {" · "}
            {totals.turns.toLocaleString()} {totals.turns === 1 ? "turn" : "turns"}
            {" · "}
            {metric === "tokens" ? `${usageMoney(totals.costMicros)} API-eq.` : `${usageCount(totals.processedTokens)} tokens`}
          </span>
        </div>

        <div className="usage-overview__providers" role="group" aria-label="Usage by provider">
          {providers.map((provider) => {
            const mode = providerFilters[provider.label];
            const dimmed = mode === undefined && hasAnyProviderInclude;
            const share = metric === "tokens" ? provider.tokenShare : provider.costShare;
            const primary = formatPrimary(provider.tokens, provider.costMicros);
            // The other metric rides with the thread count, so the percentage
            // beside the bar only ever sits next to the figure it is a share of.
            const secondary = metric === "tokens" ? usageMoney(provider.costMicros) : `${usageCount(provider.tokens)} tokens`;
            return <button type="button" key={provider.provider}
              className={`usage-overview__provider${mode === "include" ? " is-included" : mode === "exclude" ? " is-excluded" : ""}${dimmed ? " is-dimmed" : ""}`}
              data-filter-state={mode ?? "none"}
              aria-pressed={mode === "include"}
              title={filterTooltip(provider.label, mode, hasAnyProviderInclude)}
              onMouseEnter={() => setHoveredProvider(provider.provider)}
              onMouseLeave={() => setHoveredProvider(undefined)}
              onFocus={() => setHoveredProvider(provider.provider)}
              onBlur={() => setHoveredProvider(undefined)}
              onClick={() => onToggleProvider(provider.label)}>
              <span className="usage-overview__provider-top">
                <i className={`usage-overview__swatch usage-series--${provider.seriesIndex}`} aria-hidden="true" />
                <span className="usage-overview__provider-name">{provider.label}</span>
                {mode ? <span className={`usage-overview__state-badge is-${mode}`} aria-hidden="true">{mode === "include" ? "+" : "−"}</span> : null}
                <span className="usage-overview__provider-meta">
                  {provider.threads.toLocaleString()} {provider.threads === 1 ? "thread" : "threads"} · {secondary}
                </span>
                <strong>{primary}</strong>
              </span>
              <span className="usage-overview__provider-bar">
                <span className="usage-overview__share-track" aria-hidden="true">
                  <i className={`usage-series--${provider.seriesIndex}`} style={{ width: `${Math.max(share > 0 ? 1.5 : 0, share * 100)}%` }} />
                </span>
                <span className="usage-overview__provider-sub">{formatShare(share)}</span>
              </span>
              <ExcludedName mode={mode} />
            </button>;
          })}
        </div>
      </div>

      <div className="usage-overview__chart">
        <div className="usage-overview__chart-head">
          <span className="usage-overview__chart-title">
            {metric === "tokens" ? `${daily ? "Daily processed" : "Processed"} tokens` : `${daily ? "Daily API" : "API"}-equivalent cost`}
          </span>
          <span className="usage-overview__chart-kind">Stacked by provider · top edge is total</span>
        </div>
        <div className="usage-overview__chart-frame">
          <div className="usage-overview__axis-y" aria-hidden="true">
            <span>{metric === "tokens" ? usageCount(yMax) : usageMoney(yMax)}</span>
            <span>{metric === "tokens" ? usageCount(yMax / 2) : usageMoney(yMax / 2)}</span>
            <span>{metric === "tokens" ? "0" : "$0.00"}</span>
          </div>
          <div className="usage-overview__plot" onMouseLeave={() => setHoveredBucket(undefined)}>
            <svg className="usage-overview__svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <line className="usage-overview__gridline" x1="0" y1="50" x2="100" y2="50" vectorEffect="non-scaling-stroke" />
              {bandGeometry.map(({ band, line, area }) => {
                const isHot = hoveredProvider === band.key;
                const isMuted = hoveredProvider !== undefined && !isHot;
                return (
                  <g key={band.key}
                    className={`usage-overview__series usage-overview__series--${band.seriesIndex}${isHot ? " is-hot" : ""}${isMuted ? " is-muted" : ""}`}>
                    {area ? <path className="usage-overview__band-fill" d={area} /> : null}
                    {line ? <path className="usage-overview__band-line" d={line} vectorEffect="non-scaling-stroke" /> : null}
                  </g>
                );
              })}
              {hoveredBucket !== undefined ? (
                <line className="usage-overview__cursor" x1={xFor(hoveredBucket)} y1="0"
                  x2={xFor(hoveredBucket)} y2="100" vectorEffect="non-scaling-stroke" />
              ) : null}
            </svg>
            <div className="usage-overview__hits" role="group" aria-label={daily ? "Daily provider trend" : "Provider trend"}>
              {trend.map((point, index) => (
                <button key={point.from} type="button"
                  ref={(element) => { bucketButtons.current[index] = element; }}
                  tabIndex={index === (hoveredBucket ?? trend.length - 1) ? 0 : -1}
                  className="usage-overview__hit"
                  aria-label={`${formatTooltipTime(point, to - from, to)}: ${formatPrimary(point.totalTokens, point.totalCostMicros)}`}
                  aria-describedby={hoveredBucket === index ? tooltipId : undefined}
                  onMouseEnter={() => setHoveredBucket(index)}
                  onFocus={() => setHoveredBucket(index)}
                  onBlur={() => setHoveredBucket(undefined)}
                  onKeyDown={(event) => onBucketKey(event, index)} />
              ))}
            </div>
            {activePoint && hoveredBucket !== undefined ? (
              <div id={tooltipId} role="tooltip" className="usage-overview__tooltip"
                style={hoveredX > 55
                  ? { right: `calc(${(100 - hoveredX).toFixed(2)}% + 10px)` }
                  : { left: `calc(${hoveredX.toFixed(2)}% + 10px)` }}>
                <div className="usage-overview__tooltip-head">
                  <span>{hoveredTimeLabel}</span>
                  <strong>{formatPrimary(activePoint.totalTokens, activePoint.totalCostMicros)}</strong>
                </div>
                {hoveredItems.length > 0 ? (
                  <ul className="usage-overview__tooltip-rows">
                    {hoveredItems.map((item) => (
                      <li key={item.key} className="usage-overview__tooltip-row">
                        <i className={`usage-overview__swatch usage-series--${item.seriesIndex}`} aria-hidden="true" />
                        <span className="usage-overview__tooltip-name">{item.label}</span>
                        <b>{metric === "tokens" ? usageCount(item.value) : usageMoney(item.value)}</b>
                        <small>{formatTooltipShare(item.value, hoveredTotal)}</small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="usage-overview__tooltip-empty">No usage recorded</p>
                )}
              </div>
            ) : null}
          </div>
        </div>
        <div className="usage-overview__axis-x" aria-hidden="true">
          <div className="usage-overview__ticks">
            {ticks.map((tick) => (
              <span key={tick.index}
                className={tick.edge === "start" ? "is-start" : tick.edge === "end" ? "is-end" : undefined}
                style={{ left: `${xFor(tick.index)}%` }}>{tick.text}</span>
            ))}
          </div>
        </div>
        <p className="usage-overview__readout">
          Hover chart for point breakdown · Click providers or models to include, click again to exclude
        </p>
      </div>
    </div>

    <div className="usage-overview__mix" role="group" aria-label="Token totals and cache savings">
      <div className="usage-overview__mix-head">
        <span className="usage-eyebrow">Token mix</span>
        <span className="usage-overview__mix-summary">
          Processed <strong>{usageCount(totals.processedTokens)}</strong>
          {" · "}
          Cached <strong>{Math.round(totals.cacheShare * 100)}%</strong>
          {" · "}
          Cache savings <strong>{totals.cacheSavingsMicros > 0 ? usageMoney(totals.cacheSavingsMicros) : "—"}</strong>
        </span>
      </div>
      <div className="usage-overview__type-bar" role="img"
        aria-label={`Tokens by type: Input ${usageCount(totals.plainInputTokens)}, Cache read ${usageCount(totals.cachedInputTokens)}, Cache write ${usageCount(totals.cacheWriteInputTokens)}, Output ${usageCount(totals.outputTokens)}`}>
        {tokenTypeSegments.map((segment) => segment.tokens > 0
          ? <i key={segment.key} className={segment.className} style={{ flexGrow: segment.tokens }} />
          : null)}
      </div>
      <div className="usage-overview__type-legend">
        {tokenTypeSegments.map((segment) => (
          <span key={segment.key}><i className={segment.className} aria-hidden="true" />{segment.label} <strong>{usageCount(segment.tokens)}</strong></span>
        ))}
        <span className="usage-overview__type-extra">Uncached total <strong>{usageCount(totals.uncachedInputTokens)}</strong></span>
      </div>
    </div>

    <div className="usage-overview__breakdown">
      <div className="usage-overview__breakdown-head">
        <span className="usage-eyebrow">Breakdown</span>
        {modelFilterEntries.length > 0 ? (
          <button type="button" className="usage-link usage-overview__clear" onClick={onClearModelFilters}>Clear model filters</button>
        ) : null}
        <span className="usage-overview__spacer" />
        <div className="usage-segmented usage-timeline__dimension" role="group" aria-label="Breakdown by">
          <button type="button" aria-pressed={breakdownTab === "model"} onClick={() => setBreakdownTab("model")}>Model</button>
          <button type="button" aria-pressed={breakdownTab === "day"} onClick={() => setBreakdownTab("day")}>Day</button>
        </div>
      </div>

      <div className="usage-overview__table-head">
        <span>#</span>
        <span>{breakdownTab === "model" ? "Model" : "Day"}</span>
        <span>{metric === "tokens" ? "Cost" : "Tokens"}</span>
        <span>{metric === "tokens" ? "Tokens" : "Cost"}</span>
        <span>Share</span>
      </div>

      <div className="usage-overview__table-body">
        {breakdownTab === "model" ? visibleModels.map((row, index) => {
          const share = metric === "tokens" ? row.tokenShare : row.costShare;
          const mode = modelFilters[row.filterKey];
          const dimmed = mode === undefined && hasAnyModelInclude;
          return <button type="button" key={`${row.provider}:${row.model}`}
            className={`usage-overview__table-row${mode === "include" ? " is-included" : mode === "exclude" ? " is-excluded" : ""}${dimmed ? " is-dimmed" : ""}`}
            data-filter-state={mode ?? "none"}
            aria-pressed={mode === "include"}
            title={filterTooltip(row.filterKey, mode, hasAnyModelInclude)}
            onClick={() => onToggleModel(row.filterKey)}>
            <span className="usage-overview__rank">{index + 1}</span>
            <span className="usage-overview__entity">
              <span className="usage-overview__entity-line">
                <i className={`usage-overview__swatch usage-series--${row.seriesIndex}`} aria-hidden="true" />
                <strong>{row.model}</strong>
                {mode ? <span className={`usage-overview__state-badge is-${mode}`} aria-hidden="true">{mode === "include" ? "+" : "−"}</span> : null}
                <small>{row.providerLabel}</small>
              </span>
              <span className="usage-overview__share-track" aria-hidden="true">
                <i className={`usage-series--${row.seriesIndex}`} style={{ width: `${Math.max(share > 0 ? 1.5 : 0, share * 100)}%` }} />
              </span>
            </span>
            {metricCells(row.tokens, row.costMicros, share)}
            <ExcludedName mode={mode} />
          </button>;
        }) : visibleDays.map((row, index) => {
          const share = metric === "tokens" ? row.tokenShare : row.costShare;
          return <div key={row.key} className="usage-overview__table-row is-static">
            <span className="usage-overview__rank">{index + 1}</span>
            <span className="usage-overview__entity">
              <span className="usage-overview__entity-line">
                <strong>{row.label}</strong>
                <small>{row.threads} {row.threads === 1 ? "thread" : "threads"} · {row.turns} {row.turns === 1 ? "turn" : "turns"}</small>
              </span>
              <span className="usage-overview__share-track" aria-hidden="true">
                <i className="usage-overview__share-neutral" style={{ width: `${Math.max(share > 0 ? 1.5 : 0, share * 100)}%` }} />
              </span>
            </span>
            {metricCells(row.tokens, row.costMicros, share)}
          </div>;
        })}
      </div>

      {(breakdownTab === "model" ? models.length : days.length) > DEFAULT_VISIBLE_BREAKDOWN ? (
        <button type="button" className="usage-link usage-overview__more"
          onClick={() => setExpandedBreakdown((current) => !current)}>
          {expandedBreakdown
            ? "Show fewer"
            : `Show all ${breakdownTab === "model" ? `${models.length} models` : `${days.length} days`}`}
        </button>
      ) : null}
    </div>
  </section>;
}
