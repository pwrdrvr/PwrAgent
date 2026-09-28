import { useEffect, useMemo, useRef, useState } from "react";
import type { AnalyzeUsageActivityResponse, AppServerBackendKind, BackendModelOption, FederationTarget, ReadUsageActivityResponse } from "@pwragent/shared";
import { Select } from "../../components/Select";
import type { DesktopApi } from "../../lib/desktop-api";
import { summarizeUsageActivity, type OwnedUsageRow } from "./usage-activity-summary";

const money = (micros: number) => `$${(micros / 1_000_000).toFixed(4)}`;
const count = (value: number) => value.toLocaleString();
const time = (value: number) => new Date(value).toLocaleString();
const localDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
type Source = { label: string; target: FederationTarget };
type Snapshot = { from: number; to: number; rows: OwnedUsageRow[]; sources: Array<Source & { data?: ReadUsageActivityResponse; error?: string }> };

export function UsageActivity({ desktopApi }: { desktopApi?: DesktopApi }) {
  const [sources, setSources] = useState<Source[]>([{ label: "This instance", target: { scope: "local" } }]);
  const [scope, setScope] = useState("local");
  const [from, setFrom] = useState(() => { const day = new Date(); day.setHours(0, 0, 0, 0); return localDate(day); });
  const [to, setTo] = useState(() => localDate(new Date()));
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<OwnedUsageRow>();
  const [models, setModels] = useState<BackendModelOption[]>([]);
  const [model, setModel] = useState("gpt-6-luna");
  const [entryLimit, setEntryLimit] = useState("40");
  const [characterLimit, setCharacterLimit] = useState("20000");
  const [analysis, setAnalysis] = useState<AnalyzeUsageActivityResponse>();
  const [analyzing, setAnalyzing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let disposed = false;
    void desktopApi?.readFederationActivity?.({ includeHistory: false }).then((value) => {
      if (disposed) return;
      setSources([{ label: value.health.localLabel ?? "This instance", target: { scope: "local" } },
        ...value.health.peers.filter((peer) => peer.id !== value.health.instanceId).map((peer) => ({
          label: `${peer.label}${peer.profileName ? ` (${peer.profileName})` : ""} · ${peer.status}`,
          target: { scope: "remote" as const, instanceId: peer.id },
        }))]);
    }).catch((cause: unknown) => { if (!disposed) setError(`Peer discovery unavailable: ${String(cause)}`); });
    return () => { disposed = true; };
  }, [desktopApi]);
  useEffect(() => {
    let disposed = false;
    setModels([]);
    if (selected) void desktopApi?.listBackends?.({ federationTarget: selected.target }).then((value) => {
      if (!disposed) setModels(value.backends.find((backend) => backend.kind === "codex")?.launchpadOptions?.models ?? []);
    }).catch(() => { /* Explicit default remains selectable; owner returns availability errors. */ });
    return () => { disposed = true; };
  }, [desktopApi, selected]);
  const summary = useMemo(() => snapshot ? summarizeUsageActivity(snapshot.rows, snapshot.from, snapshot.to) : undefined, [snapshot]);
  const refresh = async () => {
    if (!desktopApi?.readUsageActivity || pending) return;
    const start = new Date(from).getTime();
    const end = new Date(to).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 31 * 86_400_000) {
      setError("Choose a start before the end, within 31 days."); return;
    }
    setPending(true); setError(undefined); setSelected(undefined); setAnalysis(undefined);
    const targets = scope === "all" ? sources : sources.filter((source) => source.target.scope === "local"
      ? scope === "local" : source.target.instanceId === scope);
    const results: Snapshot["sources"] = [];
    // At most four reads in flight. Each owner enforces a 5,000-row bound.
    for (let offset = 0; offset < targets.length; offset += 4) {
      const batch = await Promise.all(targets.slice(offset, offset + 4).map(async (source) => {
        try { return { ...source, data: await desktopApi.readUsageActivity!({ from: start, to: end, federationTarget: source.target }) }; }
        catch (cause) { return { ...source, error: String(cause) }; }
      }));
      results.push(...batch);
      if (!mounted.current) return;
    }
    setSnapshot({ from: start, to: end, sources: results, rows: results.flatMap((source) =>
      (source.data?.rows ?? []).map((row) => ({ ...row, owner: source.label, target: source.target }))) });
    setPending(false);
  };
  return <div className="federation-activity usage-activity">
    <h2>Usage Activity</h2>
    <p>API-equivalent list prices from recorded usage. These are not subscription charges or an allocation of account quota.</p>
    <div className="federation-activity__toolbar">
      <label>Instance <Select value={scope} onChange={setScope} options={[
        { value: "all", label: "All known instances" }, ...sources.map((source) => ({
          value: source.target.scope === "local" ? "local" : source.target.instanceId, label: source.label,
        })),
      ]} /></label>
      <label>From <input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label>To <input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      <button type="button" disabled={pending || analyzing || !desktopApi?.readUsageActivity} onClick={() => void refresh()}>{pending ? "Reading…" : "Read usage"}</button>
    </div>
    <p className="federation-activity__muted">Times use {Intl.DateTimeFormat().resolvedOptions().timeZone}. Only whole, attributed turns whose recorded start and completion both fall within the window count below. Running turns and turns crossing a boundary are excluded; costs are never prorated.</p>
    {error ? <p role="alert">{error}</p> : null}
    {snapshot && summary ? <>
      <p><strong>{snapshot.sources.some((source) => source.data)
        ? money(summary.groups.reduce((total, group) => total + group.cost, 0)) : "Usage unavailable"}</strong> {snapshot.sources.some((source) => source.error || source.data?.truncated) ? "Partial API-equivalent coverage" : "API-equivalent"} · {count(summary.contained)} contained usage rows · {time(snapshot.from)} – {time(snapshot.to)}</p>
      <p className="federation-activity__muted">Excluded: {summary.boundary} boundary/unfinished rows, {summary.unattributed} unattributed or non-additive rows. Removed {summary.duplicates} duplicate ledger rows across instances. Unpriced rows contribute tokens only. Missing history is not zero usage.</p>
      {snapshot.sources.map((source, index) => <div key={index}>
        <p>{source.label}: {source.error ? `Unavailable — ${source.error}` : source.data?.truncated ? "Partial — newest 5,000 candidate rows only" : `Read ${time(source.data!.readAt)}`}</p>
        <details><summary>Account rate-limit snapshot · {source.label}</summary>
          <p>Last observed by the owner; may be stale. Account-wide, not thread-attributed. Snapshots from different instances are not added together.</p>
          {source.data?.rateLimits.length ? source.data.rateLimits.map((limit, i) => <p key={i}>{limit.name}: {limit.usedPercent === undefined ? "percentage unavailable" : `${limit.usedPercent}% used`}{limit.resetAt ? ` · resets ${time(limit.resetAt)}` : ""}</p>) : <p>No account rate-limit snapshot available.</p>}
        </details>
      </div>)}
      <table className="federation-activity__totals"><caption>Threads by API-equivalent cost · contained turns only</caption>
        <thead><tr><th>Thread</th><th>USD</th><th>Uncached input</th><th>Cached input</th><th>Output</th><th>Inspect</th></tr></thead>
        <tbody>{summary.groups.map((group) => <tr key={group.key}>
          <th scope="row">{group.title}<small>{group.rows[0].owner} · {group.rows[0].line.backend}</small></th>
          <td>{money(group.cost)}{group.unpriced ? <small>{group.unpriced} unpriced</small> : null}</td>
          <td>{count(group.uncached)}<small>{count(group.cacheWrite)} cache-write subset</small></td><td>{count(group.cached)}</td>
          <td>{count(group.output)}<small>{count(group.reasoning)} reasoning subset</small></td>
          <td><button type="button" disabled={analyzing} onClick={() => { setSelected(group.rows[0]); setAnalysis(undefined); }}>Inspect</button></td>
        </tr>)}</tbody>
      </table>
      {!summary.groups.length ? <p>No fully contained, attributed turns in the available data. Try a wider window.</p> : null}
      {summary.excluded.length ? <details><summary>Other observed usage · excluded from the total ({summary.excluded.length})</summary>
        <p>Whole-row cost is shown for context only; none is assigned to this window. Newest 5,000 candidate rows per owner were eligible for inspection.</p>
        <table className="federation-activity__totals"><caption>Boundary, unfinished, and unattributed rows · highest whole-row cost first</caption>
          <thead><tr><th>Thread</th><th>Start / completion</th><th>Scope / source</th><th>Whole-row USD</th><th>Inspect</th></tr></thead>
          <tbody>{summary.excluded.slice(0, 100).map((row) => <tr key={`${row.line.backend}:${row.line.usageLineId}`}>
            <th scope="row">{row.title}<small>{row.owner}</small></th>
            <td>{time(row.line.startedAt ?? row.line.createdAt)}<small>{row.line.completedAt === undefined ? "Completion unavailable" : time(row.line.completedAt)}</small></td>
            <td>{row.line.scope} / {row.line.source}</td>
            <td>{row.line.priceStatus === "priced" && row.line.currency === "USD" ? money(row.line.totalCostMicros) : "Unpriced"}</td>
            <td><button type="button" disabled={analyzing} onClick={() => { setSelected(row); setAnalysis(undefined); }}>Inspect</button></td>
          </tr>)}</tbody>
        </table>{summary.excluded.length > 100 ? <p>Showing the highest-cost 100 excluded rows. Narrow the window to inspect more.</p> : null}
      </details> : null}
      {selected ? <section aria-label="Usage inspection">
        <h3>{selected.title}</h3>
        <p>{selected.line.threadId} · Analysis owner: {selected.owner}</p>
        <table className="federation-activity__totals"><caption>Recorded intervals · includes rows excluded from the window total · up to 100 rows</caption><thead><tr><th>Start</th><th>Completed</th><th>Scope / source</th><th>Model</th><th>USD</th></tr></thead>
          <tbody>{summary.rows.filter((row) => row.line.backend === selected.line.backend && row.line.threadId === selected.line.threadId).slice(0, 100).map((row) => <tr key={row.line.usageLineId}>
            <td>{time(row.line.startedAt ?? row.line.createdAt)}</td><td>{row.line.completedAt === undefined ? "Unavailable" : time(row.line.completedAt)}</td><td>{row.line.scope} / {row.line.source}</td><td>{row.line.model ?? "Unknown"}</td><td>{row.line.priceStatus === "priced" && row.line.currency === "USD" ? money(row.line.totalCostMicros) : "Unpriced"}</td>
          </tr>)}</tbody></table>
        <p>Analyze sends one recent protocol page (up to 10 turns), capped by the limits below, to the selected model on this owner. It may differ from the usage window. No earlier-history scan or other-instance analysis. This model call consumes usage.</p>
        <div className="federation-activity__toolbar">
          <label>Analysis model <Select value={model} onChange={setModel} disabled={analyzing} options={[
            { value: "gpt-6-luna", label: "GPT-6-Luna" }, ...models.filter((item) => item.id !== "gpt-6-luna").map((item) => ({ value: item.id, label: item.label ?? item.id })),
          ]} /></label>
          <label>Entry limit <Select value={entryLimit} onChange={setEntryLimit} disabled={analyzing} options={["20", "40", "100"].map((value) => ({ value, label: value }))} /></label>
          <label>Character limit <Select value={characterLimit} onChange={setCharacterLimit} disabled={analyzing} options={["10000", "20000", "40000"].map((value) => ({ value, label: count(Number(value)) }))} /></label>
          <button type="button" disabled={analyzing || !desktopApi?.analyzeUsageActivity} onClick={() => {
            setAnalyzing(true); setError(undefined); setAnalysis(undefined);
            void desktopApi!.analyzeUsageActivity!({ backend: selected.line.backend as AppServerBackendKind, threadId: selected.line.threadId,
              federationTarget: selected.target, model, entryLimit: Number(entryLimit), characterLimit: Number(characterLimit) })
              .then((result) => { if (mounted.current) setAnalysis(result); })
              .catch((cause: unknown) => { if (mounted.current) setError(String(cause)); })
              .finally(() => { if (mounted.current) setAnalyzing(false); });
          }}>{analyzing ? "Analyzing…" : "Analyze"}</button>
        </div>
        {analysis ? <><p>{analysis.model} · {analysis.entries} entries · {count(analysis.characters)} characters{analysis.truncated || analysis.hasEarlierHistory ? " · partial transcript" : ""}</p><pre className="usage-activity__analysis">{analysis.analysis}</pre></> : null}
      </section> : null}
    </> : <p>Choose the time window and read usage from the selected instances.</p>}
  </div>;
}
