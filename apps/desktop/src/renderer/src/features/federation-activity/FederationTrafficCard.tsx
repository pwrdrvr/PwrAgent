import { useId } from "react";
import type { FederationActivitySeries } from "@pwragent/shared";
import { formatTrafficBytes } from "./format-traffic-bytes";

/** Seconds the popover draws; the read asks for exactly this much history. */
export const FEDERATION_TRAFFIC_CARD_SECONDS = 60;

const COLUMN = 10;
const HALF = 26;

/**
 * The last minute of wire bytes as one-second bars: sent above the line in
 * the accent, received below in neutral. The Activity window keeps data vs
 * wire and envelope counts; this answers only "is anything moving".
 */
export function FederationTrafficCard(props: {
  series: FederationActivitySeries;
  onOpen?: () => void;
}) {
  const numbersId = useId();
  const points = props.series.history.slice(-FEDERATION_TRAFFIC_CARD_SECONDS);
  const minute = props.series.windows["1m"];
  const max = Math.max(1, ...points.flatMap((point) =>
    [point.totals.sent.wireBytes, point.totals.received.wireBytes]));
  const height = (value: number) => value <= 0 ? 0 : Math.max(1.5, (value / max) * HALF);
  const sent = formatTrafficBytes(minute.sent.wireBytes);
  const received = formatTrafficBytes(minute.received.wireBytes);
  return <button type="button" className="federation-traffic" disabled={!props.onOpen}
    aria-label="Open Federation Activity" aria-describedby={numbersId}
    onClick={props.onOpen}>
    <span className="federation-traffic__head">
      <span className="federation-traffic__title">Traffic · last 60 seconds</span>
      <span className="federation-traffic__nums" id={numbersId}>
        <span className="federation-traffic__sent">↑ {sent} sent</span>{" "}
        <span>↓ {received} received</span>
      </span>
    </span>
    <svg aria-hidden="true" className="federation-traffic__bars"
      viewBox={`0 0 ${FEDERATION_TRAFFIC_CARD_SECONDS * COLUMN} ${HALF * 2 + 1}`} preserveAspectRatio="none">
      <line x1="0" x2={FEDERATION_TRAFFIC_CARD_SECONDS * COLUMN} y1={HALF + 0.5} y2={HALF + 0.5}
        className="federation-traffic__axis" />
      {points.map((point, index) => {
        // Right-aligned, so a history shorter than a minute ends at "now".
        const x = (FEDERATION_TRAFFIC_CARD_SECONDS - points.length + index) * COLUMN + 1;
        const up = height(point.totals.sent.wireBytes);
        const down = height(point.totals.received.wireBytes);
        return <g key={point.at}>
          {up > 0 ? <rect className="federation-traffic__up" x={x} y={HALF - up} width={COLUMN - 2} height={up} /> : null}
          {down > 0 ? <rect className="federation-traffic__down" x={x} y={HALF + 1} width={COLUMN - 2} height={down} /> : null}
        </g>;
      })}
    </svg>
    <span className="federation-traffic__axis-labels" aria-hidden="true">
      <span>60s ago</span><span>Open Federation Activity ↗</span><span>now</span>
    </span>
  </button>;
}
