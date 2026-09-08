import { useEffect, useId, useRef, useState } from "react";
import { FederationConnections } from "./FederationConnections";
import { CheckIcon, CopyIcon } from "../../icons";
import { copyText } from "../../lib/copy-text";
import { formatActivityReport } from "./format-activity-report";
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
    <p className="federation-activity__muted">Since start or reset for the selected traffic view.
      Responses include errors. p50 is an estimate within about 1.1%; no payloads are retained.</p>
  </div>;
}

export function FederationAmountChart({ history, period, bytes }: {
  history: FederationActivitySeries["history"]; period: Period; bytes: boolean;
}) {
  const id = useId();
  const length = period === "1m" ? 60 : period === "10m" ? 600 : 3600;
  const [selectedAt, setSelectedAt] = useState<number>();
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollLeft = element.scrollWidth;
    setSelectedAt(undefined);
  }, [period]);
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
      : value[line.field]);
  }));
  const max = Math.max(0, ...values.flat()) || 1;
  const byteUnit = trafficByteUnit(max);
  const scale = bytes ? byteUnit.scale : 1;
  const unit = bytes ? byteUnit.unit : "envelopes";
  const axisNumber = (value: number) => value.toLocaleString(undefined, { maximumSignificantDigits: 3 });
  const width = Math.max(545, length * 8 + 10);
  const step = (width - 10) / length;
  const selectedIndex = points.findIndex((point) => point.at === selectedAt);
  const selected = points[selectedIndex];
  const time = (at: number) => new Date(at).toLocaleTimeString();
  return <figure className="federation-activity__chart">
    <figcaption>{bytes ? "Data and wire" : "Envelopes"} · {unit} per one-second bar</figcaption>
    <div className="federation-activity__chart-frame">
    <svg className="federation-activity__chart-axis" viewBox="0 0 95 165" aria-hidden="true">
      <text x="87" y="12" textAnchor="end">{unit}</text>
      {[0, 0.5, 1].map((fraction) => <text key={fraction} x="87"
        y={134 - fraction * 110} textAnchor="end">{axisNumber(max * fraction / scale)}</text>)}
    </svg>
    <div className="federation-activity__chart-scroll" ref={scrollRef}>
    <svg viewBox={`0 0 ${width} 165`} style={{ minWidth: width }} preserveAspectRatio="none" role="img" tabIndex={0}
      aria-labelledby={`${id}-title ${id}-description`} aria-describedby={selected ? `${id}-tooltip` : undefined}
      onPointerMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const index = Math.floor(((event.clientX - bounds.left) * width / bounds.width) / step);
        setSelectedAt(points[index]?.at);
      }}
      onPointerLeave={() => setSelectedAt(undefined)} onBlur={() => setSelectedAt(undefined)}
      onFocus={() => setSelectedAt(points.at(-1)?.at)}
      onKeyDown={(event) => {
        if (event.key === "Escape") { setSelectedAt(undefined); return; }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const index = Math.max(0, Math.min(points.length - 1,
          (selectedIndex < 0 ? points.length - 1 : selectedIndex) + (event.key === "ArrowLeft" ? -1 : 1)));
        setSelectedAt(points[index]?.at);
        if (scrollRef.current) scrollRef.current.scrollLeft = index * step - 150;
      }}>
      <title id={`${id}-title`}>{bytes ? "Data and wire" : "Envelope"} amounts, {unit}</title>
      <desc id={`${id}-description`}>One-second totals. Peak {axisNumber(max / scale)} {unit}.
        Sent uses accent bars; received uses neutral bars. Faded bars show uncompressed data.
        Hover or use left and right arrow keys for exact amounts. The latest second may be incomplete.</desc>
      {[0, 0.5, 1].map((fraction) => <line key={fraction}
        x1="0" x2={width - 10} y1={130 - fraction * 110} y2={130 - fraction * 110}
        className="federation-activity__grid" />)}
      {lines.map((line, index) => <path key={line.label}
        className={`federation-activity__bar federation-activity__bar--${line.direction}`}
        opacity={line.dashed ? 0.4 : 1}
        d={values[index].map((value, point) => {
          if (value <= 0) return "";
          const x = point * step + index * step / lines.length;
          const height = value / max * 110;
          return `M${x},130v${-height}h${step / lines.length - 0.5}v${height}Z`;
        }).join(" ")} />)}
      {selected ? <rect x={selectedIndex * step} y="20" width={step} height="110"
        className="federation-activity__selection" /> : null}
      <text x="0" y="155">{period} ago</text>
      <text x={width - 10} y="155" textAnchor="end">Now</text>
    </svg>
    </div>
    </div>
    <div className="federation-activity__legend">{lines.map((line) => <span key={line.label}
      className={`federation-activity__legend--${line.direction}`}>
      <span style={{ opacity: line.dashed ? 0.4 : 1 }}>■</span> {line.label}</span>)}</div>
    <div className="federation-activity__chart-detail">
      {selected ? <div role="tooltip" id={`${id}-tooltip`}>
        <strong>{time(selected.at)} – {time(selected.at + 1000)}</strong>
        {selectedIndex === points.length - 1 ? " · In progress" : ""}
        <div>{lines.map((line, index) => <span key={line.label}>
          {line.label}: {bytes ? `${number(values[index][selectedIndex])} bytes` : number(values[index][selectedIndex])}
        </span>)}</div>
      </div> : <span>Hover a bar or focus the chart and use ← → for amounts. Scroll to see earlier seconds.</span>}
    </div>
  </figure>;
}

export function FederationActivityScreen({ desktopApi }: { desktopApi?: DesktopApi }) {
  const [period, setPeriod] = useState<Period>("1m");
  const [view, setView] = useState<"physical" | "logical">("physical");
  const [peerId, setPeerId] = useState("");
  const [topmost, setTopmost] = useState(false);
  const [topmostPending, setTopmostPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyPending, setCopyPending] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);
  const [actionError, setActionError] = useState<string>();
  const { snapshot, error, pending, toggle, reset } = useFederationActivity(desktopApi, true, {
    historyPeerId: peerId || undefined, historyView: view,
  });
  const peers = snapshot ? view === "physical" ? snapshot.activity.peers : snapshot.activity.logical : [];
  const series = peerId ? peers.find((peer) => peer.peerId === peerId)?.series : snapshot?.activity.physical;
  const enabled = Boolean(snapshot?.running);
  const labelFor = (id: string) => snapshot?.health.peers.find((peer) => peer.id === id)?.label || id;
  return <div className="federation-activity">
    <div className="federation-activity__toolbar">
      <div><strong>{snapshot ? federationRuntimeLabel(snapshot) : "Loading Federation activity…"}</strong>
        {snapshot ? <p>Configured {snapshot.configuredMode === "disabled" ? "off" : `on · ${snapshot.configuredMode}`}</p> : null}</div>
      <button type="button" role="switch" aria-label="Federation enabled"
        title="Turn Federation on or off for this app instance only"
        aria-checked={enabled}
        className={`settings-switch messaging-status-popover__switch${enabled ? " is-on" : ""}`}
        disabled={!snapshot || pending || !desktopApi?.setFederationEnabled} onClick={() => void toggle()}>
        <span className="settings-switch__track" aria-hidden="true"><span className="settings-switch__thumb" /></span>
        <span>{enabled ? "On" : "Off"}</span>
      </button>
      <label><input type="checkbox" checked={topmost} disabled={topmostPending || !desktopApi?.setFederationActivityTopmost}
        onChange={(event) => {
          const enabled = event.target.checked;
          setTopmostPending(true);
          void desktopApi?.setFederationActivityTopmost?.(enabled).then(setTopmost).catch((cause: unknown) => {
            setActionError(cause instanceof Error ? cause.message : String(cause));
          }).finally(() => setTopmostPending(false));
        }} /> Always on top</label>
      <button type="button" disabled={pending || !desktopApi?.resetFederationActivity}
        title="Clear all Federation activity totals, size statistics and history for every peer"
        onClick={() => { setCopied(false); void reset(); }}>Reset</button>
      <button type="button" aria-label="Copy Federation activity" title={copied ? "Copied" : "Copy selected activity view"}
        disabled={!snapshot || !series || (view === "logical" && !peerId) || copyPending}
        onClick={() => {
          if (!snapshot || !series) return;
          setCopyPending(true);
          setActionError(undefined);
          void copyText(formatActivityReport(series,
            `${view === "physical" ? "Physical connections" : "Logical endpoint"}: ${peerId ? labelFor(peerId) : "All physical connections"}`,
            snapshot.activity.since, snapshot.activity.at), desktopApi)
            .then(() => setCopied(true))
            .catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause)))
            .finally(() => setCopyPending(false));
        }}>
        {copied ? <CheckIcon size={16} aria-hidden="true" /> : <CopyIcon size={16} aria-hidden="true" />}
      </button>
      <span role="status" className="federation-activity__muted">{copied ? "Federation activity copied" : ""}</span>
    </div>
    {snapshot ? <FederationConnections health={snapshot.health} /> : null}
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
    <p className="federation-activity__muted">Sent counts bytes accepted by the local socket; it does not confirm delivery.</p>
    {series && (view === "physical" || peerId) ? <>
      <FederationAmountChart history={series.history} period={period} bytes />
      <FederationAmountChart history={series.history} period={period} bytes={false} />
      <Totals series={series} />
      <PayloadSizes series={series} />
    </> : <p>No endpoint traffic recorded.</p>}
    {snapshot ? <p className="federation-activity__muted">Totals since {new Date(snapshot.activity.since).toLocaleString()}.
      Charts show amounts recorded in each second for up to one hour. The latest second is still in progress.</p> : null}
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
