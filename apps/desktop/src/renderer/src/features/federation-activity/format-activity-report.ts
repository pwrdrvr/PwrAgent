import type { FederationActivitySeries } from "@pwragent/shared";
import { formatTrafficBytes } from "./format-traffic-bytes";

export function formatActivityReport(series: FederationActivitySeries, view: string, since: number, at: number): string {
  const lines = ["Federation Activity", view, `Since: ${new Date(since).toISOString()}`,
    `Captured: ${new Date(at).toISOString()}`, ""];
  for (const direction of ["sent", "received"] as const) {
    lines.push(direction === "sent" ? "Sent traffic" : "Received traffic", "Traffic\tLast 1m\tLast 10m\tLast 1h\tTotal");
    for (const [key, label] of [
      ["requests", "Requests"], ["responses", "Responses (including errors)"],
      ["notifications", "Notifications"], ["other", "Other envelopes (including blobs)"],
      ["dataBytes", "Data (uncompressed)"], ["wireBytes", "Wire (encoded)"],
    ] as const) {
      lines.push([label, ...[series.windows["1m"], series.windows["10m"], series.windows["1h"], series.lifetime]
        .map((totals) => key === "dataBytes" || key === "wireBytes"
          ? `${formatTrafficBytes(totals[direction][key])} (${totals[direction][key]} bytes)`
          : String(totals[direction][key]))].join("\t"));
    }
    lines.push("");
  }
  lines.push("Request/response sizes (uncompressed, since start or reset)", "Traffic\tSamples\tAvg\tp50 (approx.)\tMin\tMax");
  for (const kind of ["requests", "responses"] as const) {
    for (const direction of ["sent", "received"] as const) {
      const stats = series.sizes[direction][kind];
      lines.push([`${direction} ${kind}`, stats.count,
        ...[stats.averageBytes, stats.p50Bytes, stats.minBytes, stats.maxBytes]
          .map((value) => value === undefined ? "—" : `${formatTrafficBytes(value)} (${value} bytes)`)].join("\t"));
    }
  }
  lines.push("", "p50 is estimated within about 1.1%. Responses include errors.",
    "Wire counts encoded WebSocket application-message payload bytes, including Noise tags; excludes WebSocket framing, handshakes, ping/pong/close, TCP/TLS/IP overhead.",
    "Physical connections count each hop; logical endpoints exclude transit. These are alternate views, not additive totals.");
  return lines.join("\n");
}
