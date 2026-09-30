import { useEffect, useRef, useState } from "react";
import type { AnalyzeUsageActivityResponse, UsageAnalysisModelBackend } from "@pwragent/shared";
import { Select } from "../../components/Select";
import { usageClock, usageMoney } from "./usage-activity-presentation";
import type { OwnedUsageRow, UsageGroup } from "./usage-activity-summary";
import { UsageSignals, turnSignals } from "./UsageSignals";

const priced = (row: OwnedUsageRow) => row.line.priceStatus === "priced" && row.line.currency === "USD";
const cacheShare = (row: OwnedUsageRow) => {
  const input = row.line.cachedInputTokens + row.line.uncachedInputTokens;
  return input ? Math.round(row.line.cachedInputTokens / input * 100) : 0;
};

export type AnalysisScope = "turn" | "recent";

/** A model the owner can run analysis on, and the agent that serves it. */
export type AnalysisModelChoice = { backend: UsageAnalysisModelBackend; id: string; label: string; agent: string };

/** One picker value per backend and model. Model IDs never contain a space. */
export const analysisModelKey = (backend: UsageAnalysisModelBackend, id: string) => `${backend} ${id}`;
export function parseAnalysisModelKey(key: string): { backend: UsageAnalysisModelBackend; id: string } {
  const space = key.indexOf(" ");
  return { backend: key.slice(0, space) as UsageAnalysisModelBackend, id: key.slice(space + 1) };
}
export const DEFAULT_ANALYSIS_MODEL = analysisModelKey("codex", "gpt-6-luna");

/** An analysis request and where it got to. `key` names the thread and turn it read. */
export type UsageAnalysis = { key: string; startedAt: number; owner: string; modelLabel: string } & (
  | { status: "running" }
  | { status: "done"; result: AnalyzeUsageActivityResponse }
  | { status: "failed"; error: string });

/** Whole seconds since `from`, ticking while `active`. */
function useElapsed(from: number | undefined, active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, from]);
  return from === undefined ? 0 : Math.max(0, Math.round((now - from) / 1_000));
}

export function UsageInspector(props: {
  group?: UsageGroup;
  /** An excluded row inspected on its own, outside any group. */
  row?: OwnedUsageRow;
  total: number;
  turn?: OwnedUsageRow;
  onTurn: (row: OwnedUsageRow) => void;
  onClose: () => void;
  /** Focus the main window on this thread; absent where no window can show it. */
  onOpenThread?: () => void;
  scope: AnalysisScope;
  onScope: (scope: AnalysisScope) => void;
  models: AnalysisModelChoice[];
  /** An `analysisModelKey`. */
  model: string;
  onModel: (model: string) => void;
  entryLimit: string;
  onEntryLimit: (value: string) => void;
  characterLimit: string;
  onCharacterLimit: (value: string) => void;
  /** This target's analysis, running or settled. */
  analysis?: UsageAnalysis;
  /** Some analysis is running, perhaps for another thread. */
  analyzing: boolean;
  canAnalyze: boolean;
  onAnalyze: () => void;
}) {
  const { group, turn, analyzing, analysis } = props;
  const running = analysis?.status === "running";
  const elapsed = useElapsed(analysis?.startedAt, running);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Once this turn has an analysis the inspector splits into Details and
  // Analysis, and moves to Analysis when it starts and again when it lands.
  const [tab, setTab] = useState<"details" | "analysis">("details");
  const analysisMark = analysis ? `${analysis.key}@${analysis.startedAt}:${analysis.status}` : undefined;
  useEffect(() => {
    setTab(analysisMark ? "analysis" : "details");
    bodyRef.current?.scrollTo?.({ top: 0 });
  }, [analysisMark]);
  const lead = group?.rows[0] ?? props.row!;
  const turns = group ? [...group.rows].sort((a, b) => (b.line.completedAt ?? 0) - (a.line.completedAt ?? 0)) : [];
  const largest = Math.max(1, ...turns.map((row) => priced(row) ? row.line.totalCostMicros : 0));
  const target = turn ?? lead;
  const turnScope = props.scope === "turn" && target.line.turnId !== undefined && !target.rollup;
  // Each model names the agent it runs in, since the owner may offer several.
  const models = [{ value: DEFAULT_ANALYSIS_MODEL, label: "GPT-6-Luna", description: "Codex" },
    ...props.models.map((item) => ({ value: analysisModelKey(item.backend, item.id), label: item.label, description: item.agent }))
      .filter((item) => item.value !== DEFAULT_ANALYSIS_MODEL)];

  const turnList = group ? <div className="usage-turns">
    <div className="usage-eyebrow">Turns in window <span className="usage-subtle">· cached · cost</span></div>
    <div className="usage-turns__list" role="group" aria-label="Turns in window">
      {turns.slice(0, 40).map((row) => {
        const isHelper = group.helperRows.includes(row);
        const signals = turnSignals(row.line, isHelper ? row.title : undefined, row.rollup);
        return <button type="button" key={row.line.usageLineId} className="usage-turn" aria-pressed={row === turn}
          aria-label={`Turn ${usageClock(row.line.startedAt ?? row.line.createdAt)} to ${usageClock(row.line.completedAt!)}${isHelper ? `, helper ${row.title}` : ""}`}
          onClick={() => props.onTurn(row)}>
          <time>{usageClock(row.line.startedAt ?? row.line.createdAt)}–{usageClock(row.line.completedAt!)}</time>
          <span className="usage-turn__cache">{cacheShare(row)}%</span>
          <span className="usage-turn__meter"><i style={{ width: `${priced(row) ? row.line.totalCostMicros / largest * 100 : 0}%` }} /></span>
          <strong>{priced(row) ? usageMoney(row.line.totalCostMicros) : "—"}</strong>
          {signals.length ? <UsageSignals signals={signals} /> : null}
        </button>;
      })}
    </div>
    {turns.length > 40 ? <p className="usage-list-note">Showing the 40 latest turns.</p> : null}
  </div> : null;

  const settings = <section className="usage-analysis" aria-label="Analyze usage">
    <div className="usage-eyebrow">{analysis ? "Analyze again" : "Analyze"}</div>
    <div className="usage-analysis__row"><span>Read</span>
      <div className="usage-segmented" role="group" aria-label="Analysis scope">
        <button type="button" aria-pressed={props.scope === "turn"} disabled={analyzing || target.line.turnId === undefined || target.rollup !== undefined} onClick={() => props.onScope("turn")}>Selected turn</button>
        <button type="button" aria-pressed={props.scope === "recent"} disabled={analyzing} onClick={() => props.onScope("recent")}>Recent entries</button>
      </div></div>
    <label className="usage-analysis__row"><span>Model</span><Select value={props.model} onChange={props.onModel} disabled={analyzing} options={models} /></label>
    <details className="usage-analysis__limits"><summary>Limits · {props.entryLimit} entries, {Number(props.characterLimit).toLocaleString()} characters</summary>
      <div><label>Entries <Select value={props.entryLimit} onChange={props.onEntryLimit} disabled={analyzing} options={["20", "40", "100"].map((value) => ({ value, label: value }))} /></label>
        <label>Characters <Select value={props.characterLimit} onChange={props.onCharacterLimit} disabled={analyzing} options={["10000", "20000", "40000"].map((value) => ({ value, label: Number(value).toLocaleString() }))} /></label></div>
    </details>
    <p className="usage-analysis__scope">{turnScope
      ? `Reads the turn from ${usageClock(target.line.startedAt ?? target.line.createdAt)} on ${target.owner}. If it is older than the last 50 turns, the recent entries are read instead.`
      : `Reads the thread's most recent entries on ${target.owner}. They may not include the turns in this window.`}
      {" "}This is a model call of its own, and it uses your limit with that model's provider. The model reads only this excerpt and gets no tools.</p>
  </section>;

  const outcome = analysis?.status === "done" ? <div className="usage-analysis__result" role="status">
    <div className="usage-eyebrow">{analysis.result.model}{analysis.result.scope === "turn" ? " · selected turn" : analysis.result.scope === "recent" ? " · recent entries" : ""}</div>
    <p>Read {analysis.result.entries} entries · {analysis.result.characters.toLocaleString()} characters{analysis.result.truncated ? " · partial" : ""}
      {turnScope && analysis.result.scope === "recent" ? " · the turn was out of reach" : ""}</p>
    <pre>{analysis.result.analysis.trim() || "The model returned no text."}</pre>
    <p>Model output. Check it against the transcript. Not saved.</p>
  </div> : analysis?.status === "failed" ? <div className="usage-analysis__result usage-analysis__result--failed" role="alert">
    <div className="usage-eyebrow">Analysis failed</div>
    <pre>{analysis.error}</pre>
  </div> : running ? <p className="usage-analysis__waiting">Waiting for {analysis.modelLabel}. The answer appears here.</p> : null;

  const selectTab = (next: "details" | "analysis") => { setTab(next); bodyRef.current?.scrollTo?.({ top: 0 }); };
  return <aside className="usage-inspector" aria-label="Usage inspection">
    <div className="usage-inspector__body" ref={bodyRef}>
      <div className="usage-inspector__heading"><span className="usage-eyebrow">{group ? "Thread" : "Excluded interval"}</span>
        <button type="button" className="usage-icon-button" aria-label="Close thread detail" onClick={props.onClose}>×</button></div>
      <h2>{group?.title ?? lead.title}</h2>
      {props.onOpenThread ? <button type="button" className="usage-link usage-inspector__open" onClick={props.onOpenThread}>Open thread ↗</button> : null}
      <p className="usage-inspector__owner">{lead.owner}{lead.line.model ? ` · ${lead.line.modelLabel ?? lead.line.model}` : ""}</p>
      <div className="usage-inspector__cost"><strong>{group ? usageMoney(group.cost) : "Excluded"}</strong>
        <span>{group
          ? `${props.total ? Math.round(group.cost / props.total * 100) : 0}% of the window · ${group.rows.length} ${group.rows.length === 1 ? "turn" : "turns"}${group.helperThreads ? `, ${usageMoney(group.helperCost)} from helpers` : ""}`
          : "from the window total"}</span></div>
      {analysis && group ? <>
        <div className="usage-inspector__tabs" role="tablist" aria-label="Inspection"
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const next = tab === "details" ? "analysis" : "details";
            selectTab(next);
            event.currentTarget.querySelector<HTMLElement>(`#usage-inspector-tab-${next}`)?.focus();
          }}>
          {(["details", "analysis"] as const).map((key) => <button type="button" role="tab" key={key} id={`usage-inspector-tab-${key}`}
            aria-selected={tab === key} aria-controls="usage-inspector-panel" tabIndex={tab === key ? 0 : -1}
            onClick={() => selectTab(key)}>{key === "details" ? "Details" : "Analysis"}{key === "analysis" && running ? <span className="pending-spinner pending-spinner--sm" aria-hidden="true" /> : null}</button>)}
        </div>
        <div id="usage-inspector-panel" role="tabpanel" aria-labelledby={`usage-inspector-tab-${tab}`}>
          {tab === "details" ? turnList : <>{outcome}{settings}</>}
        </div>
      </> : <>{turnList}{outcome}{settings}</>}
    </div>
    <div className="usage-inspector__footer">
      {running ? <p className="usage-inspector__progress" role="status">
        <span className="pending-spinner pending-spinner--sm" aria-hidden="true" />
        Reading on {analysis.owner} and asking {analysis.modelLabel} · {elapsed} s</p>
        : analyzing ? <p className="usage-inspector__progress">Another thread's analysis is still running.</p> : null}
      <button type="button" className="usage-button usage-button--primary" disabled={analyzing || !props.canAnalyze} onClick={props.onAnalyze}>
        {running ? "Analyzing…" : analysis ? (turnScope ? "Analyze turn again" : "Analyze thread again")
          : turnScope ? "Analyze turn" : "Analyze thread"}</button>
    </div>
  </aside>;
}
