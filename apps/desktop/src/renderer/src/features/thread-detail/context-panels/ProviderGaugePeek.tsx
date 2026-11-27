import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import { usageLimitProviderForBackend } from "@pwragent/shared/contracts/usage-activity";
import { GaugeIcon, PopoutIcon } from "../../../icons";
import type { DesktopApi } from "../../../lib/desktop-api";
import {
  describeRateLimitRow,
  formatBackendPlanType,
  isIndividualRateLimit,
  selectVisibleRateLimits,
  type BackendRateLimitSummary,
} from "../../../lib/backend-status-format";
import { HoverCardBridge, type BridgedHoverCard } from "../../../lib/hover-card-bridge";
import { groupRateLimitsByScope } from "../../../lib/rate-limit-scopes";
import { useViewportTooltip } from "../../../lib/useViewportTooltip";
import {
  useLocalUsagePace,
  usagePaceAccountKey,
  usagePaceRefreshKey,
} from "../../federation-activity/useLocalUsagePace";
import { describeLimitPace } from "../../federation-activity/usage-activity-presentation";
import {
  limitSeriesFor,
  limitUsageDropped,
  type LimitAccount,
} from "../../federation-activity/usage-limits";
import { capLatchSample, fiveHourLatchKey, fiveHourLatches, type FiveHourSample } from "./five-hour-latch";
import { RateLimitRow } from "./RateLimitRow";

type PeekDesktopApi = Pick<DesktopApi, "openUsageActivity" | "readUsageActivity">;

/**
 * One of a provider's shared allowances in the peek, by its longest window
 * (Weekly where it has one): Antigravity's "Claude/GPT" and "Gemini" pools
 * are two, a single plan is one with no `scope`.
 */
export type ProviderPeekScope = {
  /** Null for a provider's only scope, which shows no subheader. */
  scope: string | null;
  /** The row label: the window alone, "Weekly". */
  window: string;
  limit: BackendRateLimitSummary;
  usedPercent?: number;
  /** The scope's 5h window, shown under its Weekly one while at risk. */
  fiveHour?: BackendRateLimitSummary;
};

/**
 * A provider's cap with no window, such as a Codex business account's
 * Individual limit, shown above its allowances while at risk.
 */
export type ProviderPeekCap = {
  /** The row label: "Individual". */
  window: string;
  limit: BackendRateLimitSummary;
  usedPercent: number;
};

/** One provider in the peek: a line per allowance, or none reported. */
export type ProviderPeekEntry = {
  backend: BackendSummary;
  /** Its caps at risk; the latch decides, as for a 5h row. */
  caps: ProviderPeekCap[];
  scopes: ProviderPeekScope[];
  /** The fullest shown allowance or cap, which orders the providers. */
  usedPercent?: number;
};

/** The providers whose limits have a pace line: those reporting a percentage. */
function chartableBackends(backends: readonly BackendSummary[]): BackendSummary[] {
  return backends.filter((backend) => backend.available
    && usageLimitProviderForBackend(backend.kind) && backend.rateLimits?.some((limit) => limit.usedPercent !== undefined));
}

/**
 * Each scope's longest window, which is Weekly wherever the provider has
 * one; the 5h windows stay on the AI providers panel. A provider whose limits
 * have no window (a credit balance) shows its fullest one instead.
 */
function providerPeekScopes(
  backend: BackendSummary,
  now: number,
): { scopes: ProviderPeekScope[]; caps: ProviderPeekCap[] } {
  const visible = selectVisibleRateLimits(backend);
  // The panel's filter, in the provider's own order: Antigravity's pools
  // read as it reports them, not as the panel sorts its rows.
  const shown = new Set(visible);
  const scopes = groupRateLimitsByScope((backend.rateLimits ?? []).filter((limit) => shown.has(limit)));
  const usedPercentOf = (limit: BackendRateLimitSummary) => describeRateLimitRow(limit, now).usedPercent;
  if (scopes.length) {
    return { scopes: scopes.map((group) => {
      const { limit, window } = group.windows[0]!;
      const usedPercent = usedPercentOf(limit);
      const fiveHour = group.windows.find((entry) => entry !== group.windows[0] && entry.window.minutes === 300);
      return {
        scope: group.scope,
        window: window.label,
        limit,
        ...(usedPercent === undefined ? {} : { usedPercent }),
        ...(fiveHour ? { fiveHour: fiveHour.limit } : {}),
      };
    }), caps: providerPeekCaps(backend, visible, now) };
  }
  let fullest: ProviderPeekScope | undefined;
  for (const limit of visible) {
    const usedPercent = usedPercentOf(limit);
    if (usedPercent === undefined || (fullest?.usedPercent ?? -1) >= usedPercent) continue;
    fullest = { scope: null, window: describeRateLimitRow(limit, now).label.replace(/ limit$/i, ""), limit, usedPercent };
  }
  // With no window to show, the fullest limit is the row, a cap included.
  return { scopes: fullest ? [fullest] : [], caps: [] };
}

/**
 * The provider's caps with no window that its latch shows: at 80% used, and
 * until they fall below 60%. Steps each cap's latch with this reading.
 */
function providerPeekCaps(
  backend: BackendSummary,
  visible: readonly BackendRateLimitSummary[],
  now: number,
): ProviderPeekCap[] {
  return visible.flatMap((limit) => {
    if (!isIndividualRateLimit(limit)) return [];
    const usedPercent = describeRateLimitRow(limit, now).usedPercent;
    if (usedPercent === undefined) return [];
    const shown = fiveHourLatches.observe(fiveHourLatchKey(backend.kind, limit), capLatchSample(usedPercent, limit.resetAt));
    return shown ? [{ window: "Individual", limit, usedPercent }] : [];
  });
}

/**
 * Each available provider with its allowances, fullest provider first. A
 * provider that reported no percentage sorts after every one that did, in
 * the panel's order, so the peek reads as "what runs out first". Scopes keep
 * the provider's own order. Each call steps the caps' latches, so the first
 * reading at 80% shows the cap.
 */
export function providerPeekEntries(
  backends: readonly BackendSummary[],
  now: number,
): ProviderPeekEntry[] {
  const entries = backends
    .filter((backend) => backend.available)
    .map((backend, order) => {
      const { scopes, caps } = providerPeekScopes(backend, now);
      const percents = [
        ...caps.map((cap) => cap.usedPercent),
        ...scopes.flatMap((scope) => scope.usedPercent === undefined ? [] : [scope.usedPercent]),
      ];
      const usedPercent = percents.length ? Math.max(...percents) : undefined;
      return {
        order,
        entry: { backend, caps, scopes, ...(usedPercent === undefined ? {} : { usedPercent }) } satisfies ProviderPeekEntry,
      };
    });
  return entries
    .sort((left, right) =>
      (right.entry.usedPercent ?? -1) - (left.entry.usedPercent ?? -1) || left.order - right.order)
    .map(({ entry }) => entry);
}

/**
 * The AI provider gauge's hover peek: each provider's tightest limit, read
 * without opening the rail. It is its own enterable card with its own
 * bridge, since nothing else in the rail is one. The click on the gauge still
 * opens the full panel; `onOpenPanel` is that same handler.
 */
export function useProviderGaugePeek(options: {
  backends: BackendSummary[];
  desktopApi?: PeekDesktopApi;
  onOpenPanel: () => void;
}): {
  /** The pointer entered the gauge tab. */
  enter: (target: HTMLElement) => void;
  /** The pointer left the gauge tab. */
  leave: () => void;
  hide: () => void;
  node: ReactNode;
} {
  const bridge = useMemo(() => new HoverCardBridge(), []);
  const cardRef = useRef<BridgedHoverCard>({ hide: () => undefined });
  const tooltip = useViewportTooltip({
    className: "pr-status-card provider-peek",
    placement: "beside",
    interactive: {
      onPointerEnter: () => bridge.enterCard(cardRef.current),
      onPointerLeave: () => bridge.leaveCard(cardRef.current),
      // The card opens beside the spine, over the open panel or the
      // transcript; the strip keeps the pointer on the card across the gap.
      bridge: true,
    },
  });
  const { hide, show, showAfterDelay, update, visible } = tooltip;
  cardRef.current.hide = hide;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const content = (): ReactNode => (
    <ProviderGaugePeekCard
      backends={optionsRef.current.backends}
      desktopApi={optionsRef.current.desktopApi}
      // Only content passed through `update` re-places the card, so one
      // that grew by its pace lines on its own ran off the window's bottom.
      onPaceChange={() => update(content())}
      onOpenPanel={() => {
        hide();
        optionsRef.current.onOpenPanel();
      }}
    />
  );
  useEffect(() => {
    if (visible) bridge.shown(cardRef.current);
    else bridge.hidden(cardRef.current);
  }, [bridge, visible]);
  // Every snapshot steps the 5h latches, open peek or not: a window that
  // crossed 80% between glances shows on the next one.
  useEffect(() => {
    observeFiveHourWindows(options.backends, Date.now());
  }, [options.backends]);
  // Fresh limits arrive with each turn; keep an open peek current.
  useEffect(() => {
    if (visible) update(content());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.backends, visible, update]);

  return {
    enter: (target) => {
      if (bridge.enterTrigger(cardRef.current)) {
        show(target, content());
        return;
      }
      showAfterDelay(target, content);
    },
    leave: () => {
      if (visible) {
        bridge.leaveTrigger(cardRef.current);
        return;
      }
      hide();
    },
    hide,
    node: tooltip.tooltipNode,
  };
}

export function ProviderGaugePeekCard(props: {
  backends: BackendSummary[];
  desktopApi?: PeekDesktopApi;
  /** The pace lines changed the card's height: place it again. */
  onPaceChange?: () => void;
  onOpenPanel: () => void;
}) {
  // The card reads the pace itself, so a read still running when the peek
  // closes lands in the shared cache for the next glance.
  const chartable = chartableBackends(props.backends);
  const pace = useLocalUsagePace(
    chartable.length ? props.desktopApi?.readUsageActivity : undefined,
    usagePaceRefreshKey(chartable),
    usagePaceAccountKey(chartable),
  );
  const placedPace = useRef(pace);
  useLayoutEffect(() => {
    if (pace === placedPace.current) return;
    placedPace.current = pace;
    props.onPaceChange?.();
  });
  // Reset times are relative to the backends' latest refresh, as in the panel.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [props.backends]);
  const entries = providerPeekEntries(props.backends, now);
  const openUsageActivity = props.desktopApi?.openUsageActivity;

  return (
    <>
      <div className="pr-status-card__header">
        <span className="pr-status-card__eyebrow">AI providers</span>
        {openUsageActivity ? (
          <button
            className="pr-status-card__action provider-peek__activity"
            tabIndex={-1}
            type="button"
            // Opens its own window: a press must not focus into the rail,
            // whose focus handler would open the panel behind the peek.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void openUsageActivity()}
          >
            Usage Activity
            <PopoutIcon size={10} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {entries.length ? (
        <ul className="provider-peek__list">
          {entries.map(({ backend, caps, scopes }) => (
            <li key={backend.kind} className="provider-peek__provider">
              <span className="provider-peek__name">
                <span aria-hidden="true" className="backend-status-list__dot" />
                {backend.label}
              </span>
              {/* The provider's own cap leads while at risk: it binds every scope. */}
              {caps.length ? (
                <div className="provider-peek__scope">
                  {caps.map((cap) => (
                    <PeekLimitRow
                      key={cap.limit.name}
                      window={cap.window}
                      limit={cap.limit}
                      now={now}
                      account={pace?.accounts.get(usageLimitProviderForBackend(backend.kind) ?? "")}
                      warning={cap.usedPercent >= 100}
                    />
                  ))}
                </div>
              ) : null}
              {scopes.length ? scopes.map((entry) => {
                const account = pace?.accounts.get(usageLimitProviderForBackend(backend.kind) ?? "");
                const fiveHour = entry.fiveHour
                  ? observeFiveHour(backend, entry.fiveHour, account, now)
                  : undefined;
                return (
                  <div key={entry.scope ?? ""} className="provider-peek__scope">
                    {/* Named only where the provider has more than one. */}
                    {entry.scope !== null ? (
                      <span className="provider-peek__scope-name">{entry.scope}</span>
                    ) : null}
                    <PeekLimitRow window={entry.window} limit={entry.limit} now={now} account={account} />
                    {fiveHour?.shown ? (
                      <PeekLimitRow
                        window="5h"
                        limit={entry.fiveHour!}
                        now={now}
                        account={account}
                        warning={fiveHour.warning}
                      />
                    ) : null}
                  </div>
                );
              }) : (
                <span className="provider-peek__none">
                  {backend.account?.planType
                    ? `${formatBackendPlanType(backend, backend.account.planType)} · no limits reported`
                    : "No limits reported"}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="project-card__caption">No provider is available.</div>
      )}
      <div className="project-card__section">
        <button
          className="project-card__target"
          tabIndex={-1}
          type="button"
          onClick={props.onOpenPanel}
        >
          <GaugeIcon size={14} aria-hidden="true" />
          <span className="project-card__target-name">Open AI provider info</span>
        </button>
      </div>
    </>
  );
}

/**
 * The panel's limit row under a window-only label in one fixed column, so
 * every provider's bar starts at the same edge and runs the same width. The
 * panel's own label (the scope and "limit" too) stays on the panel.
 */
function PeekLimitRow(props: {
  window: string;
  limit: BackendRateLimitSummary;
  now: number;
  account: LimitAccount | undefined;
  /** Out, or on pace to run out before the reset. */
  warning?: boolean;
}) {
  return (
    <div className={`provider-peek__limit${props.warning ? " is-warning" : ""}`}>
      <span className="provider-peek__window">{props.window}</span>
      <dl className="backend-status-list__metadata-grid provider-peek__stat">
        <RateLimitRow limit={props.limit} now={props.now} account={props.account} />
      </dl>
    </div>
  );
}

/**
 * Where a limit's pace lands at its reset, exactly as `RateLimitRow`'s pace
 * line reads it ("On pace for about N% at the reset"), so a 5h row that
 * appears agrees with its own pace text; 100 when it runs out first.
 * Undefined while unknown: under 30 minutes of the window, no pace, or a
 * reading the series has not caught up with.
 */
export function projectedPercentAtReset(
  limit: BackendRateLimitSummary,
  account: LimitAccount | undefined,
  now: number,
): number | undefined {
  const used = describeRateLimitRow(limit, now).usedPercent;
  const series = limitSeriesFor(account, limit);
  if (!series || used === undefined || used >= 100 || series.latest.usedPercent >= 100
    || limitUsageDropped(series.latest.usedPercent, used) || series.latest.resetAt !== limit.resetAt
    || (limit.resetAt !== undefined && limit.resetAt <= now)) return undefined;
  const pace = describeLimitPace(series, now, true);
  if (!pace) return undefined;
  if (pace.projection.kind === "full") return 100;
  return pace.projection.percent < used ? undefined : pace.projection.percent;
}

function fiveHourSample(limit: BackendRateLimitSummary, projectedPercent: number | undefined, now: number): FiveHourSample {
  const usedPercent = describeRateLimitRow(limit, now).usedPercent;
  return {
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(projectedPercent === undefined ? {} : { projectedPercent }),
    ...(limit.resetAt === undefined ? {} : { resetAt: limit.resetAt }),
  };
}

/** Steps a scope's 5h latch with this reading and its pace. */
function observeFiveHour(
  backend: BackendSummary,
  limit: BackendRateLimitSummary,
  account: LimitAccount | undefined,
  now: number,
): { shown: boolean; warning: boolean } {
  const projected = projectedPercentAtReset(limit, account, now);
  const sample = fiveHourSample(limit, projected, now);
  const shown = fiveHourLatches.observe(fiveHourLatchKey(backend.kind, limit), sample);
  // Out already, or on pace to be before the reset.
  return { shown, warning: (sample.usedPercent ?? 0) >= 100 || (projected ?? 0) >= 100 };
}

/** A snapshot's readings, without a pace: they can show a row or start a window. */
function observeFiveHourWindows(backends: readonly BackendSummary[], now: number): void {
  for (const { backend, scopes } of providerPeekEntries(backends, now)) {
    for (const entry of scopes) {
      if (!entry.fiveHour) continue;
      fiveHourLatches.observe(fiveHourLatchKey(backend.kind, entry.fiveHour), fiveHourSample(entry.fiveHour, undefined, now));
    }
  }
}
