import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AppServerBackendKind,
  AppServerReadThreadResponse,
  AppServerThreadActivityDetail,
  ThreadToolAccounting,
  ThreadToolInvocationCategory,
  ThreadToolInvocationRecord,
} from "@pwragent/shared";
import { buildThreadToolIncidentPrompt } from "@pwragent/shared";
import { formatBackendLabel } from "../../lib/backend-label";
import { useDesktopApi } from "../../lib/desktop-api";
import { ThreadChip } from "./ThreadChip";
import { detailMatchesInvocationItem } from "./tool-call-details";
import type {
  CategoryShare,
  IncidentSortMode,
  TurnCostRow,
  TurnCostStrip,
} from "./tool-output-incident-insights";
import {
  buildCategoryComposition,
  buildTurnCostStrip,
  capMeterWidth,
  formatCapShare,
  formatCategoryLabel,
  formatCompactTokens,
  formatInvocationIdentity,
  invocationStatusTone,
  isOverOutputCap,
  sortIncidentCases,
  summarizeIncidents,
} from "./tool-output-incident-insights";

const HISTORY_PAGE_LIMIT = 100;

export function ToolOutputIncidentExplorerWindow() {
  const desktopApi = useDesktopApi();
  const [route, setRoute] = useState(readIncidentRoute);
  const [accounting, setAccounting] = useState<ThreadToolAccounting>();
  const [latest, setLatest] = useState<AppServerReadThreadResponse>();
  const [selectedId, setSelectedId] = useState<string>();
  const [category, setCategory] = useState<ThreadToolInvocationCategory | "all">("all");
  const [turnFilter, setTurnFilter] = useState<string>();
  const [sortMode, setSortMode] = useState<IncidentSortMode>("largest");
  const [search, setSearch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [identityExpanded, setIdentityExpanded] = useState(false);
  const [output, setOutput] = useState<string>();
  const [outputSearch, setOutputSearch] = useState("");
  const [status, setStatus] = useState<string>();
  const [statusTone, setStatusTone] = useState<"error" | "info">("info");
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);

  /* Stable identity: `refresh` depends on it, and a refresh that changed every
     render would re-run the effect that calls it on every render. */
  const reportError = useCallback((error: unknown) => {
    setStatusTone("error");
    setStatus(error instanceof Error ? error.message : String(error));
  }, []);

  const refresh = useCallback(async () => {
    if (!route || !desktopApi?.readThread) return;
    setLoading(true);
    setStatus(undefined);
    try {
      const response = await desktopApi.readThread({
        backend: route.backend,
        includeAllToolInvocations: true,
        limit: HISTORY_PAGE_LIMIT,
        threadId: route.threadId,
        viewOnly: true,
      });
      setLatest(response);
      setAccounting(response.toolAccounting);
    } catch (error) {
      reportError(error);
    } finally {
      setLoading(false);
    }
  }, [desktopApi, reportError, route]);

  useEffect(() => {
    document.title = route ? `Tool-output incidents — ${route.title}` : "Tool-output incidents";
    void refresh();
  }, [refresh, route]);

  useEffect(() => {
    if (!desktopApi?.onToolOutputIncidentExplorerRefresh) return;
    return desktopApi.onToolOutputIncidentExplorerRefresh((request) => {
      if (request) {
        setRoute({
          backend: request.backend,
          projectLabel: request.projectLabel,
          threadId: request.threadId,
          title: request.title,
        });
      }
      void refresh();
    });
  }, [desktopApi, refresh]);

  const allInvocations = useMemo(
    () => accounting?.invocations ?? [],
    [accounting?.invocations],
  );
  const flagged = useMemo(
    () => allInvocations.filter((invocation) => invocation.noisy),
    [allInvocations],
  );
  const summary = useMemo(() => summarizeIncidents(allInvocations), [allInvocations]);
  const turnStrip = useMemo(() => buildTurnCostStrip(allInvocations), [allInvocations]);
  const composition = useMemo(() => buildCategoryComposition(flagged), [flagged]);
  /* Every turn, not just the rows the strip had room for — a case in a turn
     that fell below the row limit still belongs to that turn. */
  const turnLabels = turnStrip.labelsByKey;

  const invocations = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return sortIncidentCases(
      flagged.filter((invocation) =>
        (category === "all" || invocation.category === category)
        && (turnFilter === undefined || (invocation.turnId ?? "") === turnFilter)
        && (
          !normalizedSearch
          || (invocation.normalizedCommand ?? invocation.toolName)
            .toLowerCase()
            .includes(normalizedSearch)
          || invocation.noisyReason?.toLowerCase().includes(normalizedSearch)
        )
      ),
      sortMode,
    );
  }, [category, flagged, search, sortMode, turnFilter]);
  const selected = invocations.find((invocation) => invocation.invocationId === selectedId)
    ?? invocations[0];

  useEffect(() => {
    setPrompt(selected
      ? selected.suggestedPrompt ?? buildThreadToolIncidentPrompt({
          invocation: selected,
          reason: selected.noisyReason ?? "large tool output",
        })
      : "");
    setIdentityExpanded(false);
    setOutput(undefined);
    setOutputSearch("");
    if (!selected || !latest || !desktopApi?.readThread || !route) return;
    let cancelled = false;
    void readInvocationOutput({
      backend: route.backend,
      desktopApi,
      initial: latest,
      invocation: selected,
      threadId: route.threadId,
    }).then((value) => {
      if (!cancelled) setOutput(value);
    }).catch((error) => {
      if (!cancelled) reportError(error);
    });
    return () => {
      cancelled = true;
    };
  }, [desktopApi, latest, reportError, route, selected]);

  if (!route) {
    return <p className="incident-explorer__error">Invalid incident explorer route.</p>;
  }

  const activeTurnId = findActiveTurnId(latest);
  const canSteerSelected = Boolean(
    selected?.turnId
    && selected.turnId === activeTurnId
    && desktopApi?.steerTurn,
  );
  const canSendAsNewTurn = Boolean(!activeTurnId && desktopApi?.startTurn);
  const visibleOutputLines = filterOutputLines(output, outputSearch);
  const laterTripsInTurn = selected ? countLaterTripsInTurn(allInvocations, selected) : 0;

  const analyze = async (): Promise<void> => {
    if (!desktopApi?.analyzeThreadToolHistory) return;
    setAnalyzing(true);
    setStatus(undefined);
    try {
      const response = await desktopApi.analyzeThreadToolHistory({
        backend: route.backend,
        threadId: route.threadId,
      });
      setAccounting(response.accounting);
      setStatusTone(response.coverage.completeness === "complete" ? "info" : "error");
      setStatus(
        response.coverage.completeness === "complete"
          ? `Analyzed ${response.coverage.invocationCount.toLocaleString()} tool calls across ${response.coverage.pageCount.toLocaleString()} page${response.coverage.pageCount === 1 ? "" : "s"}.`
          : response.coverage.explanation ?? "Analysis is incomplete.",
      );
    } catch (error) {
      reportError(error);
    } finally {
      setAnalyzing(false);
    }
  };

  const sendPrompt = async (): Promise<void> => {
    if (!selected || !prompt.trim()) return;
    setStatus(undefined);
    try {
      if (canSteerSelected && selected.turnId) {
        await desktopApi?.steerTurn?.({
          backend: route.backend,
          expectedTurnId: selected.turnId,
          input: [{ type: "text", text: prompt.trim() }],
          requestId: `tool-output-incident:${selected.invocationId}:${Date.now()}`,
          threadId: route.threadId,
        });
        setStatusTone("info");
        setStatus("Steering delivered to the exact active turn.");
      } else if (canSendAsNewTurn) {
        await desktopApi?.startTurn?.({
          backend: route.backend,
          input: [{ type: "text", text: prompt.trim() }],
          threadId: route.threadId,
        });
        setStatusTone("info");
        setStatus("Prompt sent as a new turn.");
      }
    } catch (error) {
      reportError(error);
    }
  };

  return (
    <div className="incident-explorer">
      <header className="activity-titlebar">
        <p className="activity-titlebar__brand">
          Pwr<span className="activity-titlebar__brand-accent">Agent</span>
        </p>
        <div
          aria-label={[
            route.projectLabel,
            route.title,
            "Tool Output Incidents",
          ].filter(Boolean).join(" > ")}
          className="activity-titlebar__breadcrumb"
        >
          {route.projectLabel ? (
            <>
              <span className="activity-titlebar__crumb" title={route.projectLabel}>
                {route.projectLabel}
              </span>
              <span aria-hidden="true" className="activity-titlebar__separator">›</span>
            </>
          ) : null}
          <ThreadChip
            link={{
              backend: route.backend,
              inThreadList: true,
              threadId: route.threadId,
              title: route.title,
            }}
            onOpen={() => {
              void desktopApi?.showThreadFromToolOutputIncidentExplorer?.({
                backend: route.backend,
                threadId: route.threadId,
              }).catch((error: unknown) => {
                reportError(error);
              });
            }}
          />
          <span aria-hidden="true" className="activity-titlebar__separator">›</span>
          <span className="activity-titlebar__current">Tool Output Incidents</span>
        </div>
        <span className="chip chip--backend">
          {formatBackendLabel(route.backend)}
        </span>
        <div className="activity-titlebar__spacer" />
        <div className="incident-explorer__actions">
          <button
            className="incident-explorer__button"
            type="button"
            onClick={() => void analyze()}
            disabled={analyzing}
          >
            {accounting?.analysis ? "Refresh analysis" : "Analyze history"}
          </button>
          <button
            className="incident-explorer__button incident-explorer__button--ghost"
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
          >
            Refresh
          </button>
        </div>
      </header>

      <div className="incident-explorer__summary" aria-label="Incident metrics">
        <div className="incident-explorer__headline">
          <p className="incident-explorer__eyebrow">Replay cost from flagged calls</p>
          <p className="incident-explorer__hero">
            <strong>{formatCompactTokens(summary.incidentTokens)}</strong>
            <span>
              tokens · {Math.round(summary.share * 100)}% of all tool output
            </span>
          </p>
          <span
            aria-hidden="true"
            className="incident-explorer__meter"
          >
            <i style={{ width: `${Math.round(summary.share * 100)}%` }} />
          </span>
          <p className="incident-explorer__caption">
            <b>{summary.caseCount}</b> {summary.caseCount === 1 ? "case" : "cases"}
            {" · "}{summary.turnCount} {summary.turnCount === 1 ? "turn" : "turns"}
            {" · "}{summary.incidentChars.toLocaleString()} chars
            {" · worst "}{summary.worstChars.toLocaleString()}
          </p>
        </div>
        <div className="incident-explorer__composition-group" role="group" aria-label="Filter by category">
          <p className="incident-explorer__eyebrow">Where it went</p>
          <CompositionBar composition={composition} />
          <div className="incident-explorer__legend">
            <button
              aria-pressed={category === "all"}
              className="incident-explorer__legend-item"
              onClick={() => setCategory("all")}
              type="button"
            >
              <i className="incident-explorer__swatch incident-explorer__swatch--all" />
              All categories
              <em>{formatCompactTokens(summary.incidentTokens)}</em>
            </button>
            {composition.map((entry, index) => (
              <button
                aria-pressed={category === entry.category}
                className="incident-explorer__legend-item"
                disabled={entry.category === "other"}
                key={entry.category}
                onClick={() => setCategory(
                  entry.category === "other"
                    ? "all"
                    : entry.category as ThreadToolInvocationCategory,
                )}
                type="button"
              >
                <i
                  className="incident-explorer__swatch"
                  data-rank={Math.min(index + 1, 5)}
                />
                {entry.label}
                <em>
                  {formatCompactTokens(entry.estimatedOutputTokens)}
                  {" · "}{Math.round(entry.share * 100)}%
                </em>
              </button>
            ))}
          </div>
        </div>
      </div>

      <TurnStrip
        onSelect={(row) => setTurnFilter(
          turnFilter === row.key ? undefined : row.key,
        )}
        selectedKey={turnFilter}
        strip={turnStrip}
      />

      {accounting?.analysis?.completeness === "partial" ? (
        <p className="incident-explorer__coverage" role="status">
          Partial coverage: {accounting.analysis.explanation}
        </p>
      ) : null}
      {status ? (
        <p
          className="incident-explorer__status"
          data-tone={statusTone}
          role="status"
        >
          {status}
        </p>
      ) : null}

      <div className="incident-explorer__body">
        <aside className="incident-explorer__list" aria-label="Incident cases">
          <div className="incident-explorer__filters">
            <input
              aria-label="Filter incident cases"
              onChange={(event) => setSearch(event.currentTarget.value)}
              placeholder="Filter cases"
              type="search"
              value={search}
            />
            <select
              aria-label="Sort cases"
              onChange={(event) => setSortMode(event.currentTarget.value as IncidentSortMode)}
              value={sortMode}
            >
              <option value="largest">Largest first</option>
              <option value="newest">Newest first</option>
              <option value="turn">By turn</option>
            </select>
          </div>
          {turnFilter !== undefined || category !== "all" ? (
            <div className="incident-explorer__active-filters">
              <span>
                Showing {invocations.length.toLocaleString()} of {flagged.length.toLocaleString()} cases
              </span>
              <button
                className="incident-explorer__button incident-explorer__button--ghost"
                onClick={() => {
                  setCategory("all");
                  setTurnFilter(undefined);
                }}
                type="button"
              >
                Clear filters
              </button>
            </div>
          ) : null}
          {groupCases(invocations, sortMode, turnLabels).map((group) => (
            <section className="incident-explorer__group" key={group.key}>
              {group.label ? <h3>{group.label}</h3> : null}
              {group.invocations.map((invocation) => (
                <CaseRow
                  invocation={invocation}
                  key={invocation.invocationId}
                  onSelect={() => setSelectedId(invocation.invocationId)}
                  selected={invocation.invocationId === selected?.invocationId}
                />
              ))}
            </section>
          ))}
          {!loading && invocations.length === 0 ? (
            <p className="incident-explorer__empty">No findings match these filters.</p>
          ) : null}
        </aside>

        <main className="incident-explorer__detail">
          {selected ? (
            <>
              <section className="incident-explorer__evidence">
                <div className="incident-explorer__section-heading">
                  <h2>Selected invocation</h2>
                  <button
                    className="incident-explorer__button incident-explorer__button--ghost"
                    onClick={() => void desktopApi?.copyText?.(
                      selected.normalizedCommand ?? selected.toolName,
                    )}
                    type="button"
                  >
                    Copy command
                  </button>
                </div>
                <div
                  className="incident-explorer__identity"
                  data-expanded={identityExpanded}
                >
                  <code>{selected.normalizedCommand ?? selected.toolName}</code>
                  <button
                    className="incident-explorer__button incident-explorer__button--ghost"
                    onClick={() => setIdentityExpanded((value) => !value)}
                    type="button"
                  >
                    {identityExpanded ? "Collapse" : "Expand"}
                  </button>
                </div>
                <div className="incident-explorer__facts">
                  <Fact
                    label={selected.status}
                    tone={invocationStatusTone(selected)}
                    value={selected.exitCode !== undefined ? `exit ${selected.exitCode}` : "—"}
                  />
                  <Fact
                    label={formatCategoryLabel(selected.category)}
                    value={turnLabels.get(selected.turnId ?? "") ?? "No turn"}
                  />
                  <Fact label="observed" value={formatTimestamp(selected.observedAt)} />
                  <Fact
                    label="output"
                    tone={selected.outputState === "available" ? undefined : "warning"}
                    value={describeAvailability(selected)}
                  />
                  <Fact label="source" value={selected.source ?? "live"} />
                </div>

                <div className="incident-explorer__budget">
                  <div className="incident-explorer__budget-head">
                    <strong>{selected.estimatedOutputTokens.toLocaleString()} tokens</strong>
                    <span>{formatCapShare(selected.outputChars)}</span>
                  </div>
                  <span aria-hidden="true" className="incident-explorer__meter">
                    <i
                      data-critical={isOverOutputCap(selected.outputChars)}
                      style={{ width: `${capMeterWidth(selected.outputChars) * 100}%` }}
                    />
                  </span>
                  <p className="incident-explorer__caption">
                    {selected.outputChars.toLocaleString()} chars ·{" "}
                    {laterTripsInTurn > 0
                      ? `replayed on the ${laterTripsInTurn.toLocaleString()} later round ${laterTripsInTurn === 1 ? "trip" : "trips"} in this turn`
                      : "no later round trips in this turn replayed it"}
                  </p>
                  <p className="incident-explorer__reason">
                    {selected.noisyReason ?? "large output"}
                  </p>
                </div>
              </section>

              <section className="incident-explorer__prompt">
                <details className="incident-explorer__steer">
                  <summary>Proposed steering</summary>
                  <textarea
                    aria-label="Editable proposed steering prompt"
                    onChange={(event) => setPrompt(event.currentTarget.value)}
                    rows={8}
                    value={prompt}
                  />
                </details>
                <div className="incident-explorer__prompt-actions">
                  <button
                    className="incident-explorer__button incident-explorer__primary"
                    disabled={!prompt.trim() || (!canSendAsNewTurn && !canSteerSelected)}
                    onClick={() => void sendPrompt()}
                    type="button"
                  >
                    {canSteerSelected ? "Steer exact active turn" : "Send next turn"}
                  </button>
                  <button
                    className="incident-explorer__button"
                    onClick={() => void desktopApi?.copyText?.(prompt)}
                    type="button"
                  >
                    Copy
                  </button>
                  {!canSteerSelected && activeTurnId ? (
                    <p>The selected finding belongs to another turn. It cannot steer the active turn; send it after that turn ends.</p>
                  ) : null}
                </div>
              </section>

              <section className="incident-explorer__output">
                <div className="incident-explorer__section-heading">
                  <h2>Captured output</h2>
                  {output !== undefined ? (
                    <input
                      aria-label="Search captured output"
                      onChange={(event) => setOutputSearch(event.currentTarget.value)}
                      placeholder="Search output"
                      type="search"
                      value={outputSearch}
                    />
                  ) : null}
                </div>
                {output !== undefined ? (
                  <ol className="incident-explorer__output-lines">
                    {visibleOutputLines.map((line) => (
                      <li key={line.number} value={line.number}>
                        <code>{line.text || " "}</code>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="incident-explorer__unavailable">
                    <b>Not retained by normalized replay</b>
                    {selected.outputState === "compacted"
                      ? `The ${selected.outputChars.toLocaleString()} characters this call returned were compacted out. Size and category come from tool accounting, recorded when the call ran.`
                      : selected.outputState === "truncated"
                        ? "Only the truncated output retained by normalized replay is available."
                        : "Output is unavailable in the currently available normalized replay."}
                  </p>
                )}
              </section>
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}

function CompositionBar(props: { composition: CategoryShare[] }) {
  if (props.composition.length === 0) return null;
  return (
    <span aria-hidden="true" className="incident-explorer__composition">
      {props.composition.map((entry, index) => (
        <i
          data-rank={Math.min(index + 1, 5)}
          key={entry.category}
          style={{ width: `${entry.share * 100}%` }}
        />
      ))}
    </span>
  );
}

/**
 * The second cost driver. A solid bar reads as volume, a tick rail reads as
 * discrete events — deliberately different marks, because a turn that is long
 * on trips and short on tokens is a different problem than the reverse, and
 * the two need to be told apart at a glance.
 */
function TurnStrip(props: {
  onSelect: (row: TurnCostRow) => void;
  selectedKey?: string;
  strip: TurnCostStrip;
}) {
  if (props.strip.rows.length === 0) return null;
  return (
    <section className="incident-explorer__turns" aria-label="Cost by turn">
      <div className="incident-explorer__turns-head">
        <p className="incident-explorer__eyebrow">
          {props.strip.ordering === "cost" ? "Costliest turns" : "Cost by turn"}
        </p>
        <p className="incident-explorer__turns-legend">
          <span className="incident-explorer__turns-key" data-kind="tokens" /> output tokens
          {" · "}
          <span className="incident-explorer__turns-key" data-kind="trips" /> round trips
        </p>
      </div>
      {props.strip.rows.map((row) => (
        <button
          aria-pressed={props.selectedKey === row.key}
          className="incident-explorer__turn"
          key={row.key}
          onClick={() => props.onSelect(row)}
          type="button"
        >
          <span className="incident-explorer__turn-label">
            {row.label}
            <span>{` · ${formatClockTime(row.firstObservedAt)}`}</span>
          </span>
          <span aria-hidden="true" className="incident-explorer__turn-bar">
            <i
              data-critical={row.overCapCount > 0}
              style={{ width: `${scaleWidth(row.estimatedOutputTokens, props.strip.maxTokens)}%` }}
            />
          </span>
          <span className="incident-explorer__turn-number">
            {formatCompactTokens(row.estimatedOutputTokens)} tok
          </span>
          <span aria-hidden="true" className="incident-explorer__turn-trips">
            <i style={{ width: `${scaleWidth(row.callCount, props.strip.maxCallCount)}%` }} />
          </span>
          <span className="incident-explorer__turn-number">
            {row.callCount.toLocaleString()} {row.callCount === 1 ? "call" : "calls"}
          </span>
        </button>
      ))}
      {props.strip.hiddenTurnCount > 0 ? (
        <p className="incident-explorer__turns-note">
          {props.strip.hiddenTurnCount.toLocaleString()} lower-cost{" "}
          {props.strip.hiddenTurnCount === 1 ? "turn is" : "turns are"} not shown.
        </p>
      ) : null}
    </section>
  );
}

function CaseRow(props: {
  invocation: ThreadToolInvocationRecord;
  onSelect: () => void;
  selected: boolean;
}) {
  const invocation = props.invocation;
  const command = invocation.normalizedCommand ?? invocation.toolName;
  const identity = formatInvocationIdentity(command);
  const critical = isOverOutputCap(invocation.outputChars);
  return (
    <button
      aria-current={props.selected}
      className="incident-explorer__case"
      data-selected={props.selected}
      onClick={props.onSelect}
      title={command}
      type="button"
    >
      <span className="incident-explorer__case-top">
        <span className="incident-explorer__case-id">
          <b>{identity.lead}</b>
          {identity.detail ? <span>{` ${identity.detail}`}</span> : null}
        </span>
        <span className="incident-explorer__case-tokens">
          {formatCompactTokens(invocation.estimatedOutputTokens)}
        </span>
      </span>
      <span aria-hidden="true" className="incident-explorer__meter">
        <i
          data-critical={critical}
          style={{ width: `${capMeterWidth(invocation.outputChars) * 100}%` }}
        />
      </span>
      <span className="incident-explorer__case-sub">
        {formatCapShare(invocation.outputChars, { short: true })}
        {" · "}{invocation.outputChars.toLocaleString()} chars
        {" · "}{formatClockTime(invocation.observedAt)}
      </span>
    </button>
  );
}

function Fact(props: {
  label: string;
  tone?: "error" | "ok" | "warning";
  value: string;
}) {
  return (
    <span className="incident-explorer__fact" data-tone={props.tone}>
      <b>{props.label}</b>
      {props.value}
    </span>
  );
}

function scaleWidth(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(2, Math.round(value / max * 100));
}

function describeAvailability(invocation: ThreadToolInvocationRecord): string {
  return invocation.outputState
    ?? (invocation.outputTruncated ? "truncated" : "unavailable");
}

/**
 * Round trips after this call inside the same turn. Every one of them replays
 * this output, which is what makes a single large result compound.
 */
function countLaterTripsInTurn(
  invocations: ThreadToolInvocationRecord[],
  selected: ThreadToolInvocationRecord,
): number {
  /* A full-history analyze pass can stamp several of a turn's calls with the
     same millisecond, so "later" falls back to persisted order rather than
     dropping every tie and understating the replay count. */
  const selectedIndex = invocations.indexOf(selected);
  return invocations.filter((invocation, index) =>
    (invocation.turnId ?? "") === (selected.turnId ?? "")
    && (
      invocation.observedAt > selected.observedAt
      || (invocation.observedAt === selected.observedAt && index > selectedIndex)
    )
  ).length;
}

function readIncidentRoute(): {
  backend: AppServerBackendKind;
  projectLabel?: string;
  threadId: string;
  title: string;
} | undefined {
  const [kind, backend, threadId, title, projectLabel] = window.location.hash
    .replace(/^#/, "")
    .split("/");
  if (kind !== "tool-output-incidents" || !backend || !threadId) return undefined;
  return {
    backend: decodeURIComponent(backend) as AppServerBackendKind,
    ...(projectLabel
      ? { projectLabel: decodeURIComponent(projectLabel) }
      : {}),
    threadId: decodeURIComponent(threadId),
    title: title ? decodeURIComponent(title) : "Thread",
  };
}

function findActiveTurnId(response: AppServerReadThreadResponse | undefined): string | undefined {
  const entries = response?.replay.entries ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const turn = entries[index]?.turn;
    if (turn?.status === "in_progress") return turn.id;
  }
  return undefined;
}

function groupCases(
  invocations: ThreadToolInvocationRecord[],
  sortMode: IncidentSortMode,
  turnLabels: Map<string, string>,
) {
  if (sortMode !== "turn") {
    return [{ invocations, key: "all", label: "" }];
  }
  const groups = new Map<string, {
    invocations: ThreadToolInvocationRecord[];
    key: string;
    label: string;
  }>();
  for (const invocation of invocations) {
    const key = invocation.turnId ?? "";
    const group = groups.get(key) ?? {
      invocations: [],
      key,
      label: turnLabels.get(key) ?? "Unassigned",
    };
    group.invocations.push(invocation);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    label: `${group.label} · ${group.invocations.length} ${group.invocations.length === 1 ? "case" : "cases"}`,
  }));
}

async function readInvocationOutput(params: {
  backend: AppServerBackendKind;
  desktopApi: NonNullable<ReturnType<typeof useDesktopApi>>;
  initial: AppServerReadThreadResponse;
  invocation: ThreadToolInvocationRecord;
  threadId: string;
}): Promise<string | undefined> {
  let response = params.initial;
  const seen = new Set<string>();
  for (;;) {
    const detail = findInvocationDetail(response, params.invocation);
    if (detail?.command?.output !== undefined) return detail.command.output;
    const cursor = response.replay.pagination.previousCursor;
    if (
      !response.replay.pagination.hasPreviousPage
      || !cursor
      || seen.has(cursor)
      || !params.desktopApi.readThread
    ) return undefined;
    seen.add(cursor);
    response = await params.desktopApi.readThread({
      backend: params.backend,
      before: cursor,
      limit: HISTORY_PAGE_LIMIT,
      threadId: params.threadId,
      viewOnly: true,
    });
  }
}

function findInvocationDetail(
  response: AppServerReadThreadResponse,
  invocation: ThreadToolInvocationRecord,
): AppServerThreadActivityDetail | undefined {
  let matched: AppServerThreadActivityDetail | undefined;
  for (const entry of response.replay.entries) {
    if (entry.type !== "activity") continue;
    const entryCommandDetails = entry.details.filter((detail) => detail.command);
    if (entry.id === invocation.itemId) {
      return entryCommandDetails.find((detail) =>
        detail.command?.rawCommand === invocation.normalizedCommand
        || detail.command?.displayCommand === invocation.normalizedCommand
      )
        ?? entryCommandDetails.find((detail) =>
          detail.command?.output?.length === invocation.outputChars
        )
        ?? entryCommandDetails.find((detail) =>
          detail.command?.output !== undefined
        )
        ?? entryCommandDetails[0];
    }
    for (const detail of entry.details) {
      if (
        !detail.command
        || !detailMatchesInvocationItem(detail.id, invocation.itemId)
      ) continue;
      if (detail.command.output !== undefined) return detail;
      matched ??= detail;
    }
  }
  return matched;
}

function filterOutputLines(output: string | undefined, query: string) {
  if (output === undefined) return [];
  const normalizedQuery = query.trim().toLowerCase();
  return output.split(/\r\n|\r|\n/).map((text, index) => ({
    number: index + 1,
    text,
  })).filter((line) => !normalizedQuery || line.text.toLowerCase().includes(normalizedQuery));
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function formatClockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
