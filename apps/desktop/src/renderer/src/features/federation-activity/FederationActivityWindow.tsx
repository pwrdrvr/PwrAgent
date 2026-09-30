import { FEDERATION_CAPTURE_DESCRIPTION, FederationCaptureTag } from "./FederationTrafficCapture";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { FederationConnections } from "./FederationConnections";
import { CheckIcon, CopyIcon } from "../../icons";
import { copyText } from "../../lib/copy-text";
import { formatActivityReport } from "./format-activity-report";
import type { FederationActivitySeries } from "@pwragent/shared";
import { useDesktopApi, type DesktopApi } from "../../lib/desktop-api";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import { useDismissOnOutsidePointer } from "../../lib/useDismissOnOutsidePointer";
import { PinIcon } from "../../icons";
import { FederationPeerFilter, federationPeerFilterChips } from "./FederationPeerFilter";
import { formatTrafficBytes, trafficByteUnit } from "./format-traffic-bytes";
import { federationRuntimeLabel, useFederationActivity } from "./useFederationActivity";
import { BrandLockup } from "../chrome/BrandLockup";

type Period = "1m" | "10m" | "1h";
const PERIODS: Period[] = ["1m", "10m", "1h"];
const number = (value: number) => Math.trunc(value).toLocaleString();
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

/**
 * One mirrored chart: sent bars rise from the axis in the accent, received
 * bars hang below it in neutral, the same shape as the popover's traffic
 * card. Bytes charts show wire bytes only; data (uncompressed) bytes live in
 * the tables, so no bar needs a legend entry for fading.
 */
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
  const lines = [
    { direction: "sent", label: bytes ? "Sent wire" : "Sent" },
    { direction: "received", label: bytes ? "Received wire" : "Received" },
  ] as const;
  const values = lines.map((line) => points.map(({ totals }) => {
    const value = totals[line.direction];
    return bytes ? value.wireBytes : value.requests + value.responses + value.notifications + value.other;
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
  const title = bytes ? "Wire bytes" : "Envelopes";
  return <figure className="federation-activity__chart">
    <figcaption>{title} · {unit} per second
      <span className="federation-activity__muted"> · sent above, received below</span></figcaption>
    <div className="federation-activity__chart-frame">
    <svg className="federation-activity__chart-axis" viewBox="0 0 95 165" aria-hidden="true">
      <text x="87" y="12" textAnchor="end">{unit}</text>
      {[1, 0, -1].map((fraction) => <text key={fraction} x="87"
        y={CHART_AXIS - fraction * CHART_HALF + 4} textAnchor="end">{axisNumber(max * Math.abs(fraction) / scale)}</text>)}
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
      <title id={`${id}-title`}>{bytes ? "Wire byte" : "Envelope"} amounts, {unit}</title>
      <desc id={`${id}-description`}>One-second totals. Peak {axisNumber(max / scale)} {unit}.
        Sent rises above the axis in accent bars; received hangs below it in neutral bars.
        Hover or use left and right arrow keys for exact amounts. The latest second may be incomplete.</desc>
      {[1, 0, -1].map((fraction) => <line key={fraction}
        x1="0" x2={width - 10} y1={CHART_AXIS - fraction * CHART_HALF} y2={CHART_AXIS - fraction * CHART_HALF}
        className={fraction === 0 ? "federation-activity__axis" : "federation-activity__grid"} />)}
      {lines.map((line, index) => <path key={line.label}
        className={`federation-activity__bar federation-activity__bar--${line.direction}`}
        d={values[index].map((value, point) => {
          if (value <= 0) return "";
          const x = point * step + 0.5;
          const height = Math.max(1, value / max * CHART_HALF);
          return line.direction === "sent"
            ? `M${x},${CHART_AXIS}v${-height}h${step - 1}v${height}Z`
            : `M${x},${CHART_AXIS + 1}v${height}h${step - 1}v${-height}Z`;
        }).join(" ")} />)}
      {selected ? <rect x={selectedIndex * step} y={CHART_AXIS - CHART_HALF} width={step} height={CHART_HALF * 2 + 1}
        className="federation-activity__selection" /> : null}
      <text x="0" y="160">{period} ago</text>
      <text x={width - 10} y="160" textAnchor="end">Now</text>
    </svg>
    </div>
    </div>
    <div className="federation-activity__chart-detail">
      {selected ? <div role="tooltip" id={`${id}-tooltip`}>
        <strong>{time(selected.at)} – {time(selected.at + 1000)}</strong>
        {selectedIndex === points.length - 1 ? " · In progress" : ""}
        {lines.map((line, index) => <span key={line.label}
          className={`federation-activity__legend--${line.direction}`}>
          {line.label}: {bytes ? `${number(values[index][selectedIndex])} bytes` : number(values[index][selectedIndex])}
        </span>)}
      </div> : <div className="federation-activity__legend">{lines.map((line) => <span key={line.label}
        className={`federation-activity__legend--${line.direction}`}>
        <span aria-hidden="true">■</span> {line.label}</span>)}
        <span>Hover a bar or focus the chart and use ← → for amounts.</span></div>}
    </div>
  </figure>;
}

/** Plot geometry shared by the mirrored charts, in viewBox units. */
const CHART_AXIS = 80;
const CHART_HALF = 58;

/** The selected view's last minute as four numbers, above the charts. */
function MinuteStrip({ series }: { series: FederationActivitySeries }) {
  const minute = series.windows["1m"];
  const both = (key: "requests" | "responses") => minute.sent[key] + minute.received[key];
  const stats = [
    { label: "Sent", value: formatTrafficBytes(minute.sent.wireBytes), title: `${number(minute.sent.wireBytes)} wire bytes` },
    { label: "Received", value: formatTrafficBytes(minute.received.wireBytes), title: `${number(minute.received.wireBytes)} wire bytes` },
    { label: "Requests", value: number(both("requests")),
      title: `${number(minute.sent.requests)} sent · ${number(minute.received.requests)} received` },
    { label: "Responses", value: number(both("responses")),
      title: `${number(minute.sent.responses)} sent · ${number(minute.received.responses)} received, including errors` },
  ];
  return <dl className="federation-activity__minute">
    {stats.map((stat) => <div key={stat.label} title={stat.title}>
      <dt>{stat.label} · 1m</dt><dd>{stat.value}</dd>
    </div>)}
  </dl>;
}

export function FederationActivityScreen({ desktopApi }: { desktopApi?: DesktopApi }) {
  const [period, setPeriod] = useState<Period>("1m");
  const [view, setView] = useState<"physical" | "logical">("physical");
  const [peerId, setPeerId] = useState("");
  const [topmost, setTopmost] = useState(false);
  const [topmostPending, setTopmostPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyPending, setCopyPending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const menuAnchor = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useMenuNavigation({ open: menuOpen, menuRef: menu, triggerRef: menuButton, onClose: closeMenu });
  useDismissOnOutsidePointer(menuOpen, menuAnchor, closeMenu);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);
  const [actionError, setActionError] = useState<string>();
  const { snapshot, error, pending, toggle, reset, capture } = useFederationActivity(desktopApi, true, {
    historyPeerId: peerId || undefined, historyView: view,
  });
  const peers = snapshot ? view === "physical" ? snapshot.activity.peers : snapshot.activity.logical : [];
  const series = peerId ? peers.find((peer) => peer.peerId === peerId)?.series : snapshot?.activity.physical;
  const enabled = Boolean(snapshot?.running);
  const capturing = Boolean(snapshot?.detailedLoggingUntil);
  const chips = snapshot ? federationPeerFilterChips(snapshot.health, peers) : [];
  const labelFor = (id: string) => chips.find((chip) => chip.instanceId === id)?.label || id;
  const fail = (cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause));
  const selectView = (next: "physical" | "logical") => {
    setView(next); setPeerId(next === "logical" ? snapshot?.activity.logical[0]?.peerId || "" : "");
  };
  const canCopy = Boolean(snapshot && series && (view === "physical" || peerId) && !copyPending);
  const copyActivity = () => {
    if (!snapshot || !series) return;
    setCopyPending(true);
    setActionError(undefined);
    void copyText(formatActivityReport(series,
      `${view === "physical" ? "Physical connections" : "Logical endpoint"}: ${peerId ? labelFor(peerId) : "All physical connections"}`,
      snapshot.activity.since, snapshot.activity.at), desktopApi)
      .then(() => setCopied(true))
      .catch(fail)
      .finally(() => setCopyPending(false));
  };
  return <div className="federation-activity">
    <div className="federation-activity__head">
      <div className="federation-activity__state">
        <strong>{snapshot ? federationRuntimeLabel(snapshot) : "Loading Federation activity…"}</strong>
        <FederationCaptureTag until={snapshot?.detailedLoggingUntil} />
        {snapshot ? <p>Configured {snapshot.configuredMode === "disabled" ? "off" : `on · ${snapshot.configuredMode}`}</p> : null}
      </div>
      <div className="federation-activity__tools">
        <button type="button" role="switch" aria-label="Federation enabled"
          title="Turn Federation on or off for this app instance only"
          aria-checked={enabled}
          className={`settings-switch messaging-status-popover__switch${enabled ? " is-on" : ""}`}
          disabled={!snapshot || pending || !desktopApi?.setFederationEnabled} onClick={() => void toggle()}>
          <span className="settings-switch__track" aria-hidden="true"><span className="settings-switch__thumb" /></span>
          <span>{enabled ? "On" : "Off"}</span>
        </button>
        <button type="button" className="messaging-status-popover__settings federation-activity__pin"
          aria-label="Always on top" aria-pressed={topmost} title="Keep this window above other windows"
          disabled={topmostPending || !desktopApi?.setFederationActivityTopmost}
          onClick={() => {
            setTopmostPending(true);
            void desktopApi?.setFederationActivityTopmost?.(!topmost).then(setTopmost).catch(fail)
              .finally(() => setTopmostPending(false));
          }}>
          <PinIcon size={14} aria-hidden="true" />
        </button>
        <div ref={menuAnchor} className="federation-status-control__menu-anchor">
          <button ref={menuButton} type="button" className="messaging-status-popover__settings"
            aria-label="More Federation Activity actions" aria-haspopup="menu" aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            onClick={() => setMenuOpen((value) => !value)}>
            <span aria-hidden="true">⋯</span>
          </button>
          {menuOpen ? <div ref={menu} id={menuId} role="menu" aria-label="Federation Activity actions"
            tabIndex={-1} className="federation-status-control__menu">
            <button type="button" role="menuitem" className="federation-status-control__menu-item"
              disabled={!canCopy}
              onClick={() => { setMenuOpen(false); menuButton.current?.focus(); copyActivity(); }}>
              Copy Federation activity
              {copied ? <CheckIcon size={12} aria-hidden="true" /> : <CopyIcon size={12} aria-hidden="true" />}
            </button>
            <button type="button" role="menuitemcheckbox" aria-checked={capturing}
              className="federation-status-control__menu-item" title={FEDERATION_CAPTURE_DESCRIPTION}
              disabled={!snapshot || pending || !desktopApi?.setFederationTrafficCapture}
              onClick={() => { void capture(!capturing); }}>
              Capture previous + next 60 seconds
              <span aria-hidden="true" className="federation-status-control__menu-check">{capturing ? "✓" : ""}</span>
            </button>
            <button type="button" role="menuitem" className="federation-status-control__menu-item"
              title="Clear all Federation activity totals, size statistics and history for every peer"
              disabled={pending || !desktopApi?.resetFederationActivity}
              onClick={() => { setMenuOpen(false); menuButton.current?.focus(); setCopied(false); void reset(); }}>
              Reset all activity</button>
          </div> : null}
        </div>
      </div>
      <span role="status" className="federation-activity__muted">{copied ? "Federation activity copied" : ""}</span>
    </div>
    {snapshot?.health.leaseHolder ? <p>Lease holder: {snapshot.health.leaseHolder.instanceId}
      {snapshot.health.leaseHolder.processId ? ` · PID ${snapshot.health.leaseHolder.processId}` : ""}
      {snapshot.health.leaseHolder.cwdHint ? ` · ${snapshot.health.leaseHolder.cwdHint}` : ""}</p> : null}
    {snapshot?.health.unavailableReason ? <p>{snapshot.health.unavailableReason}</p> : null}
    {error || actionError ? <p role="alert">{error || actionError}</p> : null}
    {chips.length || view === "physical"
      ? <FederationPeerFilter chips={chips} peers={peers} selected={peerId}
        allowAll={view === "physical"} onSelect={setPeerId} />
      : null}
    <div className="federation-activity__controls">
      <span className="usage-segmented" role="group" aria-label="Attribution">
        <button type="button" aria-pressed={view === "physical"} title="Each direct or gateway connection"
          onClick={() => selectView("physical")}>Connections</button>
        <button type="button" aria-pressed={view === "logical"} title="Only traffic this instance sent or received as an endpoint"
          onClick={() => selectView("logical")}>Endpoints</button>
      </span>
      <span className="usage-segmented" role="group" aria-label="Chart window">
        {PERIODS.map((value) => <button type="button" key={value} aria-pressed={period === value}
          onClick={() => setPeriod(value)}>{value}</button>)}
      </span>
      {snapshot ? <FederationConnections health={snapshot.health} collapsible /> : null}
    </div>
    {series && (view === "physical" || peerId) ? <>
      <MinuteStrip series={series} />
      <FederationAmountChart history={series.history} period={period} bytes />
      <FederationAmountChart history={series.history} period={period} bytes={false} />
      <Totals series={series} />
      <PayloadSizes series={series} />
    </> : <p>No endpoint traffic recorded.</p>}
    {snapshot ? <p className="federation-activity__muted">Totals since {new Date(snapshot.activity.since).toLocaleString()}.
      Charts show wire bytes and envelopes recorded in each second for up to one hour; the tables
      also show uncompressed data bytes. The latest second is still in progress.</p> : null}
    <details className="federation-activity__boundaries"><summary>What is measured</summary>
      <p>{view === "physical"
        ? "Each direct or gateway connection counts its own transfers. A relayed envelope crosses two connections at a gateway."
        : "Only traffic sent or received by this instance as an endpoint; transit forwarding is excluded. This is an alternate view, not extra traffic."}
        {" "}Sent counts bytes accepted by the local socket; it does not confirm delivery.</p>
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
      <BrandLockup variant="activity-titlebar" />
      <div className="activity-titlebar__breadcrumb"><span className="activity-titlebar__eyebrow">Federation</span>
        <span aria-hidden="true" className="activity-titlebar__separator">›</span>
        <span className="activity-titlebar__current">Activity</span></div>
      <div className="activity-titlebar__spacer" />
    </header>
    <div className="activity-content federation-activity-content"><FederationActivityScreen desktopApi={desktopApi} /></div>
  </section></div>;
}
