import { useEffect, useMemo, useRef, useState } from "react";
import type { AnalyzeUsageActivityResponse, AppServerBackendKind, BackendModelOption, FederationTarget, ReadUsageActivityResponse } from "@pwragent/shared";
import { UsageTimeline } from "./UsageTimeline";
import { usageCompletionBuckets, usageMoney as money, usageCount as compact, usageClock } from "./usage-activity-presentation";
import { Select } from "../../components/Select";
import type { DesktopApi } from "../../lib/desktop-api";
import { summarizeUsageActivity, type OwnedUsageRow } from "./usage-activity-summary";


const count = (value: number) => value.toLocaleString();
const time = (value: number) => new Date(value).toLocaleString();
const localDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
type Source = { label: string; target: FederationTarget };
type Snapshot = { queryKey: string; from: number; to: number; rows: OwnedUsageRow[]; sources: Array<Source & { data?: ReadUsageActivityResponse; error?: string }> };

export function UsageActivity({ desktopApi }: { desktopApi?: DesktopApi }) {
  const [sources, setSources] = useState<Source[]>([{ label: "This instance", target: { scope: "local" } }]);
  const [scope, setScope] = useState("all");
  const [period, setPeriod] = useState("today");
  const [lens, setLens] = useState<"threads" | "excluded">("threads");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("cost");
  const [bucket, setBucket] = useState<number>();
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
  const queryKey = JSON.stringify([scope, period, from, to]);
  const refresh = async () => {
    if (!desktopApi?.readUsageActivity || pending) return;
    const end = period === "custom" ? new Date(to).getTime() : Date.now();
    const today = new Date(end); today.setHours(0, 0, 0, 0);
    const start = period === "custom" ? new Date(from).getTime()
      : period === "today" ? today.getTime() : end - (period === "week" ? 7 : 1) * 86_400_000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 31 * 86_400_000) {
      setError("Choose a start before the end, within 31 days."); return;
    }
    setPending(true); setError(undefined); setSelected(undefined); setAnalysis(undefined); setBucket(undefined);
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
    setSnapshot({ queryKey, from: start, to: end, sources: results, rows: results.flatMap((source) =>
      (source.data?.rows ?? []).map((row) => ({ ...row, owner: source.label, target: source.target }))) });
    setPending(false);
  };
  const included = summary?.groups.flatMap((group) => group.rows) ?? [];
  const buckets = snapshot ? usageCompletionBuckets(included, snapshot.from, snapshot.to) : undefined;
  const selectedInterval = bucket === undefined ? undefined : buckets?.[bucket];
  const filteredSummary = snapshot && selectedInterval
    ? summarizeUsageActivity(included.filter((row) => row.line.completedAt! >= selectedInterval.from && row.line.completedAt! < selectedInterval.to), snapshot.from, snapshot.to)
    : summary;
  const groups = [...(filteredSummary?.groups ?? [])].filter((group) =>
    `${group.title} ${group.rows[0].owner} ${group.rows[0].line.threadId}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    .sort((a, b) => sort === "tokens" ? (b.uncached + b.cached + b.output) - (a.uncached + a.cached + a.output)
      : sort === "recent" ? Math.max(...b.rows.map((row) => row.line.completedAt!)) - Math.max(...a.rows.map((row) => row.line.completedAt!)) : b.cost - a.cost);
  const excluded = (summary?.excluded ?? []).filter((row) => `${row.title} ${row.owner}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const total = summary?.groups.reduce((value, group) => value + group.cost, 0) ?? 0;
  const totals = included.reduce((value, { line }) => ({
    uncached: value.uncached + line.uncachedInputTokens, cached: value.cached + line.cachedInputTokens,
    output: value.output + line.outputTokens, reasoning: value.reasoning + line.reasoningOutputTokens,
    unpriced: value.unpriced + (line.priceStatus === "priced" && line.currency === "USD" ? 0 : 1),
  }), { uncached: 0, cached: 0, output: 0, reasoning: 0, unpriced: 0 });
  const cacheShare = totals.cached + totals.uncached ? totals.cached / (totals.cached + totals.uncached) : 0;
  const available = snapshot?.sources.filter((source) => source.data).length ?? 0;
  const partial = snapshot?.sources.some((source) => source.error || source.data?.truncated);
  const selectedGroup = selected && summary?.groups.find((group) => group.rows.some((row) => row.line.threadId === selected.line.threadId && row.line.backend === selected.line.backend));
  const selectedRows = selected ? (summary?.rows.filter((row) => row.line.backend === selected.line.backend && row.line.threadId === selected.line.threadId) ?? [])
    .sort((a, b) => (b.line.completedAt ?? b.line.createdAt) - (a.line.completedAt ?? a.line.createdAt)) : [];
  const selectRow = (row: OwnedUsageRow) => { setSelected(row); setAnalysis(undefined); setError(undefined); };
  const runAnalysis = () => {
    if (!selected || !desktopApi?.analyzeUsageActivity || analyzing) return;
    setAnalyzing(true); setError(undefined); setAnalysis(undefined);
    void desktopApi.analyzeUsageActivity({ backend: selected.line.backend as AppServerBackendKind, threadId: selected.line.threadId,
      federationTarget: selected.target, model, entryLimit: Number(entryLimit), characterLimit: Number(characterLimit) })
      .then((result) => { if (mounted.current) setAnalysis(result); })
      .catch((cause: unknown) => { if (mounted.current) setError(String(cause)); })
      .finally(() => { if (mounted.current) setAnalyzing(false); });
  };
  return <div className="usage-workspace" aria-label="Usage Activity" aria-busy={pending}>
    <div className="usage-controls" title={`Times in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`}>
      <label><span className="usage-sr-only">Instance</span><Select value={scope} onChange={setScope} options={[
        { value: "all", label: "All instances" }, ...sources.map((source) => ({
          value: source.target.scope === "local" ? "local" : source.target.instanceId, label: source.label,
        })),
      ]} /></label>
      <label><span className="usage-sr-only">Period</span><Select value={period} onChange={setPeriod} options={[
        { value: "today", label: "Today" }, { value: "day", label: "Last 24 hours" },
        { value: "week", label: "Last 7 days" }, { value: "custom", label: "Custom range" },
      ]} /></label>
      {period === "custom" ? <><label className="usage-date">From <input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label className="usage-date">To <input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} /></label></> : null}
      <span className="usage-controls__spacer" />
      <span className="usage-controls__asof">{snapshot ? snapshot.queryKey !== queryKey ? "Selection changed" : available ? `Read ${usageClock(Math.max(...snapshot.sources.map((source) => source.data?.readAt ?? 0)))}` : "No instances available" : Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
      <button type="button" className="usage-button" disabled={pending || analyzing || !desktopApi?.readUsageActivity} onClick={() => void refresh()}>{pending ? "Reading…" : snapshot ? snapshot.queryKey !== queryKey ? "Apply selection" : "Refresh" : "Load activity"}</button>
    </div>
    {error ? <p role="alert" className="usage-error">{error}</p> : null}
    {snapshot && summary ? <>
      <div className="usage-overview">
        <section className="usage-headline" aria-label="Usage summary">
          <div className="usage-eyebrow">API-equivalent cost <span className="usage-subtle">/ contained turns</span></div>
          <div className="usage-headline__figure"><strong>{available ? money(total) : "Unavailable"}</strong>
            <span>{summary.groups.length} threads <span className="usage-subtle">·</span> {count(summary.contained)} intervals</span></div>
          <div className="usage-metrics">
            <div><span>Uncached input</span><strong>{compact(totals.uncached)}</strong><small>tokens</small></div>
            <div><span>Cached input</span><strong>{compact(totals.cached)}</strong><small>{Math.round(cacheShare * 100)}% of input</small></div>
            <div><span>Output</span><strong>{compact(totals.output)}</strong><small>{compact(totals.reasoning)} reasoning subset</small></div>
          </div>
          <div className="usage-cache-bar" role="img" aria-label={`${Math.round(cacheShare * 100)}% of recorded input was cached`}><i style={{ width: `${cacheShare * 100}%` }} /></div>
          <div className="usage-headline__caption"><span><i /> Cached input</span><span>{time(snapshot.from)} — {time(snapshot.to)}</span></div>
        </section>
        {buckets ? <UsageTimeline buckets={buckets} selected={bucket} onSelect={setBucket} /> : null}
      </div>
      <div className="usage-disclosures">
        <details className="usage-disclosure"><summary><span className={`usage-status-dot${partial ? " is-partial" : ""}`} />
          <strong>{partial ? "Partial coverage" : "Recorded usage"}</strong>
          <span>{available}/{snapshot.sources.length} instances</span><span>{summary.boundary + summary.unattributed} excluded</span>
          <span>{totals.unpriced} unpriced</span><span className="usage-disclosure__hint">Coverage & method</span></summary>
          <div className="usage-disclosure__body">
            <p>Only whole attributed turns whose start and completion fall inside this window contribute. Running and boundary-crossing turns are excluded, never prorated. Prices are API equivalents, not subscription charges. Missing history is not zero usage.</p>
            <p>{summary.boundary} boundary/unfinished rows · {summary.unattributed} non-additive or unattributed rows · {summary.duplicates} duplicate copies removed. Unpriced rows contribute tokens only. Cache-write tokens are part of uncached input; reasoning tokens are part of output.</p>
            {snapshot.sources.map((source, index) => <p key={index}><strong>{source.label}</strong> · {source.error ? `Unavailable — ${source.error}` : source.data?.truncated ? "Partial — newest 5,000 candidate rows" : `Read ${time(source.data!.readAt)}`}</p>)}
          </div>
        </details>
        <details className="usage-disclosure"><summary><strong>Account limits</strong><span>Owner snapshots</span><span className="usage-disclosure__hint">Separate from thread cost</span></summary>
          <div className="usage-accounts">{snapshot.sources.map((source, index) => <section key={index}>
            <h3>{source.label}</h3>{source.data?.rateLimits.length ? source.data.rateLimits.map((limit, i) => <div className="usage-account" key={i}>
              <span>{limit.name}</span><strong>{limit.usedPercent === undefined ? "Unavailable" : `${limit.usedPercent}% used`}</strong>
              {limit.usedPercent !== undefined ? <div className="usage-account__meter"><i style={{ width: `${Math.min(100, Math.max(0, limit.usedPercent))}%` }} /></div> : null}
              <small>{limit.resetAt ? `Resets ${time(limit.resetAt)}` : "Reset time unavailable"}</small>
            </div>) : <p>No account snapshot available.</p>}</section>)}
            <p className="usage-accounts__note">Last observed by each owner; may be stale. Account-wide snapshots are never summed across instances or attributed to individual threads.</p>
          </div>
        </details>
      </div>
      <div className={`usage-results${selected ? " has-inspector" : ""}`}>
        <section className="usage-results__main" aria-label="Usage results">
          <div className="usage-results__toolbar">
            <div className="usage-lenses" role="group" aria-label="Usage rows">
              <button type="button" aria-pressed={lens === "threads"} onClick={() => setLens("threads")}>Threads <span>{filteredSummary?.groups.length ?? 0}</span></button>
              <button type="button" aria-pressed={lens === "excluded"} onClick={() => setLens("excluded")}>Excluded <span>{summary.excluded.length}</span></button>
            </div>
            <label className="usage-search"><span className="usage-sr-only">Find a thread</span><input placeholder="Find a thread…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
            {lens === "threads" ? <label><span className="usage-sr-only">Sort threads</span><Select value={sort} onChange={setSort} options={[
              { value: "cost", label: "Highest cost" }, { value: "tokens", label: "Most tokens" }, { value: "recent", label: "Latest completion" },
            ]} /></label> : null}
          </div>
          {selectedInterval && lens === "threads" ? <div className="usage-filter-note">Completed {usageClock(selectedInterval.from)}–{usageClock(selectedInterval.to)}<button type="button" onClick={() => setBucket(undefined)}>Clear time filter ×</button></div> : null}
          {lens === "excluded" ? <p className="usage-list-note">Whole-row prices for context. None of these rows contributes to the window total.</p> : null}
          <div className="usage-list-head"><span>Thread / instance</span><span>{lens === "threads" ? "Input · cached" : "Scope / source"}</span><span>{lens === "threads" ? "API-equivalent" : "Whole row"}</span></div>
          <div className="usage-thread-list">
            {lens === "threads" ? groups.slice(0, 250).map((group, index) => {
              const row = group.rows[0];
              const modelNames = [...new Set(group.rows.map((item) => item.line.model ?? "Unknown model"))].join(", ");
              return <button type="button" key={group.key} className="usage-thread" disabled={analyzing}
                aria-label={`Inspect ${group.title}`} aria-pressed={selectedGroup?.key === group.key} onClick={() => selectRow(row)}>
                <span className="usage-thread__identity"><span className="usage-thread__rank">{String(index + 1).padStart(2, "0")}</span><span><strong>{group.title}</strong><small>{row.owner} · {modelNames}</small></span></span>
                <span className="usage-thread__tokens">{compact(group.uncached + group.cached)}<small>{Math.round(group.cached / Math.max(1, group.uncached + group.cached) * 100)}% cached · {compact(group.output)} out</small></span>
                <span className="usage-thread__cost"><strong>{money(group.cost)}</strong><small>{group.unpriced ? `${group.unpriced} unpriced` : `${group.rows.length} ${group.rows.length === 1 ? "interval" : "intervals"}`}</small></span>
                <span className="usage-thread__share" aria-hidden="true" style={{ width: `${total ? group.cost / total * 100 : 0}%` }} />
              </button>;
            }) : excluded.slice(0, 250).map((row) => <button type="button" className="usage-thread" key={`${row.line.backend}:${row.line.usageLineId}`} disabled={analyzing}
              aria-label={`Inspect ${row.title}`} aria-pressed={selected === row} onClick={() => selectRow(row)}>
              <span className="usage-thread__identity"><span><strong>{row.title}</strong><small>{row.owner} · {time(row.line.startedAt ?? row.line.createdAt)}</small></span></span>
              <span className="usage-thread__tokens">{row.line.scope}<small>{row.line.source} · {row.line.completedAt === undefined ? "unfinished" : "outside total"}</small></span>
              <span className="usage-thread__cost"><strong>{row.line.priceStatus === "priced" && row.line.currency === "USD" ? money(row.line.totalCostMicros) : "Unpriced"}</strong><small>excluded</small></span>
            </button>)}
            {(lens === "threads" ? groups : excluded).length === 0 ? <div className="usage-empty"><strong>{search ? "No matching threads" : "No usage rows in this view"}</strong><p>{search ? "Try a thread title or instance name." : "Choose a wider window or inspect excluded rows."}</p></div> : null}
            {(lens === "threads" ? groups : excluded).length > 250 ? <p className="usage-list-note">Showing 250 results. Filter by thread name or narrow the time window.</p> : null}
          </div>
          <div className="usage-list-footer"><span>{groups.length} threads · {summary.contained} contained intervals</span><span>USD list-price estimate</span></div>
        </section>
        {selected ? <aside className="usage-inspector" aria-label="Usage inspection">
          <div className="usage-inspector__body">
          <div className="usage-inspector__heading"><span className="usage-eyebrow">Thread detail</span><button type="button" className="usage-icon-button" aria-label="Close thread detail" disabled={analyzing} onClick={() => setSelected(undefined)}>×</button></div>
          <h2>{selected.title}</h2><p className="usage-inspector__owner">{selected.owner}</p>
          <div className="usage-inspector__cost"><strong>{selectedGroup ? money(selectedGroup.cost) : "Excluded"}</strong><span>{selectedGroup ? "in contained turns" : "from the window total"}</span></div>
          <details className="usage-turns"><summary>Recorded intervals <span>{selectedRows.length}</span></summary>
            <div>{selectedRows.slice(0, 20).map((row) => <div className="usage-turn" key={row.line.usageLineId}>
              <span>{usageClock(row.line.startedAt ?? row.line.createdAt)} → {row.line.completedAt === undefined ? "unfinished" : usageClock(row.line.completedAt)}<small>{row.line.scope} / {row.line.source} · {row.line.model ?? "Unknown model"}</small></span>
              <strong>{row.line.priceStatus === "priced" && row.line.currency === "USD" ? money(row.line.totalCostMicros) : "—"}</strong>
            </div>)}</div><p>Whole-row prices; may include excluded intervals. Showing up to 20 rows.</p>
          </details>
          <section className="usage-analysis" aria-label="Analyze usage">
            <div className="usage-eyebrow">Analyze this thread</div>
            <label>Model <Select value={model} onChange={setModel} disabled={analyzing} options={[
              { value: "gpt-6-luna", label: "GPT-6-Luna" }, ...models.filter((item) => item.id !== "gpt-6-luna").map((item) => ({ value: item.id, label: item.label ?? item.id })),
            ]} /></label>
            <div className="usage-analysis__limits"><label>Entries <Select value={entryLimit} onChange={setEntryLimit} disabled={analyzing} options={["20", "40", "100"].map((value) => ({ value, label: value }))} /></label>
              <label>Characters <Select value={characterLimit} onChange={setCharacterLimit} disabled={analyzing} options={["10000", "20000", "40000"].map((value) => ({ value, label: count(Number(value)) }))} /></label></div>
            <div className="usage-analysis__scope"><strong>Recent page · up to 10 turns</strong><span>On {selected.owner}. May differ from the activity window. No earlier-history scan or analysis fanout.</span></div>
            {analysis ? <div className="usage-analysis__result" role="status"><div className="usage-eyebrow">Analysis</div><p>{analysis.model} · {analysis.entries} entries · {count(analysis.characters)} characters{analysis.truncated || analysis.hasEarlierHistory ? " · partial transcript" : ""}</p><pre>{analysis.analysis}</pre></div> : null}
          </section>
          <details className="usage-thread-id"><summary>Thread identity</summary><code>{selected.line.threadId}</code><p>{selected.line.backend}</p></details>
          </div>
          <div className="usage-inspector__footer">
            <button type="button" className="usage-button usage-button--primary" disabled={analyzing || !desktopApi?.analyzeUsageActivity} onClick={runAnalysis}>{analyzing ? "Analyzing excerpt…" : "Analyze thread"}<span aria-hidden="true">↗</span></button>
            <small className="usage-analysis__cost-note">{entryLimit} entries · {compact(Number(characterLimit))} characters max. This model call consumes usage.</small>
          </div>
        </aside> : null}
      </div>
    </> : <div className="usage-empty usage-empty--initial"><span className="usage-eyebrow">Across your instances</span><h2>See where your usage goes.</h2><p>Compare thread costs, inspect completed turns, and analyze the work behind them.</p><span>Select an instance and time range, then load activity.</span></div>}
  </div>;
}
