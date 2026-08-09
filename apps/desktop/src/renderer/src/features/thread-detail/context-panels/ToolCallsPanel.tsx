import { useMemo, useState } from "react";
import type {
  AppServerThreadActivityDetail,
  AppServerThreadEntry,
  ThreadToolAccounting,
  ThreadToolInvocationRecord,
  ThreadToolInvocationSummary,
} from "@pwragent/shared";
import { TranscriptCommandOutput } from "../TranscriptCommandOutput";
import { formatTokenCount } from "./subagent-format";
import { formatTimestamp } from "./context-rail-shared";

type ToolCallsPanelProps = {
  entries?: AppServerThreadEntry[];
  onScrollToTurn?: (turnId: string, turnTimeMs?: number) => void;
  toolAccounting?: ThreadToolAccounting;
};

type ToolAccountingTotals = {
  errorLines: number;
  estimatedOutputTokens: number;
  invocationCount: number;
  noisyInvocationCount: number;
  outputChars: number;
  outputLines: number;
  warningLines: number;
};

export function ToolCallsPanel(props: ToolCallsPanelProps) {
  const [expandedSummary, setExpandedSummary] = useState<string>();
  const [expandedInvocation, setExpandedInvocation] = useState<string>();
  const accounting = props.toolAccounting;
  const totals = aggregateToolAccounting(accounting);
  const detailsByItemId = useMemo(
    () => collectCommandDetails(props.entries ?? []),
    [props.entries],
  );

  return (
    <section className="context-panel__section tool-calls-panel">
      <h3>Tool calls</h3>
      {totals ? (
        <dl className="context-grid">
          <dt>Estimated output tokens</dt>
          <dd>{formatTokenCount(totals.estimatedOutputTokens)}</dd>
          <dt>Output volume</dt>
          <dd>
            {formatCharacterCount(totals.outputChars)} ·{" "}
            {totals.outputLines.toLocaleString()} lines
          </dd>
          <dt>Invocations</dt>
          <dd>
            {totals.invocationCount.toLocaleString()}
            {totals.noisyInvocationCount > 0 ? (
              <span className="context-list__meta">
                {" "}
                ({totals.noisyInvocationCount.toLocaleString()} noisy)
              </span>
            ) : null}
          </dd>
          <dt>Warnings / errors</dt>
          <dd>
            {totals.warningLines.toLocaleString()} /{" "}
            {totals.errorLines.toLocaleString()}
          </dd>
        </dl>
      ) : (
        <p className="context-empty">No tool calls recorded yet.</p>
      )}

      {accounting?.alerts.length ? (
        <ul className="context-list context-list--cards tool-call-alert-list">
          {accounting.alerts.map((alert) => (
            <li key={alert.alertId} className="rail-card tool-call-alert">
              <p className="rail-card__title">Noisy polling detected</p>
              <p className="rail-card__usage">{alert.message}</p>
              <p className="rail-card__usage">
                Suggested steering: {alert.suggestedPrompt}
              </p>
            </li>
          ))}
        </ul>
      ) : null}

      {accounting?.summaries.length ? (
        <div className="tool-call-groups">
          <h4>Commands</h4>
          <ul className="context-list context-list--cards tool-call-summary-list">
            {accounting.summaries.map((summary) => {
              const summaryKey = `${summary.category}:${summary.toolName}`;
              const expanded = expandedSummary === summaryKey;
              const invocations = accounting.invocations.filter(
                (invocation) =>
                  invocation.category === summary.category
                  && invocation.toolName === summary.toolName,
              );
              return (
                <li key={summaryKey} className="rail-card tool-call-summary-row">
                  <div className="tool-call-row__header">
                    <p className="rail-card__title">
                      {formatToolSummaryTitle(summary)}
                    </p>
                    <button
                      type="button"
                      className="button button--ghost tool-call-row__details"
                      aria-expanded={expanded}
                      onClick={() => {
                        setExpandedSummary(expanded ? undefined : summaryKey);
                        setExpandedInvocation(undefined);
                      }}
                    >
                      {expanded ? "Hide" : "Details"}
                    </button>
                  </div>
                  <p className="rail-card__usage">
                    {formatTokenCount(summary.estimatedOutputTokens)} est. output tokens ·{" "}
                    {formatCharacterCount(summary.outputChars)}
                  </p>
                  <p className="rail-card__usage">
                    {summary.invocationCount.toLocaleString()} invocation
                    {summary.invocationCount === 1 ? "" : "s"} ·{" "}
                    {summary.warningLines.toLocaleString()} warn ·{" "}
                    {summary.errorLines.toLocaleString()} error ·{" "}
                    {(summary.infoLines + summary.debugLines).toLocaleString()} info/debug
                  </p>
                  {expanded ? (
                    <ToolInvocationList
                      detailsByItemId={detailsByItemId}
                      expandedInvocation={expandedInvocation}
                      invocations={invocations}
                      onExpandedInvocationChange={setExpandedInvocation}
                      onScrollToTurn={props.onScrollToTurn}
                      totalCount={summary.invocationCount}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function ToolInvocationList(props: {
  detailsByItemId: Map<string, AppServerThreadActivityDetail>;
  expandedInvocation?: string;
  invocations: ThreadToolInvocationRecord[];
  onExpandedInvocationChange: (invocationId: string | undefined) => void;
  onScrollToTurn?: (turnId: string, turnTimeMs?: number) => void;
  totalCount: number;
}) {
  if (props.invocations.length === 0) {
    return (
      <p className="context-empty tool-call-instances__empty">
        No instances available.
      </p>
    );
  }

  return (
    <div className="tool-call-instances">
      {props.invocations.length < props.totalCount ? (
        <p className="tool-call-instances__status">
          Showing latest {props.invocations.length.toLocaleString()} of{" "}
          {props.totalCount.toLocaleString()} recorded instances.
        </p>
      ) : null}
      <ul className="tool-call-instance-list" aria-label="Command instances">
        {props.invocations.map((invocation) => {
          const expanded = props.expandedInvocation === invocation.invocationId;
          const transcriptDetail = props.detailsByItemId.get(invocation.itemId);
          const detail = transcriptDetail ?? buildFallbackDetail(invocation);
          return (
            <li
              key={invocation.invocationId}
              className={`tool-call-instance${
                invocation.noisy ? " tool-call-instance--noisy" : ""
              }`}
            >
              <div className="tool-call-row__header">
                <p className="tool-call-instance__command">
                  {invocation.normalizedCommand ?? invocation.toolName}
                </p>
                <button
                  type="button"
                  className="button button--ghost tool-call-row__details"
                  aria-expanded={expanded}
                  onClick={() =>
                    props.onExpandedInvocationChange(
                      expanded ? undefined : invocation.invocationId,
                    )
                  }
                >
                  {expanded ? "Hide" : "Details"}
                </button>
              </div>
              <p className="rail-card__model">
                {invocation.status}
                {invocation.exitCode !== undefined
                  ? ` · exit ${invocation.exitCode}`
                  : ""}
                {invocation.outputTruncated ? " · accounting truncated" : ""}
                {invocation.noisy ? " · noisy" : ""}
              </p>
              <p className="rail-card__usage">
                {formatTokenCount(invocation.estimatedOutputTokens)} est. output tokens ·{" "}
                {formatCharacterCount(invocation.outputChars)} ·{" "}
                {invocation.outputLines.toLocaleString()} lines
              </p>
              <ToolInvocationTimestamp
                invocation={invocation}
                onScrollToTurn={props.onScrollToTurn}
              />
              {expanded ? (
                <div className="tool-call-instance__detail">
                  <TranscriptCommandOutput detail={detail} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function collectCommandDetails(
  entries: AppServerThreadEntry[],
): Map<string, AppServerThreadActivityDetail> {
  const detailsByItemId = new Map<string, AppServerThreadActivityDetail>();
  for (const entry of entries) {
    if (entry.type !== "activity") {
      continue;
    }
    for (const detail of entry.details) {
      if (detail.kind === "command" && detail.command) {
        detailsByItemId.set(detail.id, detail);
      }
    }
  }
  return detailsByItemId;
}

function buildFallbackDetail(
  invocation: ThreadToolInvocationRecord,
): AppServerThreadActivityDetail {
  const command = invocation.normalizedCommand ?? invocation.toolName;
  return {
    id: invocation.itemId,
    kind: "command",
    label: command,
    status: invocation.status === "pending" ? "in_progress" : invocation.status,
    command: {
      displayCommand: command,
      rawCommand: command,
      ...(invocation.exitCode !== undefined
        ? { exitCode: invocation.exitCode }
        : {}),
    },
  };
}

function aggregateToolAccounting(
  toolAccounting: ThreadToolAccounting | undefined,
): ToolAccountingTotals | undefined {
  if (!toolAccounting || toolAccounting.summaries.length === 0) {
    return undefined;
  }
  return toolAccounting.summaries.reduce<ToolAccountingTotals>(
    (totals, summary) => ({
      errorLines: totals.errorLines + summary.errorLines,
      estimatedOutputTokens:
        totals.estimatedOutputTokens + summary.estimatedOutputTokens,
      invocationCount: totals.invocationCount + summary.invocationCount,
      noisyInvocationCount:
        totals.noisyInvocationCount + summary.noisyInvocationCount,
      outputChars: totals.outputChars + summary.outputChars,
      outputLines: totals.outputLines + summary.outputLines,
      warningLines: totals.warningLines + summary.warningLines,
    }),
    {
      errorLines: 0,
      estimatedOutputTokens: 0,
      invocationCount: 0,
      noisyInvocationCount: 0,
      outputChars: 0,
      outputLines: 0,
      warningLines: 0,
    },
  );
}

function formatToolSummaryTitle(summary: ThreadToolInvocationSummary): string {
  return `${summary.toolName} · ${summary.category}`;
}

function formatCharacterCount(chars: number): string {
  if (chars >= 1_000_000) {
    return `${(chars / 1_000_000).toFixed(chars >= 10_000_000 ? 0 : 1)}M chars`;
  }
  if (chars >= 1_000) {
    return `${(chars / 1_000).toFixed(chars >= 10_000 ? 0 : 1)}k chars`;
  }
  return `${chars.toLocaleString()} chars`;
}

function ToolInvocationTimestamp(props: {
  invocation: ThreadToolInvocationRecord;
  onScrollToTurn?: (turnId: string, turnTimeMs?: number) => void;
}) {
  const timestamp = formatTimestamp(props.invocation.observedAt);
  const canScrollToTurn = Boolean(props.invocation.turnId && props.onScrollToTurn);

  return (
    <p className="rail-card__times">
      {canScrollToTurn ? (
        <button
          type="button"
          className="rail-card__time-button"
          title="Scroll the transcript to this turn"
          aria-label={`Scroll the transcript to this turn (${timestamp})`}
          onClick={() =>
            props.invocation.turnId
            && props.onScrollToTurn?.(
              props.invocation.turnId,
              props.invocation.observedAt,
            )
          }
        >
          {timestamp}
        </button>
      ) : (
        timestamp
      )}
      {props.invocation.turnId ? ` · ${props.invocation.turnId}` : ""}
    </p>
  );
}
