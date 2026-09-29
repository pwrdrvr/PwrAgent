import { useEffect, useMemo, useRef, useState } from "react";
import type { AnalyzeUsageActivityResponse, AppServerBackendKind, BackendModelOption, FederationTarget, ReadUsageActivityResponse } from "@pwragent/shared";
import { UsageTimeline } from "./UsageTimeline";
import { UsageLimitsBand } from "./UsageLimitsBand";
import { UsageInspector, type AnalysisScope } from "./UsageInspector";
import { UsageSignals, groupSignals } from "./UsageSignals";
import { USAGE_SERIES, usageCompletionBuckets, usageSpendStrip, usageMoney as money, usageCount as compact, usageClock } from "./usage-activity-presentation";
import { buildLimitAccounts, fiveHourSeries, limitLabel, seriesStart, sinceResetSeries, type LimitAccount } from "./usage-limits";
import { Select } from "../../components/Select";
import type { DesktopApi } from "../../lib/desktop-api";
import { summarizeUsageActivity, type OwnedUsageRow, type UsageGroup } from "./usage-activity-summary";

const DAY = 86_400_000;
const MAX_WINDOW = 31 * DAY;
const time = (value: number) => new Date(value).toLocaleString();
const localDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const sourceId = (target: FederationTarget) => target.scope === "local" ? "local" : target.instanceId;

type Source = { label: string; target: FederationTarget; status?: string };
type Preset = "reset" | "five" | "today" | "day" | "week" | "custom";
type SourceResult = Source & { data?: ReadUsageActivityResponse; error?: string };
type Snapshot = { queryKey: string; from: number; to: number; preset: Preset; rows: OwnedUsageRow[]; sources: SourceResult[]; accounts: LimitAccount[] };

const PRESETS: Array<{ value: Preset; label: string; title: string }> = [
  { value: "reset", label: "Since reset", title: "Since the account's longest limit last reset" },
  { value: "five", label: "5-hour window", title: "The current 5-hour limit window" },
  { value: "today", label: "Today", title: "Since midnight" },
  { value: "day", label: "24 h", title: "The last 24 hours" },
  { value: "week", label: "7 days", title: "The last 7 days" },
  { value: "custom", label: "Custom", title: "Choose a start and end" },
];

/** The account whose limits drive the reset presets and the chart's line. */
function focusAccount(accounts: LimitAccount[], preferred: string | undefined, localLabel: string) {
  return accounts.find((account) => account.key === preferred)
    ?? accounts.find((account) => account.owners.includes(localLabel)) ?? accounts[0];
}

/** Where a limit-based preset starts, once the account's limits are known. */
function limitStart(preset: Preset, account: LimitAccount | undefined) {
  return preset === "reset" ? seriesStart(sinceResetSeries(account))
    : preset === "five" ? seriesStart(fiveHourSeries(account)) : undefined;
}

export function UsageActivity({ desktopApi }: { desktopApi?: DesktopApi }) {
  const [sources, setSources] = useState<Source[]>([{ label: "This instance", target: { scope: "local" } }]);
  const [disabled, setDisabled] = useState<Set<string>>(() => new Set());
  const [preset, setPreset] = useState<Preset>("reset");
  const [lens, setLens] = useState<"threads" | "excluded">("threads");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("cost");
  const [bucket, setBucket] = useState<number>();
  const [from, setFrom] = useState(() => { const day = new Date(); day.setHours(0, 0, 0, 0); return localDate(day); });
  const [to, setTo] = useState(() => localDate(new Date()));
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [focusKey, setFocusKey] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [selectedKey, setSelectedKey] = useState<string>();
  const [selectedExcluded, setSelectedExcluded] = useState<OwnedUsageRow>();
  const [turn, setTurn] = useState<OwnedUsageRow>();
  const [scope, setScope] = useState<AnalysisScope>("turn");
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
          label: `${peer.label}${peer.profileName ? ` (${peer.profileName})` : ""}`, status: peer.status,
          target: { scope: "remote" as const, instanceId: peer.id },
        }))]);
    }).catch((cause: unknown) => { if (!disposed) setError(`Peer discovery unavailable: ${String(cause)}`); });
    return () => { disposed = true; };
  }, [desktopApi]);

  const summary = useMemo(() => snapshot ? summarizeUsageActivity(snapshot.rows, snapshot.from, snapshot.to) : undefined, [snapshot]);
  const selectedGroup = selectedKey ? summary?.groups.find((group) => group.key === selectedKey) : undefined;
  const inspected = selectedGroup?.rows[0] ?? selectedExcluded;
  const analysisTarget = scope === "turn" && turn?.line.turnId ? turn : inspected;
  const modelTarget = analysisTarget?.target;
  const modelTargetKey = modelTarget ? sourceId(modelTarget) : undefined;
  useEffect(() => {
    let disposed = false;
    setModels([]);
    if (modelTarget) void desktopApi?.listBackends?.({ federationTarget: modelTarget }).then((value) => {
      if (!disposed) setModels(value.backends.find((backend) => backend.kind === "codex")?.launchpadOptions?.models ?? []);
    }).catch(() => { /* The default stays selectable; the owner reports availability. */ });
    return () => { disposed = true; };
    // Refetch per owner, not per selected row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktopApi, modelTargetKey]);

  const enabledSources = sources.filter((source) => !disabled.has(sourceId(source.target)));
  const queryKey = JSON.stringify([enabledSources.map((source) => sourceId(source.target)), preset, preset === "custom" ? [from, to] : null]);
  const localLabel = sources[0].label;

  const readAll = async (targets: Source[], start: number, end: number) => {
    const results: SourceResult[] = [];
    // At most four reads in flight. Each owner enforces a 5,000-row bound.
    for (let offset = 0; offset < targets.length; offset += 4) {
      results.push(...await Promise.all(targets.slice(offset, offset + 4).map(async (source) => {
        try { return { ...source, data: await desktopApi!.readUsageActivity!({ from: start, to: end, federationTarget: source.target }) }; }
        catch (cause) { return { ...source, error: String(cause) }; }
      })));
    }
    return results;
  };
  const accountsOf = (results: SourceResult[]) => buildLimitAccounts(results.filter((source) => source.data).map((source) => ({
    owner: source.label, current: source.data!.limitObservation, history: source.data!.limitHistory,
  })));

  const refresh = async () => {
    if (!desktopApi?.readUsageActivity || pending) return;
    const now = Date.now();
    const end = preset === "custom" ? new Date(to).getTime() : now;
    const today = new Date(end); today.setHours(0, 0, 0, 0);
    // A limit preset starts where the account's window began. Until limits are
    // known, read the longest such window and narrow once they arrive.
    const known = limitStart(preset, focusAccount(snapshot?.accounts ?? [], focusKey, localLabel));
    let start = preset === "custom" ? new Date(from).getTime()
      : preset === "today" ? today.getTime()
      : preset === "day" ? end - DAY
      : preset === "week" ? end - 7 * DAY
      : known ?? end - (preset === "five" ? 5 * 3_600_000 : 8 * DAY);
    start = Math.max(start, end - MAX_WINDOW);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > MAX_WINDOW) {
      setError("Choose a start before the end, within 31 days."); return;
    }
    setPending(true); setError(undefined); setSelectedKey(undefined); setSelectedExcluded(undefined);
    setTurn(undefined); setAnalysis(undefined); setBucket(undefined);
    let results = await readAll(enabledSources, start, end);
    if (!mounted.current) return;
    let accounts = accountsOf(results);
    const resolved = limitStart(preset, focusAccount(accounts, focusKey, localLabel));
    if (resolved !== undefined && resolved < end) {
      const bounded = Math.max(resolved, end - MAX_WINDOW);
      if (bounded < start - 60_000) {
        // The window began before what was read: read once more from its start.
        results = await readAll(enabledSources, bounded, end);
        if (!mounted.current) return;
        accounts = accountsOf(results);
      }
      start = bounded;
    }
    setSnapshot({ queryKey, from: start, to: end, preset, sources: results, accounts,
      // A narrowed window drops turns that finished before it began; they are
      // outside the window, not intervals that straddle its start.
      rows: results.flatMap((source) => (source.data?.rows ?? [])
        .filter((row) => row.line.completedAt === undefined || row.line.completedAt >= start)
        .map((row) => ({ ...row, owner: source.label, target: source.target }))) });
    setPending(false);
  };

  const included = summary?.groups.flatMap((group) => group.rows) ?? [];
  // The five most expensive threads get chart colors; each keeps its color in
  // every row, strip, and legend entry.
  const seriesIndex = new Map((summary?.groups ?? []).slice(0, USAGE_SERIES).map((group, index) => [group.key, index]));
  const rowSeries = new Map<OwnedUsageRow, number>();
  for (const group of summary?.groups ?? []) {
    const index = seriesIndex.get(group.key);
    if (index !== undefined) for (const row of group.rows) rowSeries.set(row, index);
  }
  const buckets = snapshot ? usageCompletionBuckets(included, snapshot.from, snapshot.to, (row) => rowSeries.get(row)) : undefined;
  const selectedInterval = bucket === undefined ? undefined : buckets?.[bucket];
  const filteredSummary = snapshot && selectedInterval
    ? summarizeUsageActivity(included.filter((row) => row.line.completedAt! >= selectedInterval.from && row.line.completedAt! < selectedInterval.to), snapshot.from, snapshot.to)
    : summary;
  const matches = (text: string) => text.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  const groups = [...(filteredSummary?.groups ?? [])].filter((group) => matches(`${group.title} ${group.rows[0].owner} ${group.rows[0].line.threadId}`))
    .sort((a, b) => sort === "tokens" ? (b.uncached + b.cached + b.output) - (a.uncached + a.cached + a.output)
      : sort === "recent" ? Math.max(...b.rows.map((row) => row.line.completedAt!)) - Math.max(...a.rows.map((row) => row.line.completedAt!)) : b.cost - a.cost);
  const excluded = (summary?.excluded ?? []).filter((row) => matches(`${row.title} ${row.owner}`));
  const total = summary?.groups.reduce((value, group) => value + group.cost, 0) ?? 0;
  const totals = included.reduce((value, { line }) => ({
    uncached: value.uncached + line.uncachedInputTokens, cached: value.cached + line.cachedInputTokens,
    output: value.output + line.outputTokens,
  }), { uncached: 0, cached: 0, output: 0 });
  const cacheShare = totals.cached + totals.uncached ? totals.cached / (totals.cached + totals.uncached) : 0;
  const available = snapshot?.sources.filter((source) => source.data).length ?? 0;
  const missing = snapshot?.sources.filter((source) => source.error) ?? [];
  const capped = snapshot?.sources.filter((source) => source.data?.truncated) ?? [];
  const focus = snapshot ? focusAccount(snapshot.accounts, focusKey, localLabel) : undefined;
  const lineSeries = snapshot?.preset === "five" ? fiveHourSeries(focus) : sinceResetSeries(focus);

  const inspectGroup = (group: UsageGroup) => {
    setSelectedExcluded(undefined); setSelectedKey(group.key); setAnalysis(undefined); setError(undefined);
    const turns = group.rows.filter((row) => row.line.priceStatus === "priced");
    setTurn([...turns.length ? turns : group.rows].sort((a, b) => b.line.totalCostMicros - a.line.totalCostMicros)[0]);
    setScope("turn");
  };
  const inspectExcluded = (row: OwnedUsageRow) => {
    setSelectedKey(undefined); setSelectedExcluded(row); setTurn(undefined); setScope("recent"); setAnalysis(undefined); setError(undefined);
  };
  const closeInspector = () => { setSelectedKey(undefined); setSelectedExcluded(undefined); setTurn(undefined); setAnalysis(undefined); };
  const runAnalysis = () => {
    const target = analysisTarget;
    if (!target || !desktopApi?.analyzeUsageActivity || analyzing) return;
    setAnalyzing(true); setError(undefined); setAnalysis(undefined);
    const turnId = scope === "turn" ? target.line.turnId : undefined;
    void desktopApi.analyzeUsageActivity({ backend: target.line.backend as AppServerBackendKind, threadId: target.line.threadId,
      ...turnId ? { turnId } : {}, federationTarget: target.target, model,
      entryLimit: Number(entryLimit), characterLimit: Number(characterLimit) })
      .then((result) => { if (mounted.current) setAnalysis(result); })
      .catch((cause: unknown) => { if (mounted.current) setError(String(cause)); })
      .finally(() => { if (mounted.current) setAnalyzing(false); });
  };
  const toggleSource = (id: string) => setDisabled((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else if (sources.length - next.size > 1) next.add(id);
    return next;
  });

  return <div className="usage-workspace" aria-label="Usage Activity" aria-busy={pending}>
    <div className="usage-controls" title={`Times in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`}>
      <div className="usage-instances" role="group" aria-label="Instances">
        {sources.map((source) => {
          const id = sourceId(source.target);
          const offline = source.status !== undefined && source.status !== "connected";
          return <button type="button" key={id} className={`usage-instance${offline ? " is-offline" : ""}`}
            aria-pressed={!disabled.has(id)} onClick={() => toggleSource(id)}
            title={offline ? `${source.label} is ${source.status}` : source.label}><i aria-hidden="true" />{source.label}</button>;
        })}
      </div>
      <div className="usage-segmented" role="group" aria-label="Period">
        {PRESETS.map((item) => <button type="button" key={item.value} aria-pressed={preset === item.value} title={item.title}
          onClick={() => setPreset(item.value)}>{item.label}</button>)}
      </div>
      {preset === "custom" ? <><label className="usage-date">From <input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label className="usage-date">To <input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} /></label></> : null}
      <span className="usage-controls__spacer" />
      <span className="usage-controls__asof">{snapshot ? snapshot.queryKey !== queryKey ? "Selection changed" : available ? `Read ${usageClock(Math.max(...snapshot.sources.map((source) => source.data?.readAt ?? 0)))}` : "No instances available" : Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
      <button type="button" className="usage-button" disabled={pending || analyzing || !desktopApi?.readUsageActivity} onClick={() => void refresh()}>{pending ? "Reading…" : snapshot ? snapshot.queryKey !== queryKey ? "Apply selection" : "Refresh" : "Load activity"}</button>
    </div>
    {error ? <p role="alert" className="usage-error">{error}</p> : null}
    {missing.length || capped.length ? <div className="usage-coverage" role="status"><span className="usage-status-dot is-partial" />
      <span>{missing.map((source) => <span key={sourceId(source.target)}><strong>{source.label} is unavailable.</strong> Its threads are not listed; the limits still count its usage. <span className="usage-subtle">{source.error}</span> </span>)}
        {capped.map((source) => <span key={sourceId(source.target)}><strong>{source.label}</strong> returned its newest 5,000 rows. Narrow the window for the rest. </span>)}</span></div> : null}
    {snapshot && summary ? <>
      <UsageLimitsBand accounts={snapshot.accounts} focusKey={focus?.key} onFocus={setFocusKey} now={snapshot.to}
        cost={available ? total : undefined} threads={summary.groups.length} turns={summary.contained}
        cacheShare={cacheShare} uncached={totals.uncached} output={totals.output} />
      {buckets ? <UsageTimeline buckets={buckets} selected={bucket} onSelect={setBucket}
        series={(summary.groups).slice(0, USAGE_SERIES).map((group) => `${group.title} · ${money(group.cost)}`)}
        limit={lineSeries ? { label: limitLabel(lineSeries), points: lineSeries.points, resets: lineSeries.resets } : undefined} /> : null}
      <div className={`usage-results${inspected ? " has-inspector" : ""}`}>
        <section className="usage-results__main" aria-label="Usage results">
          <div className="usage-results__toolbar">
            {lens === "threads" ? <span className="usage-results__title"><span className="usage-eyebrow">Threads</span> <span className="usage-subtle">{filteredSummary?.groups.length ?? 0}</span></span>
              : <button type="button" className="usage-link" onClick={() => setLens("threads")}>← Threads</button>}
            <span className="usage-controls__spacer" />
            <label className="usage-search"><span className="usage-sr-only">Find a thread</span><input placeholder="Find a thread…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
            {lens === "threads" ? <label><span className="usage-sr-only">Sort threads</span><Select value={sort} onChange={setSort} options={[
              { value: "cost", label: "Highest cost" }, { value: "tokens", label: "Most tokens" }, { value: "recent", label: "Latest completion" },
            ]} /></label> : null}
          </div>
          {selectedInterval && lens === "threads" ? <div className="usage-filter-note">Completed {usageClock(selectedInterval.from)}–{usageClock(selectedInterval.to)}<button type="button" onClick={() => setBucket(undefined)}>Clear time filter ×</button></div> : null}
          {lens === "excluded" ? <p className="usage-list-note">These intervals start before the window, run past it, or were never attributed to a turn. Their whole-row prices are shown for context; none counts toward the total.</p> : null}
          {lens === "threads" ? <div className="usage-list-head"><span>Thread / instance</span><span>When</span><span>Signals</span><span>Input · cached</span><span>API-eq.</span></div> : null}
          <div className="usage-thread-list">
            {lens === "threads" ? groups.slice(0, 250).map((group) => {
              const row = group.rows[0];
              const series = seriesIndex.get(group.key);
              const strip = usageSpendStrip(group.rows, snapshot.from, snapshot.to);
              const stripMax = Math.max(1, ...strip);
              const signals = groupSignals(group);
              const modelNames = [...new Set(group.rows.filter((item) => !group.helperRows.includes(item))
                .map((item) => item.line.modelLabel ?? item.line.model ?? "Unknown model"))].join(", ");
              return <button type="button" key={group.key} className={`usage-thread usage-thread--series-${series ?? "other"}`} disabled={analyzing}
                aria-label={`Inspect ${group.title}`} aria-pressed={selectedGroup?.key === group.key} onClick={() => inspectGroup(group)}>
                <span className="usage-thread__identity"><i className={`usage-thread__swatch usage-series--${series ?? "other"}`} aria-hidden="true" />
                  <span><strong>{group.title}</strong><small>{row.owner} · {modelNames}{group.helperThreads ? ` · ${group.helperThreads} ${group.helperThreads === 1 ? "helper" : "helpers"}, ${money(group.helperCost)} included` : ""}</small></span></span>
                <span className="usage-thread__strip" aria-hidden="true">{strip.map((cost, index) =>
                  <i key={index} style={cost > 0 ? { opacity: 0.3 + 0.7 * cost / stripMax } : undefined} className={cost > 0 ? `usage-series--${series ?? "other"}` : undefined} />)}</span>
                <UsageSignals signals={signals} />
                <span className="usage-thread__tokens">{compact(group.uncached + group.cached)}<small>{Math.round(group.cached / Math.max(1, group.uncached + group.cached) * 100)}% cached</small></span>
                <span className="usage-thread__cost"><strong>{money(group.cost)}</strong><small>{group.unpriced ? `${group.unpriced} unpriced` : `${total ? Math.round(group.cost / total * 100) : 0}%`}</small></span>
              </button>;
            }) : excluded.slice(0, 250).map((row) => <button type="button" className="usage-thread usage-thread--excluded" key={`${row.line.backend}:${row.line.usageLineId}`} disabled={analyzing}
              aria-label={`Inspect ${row.title}`} aria-pressed={selectedExcluded === row} onClick={() => inspectExcluded(row)}>
              <span className="usage-thread__identity"><span><strong>{row.title}</strong><small>{row.owner} · {time(row.line.startedAt ?? row.line.createdAt)}</small></span></span>
              <span className="usage-thread__tokens">{row.line.scope}<small>{row.line.source} · {row.line.completedAt === undefined ? "unfinished" : "outside total"}</small></span>
              <span className="usage-thread__cost"><strong>{row.line.priceStatus === "priced" && row.line.currency === "USD" ? money(row.line.totalCostMicros) : "Unpriced"}</strong><small>excluded</small></span>
            </button>)}
            {(lens === "threads" ? groups : excluded).length === 0 ? <div className="usage-empty"><strong>{search ? "No matching threads" : "No usage in this view"}</strong><p>{search ? "Try a thread title or instance name." : "Choose a wider window, or check the excluded intervals."}</p></div> : null}
            {(lens === "threads" ? groups : excluded).length > 250 ? <p className="usage-list-note">Showing 250 results. Filter by thread name or narrow the time window.</p> : null}
          </div>
          <div className="usage-list-footer"><span>{summary.groups.length} threads · {summary.contained} turns contained in the window</span>
            {lens === "threads" && summary.excluded.length ? <button type="button" className="usage-link" onClick={() => setLens("excluded")}>{summary.excluded.length} excluded {summary.excluded.length === 1 ? "interval" : "intervals"}</button>
              : <span>USD list-price estimate</span>}</div>
        </section>
        {inspected ? <UsageInspector group={selectedGroup} row={selectedExcluded} total={total} turn={turn}
          onTurn={(row) => { setTurn(row); setScope("turn"); setAnalysis(undefined); }} onClose={closeInspector}
          scope={scope} onScope={(next) => { setScope(next); setAnalysis(undefined); }}
          models={models} model={model} onModel={setModel}
          entryLimit={entryLimit} onEntryLimit={setEntryLimit} characterLimit={characterLimit} onCharacterLimit={setCharacterLimit}
          analysis={analysis} analyzing={analyzing} canAnalyze={Boolean(desktopApi?.analyzeUsageActivity)} onAnalyze={runAnalysis} /> : null}
      </div>
    </> : <div className="usage-empty usage-empty--initial"><span className="usage-eyebrow">Across your instances</span><h2>See where your usage goes.</h2>
      <p>Compare your account limits with the threads that spent them, then analyze the turns behind the spend.</p><span>Choose instances and a period, then load activity.</span></div>}
  </div>;
}
