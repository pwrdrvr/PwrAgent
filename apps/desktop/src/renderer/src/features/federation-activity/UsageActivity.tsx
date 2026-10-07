import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { AppServerBackendKind, DesktopHelperModelSettings, FederationTarget, ReadUsageActivityResponse,
  UsageAnalysisModelBackend } from "@pwragent/shared";
import { UsageTimeline, type UsageChartForecast, type UsageChartMember } from "./UsageTimeline";
import { UsageLimitsBand } from "./UsageLimitsBand";
import { UsageInspector, analysisModelKey, defaultAnalysisModel, parseAnalysisModelKey,
  type AnalysisModelChoice, type AnalysisScope, type UsageAnalysis } from "./UsageInspector";
import { UsageSignals, groupSignals } from "./UsageSignals";
import { USAGE_SERIES, usageBucketLabel, usageCompletionBuckets, usageDimensionValue, type UsageDimension, usageNotCountedReason, usageSpendStrip, usageMoney as money, usageCount as compact, usageClock } from "./usage-activity-presentation";
import { buildLimitAccounts, fiveHourSeries, limitLabel, projectLimit, seriesStart, sinceResetSeries, type LimitAccount, type LimitSeries } from "./usage-limits";
import { Select } from "../../components/Select";
import type { DesktopApi } from "../../lib/desktop-api";
import { summarizeUsageActivity, type OwnedUsageRow, type UsageGroup } from "./usage-activity-summary";
import { USAGE_RESULTS_MAX_HEIGHT, USAGE_RESULTS_MIN_HEIGHT, clampUsageResultsHeight, readStoredUsageResultsHeight,
  writeStoredUsageResultsHeight } from "./usage-activity-layout";

const DAY = 86_400_000;
const MAX_WINDOW = 31 * DAY;
/** A focused window rereads when its data is older than this. */
const STALE_AFTER = 60_000;
const time = (value: number) => new Date(value).toLocaleString();
const localDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const sourceId = (target: FederationTarget) => target.scope === "local" ? "local" : target.instanceId;

type Source = { label: string; target: FederationTarget; status?: string };
type Preset = "reset" | "five" | "today" | "day" | "week" | "month" | "custom";
type SourceResult = Source & { data?: ReadUsageActivityResponse; error?: string };
type Snapshot = {
  queryKey: string; from: number; to: number; preset: Preset; readAt: number;
  rows: OwnedUsageRow[]; sources: SourceResult[]; accounts: LimitAccount[];
};

const PRESETS: Array<{ value: Preset; label: string; title: string }> = [
  { value: "reset", label: "Since reset", title: "Since the account's longest limit last reset" },
  { value: "five", label: "5-hour window", title: "The current 5-hour limit window" },
  { value: "today", label: "Today", title: "Since midnight" },
  { value: "day", label: "24 h", title: "The last 24 hours" },
  { value: "week", label: "7 days", title: "The last 7 days" },
  { value: "month", label: "30 days", title: "The last 30 days" },
  { value: "custom", label: "Custom", title: "Choose a start and end" },
];

const isOnline = (source: Source) => source.target.scope === "local" || source.status === undefined || source.status === "connected";

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

/**
 * A peer that answers "no handler" runs a PwrAgent from before usage activity;
 * one that answers "not connected" dropped between discovery and the read.
 */
function unavailableKind(error: string): "outdated" | "offline" | "failed" {
  if (/method_not_found|No federation handler/i.test(error)) return "outdated";
  if (/target_unavailable|not connected/i.test(error)) return "offline";
  return "failed";
}

const DIMENSION_LABELS: Record<UsageDimension, string> = { thread: "Thread", model: "Model", provider: "Provider", instance: "Instance" };

/** One analysis per thread and turn; its answer stays with it while the operator looks elsewhere. */
const analysisKey = (row: OwnedUsageRow, turnId: string | undefined) =>
  `${sourceId(row.target)}|${row.line.backend}|${row.line.threadId}|${turnId ?? "recent"}`;

/** The current pace carried to the limit's reset, for a window that ends now. */
function limitForecast(series: LimitSeries | undefined): UsageChartForecast | undefined {
  const projection = series ? projectLimit(series) : undefined;
  const resetAt = series?.latest.resetAt;
  if (!series || !projection || resetAt === undefined) return undefined;
  const { latest } = series;
  return { start: { at: latest.at, percent: latest.usedPercent }, resetAt,
    ...projection.kind === "full"
      ? { end: { at: projection.at, percent: 100 }, fullAt: projection.at }
      : { end: { at: projection.resetAt, percent: projection.percent } } };
}

/** An IPC failure without the "Error invoking remote method …: Error:" wrapping Electron adds. */
const plainError = (cause: unknown) =>
  String(cause).replace(/^(?:Error: |Error invoking remote method '[^']*': )+/, "");

function nameList(names: string[]) {
  return names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

export function UsageActivity({ desktopApi }: { desktopApi?: DesktopApi }) {
  const [sources, setSources] = useState<Source[]>([{ label: "This instance", target: { scope: "local" } }]);
  // Until discovery settles, a read would miss every peer and immediately be
  // replaced; the first read waits for it.
  const [peersReady, setPeersReady] = useState(() => !desktopApi?.readFederationActivity);
  const [disabled, setDisabled] = useState<Set<string>>(() => new Set());
  const [preset, setPreset] = useState<Preset>("reset");
  const [lens, setLens] = useState<"threads" | "excluded">("threads");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("cost");
  const [bucket, setBucket] = useState<number>();
  const [dimension, setDimension] = useState<UsageDimension>("thread");
  // One model, provider or instance the thread list is narrowed to.
  const [facet, setFacet] = useState<string>();
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
  const [models, setModels] = useState<AnalysisModelChoice[]>([]);
  // An explicit pick; undefined follows the Usage analysis default model.
  const [model, setModel] = useState<string>();
  const [helperModels, setHelperModels] = useState<DesktopHelperModelSettings>();
  const [entryLimit, setEntryLimit] = useState("40");
  const [characterLimit, setCharacterLimit] = useState("20000");
  const [analysis, setAnalysis] = useState<UsageAnalysis>();
  const [dismissedCoverage, setDismissedCoverage] = useState<string>();
  const [resultsHeight, setResultsHeight] = useState(readStoredUsageResultsHeight);
  const resultsRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const readSeq = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const discoverPeers = useCallback(() => {
    if (!desktopApi?.readFederationActivity) return;
    void desktopApi.readFederationActivity({ includeHistory: false }).then((value) => {
      if (!mounted.current) return;
      setSources([{ label: value.health.localLabel ?? "This instance", target: { scope: "local" } },
        ...value.health.peers.filter((peer) => peer.id !== value.health.instanceId).map((peer) => ({
          label: `${peer.label}${peer.profileName ? ` (${peer.profileName})` : ""}`, status: peer.status,
          target: { scope: "remote" as const, instanceId: peer.id },
        }))]);
    }).catch(() => { /* Reads still cover this instance. */ })
      .finally(() => { if (mounted.current) setPeersReady(true); });
  }, [desktopApi]);
  useEffect(() => { discoverPeers(); }, [discoverPeers]);
  useEffect(() => {
    const readHelperModels = () => void desktopApi?.readSettings?.({}).then((value) => {
      if (mounted.current) setHelperModels(value.snapshot.models.helperModels);
    }).catch(() => { /* Automatic stays the default. */ });
    readHelperModels();
    // Config writes are not broadcast. Coming back from Settings focuses this
    // window, so a Helper model change moves the default then.
    window.addEventListener("focus", readHelperModels);
    return () => window.removeEventListener("focus", readHelperModels);
  }, [desktopApi]);

  const summary = useMemo(() => snapshot ? summarizeUsageActivity(snapshot.rows, snapshot.from, snapshot.to) : undefined, [snapshot]);
  const selectedGroup = selectedKey ? summary?.groups.find((group) => group.key === selectedKey) : undefined;
  const inspected = selectedGroup?.rows[0] ?? selectedExcluded;
  const analysisTarget = scope === "turn" && turn?.line.turnId ? turn : inspected;
  const analysisTurnId = scope === "turn" ? analysisTarget?.line.turnId : undefined;
  const currentAnalysisKey = analysisTarget ? analysisKey(analysisTarget, analysisTurnId) : undefined;
  const analyzing = analysis?.status === "running";
  const modelTarget = analysisTarget?.target;
  const modelTargetKey = modelTarget ? sourceId(modelTarget) : undefined;
  // Only an owner that lists a backend runs analysis on it. An older owner
  // lists none and would ask Codex for a Grok model, so it gets Codex only.
  const ownerBackends: readonly UsageAnalysisModelBackend[] = snapshot?.sources
    .find((source) => sourceId(source.target) === modelTargetKey)?.data?.analysisModelBackends ?? ["codex"];
  const ownerBackendsKey = ownerBackends.join(",");
  useEffect(() => {
    let disposed = false;
    setModels([]);
    // Before the owner's models arrive, and if they never do, a choice on a
    // backend this owner does not list is not sent to it.
    setModel((current) => current && ownerBackends.includes(parseAnalysisModelKey(current).backend) ? current : undefined);
    if (modelTarget) void desktopApi?.listBackends?.({ federationTarget: modelTarget }).then((value) => {
      if (disposed) return;
      const choices = ownerBackends.flatMap((kind) => {
        const backend = value.backends.find((item) => item.kind === kind);
        if (!backend || (kind !== "codex" && !backend.available)) return [];
        return (backend.launchpadOptions?.models ?? []).map((item) => ({ backend: kind, id: item.id, label: item.label ?? item.id, agent: backend.label }));
      });
      setModels(choices);
      // An agent this owner cannot run falls back to the default. A Codex
      // model stays selectable; the owner reports its availability.
      setModel((current) => current === undefined || parseAnalysisModelKey(current).backend === "codex"
        || choices.some((item) => analysisModelKey(item.backend, item.id) === current) ? current : undefined);
    }).catch(() => { /* The default stays selectable; the owner reports availability. */ });
    return () => { disposed = true; };
    // Refetch per owner, not per selected row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktopApi, modelTargetKey, ownerBackendsKey]);

  const defaultModel = useMemo(() => defaultAnalysisModel(helperModels, models, ownerBackends),
    // ownerBackends is rebuilt each render; its key is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [helperModels, models, ownerBackendsKey]);
  const selectedModel = model ?? defaultModel.value;
  const enabledSources = sources.filter((source) => isOnline(source) && !disabled.has(sourceId(source.target)));
  const offlineSources = sources.filter((source) => !isOnline(source));
  const limitPreset = preset === "reset" || preset === "five";
  const queryKey = JSON.stringify([enabledSources.map((source) => sourceId(source.target)), preset,
    preset === "custom" ? [from, to] : null, limitPreset ? focusKey ?? null : null]);
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
    if (!desktopApi?.readUsageActivity) return;
    const seq = ++readSeq.current;
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
      : preset === "month" ? end - 30 * DAY
      : known ?? end - (preset === "five" ? 5 * 3_600_000 : 8 * DAY);
    if (preset !== "custom") start = Math.max(start, end - MAX_WINDOW);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > MAX_WINDOW) {
      setError("Choose a start before the end, within 31 days."); return;
    }
    // A refresh of the same selection keeps what the operator was looking at.
    const sameQuery = snapshot?.queryKey === queryKey;
    setPending(true); setError(undefined);
    if (!sameQuery) {
      setSelectedKey(undefined); setSelectedExcluded(undefined); setTurn(undefined); setBucket(undefined); setFacet(undefined);
    }
    let results = await readAll(enabledSources, start, end);
    if (!mounted.current || seq !== readSeq.current) return;
    let accounts = accountsOf(results);
    const resolved = limitStart(preset, focusAccount(accounts, focusKey, localLabel));
    if (resolved !== undefined && resolved < end) {
      const bounded = Math.max(resolved, end - MAX_WINDOW);
      if (Math.abs(bounded - start) > 60_000) {
        // Read once more over the window itself: from its start when it began
        // earlier than what was read, and when it began later, so the owners'
        // helper rollups and bars fit the window instead of straddling its start.
        results = await readAll(enabledSources, bounded, end);
        if (!mounted.current || seq !== readSeq.current) return;
        accounts = accountsOf(results);
      }
      start = bounded;
    }
    setSnapshot({ queryKey, from: start, to: end, preset, readAt: Date.now(), sources: results, accounts,
      // A narrowed window drops turns that finished before it began; they are
      // outside the window, not intervals that straddle its start.
      rows: results.flatMap((source) => (source.data?.rows ?? [])
        .filter((row) => row.line.completedAt === undefined || row.line.completedAt >= start)
        .map((row) => ({ ...row, owner: source.label, target: source.target }))) });
    setPending(false);
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  // Every selection change reads at once; a custom range waits for typing to
  // pause so each keystroke in a date field is not a read.
  useEffect(() => {
    if (!peersReady || !desktopApi?.readUsageActivity) return;
    const timer = window.setTimeout(() => void refreshRef.current(), preset === "custom" ? 400 : 0);
    return () => window.clearTimeout(timer);
  }, [queryKey, peersReady, desktopApi, preset]);
  // Coming back to the window rereads data that has gone stale, and picks up
  // peers that connected meanwhile.
  useEffect(() => {
    const onFocus = () => {
      const current = snapshotRef.current;
      if (!current || Date.now() - current.readAt < STALE_AFTER) return;
      discoverPeers();
      void refreshRef.current();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [discoverPeers]);

  const included = summary?.groups.flatMap((group) => group.rows) ?? [];
  const instances = (snapshot?.sources ?? []).filter((source) => source.data).length;
  const shownDimension: UsageDimension = dimension === "instance" && instances < 2 ? "thread" : dimension;
  // The five most expensive threads (or models, providers, instances) get
  // chart colors; a thread keeps its color in every row, strip, and legend entry.
  const seriesIndex = new Map(shownDimension === "thread"
    ? (summary?.groups ?? []).slice(0, USAGE_SERIES).map((group, index) => [group.key, index]) : []);
  const rowSeries = new Map<OwnedUsageRow, number>();
  let facets: Array<{ value: string; cost: number }> = [];
  if (shownDimension === "thread") {
    for (const group of summary?.groups ?? []) {
      const index = seriesIndex.get(group.key);
      if (index !== undefined) for (const row of group.rows) rowSeries.set(row, index);
    }
  } else {
    const costs = new Map<string, number>();
    for (const row of included) {
      const value = usageDimensionValue(row, shownDimension);
      costs.set(value, (costs.get(value) ?? 0) + (row.line.priceStatus === "priced" && row.line.currency === "USD" ? row.line.totalCostMicros : 0));
    }
    facets = [...costs].map(([value, cost]) => ({ value, cost })).sort((a, b) => b.cost - a.cost);
    const index = new Map(facets.slice(0, USAGE_SERIES).map((item, position) => [item.value, position]));
    for (const row of included) {
      const position = index.get(usageDimensionValue(row, shownDimension));
      if (position !== undefined) rowSeries.set(row, position);
    }
  }
  const activeFacet = shownDimension !== "thread" && facet !== undefined && facets.some((item) => item.value === facet) ? facet : undefined;
  // A bucket member is the row's thread, model, provider or instance; its
  // thread is the group it rolls up to, so a helper counts as its parent.
  const rowThread = new Map((summary?.groups ?? []).flatMap((group) => group.rows.map((row) => [row, group.key] as const)));
  const buckets = snapshot ? usageCompletionBuckets(included, snapshot.from, snapshot.to, (row) => rowSeries.get(row), (row) => {
    const thread = rowThread.get(row) ?? "";
    return { key: shownDimension === "thread" ? thread : usageDimensionValue(row, shownDimension), thread };
  }) : undefined;
  const selectedInterval = bucket === undefined ? undefined : buckets?.[bucket];
  const filteredSummary = snapshot && (selectedInterval || activeFacet !== undefined)
    ? summarizeUsageActivity(included.filter((row) => (!selectedInterval
      || (row.line.completedAt! >= selectedInterval.from && row.line.completedAt! < selectedInterval.to))
      && (activeFacet === undefined || usageDimensionValue(row, shownDimension as Exclude<UsageDimension, "thread">) === activeFacet)),
    snapshot.from, snapshot.to)
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
  const failures = (snapshot?.sources ?? []).filter((source) => source.error)
    .map((source) => ({ ...source, kind: unavailableKind(source.error!) }));
  const outdated = failures.filter((source) => source.kind === "outdated").map((source) => source.label);
  const offline = [...offlineSources.map((source) => source.label),
    ...failures.filter((source) => source.kind === "offline").map((source) => source.label)];
  const failed = failures.filter((source) => source.kind === "failed");
  const capped = (snapshot?.sources ?? []).filter((source) => source.data?.truncated).map((source) => source.label);
  const coverage = [
    outdated.length ? `${nameList(outdated)} ${outdated.length === 1 ? "needs" : "need"} a PwrAgent update to share usage` : "",
    offline.length ? `${nameList(offline)} ${offline.length === 1 ? "is" : "are"} offline` : "",
    failed.length ? `${nameList(failed.map((source) => source.label))} could not be read` : "",
    capped.length ? `${nameList(capped)} returned only the newest 5,000 rows; choose a shorter period for the rest` : "",
  ].filter(Boolean);
  const focus = snapshot ? focusAccount(snapshot.accounts, focusKey, localLabel) : undefined;
  const lineSeries = snapshot?.preset === "five" ? fiveHourSeries(focus) : sinceResetSeries(focus);
  // Only a window anchored on the limit ends now and belongs beside its reset.
  const forecast = snapshot?.preset === "reset" || snapshot?.preset === "five" ? limitForecast(lineSeries) : undefined;
  const coverageKey = coverage.join("|");
  const openThread = (row: OwnedUsageRow) => desktopApi?.openUsageThreadInMainWindow
    ? () => void desktopApi.openUsageThreadInMainWindow!({
      backend: row.line.backend as AppServerBackendKind, threadId: row.line.threadId,
      ...row.target.scope === "remote" ? { federationTarget: row.target } : {},
    }).catch((cause: unknown) => { if (mounted.current) setError(`Could not open the thread: ${String(cause)}`); })
    : undefined;

  // A thread opens in the main window; a model, provider or instance narrows
  // the thread list to itself. The legend and the slice card both name members this way.
  const groupsByKey = new Map((summary?.groups ?? []).map((group) => [group.key, group]));
  const chartMember = (key: string): UsageChartMember => {
    if (shownDimension === "thread") {
      const group = groupsByKey.get(key);
      return { title: group?.title ?? key, onOpen: group ? openThread(group.rows[0]) : undefined };
    }
    return { title: key, filtered: activeFacet === key, onFilter: () => setFacet((current) => current === key ? undefined : key) };
  };

  const inspectGroup = (group: UsageGroup) => {
    setSelectedExcluded(undefined); setSelectedKey(group.key); setError(undefined);
    const turns = group.rows.filter((row) => row.line.priceStatus === "priced" && !row.rollup);
    setTurn([...turns.length ? turns : group.rows].sort((a, b) => b.line.totalCostMicros - a.line.totalCostMicros)[0]);
    setScope("turn");
  };
  const inspectExcluded = (row: OwnedUsageRow) => {
    setSelectedKey(undefined); setSelectedExcluded(row); setTurn(undefined); setScope("recent"); setError(undefined);
  };
  const closeInspector = () => { setSelectedKey(undefined); setSelectedExcluded(undefined); setTurn(undefined); };
  const runAnalysis = () => {
    const target = analysisTarget;
    const key = currentAnalysisKey;
    if (!target || !key || !desktopApi?.analyzeUsageActivity || analyzing) return;
    const turnId = analysisTurnId;
    const choice = parseAnalysisModelKey(selectedModel);
    const started = { key, startedAt: Date.now(), owner: target.owner,
      modelLabel: models.find((item) => analysisModelKey(item.backend, item.id) === selectedModel)?.label
        ?? (selectedModel === defaultModel.value ? defaultModel.label : choice.id) };
    setAnalysis({ ...started, status: "running" });
    const settle = (next: UsageAnalysis) => { if (mounted.current) setAnalysis(next); };
    // Codex is sent as before, so a request to an older owner is unchanged.
    void desktopApi.analyzeUsageActivity({ backend: target.line.backend as AppServerBackendKind, threadId: target.line.threadId,
      ...turnId ? { turnId } : {}, federationTarget: target.target, model: choice.id,
      ...choice.backend !== "codex" ? { modelBackend: choice.backend } : {},
      entryLimit: Number(entryLimit), characterLimit: Number(characterLimit) })
      .then((result) => settle({ ...started, status: "done", result }))
      .catch((cause: unknown) => settle({ ...started, status: "failed", error: plainError(cause) }));
  };
  // The grip under the thread list sets its height; double-click returns it to filling the window.
  const resizeResults = (event: ReactPointerEvent<HTMLDivElement>) => {
    const grip = event.currentTarget;
    const startY = event.clientY;
    const startHeight = resultsRef.current?.getBoundingClientRect().height ?? USAGE_RESULTS_MIN_HEIGHT;
    let latest: number | undefined;
    grip.setPointerCapture?.(event.pointerId);
    const move = (next: PointerEvent) => { latest = clampUsageResultsHeight(startHeight + next.clientY - startY); setResultsHeight(latest); };
    const end = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      // A click without a drag leaves a list that fills the window as it was.
      if (latest !== undefined) writeStoredUsageResultsHeight(latest);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  };
  const nudgeResults = (delta: number) => {
    const next = clampUsageResultsHeight((resultsHeight ?? resultsRef.current?.getBoundingClientRect().height ?? USAGE_RESULTS_MIN_HEIGHT) + delta);
    setResultsHeight(next);
    writeStoredUsageResultsHeight(next);
  };
  const toggleSource = (id: string) => setDisabled((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else if (enabledSources.length > 1) next.add(id);
    return next;
  });

  return <div className="usage-workspace" aria-label="Usage Activity" aria-busy={pending}>
    <div className="usage-controls" title={`Times in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`}>
      <div className="usage-instances" role="group" aria-label="Instances">
        {sources.map((source) => {
          const id = sourceId(source.target);
          const online = isOnline(source);
          return <button type="button" key={id} className={`usage-instance${online ? "" : " is-offline"}`}
            aria-pressed={online && !disabled.has(id)} disabled={!online} onClick={() => toggleSource(id)}
            title={online ? source.label : `${source.label} is offline`}><i aria-hidden="true" />{source.label}</button>;
        })}
      </div>
      <div className="usage-segmented" role="group" aria-label="Period">
        {PRESETS.map((item) => <button type="button" key={item.value} aria-pressed={preset === item.value} title={item.title}
          onClick={() => setPreset(item.value)}>{item.label}</button>)}
      </div>
      {preset === "custom" ? <><label className="usage-date">From <input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label className="usage-date">To <input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} /></label></> : null}
      <span className="usage-controls__spacer" />
      <span className="usage-controls__asof">{snapshot ? `Read ${usageClock(snapshot.readAt)}` : Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
      <button type="button" className="usage-button" disabled={pending || !desktopApi?.readUsageActivity} onClick={() => void refresh()}>{pending ? "Reading…" : "Refresh"}</button>
    </div>
    {error ? <p role="alert" className="usage-error">{error}</p> : null}
    {coverage.length && coverageKey !== dismissedCoverage ? <div className="usage-coverage" role="status"><span className="usage-status-dot is-partial" aria-hidden="true" />
      <span className="usage-coverage__text">Not included: {coverage.join(" · ")}.</span>
      <button type="button" className="usage-icon-button usage-coverage__dismiss" aria-label="Dismiss notice"
        title="Hide until a different set of instances is missing" onClick={() => setDismissedCoverage(coverageKey)}>×</button>
      {failures.length ? <details className="usage-coverage__details"><summary>Details</summary>
        <ul>{failures.map((source) => <li key={sourceId(source.target)}><strong>{source.label}</strong> {source.error}</li>)}</ul></details> : null}
    </div> : null}
    {snapshot && summary ? <>
      <UsageLimitsBand accounts={snapshot.accounts} focusKey={focus?.key} onFocus={setFocusKey} now={snapshot.to}
        cost={available ? total : undefined} threads={summary.groups.length} turns={summary.contained}
        cacheShare={cacheShare} uncached={totals.uncached} output={totals.output} />
      {buckets ? <UsageTimeline buckets={buckets} selected={bucket} onSelect={setBucket}
        dimension={shownDimension} onDimension={(next) => { setDimension(next); setFacet(undefined); }}
        dimensions={instances > 1 ? ["thread", "model", "provider", "instance"] : ["thread", "model", "provider"]}
        series={shownDimension === "thread"
          ? summary.groups.slice(0, USAGE_SERIES).map((group) => ({ ...chartMember(group.key), cost: money(group.cost) }))
          : facets.slice(0, USAGE_SERIES).map((item) => ({ ...chartMember(item.value), cost: money(item.cost) }))}
        member={chartMember}
        limit={lineSeries ? { label: limitLabel(lineSeries), points: lineSeries.points, resets: lineSeries.resets } : undefined}
        forecast={forecast} /> : null}
      <div className={`usage-results${inspected ? " has-inspector" : ""}`} ref={resultsRef}
        style={resultsHeight === undefined ? undefined : { flex: "none", height: resultsHeight }}>
        <section className="usage-results__main" aria-label="Usage results">
          <div className="usage-results__toolbar">
            {lens === "threads" ? <span className="usage-results__title"><span className="usage-eyebrow">Threads</span> <span className="usage-subtle">{filteredSummary?.groups.length ?? 0}{filteredSummary !== summary ? ` of ${summary.groups.length}` : ""}</span></span>
              : <button type="button" className="usage-link" onClick={() => setLens("threads")}>← Threads</button>}
            {selectedInterval && lens === "threads" ? <button type="button" className="usage-chip" aria-label="Clear time filter"
              onClick={() => setBucket(undefined)}>Completed {usageBucketLabel(selectedInterval, snapshot.to)}<span aria-hidden="true">×</span></button> : null}
            <span className="usage-controls__spacer" />
            <label className="usage-search"><span className="usage-sr-only">Find a thread</span><input placeholder="Find a thread…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
            {lens === "threads" ? <label><span className="usage-sr-only">Sort threads</span><Select value={sort} onChange={setSort} options={[
              { value: "cost", label: "Highest cost" }, { value: "tokens", label: "Most tokens" }, { value: "recent", label: "Latest completion" },
            ]} /></label> : null}
          </div>
          {activeFacet !== undefined && lens === "threads" ? <div className="usage-filter-note">{DIMENSION_LABELS[shownDimension]}: {activeFacet}<button type="button" onClick={() => setFacet(undefined)}>Clear {DIMENSION_LABELS[shownDimension].toLocaleLowerCase()} filter ×</button></div> : null}
          {lens === "excluded" ? <p className="usage-list-note">Only work that both started and finished in this period counts toward the total.
            These did not, or were never tied to a turn. Their prices are shown for context and are not part of any total above.</p> : null}
          {lens === "threads" ? <div className="usage-list-head"><span>Thread / instance</span><span>When</span><span>Signals</span><span>Input · cached</span><span>API-eq.</span></div> : null}
          <div className="usage-thread-list">
            {lens === "threads" ? groups.slice(0, 250).map((group) => {
              const row = group.rows[0];
              const series = seriesIndex.get(group.key);
              const strip = usageSpendStrip(group.rows, snapshot.from, snapshot.to);
              const stripMax = Math.max(1, ...strip);
              const signals = groupSignals(group);
              const modelNames = [...new Set(group.rows.filter((item) => !group.helperRows.includes(item) && !item.rollup)
                .map((item) => item.line.modelLabel ?? item.line.model ?? "Unknown model"))].join(", ");
              return <button type="button" key={group.key} className={`usage-thread usage-thread--series-${series ?? "other"}`}
                aria-label={`Inspect ${group.title}`} aria-pressed={selectedGroup?.key === group.key} onClick={() => inspectGroup(group)}>
                <span className="usage-thread__identity"><i className={`usage-thread__swatch usage-series--${series ?? "other"}`} aria-hidden="true" />
                  <span><strong>{group.title}</strong><small>{row.owner}{modelNames ? ` · ${modelNames}` : ""}{group.helperThreads ? ` · ${group.helperThreads} ${group.helperThreads === 1 ? "helper" : "helpers"}, ${money(group.helperCost)} included` : ""}</small></span></span>
                <span className="usage-thread__strip" aria-hidden="true">{strip.map((cost, index) =>
                  <i key={index} style={cost > 0 ? { opacity: 0.3 + 0.7 * cost / stripMax } : undefined} className={cost > 0 ? `usage-series--${series ?? "other"}` : undefined} />)}</span>
                <UsageSignals signals={signals} />
                <span className="usage-thread__tokens">{compact(group.uncached + group.cached)}<small>{Math.round(group.cached / Math.max(1, group.uncached + group.cached) * 100)}% cached</small></span>
                <span className="usage-thread__cost"><strong>{money(group.cost)}</strong><small>{group.unpriced ? `${group.unpriced} unpriced` : `${total ? Math.round(group.cost / total * 100) : 0}%`}</small></span>
              </button>;
            }) : excluded.slice(0, 250).map((row) => <button type="button" className="usage-thread usage-thread--excluded" key={`${row.line.backend}:${row.line.usageLineId}`}
              aria-label={`Inspect ${row.title}`} aria-pressed={selectedExcluded === row} onClick={() => inspectExcluded(row)}>
              <span className="usage-thread__identity"><span><strong>{row.title}</strong><small>{row.owner} · started {time(row.line.startedAt ?? row.line.createdAt)}</small></span></span>
              <span className="usage-thread__reason">{usageNotCountedReason(row, snapshot.from, snapshot.to)}</span>
              <span className="usage-thread__cost"><strong>{row.line.priceStatus === "priced" && row.line.currency === "USD" ? money(row.line.totalCostMicros) : "Unpriced"}</strong><small>not counted</small></span>
            </button>)}
            {(lens === "threads" ? groups : excluded).length === 0 ? <div className="usage-empty"><strong>{search ? "No matching threads" : "No usage in this period"}</strong><p>{search ? "Try a thread title or instance name." : "Choose a longer period."}</p></div> : null}
            {(lens === "threads" ? groups : excluded).length > 250 ? <p className="usage-list-note">Showing 250 results. Filter by thread name or choose a shorter period.</p> : null}
          </div>
          <div className="usage-list-footer"><span>{summary.groups.length} threads · {summary.contained} turns in the total</span>
            {lens === "threads" && summary.excluded.length ? <button type="button" className="usage-link" title="Work that started before this period, finished after it, or never recorded an end"
              onClick={() => setLens("excluded")}>{summary.excluded.length} not counted</button>
              : <span>USD list-price estimate</span>}</div>
        </section>
        {inspected ? <UsageInspector group={selectedGroup} row={selectedExcluded} total={total} turn={turn}
          onTurn={(row) => { setTurn(row); setScope("turn"); }} onClose={closeInspector}
          onOpenThread={openThread(inspected)}
          scope={scope} onScope={setScope}
          models={models} defaultModel={defaultModel} model={selectedModel} onModel={setModel}
          entryLimit={entryLimit} onEntryLimit={setEntryLimit} characterLimit={characterLimit} onCharacterLimit={setCharacterLimit}
          analysis={analysis?.key === currentAnalysisKey ? analysis : undefined} analyzing={analyzing} canAnalyze={Boolean(desktopApi?.analyzeUsageActivity)} onAnalyze={runAnalysis} /> : null}
      </div>
      <div className="usage-results-grip" role="separator" aria-orientation="horizontal" aria-label="Resize thread list"
        aria-valuenow={Math.round(resultsHeight ?? resultsRef.current?.getBoundingClientRect().height ?? USAGE_RESULTS_MIN_HEIGHT)}
        aria-valuemin={USAGE_RESULTS_MIN_HEIGHT} aria-valuemax={USAGE_RESULTS_MAX_HEIGHT} tabIndex={0}
        title="Drag to resize. Double-click to fit the window."
        onPointerDown={resizeResults}
        onDoubleClick={() => { setResultsHeight(undefined); writeStoredUsageResultsHeight(undefined); }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          nudgeResults(event.key === "ArrowDown" ? 24 : -24);
        }}><span aria-hidden="true" /></div>
    </> : <div className="usage-empty usage-empty--initial" role="status">{pending || !peersReady
      ? <><span className="usage-eyebrow">Reading usage</span><p>Collecting limits and spend from your instances…</p></>
      : <><span className="usage-eyebrow">No usage read</span><p>Refresh to read usage from your instances.</p></>}</div>}
  </div>;
}
