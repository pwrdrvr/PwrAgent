import type { AnalyzeUsageActivityResponse, BackendModelOption } from "@pwragent/shared";
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

export function UsageInspector(props: {
  group?: UsageGroup;
  /** An excluded row inspected on its own, outside any group. */
  row?: OwnedUsageRow;
  total: number;
  turn?: OwnedUsageRow;
  onTurn: (row: OwnedUsageRow) => void;
  onClose: () => void;
  scope: AnalysisScope;
  onScope: (scope: AnalysisScope) => void;
  models: BackendModelOption[];
  model: string;
  onModel: (model: string) => void;
  entryLimit: string;
  onEntryLimit: (value: string) => void;
  characterLimit: string;
  onCharacterLimit: (value: string) => void;
  analysis?: AnalyzeUsageActivityResponse;
  analyzing: boolean;
  canAnalyze: boolean;
  onAnalyze: () => void;
}) {
  const { group, turn, analyzing } = props;
  const lead = group?.rows[0] ?? props.row!;
  const turns = group ? [...group.rows].sort((a, b) => (b.line.completedAt ?? 0) - (a.line.completedAt ?? 0)) : [];
  const largest = Math.max(1, ...turns.map((row) => priced(row) ? row.line.totalCostMicros : 0));
  const target = turn ?? lead;
  const turnScope = props.scope === "turn" && target.line.turnId !== undefined;
  const models = [{ value: "gpt-6-luna", label: "GPT-6-Luna" },
    ...props.models.filter((item) => item.id !== "gpt-6-luna").map((item) => ({ value: item.id, label: item.label ?? item.id }))];
  return <aside className="usage-inspector" aria-label="Usage inspection">
    <div className="usage-inspector__body">
      <div className="usage-inspector__heading"><span className="usage-eyebrow">{group ? "Thread" : "Excluded interval"}</span>
        <button type="button" className="usage-icon-button" aria-label="Close thread detail" disabled={analyzing} onClick={props.onClose}>×</button></div>
      <h2>{group?.title ?? lead.title}</h2>
      <p className="usage-inspector__owner">{lead.owner}{lead.line.model ? ` · ${lead.line.modelLabel ?? lead.line.model}` : ""}</p>
      <div className="usage-inspector__cost"><strong>{group ? usageMoney(group.cost) : "Excluded"}</strong>
        <span>{group
          ? `${props.total ? Math.round(group.cost / props.total * 100) : 0}% of the window · ${group.rows.length} ${group.rows.length === 1 ? "turn" : "turns"}${group.helperThreads ? `, ${usageMoney(group.helperCost)} from helpers` : ""}`
          : "from the window total"}</span></div>
      {group ? <div className="usage-turns">
        <div className="usage-eyebrow">Turns in window <span className="usage-subtle">· cached · cost</span></div>
        <div className="usage-turns__list" role="group" aria-label="Turns in window">
          {turns.slice(0, 40).map((row) => {
            const isHelper = group.helperRows.includes(row);
            const signals = turnSignals(row.line, isHelper ? row.title : undefined);
            return <button type="button" key={row.line.usageLineId} className="usage-turn" aria-pressed={row === turn} disabled={analyzing}
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
      </div> : null}
      <section className="usage-analysis" aria-label="Analyze usage">
        <div className="usage-eyebrow">Analyze</div>
        <div className="usage-analysis__row"><span>Read</span>
          <div className="usage-segmented" role="group" aria-label="Analysis scope">
            <button type="button" aria-pressed={props.scope === "turn"} disabled={analyzing || target.line.turnId === undefined} onClick={() => props.onScope("turn")}>Selected turn</button>
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
          {" "}This is a model call of its own, and it uses your limit.</p>
        {props.analysis ? <div className="usage-analysis__result" role="status">
          <div className="usage-eyebrow">{props.analysis.model}{props.analysis.scope === "turn" ? " · selected turn" : props.analysis.scope === "recent" ? " · recent entries" : ""}</div>
          <p>Read {props.analysis.entries} entries · {props.analysis.characters.toLocaleString()} characters{props.analysis.truncated ? " · partial" : ""}
            {turnScope && props.analysis.scope === "recent" ? " · the turn was out of reach" : ""}</p>
          <pre>{props.analysis.analysis}</pre>
          <p>Model output. Check it against the transcript. Not saved.</p>
        </div> : null}
      </section>
    </div>
    <div className="usage-inspector__footer">
      <button type="button" className="usage-button usage-button--primary" disabled={analyzing || !props.canAnalyze} onClick={props.onAnalyze}>
        {analyzing ? "Analyzing…" : turnScope ? "Analyze turn" : "Analyze thread"}</button>
    </div>
  </aside>;
}
