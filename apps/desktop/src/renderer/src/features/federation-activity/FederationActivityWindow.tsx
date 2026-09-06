import { useEffect, useId, useState } from "react";
import type { FederationActivitySeries } from "@pwragent/shared";
import { useDesktopApi, type DesktopApi } from "../../lib/desktop-api";
import { formatTrafficBytes, trafficByteUnit } from "./format-traffic-bytes";
import { federationRuntimeLabel, useFederationActivity } from "./useFederationActivity";

type Period = "1m" | "10m" | "1h";
const PERIODS: Period[] = ["1m", "10m", "1h"];
const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
const fields = [
  ["requests", "Requests"], ["responses", "Responses (including errors)"],
  ["notifications", "Notifications"], ["other", "Other envelopes (including blobs)"],
  ["dataBytes", "Data · uncompressed"], ["wireBytes", "Wire · encoded"],
] as const;

function Totals({ series }: { series: FederationActivitySeries }) {
  const periods = [series.windows["1m"], series.windows["10m"], series.windows["1h"], series.lifetime];
  return <div className="federation-activity__tables">
    {(["sent", "received"] as const).map((direction) => (
      <table className="federation-activity__totals" key={direction}>
        <caption>{direction === "sent" ? "Sent traffic" : "Received traffic"}</caption>
        <thead><tr><th scope="col">Traffic</th>
          <th scope="col">Last 1m</th><th scope="col">Last 10m</th>
          <th scope="col">Last 1h</th><th scope="col">Total</th>
        </tr></thead>
        <tbody>{fields.map(([key, label]) => <tr key={key}><th scope="row">{label}</th>
          {periods.map((period, index) => {
            const value = period[direction][key];
            const bytes = key === "dataBytes" || key === "wireBytes";
            return <td key={index} title={bytes ? `${number(value)} bytes` : undefined}>
              {bytes ? formatTrafficBytes(value) : number(value)}
            </td>;
          })}
        </tr>)}</tbody>
      </table>
    ))}
  </div>;
}

function PayloadSizes({ series }: { series: FederationActivitySeries }) {
  return <div className="federation-activity__tables">
    <table className="federation-activity__totals federation-activity__sizes">
      <caption>Lifetime request/response sizes · uncompressed</caption>
      <thead><tr><th scope="col">Traffic</th><th scope="col">Samples</th>
        <th scope="col">Avg</th>
        <th scope="col" title="Estimated nearest-rank median; logarithmic buckets within about 1.1%">p50 ≈</th>
        <th scope="col">Min</th><th scope="col">Max</th>
      </tr></thead>
      <tbody>{(["requests", "responses"] as const).flatMap((kind) =>
        (["sent", "received"] as const).map((direction) => {
          const stats = series.sizes[direction][kind];
          return <tr key={`${direction}-${kind}`}>
            <th scope="row">{direction === "sent" ? "Sent" : "Received"} {kind}</th>
            <td>{number(stats.count)}</td>
            {[stats.averageBytes, stats.p50Bytes, stats.minBytes, stats.maxBytes].map((value, index) =>
              <td key={index} title={value === undefined ? "No samples" : `${number(value)} bytes`}>
                {value === undefined ? "—" : formatTrafficBytes(value)}
              </td>)}
          </tr>;
        }))}</tbody>
    </table>
    <p className="federation-activity__muted">Across this process lifetime for the selected traffic view.
      Responses include errors. p50 is an estimate within about 1.1%; no payloads are retained.</p>
  </div>;
}

export function FederationRateChart({ history, period, bytes }: {
  history: FederationActivitySeries["history"]; period: Period; bytes: boolean;
}) {
  const id = useId();
  const length = period === "1m" ? 6 : period === "10m" ? 60 : 360;
  const points = history.slice(-length);
  const lines = bytes ? [
    { direction: "sent", field: "wireBytes", label: "Sent wire", dashed: false },
    { direction: "received", field: "wireBytes", label: "Received wire", dashed: false },
    { direction: "sent", field: "dataBytes", label: "Sent data", dashed: true },
    { direction: "received", field: "dataBytes", label: "Received data", dashed: true },
  ] as const : [
    { direction: "sent", field: "events", label: "Sent", dashed: false },
    { direction: "received", field: "events", label: "Received", dashed: false },
  ] as const;
  const values = lines.map((line) => points.map(({ totals }) => {
    const value = totals[line.direction];
    return (line.field === "events" ? value.requests + value.responses + value.notifications + value.other
      : value[line.field]) / 10;
  }));
  const max = Math.max(0, ...values.flat()) || 1;
  const byteUnit = trafficByteUnit(max);
  const scale = bytes ? byteUnit.scale : 1;
  const unit = bytes ? `${byteUnit.unit}/s` : "envelopes/s";
  const axisNumber = (value: number) => value.toLocaleString(undefined, { maximumSignificantDigits: 3 });
  return <figure className="federation-activity__chart">
    <figcaption>{bytes ? "Data and wire rate" : "Envelope rate"} · {unit}</figcaption>
    <svg viewBox="0 0 640 165" role="img" aria-labelledby={`${id}-title ${id}-description`}>
      <title id={`${id}-title`}>{bytes ? "Data and wire" : "Envelope"} rates, {unit}</title>
      <desc id={`${id}-description`}>Ten-second averages. Peak {axisNumber(max / scale)} {unit}. Sent uses the accent line,
        received uses the neutral line. Dashed lines show uncompressed data.</desc>
      <text x="87" y="12" textAnchor="end">{unit}</text>
      {[0, 0.5, 1].map((fraction) => <g key={fraction}>
        <line x1="95" x2="630" y1={130 - fraction * 110} y2={130 - fraction * 110} className="federation-activity__grid" />
        <text x="87" y={134 - fraction * 110} textAnchor="end">{axisNumber(max * fraction / scale)}</text>
      </g>)}
      {lines.map((line, index) => <polyline key={line.label}
        className={`federation-activity__line federation-activity__line--${line.direction}`}
        strokeDasharray={line.dashed ? "5 4" : undefined}
        points={values[index].map((value, point) => `${95 + point * 535 / Math.max(1, points.length - 1)},${130 - value / max * 110}`).join(" ")} />)}
      <text x="95" y="155">{period} ago</text>
      <text x="630" y="155" textAnchor="end">Now</text>
    </svg>
    <div className="federation-activity__legend">{lines.map((line) => <span key={line.label}
      className={`federation-activity__legend--${line.direction}`}>
      {line.dashed ? "┄" : "━"} {line.label}</span>)}</div>
  </figure>;
}

export function FederationActivityScreen({ desktopApi }: { desktopApi?: DesktopApi }) {
  const [period, setPeriod] = useState<Period>("1m");
  const [view, setView] = useState<"physical" | "logical">("physical");
  const [peerId, setPeerId] = useState("");
  const [topmost, setTopmost] = useState(false);
  const [topmostPending, setTopmostPending] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const { snapshot, error, pending, toggle } = useFederationActivity(desktopApi, true, {
    historyPeerId: peerId || undefined, historyView: view,
  });
  const peers = snapshot ? view === "physical" ? snapshot.activity.peers : snapshot.activity.logical : [];
  const series = peerId ? peers.find((peer) => peer.peerId === peerId)?.series : snapshot?.activity.physical;
  const labelFor = (id: string) => snapshot?.health.peers.find((peer) => peer.id === id)?.label || id;
  return <div className="federation-activity">
    <div className="federation-activity__toolbar">
      <div><strong>{snapshot ? federationRuntimeLabel(snapshot) : "Loading Federation activity…"}</strong>
        {snapshot ? <p>Configured {snapshot.configuredMode === "disabled" ? "off" : `on · ${snapshot.configuredMode}`}</p> : null}</div>
      <button type="button" role="switch" aria-label="Federation enabled"
        aria-checked={Boolean(snapshot && snapshot.configuredMode !== "disabled")}
        disabled={!snapshot || pending || !desktopApi?.setFederationEnabled} onClick={() => void toggle()}>
        Federation {snapshot?.configuredMode === "disabled" ? "off" : "on"}
      </button>
      <label><input type="checkbox" checked={topmost} disabled={topmostPending || !desktopApi?.setFederationActivityTopmost}
        onChange={(event) => {
          const enabled = event.target.checked;
          setTopmostPending(true);
          void desktopApi?.setFederationActivityTopmost?.(enabled).then(setTopmost).catch((cause: unknown) => {
            setActionError(cause instanceof Error ? cause.message : String(cause));
          }).finally(() => setTopmostPending(false));
        }} /> Always on top</label>
    </div>
    {snapshot?.health.leaseHolder ? <p>Lease holder: {snapshot.health.leaseHolder.instanceId}
      {snapshot.health.leaseHolder.processId ? ` · PID ${snapshot.health.leaseHolder.processId}` : ""}
      {snapshot.health.leaseHolder.cwdHint ? ` · ${snapshot.health.leaseHolder.cwdHint}` : ""}</p> : null}
    {snapshot?.health.unavailableReason ? <p>{snapshot.health.unavailableReason}</p> : null}
    {error || actionError ? <p role="alert">{error || actionError}</p> : null}
    <div className="federation-activity__toolbar">
      <label>Attribution <select value={view} onChange={(event) => {
        const next = event.target.value as "physical" | "logical";
        setView(next); setPeerId(next === "logical" ? snapshot?.activity.logical[0]?.peerId || "" : "");
      }}><option value="physical">Physical connections</option><option value="logical">Logical endpoints</option></select></label>
      <label>Peer <select value={peerId} onChange={(event) => setPeerId(event.target.value)}>
        {view === "physical" ? <option value="">All physical connections</option> : <option value="" disabled>Select an endpoint</option>}
        {peers.map((peer) => <option value={peer.peerId} key={peer.peerId}>{labelFor(peer.peerId)}</option>)}
      </select></label>
      <label>Chart window <select value={period} onChange={(event) => setPeriod(event.target.value as Period)}>
        {PERIODS.map((value) => <option key={value} value={value}>{value}</option>)}
      </select></label>
    </div>
    <p className="federation-activity__muted">{view === "physical"
      ? "Each direct or gateway connection counts its own transfers. A relayed envelope crosses two connections at a gateway."
      : "Only traffic sent or received by this instance as an endpoint; transit forwarding is excluded. This is an alternate view, not extra traffic."}</p>
    {series && (view === "physical" || peerId) ? <>
      <FederationRateChart history={series.history} period={period} bytes />
      <FederationRateChart history={series.history} period={period} bytes={false} />
      <Totals series={series} />
      <PayloadSizes series={series} />
    </> : <p>No endpoint traffic recorded.</p>}
    {snapshot ? <p className="federation-activity__muted">Process totals since {new Date(snapshot.activity.since).toLocaleString()}.
      Rolling totals have one-second resolution; charts show ten-second averages for up to one hour.</p> : null}
    <details className="federation-activity__boundaries"><summary>What is measured</summary>
      <p>Data is the serialized envelope before compression and encryption, including its protocol metadata and binary blob data.
        Wire is the encoded WebSocket application-message payload, including Noise authentication tags when present.
        It excludes WebSocket headers, TCP/TLS overhead, handshake/authentication messages and WebSocket ping, pong and close frames.</p>
      <p>Requests, responses (including errors), notifications and blob chunks count once per successful transport send
        or decoded receive. Sends mean accepted by the local socket, not acknowledged delivery. Broadcasts count each endpoint delivery.
        Logical byte totals describe the endpoint’s physical hop, not the complete route.</p>
      <p>Only numeric aggregates are retained in memory. History is limited to one hour and 32 named peers per view;
        additional peers are combined under Other peers. Lifetime totals survive reconnects and reset when the app process exits.</p>
    </details>
  </div>;
}

export function FederationActivityWindow() {
  const desktopApi = useDesktopApi();
  useEffect(() => { document.title = "Federation Activity"; }, []);
  return <div className="messaging-activity-window"><section aria-label="Federation activity" className="activity-screen">
    <header className="activity-titlebar">
      <p className="activity-titlebar__brand">Pwr<span className="activity-titlebar__brand-accent">Agent</span></p>
      <div className="activity-titlebar__breadcrumb"><span className="activity-titlebar__eyebrow">Federation</span>
        <span aria-hidden="true" className="activity-titlebar__separator">›</span>
        <span className="activity-titlebar__current">Activity</span></div>
      <div className="activity-titlebar__spacer" />
    </header>
    <div className="activity-content federation-activity-content"><FederationActivityScreen desktopApi={desktopApi} /></div>
  </section></div>;
}
