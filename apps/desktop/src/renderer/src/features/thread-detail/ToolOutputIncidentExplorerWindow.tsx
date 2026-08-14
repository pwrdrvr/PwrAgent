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

const HISTORY_PAGE_LIMIT = 100;

export function ToolOutputIncidentExplorerWindow() {
  const desktopApi = useDesktopApi();
  const [route, setRoute] = useState(readIncidentRoute);
  const [accounting, setAccounting] = useState<ThreadToolAccounting>();
  const [latest, setLatest] = useState<AppServerReadThreadResponse>();
  const [selectedId, setSelectedId] = useState<string>();
  const [category, setCategory] = useState<ThreadToolInvocationCategory | "all">("all");
  const [search, setSearch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [output, setOutput] = useState<string>();
  const [outputSearch, setOutputSearch] = useState("");
  const [status, setStatus] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);

  const refresh = useCallback(async () => {
    if (!route || !desktopApi?.readThread) return;
    setLoading(true);
    setStatus(undefined);
    try {
      const response = await desktopApi.readThread({
        backend: route.backend,
        limit: HISTORY_PAGE_LIMIT,
        threadId: route.threadId,
        viewOnly: true,
      });
      setLatest(response);
      setAccounting(response.toolAccounting);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [desktopApi, route]);

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

  const invocations = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return (accounting?.invocations ?? []).filter((invocation) =>
      invocation.noisy
      && (category === "all" || invocation.category === category)
      && (
        !normalizedSearch
        || (invocation.normalizedCommand ?? invocation.toolName)
          .toLowerCase()
          .includes(normalizedSearch)
        || invocation.noisyReason?.toLowerCase().includes(normalizedSearch)
      )
    );
  }, [accounting?.invocations, category, search]);
  const selected = invocations.find((invocation) => invocation.invocationId === selectedId)
    ?? invocations[0];

  useEffect(() => {
    setPrompt(selected
      ? selected.suggestedPrompt ?? buildThreadToolIncidentPrompt({
          invocation: selected,
          reason: selected.noisyReason ?? "large tool output",
        })
      : "");
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
      if (!cancelled) setStatus(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
    };
  }, [desktopApi, latest, route, selected]);

  if (!route) {
    return <p className="incident-explorer__error">Invalid incident explorer route.</p>;
  }

  const categories = Array.from(new Set(
    (accounting?.invocations ?? []).filter((entry) => entry.noisy).map((entry) => entry.category),
  ));
  const totals = invocations.reduce(
    (sum, invocation) => ({
      chars: sum.chars + invocation.outputChars,
      tokens: sum.tokens + invocation.estimatedOutputTokens,
      worst: Math.max(sum.worst, invocation.outputChars),
    }),
    { chars: 0, tokens: 0, worst: 0 },
  );
  const activeTurnId = findActiveTurnId(latest);
  const canSteerSelected = Boolean(
    selected?.turnId
    && selected.turnId === activeTurnId
    && desktopApi?.steerTurn,
  );
  const canSendAsNewTurn = Boolean(!activeTurnId && desktopApi?.startTurn);
  const visibleOutputLines = filterOutputLines(output, outputSearch);

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
      setStatus(
        response.coverage.completeness === "complete"
          ? `Analyzed ${response.coverage.invocationCount.toLocaleString()} tool calls across ${response.coverage.pageCount.toLocaleString()} page${response.coverage.pageCount === 1 ? "" : "s"}.`
          : response.coverage.explanation ?? "Analysis is incomplete.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
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
        setStatus("Steering delivered to the exact active turn.");
      } else if (canSendAsNewTurn) {
        await desktopApi?.startTurn?.({
          backend: route.backend,
          input: [{ type: "text", text: prompt.trim() }],
          threadId: route.threadId,
        });
        setStatus("Prompt sent as a new turn.");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
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
                setStatus(error instanceof Error ? error.message : String(error));
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
          <button type="button" onClick={() => void analyze()} disabled={analyzing}>
            {accounting?.analysis ? "Refresh analysis" : "Analyze history"}
          </button>
          <button type="button" onClick={() => void refresh()} disabled={loading}>Refresh</button>
          <button type="button" onClick={() => window.close()}>Close</button>
        </div>
      </header>
      <div className="incident-explorer__metrics" aria-label="Incident metrics">
        <Metric label="Cases" value={invocations.length.toLocaleString()} />
        <Metric label="Total output" value={`${totals.chars.toLocaleString()} chars`} />
        <Metric label="Estimated tokens" value={totals.tokens.toLocaleString()} />
        <Metric label="Worst case" value={`${totals.worst.toLocaleString()} chars`} />
      </div>
      {accounting?.analysis?.completeness === "partial" ? (
        <p className="incident-explorer__coverage" role="status">
          Partial coverage: {accounting.analysis.explanation}
        </p>
      ) : null}
      {status ? <p className="incident-explorer__status" role="status">{status}</p> : null}
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
              aria-label="Filter by category"
              onChange={(event) => setCategory(event.currentTarget.value as typeof category)}
              value={category}
            >
              <option value="all">All categories</option>
              {categories.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
            </select>
          </div>
          {groupInvocations(invocations).map((group) => (
            <section className="incident-explorer__group" key={group.key}>
              <h2>{group.turnLabel} · {group.category}</h2>
              {group.invocations.map((invocation) => (
                <button
                  className="incident-explorer__case"
                  data-selected={invocation.invocationId === selected?.invocationId}
                  key={invocation.invocationId}
                  onClick={() => setSelectedId(invocation.invocationId)}
                  type="button"
                >
                  <span>{invocation.normalizedCommand ?? invocation.toolName}</span>
                  <small>
                    {invocation.outputChars.toLocaleString()} chars · {formatTimestamp(invocation.observedAt)}
                  </small>
                </button>
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
                <h2>Selected invocation</h2>
                <dl>
                  <dt>Identity</dt><dd><code>{selected.normalizedCommand ?? selected.toolName}</code></dd>
                  <dt>Observed</dt><dd>{formatTimestamp(selected.observedAt)}</dd>
                  <dt>Status</dt><dd>{selected.status}{selected.exitCode !== undefined ? ` · exit ${selected.exitCode}` : ""}</dd>
                  <dt>Output</dt><dd>{selected.outputChars.toLocaleString()} chars · ~{selected.estimatedOutputTokens.toLocaleString()} tokens</dd>
                  <dt>Availability</dt><dd>{selected.outputState ?? (selected.outputTruncated ? "truncated" : "unavailable until replay is loaded")}</dd>
                  <dt>Reason</dt><dd>{selected.noisyReason ?? "large output"}</dd>
                  <dt>Source</dt><dd>{selected.source ?? "live"}</dd>
                </dl>
              </section>
              <section className="incident-explorer__prompt">
                <div className="incident-explorer__section-heading">
                  <h2>Proposed steering</h2>
                  <button type="button" onClick={() => void desktopApi?.copyText?.(prompt)}>Copy</button>
                </div>
                <textarea
                  aria-label="Editable proposed steering prompt"
                  onChange={(event) => setPrompt(event.currentTarget.value)}
                  rows={10}
                  value={prompt}
                />
                <button
                  className="incident-explorer__primary"
                  disabled={!prompt.trim() || (!canSendAsNewTurn && !canSteerSelected)}
                  onClick={() => void sendPrompt()}
                  type="button"
                >
                  {canSteerSelected ? "Steer exact active turn" : "Send next turn"}
                </button>
                {!canSteerSelected && activeTurnId ? (
                  <p>The selected finding belongs to another turn. It cannot steer the active turn; send it after that turn ends.</p>
                ) : null}
              </section>
              <section className="incident-explorer__output">
                <div className="incident-explorer__section-heading">
                  <h2>Captured output</h2>
                  <input
                    aria-label="Search captured output"
                    onChange={(event) => setOutputSearch(event.currentTarget.value)}
                    placeholder="Search output"
                    type="search"
                    value={outputSearch}
                  />
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
                  <p className="incident-explorer__empty">
                    {selected.outputState === "compacted"
                      ? "Output was compacted out of normalized replay."
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

function Metric(props: { label: string; value: string }) {
  return <div><span>{props.label}</span><strong>{props.value}</strong></div>;
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

function groupInvocations(invocations: ThreadToolInvocationRecord[]) {
  const groups = new Map<string, {
    category: ThreadToolInvocationCategory;
    invocations: ThreadToolInvocationRecord[];
    key: string;
    turnLabel: string;
  }>();
  for (const invocation of invocations) {
    const turn = invocation.turnId ?? "No turn";
    const key = `${turn}:${invocation.category}`;
    const group = groups.get(key) ?? {
      category: invocation.category,
      invocations: [],
      key,
      turnLabel: invocation.turnId ? `Turn ${shortId(invocation.turnId)}` : "No turn",
    };
    group.invocations.push(invocation);
    groups.set(key, group);
  }
  return [...groups.values()];
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

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}
