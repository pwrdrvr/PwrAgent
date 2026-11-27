import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import { usageLimitProviderForBackend } from "@pwragent/shared/contracts/usage-activity";
import { GaugeIcon, PopoutIcon } from "../../../icons";
import type { DesktopApi } from "../../../lib/desktop-api";
import {
  describeRateLimitRow,
  formatBackendPlanType,
  selectVisibleRateLimits,
  type BackendRateLimitSummary,
} from "../../../lib/backend-status-format";
import { HoverCardBridge, type BridgedHoverCard } from "../../../lib/hover-card-bridge";
import { useViewportTooltip } from "../../../lib/useViewportTooltip";
import {
  useLocalUsagePace,
  usagePaceAccountKey,
  usagePaceRefreshKey,
  type LocalUsagePace,
} from "../../federation-activity/useLocalUsagePace";
import { RateLimitRow } from "./RateLimitRow";

type PeekDesktopApi = Pick<DesktopApi, "openUsageActivity" | "readUsageActivity">;

/** One provider's line in the peek: its tightest limit, or none reported. */
export type ProviderPeekEntry = {
  backend: BackendSummary;
  limit?: BackendRateLimitSummary;
  usedPercent?: number;
};

/** The providers whose limits have a pace line: those reporting a percentage. */
function chartableBackends(backends: readonly BackendSummary[]): BackendSummary[] {
  return backends.filter((backend) => backend.available
    && usageLimitProviderForBackend(backend.kind) && backend.rateLimits?.some((limit) => limit.usedPercent !== undefined));
}

/**
 * Each available provider's tightest limit, worst first. A provider that
 * reported no percentage sorts after every one that did, in the panel's
 * order, so the peek reads as "what runs out first".
 */
export function providerPeekEntries(
  backends: readonly BackendSummary[],
  now: number,
): ProviderPeekEntry[] {
  const entries = backends
    .filter((backend) => backend.available)
    .map((backend, order) => {
      let tightest: { limit: BackendRateLimitSummary; usedPercent: number } | undefined;
      for (const limit of selectVisibleRateLimits(backend)) {
        const usedPercent = describeRateLimitRow(limit, now).usedPercent;
        if (usedPercent === undefined) continue;
        if (!tightest || usedPercent > tightest.usedPercent) tightest = { limit, usedPercent };
      }
      return { order, entry: { backend, ...tightest } satisfies ProviderPeekEntry };
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
  // Read here, not in the card: the pace rows arrive after the card is
  // placed, and only content passed through `update` re-places it, so a
  // card that grew on its own ran off the bottom of the window.
  const chartable = chartableBackends(options.backends);
  const pace = useLocalUsagePace(
    visible && chartable.length ? options.desktopApi?.readUsageActivity : undefined,
    usagePaceRefreshKey(chartable),
    usagePaceAccountKey(chartable),
  );
  const optionsRef = useRef({ ...options, pace });
  optionsRef.current = { ...options, pace };
  const content = (): ReactNode => (
    <ProviderGaugePeekCard
      backends={optionsRef.current.backends}
      desktopApi={optionsRef.current.desktopApi}
      pace={optionsRef.current.pace}
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
  // Fresh limits arrive with each turn, and the pace after the card opens;
  // keep an open peek current and placed for its new height.
  useEffect(() => {
    if (visible) update(content());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.backends, pace, visible, update]);

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
  pace?: LocalUsagePace;
  onOpenPanel: () => void;
}) {
  const pace = props.pace;
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
          {entries.map(({ backend, limit }) => (
            <li key={backend.kind} className="provider-peek__provider">
              <span className="provider-peek__name">
                <span aria-hidden="true" className="backend-status-list__dot" />
                {backend.label}
              </span>
              {limit ? (
                <dl className="backend-status-list__metadata-grid rail-limit-grid provider-peek__grid">
                  <RateLimitRow
                    limit={limit}
                    now={now}
                    account={pace?.accounts.get(usageLimitProviderForBackend(backend.kind) ?? "")}
                  />
                </dl>
              ) : (
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
