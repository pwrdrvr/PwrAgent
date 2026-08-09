import { useEffect, useState, type CSSProperties } from "react";
import type { FederationLoadStatus } from "@pwragent/shared";
import { formatByteCount } from "../../lib/format-bytes";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import {
  useStarMapCardDrag,
  type StarMapCardDrag,
} from "./useStarMapCardDrag";

/**
 * Past three missed polls a reading is no longer describing the machine in
 * front of you. Fresh cards say nothing about their age on purpose — a
 * ticking "4s ago" in a mission-control view is noise; only the failure is
 * worth words.
 */
const STALE_AFTER_MS = 25_000;
const STALE_TICK_MS = 5_000;

/**
 * Slot height the layout reserves for a load card. The card's content is
 * fixed (an eyebrow and three figures), so a constant beats plumbing it
 * through the measured-height map that variable thread cards need. Sized
 * with room for one note line so a stale card grows into its own gap
 * instead of over the card below it.
 */
export const STAR_MAP_LOAD_CARD_HEIGHT = 88;

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

/**
 * Live load for one instance, parked in its solar system.
 *
 * It is not a thread, so it deliberately does not look like a thread card:
 * no status cookie, no chips, no open action — three labelled figures and a
 * dismiss. It is queried on demand while it is open (see
 * `useStarMapInstanceLoad`), which is why closing it is a real affordance
 * rather than a cosmetic hide.
 */
export function StarMapLoadCard(props: {
  instanceId: string;
  instanceLabel: string;
  load?: FederationLoadStatus;
  /** Default slot offset from the instance anchor, in px. */
  baseSlot: { dx: number; dy: number };
  /** Synced drag offset layered on top of the slot. */
  offset?: { dx: number; dy: number };
  width: number;
  centered?: boolean;
  stackIndex: number;
  drag?: StarMapCardDrag;
  /**
   * Label of another instance on the same physical machine. Two profiles of
   * one box report byte-identical load, and two cards showing the same
   * numbers reads as a bug unless the card says why.
   */
  sharedWith?: string;
  onDismiss: () => void;
}) {
  const load = props.load;
  const cpuTooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const [, setTick] = useState(0);

  // Staleness has to advance on its own: a peer that stops answering stops
  // re-rendering this card, and a frozen "just read" is exactly the lie the
  // stale state exists to prevent.
  useEffect(() => {
    if (!load) return;
    const timer = setInterval(() => setTick((value) => value + 1), STALE_TICK_MS);
    return () => clearInterval(timer);
  }, [load]);

  const left = props.baseSlot.dx + (props.offset?.dx ?? 0);
  const top = props.baseSlot.dy + (props.offset?.dy ?? 0);
  const style: CSSProperties = {
    width: props.width,
    left,
    top,
    marginLeft: -props.width / 2,
    ...(props.centered ? { transform: "translateY(-50%)" } : {}),
    zIndex: props.stackIndex,
  };

  const { startDrag } = useStarMapCardDrag({
    baseSlot: props.baseSlot,
    offset: props.offset,
    drag: props.drag,
  });

  const age = load ? Math.max(0, Date.now() - load.sampledAt) : 0;
  const stale = load ? age > STALE_AFTER_MS : false;
  // Node reports 0 for every load average on Windows, so three exact zeros
  // are "not reported", not an idle machine.
  const loadAvgReported = load
    ? load.loadAvg1 !== 0 || load.loadAvg5 !== 0 || load.loadAvg15 !== 0
    : false;
  /**
   * A load average is a queue length, not a percentage, and it means
   * nothing without the core count — 3.3 is idle on 16 cores and badly
   * oversubscribed on 2. Dividing by cores gives the figure an operator can
   * actually read at a glance, and it is allowed to exceed 100%: that is
   * precisely the "work is queueing" signal worth seeing.
   */
  const cpuValue = !load || !loadAvgReported
    ? "—"
    : load.cpuCount
      ? `${Math.round((load.loadAvg1 / load.cpuCount) * 100)}%`
      : load.loadAvg1.toFixed(2);
  const cpuDetail = !load
    ? ""
    : !loadAvgReported
      ? "This platform does not report load average"
      : `Load average ${load.loadAvg1.toFixed(2)} over 1 min${
          load.cpuCount ? ` across ${load.cpuCount} cores` : ""
        } · 5 min ${load.loadAvg5.toFixed(2)} · 15 min ${load.loadAvg15.toFixed(2)}`;

  return (
    <div
      className={`star-map-card-shell star-map-load-shell${
        stale ? " star-map-load-shell--stale" : ""
      }`}
      style={style}
      data-load-instance-id={props.instanceId}
      onPointerDown={startDrag}
    >
      <div className="star-map-load-card">
        <div className="star-map-load-card__head">
          <span className="star-map-load-card__eyebrow">Load</span>
          <button
            type="button"
            className="star-map-load-card__dismiss"
            aria-label={`Remove load card for ${props.instanceLabel}`}
            onClick={props.onDismiss}
          >
            ×
          </button>
        </div>
        {load ? (
          <>
            <dl className="star-map-load-card__metrics">
              <div>
                <dt>CPU</dt>
                <dd
                  aria-label={`CPU: ${cpuValue}. ${cpuDetail}`}
                  onMouseEnter={(event) =>
                    cpuTooltip.show(event.currentTarget, cpuDetail)
                  }
                  onMouseLeave={cpuTooltip.hide}
                  onFocus={(event) =>
                    cpuTooltip.show(event.currentTarget, cpuDetail)
                  }
                  onBlur={cpuTooltip.hide}
                  tabIndex={0}
                >
                  {cpuValue}
                </dd>
              </div>
              <div>
                <dt>Free RAM</dt>
                <dd>{formatByteCount(load.availableMemoryBytes)}</dd>
              </div>
              <div>
                <dt>Free disk</dt>
                <dd>
                  {load.diskFreeBytes !== undefined
                    ? formatByteCount(load.diskFreeBytes)
                    : "—"}
                </dd>
              </div>
            </dl>
            {stale ? (
              <span className="star-map-load-card__note" role="status">
                Not responding · last read {formatAge(age)}
              </span>
            ) : null}
          </>
        ) : (
          <span className="star-map-load-card__note">Reading…</span>
        )}
        {props.sharedWith ? (
          <span className="star-map-load-card__note">
            Same machine as {props.sharedWith}
          </span>
        ) : null}
      </div>
      {cpuTooltip.tooltipNode}
    </div>
  );
}
