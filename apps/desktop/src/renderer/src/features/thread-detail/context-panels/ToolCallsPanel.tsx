import { memo, useMemo, useState } from "react";
import type {
  AppServerThreadActivityDetail,
  AppServerThreadEntry,
  ThreadToolAccounting,
  ThreadToolInvocationRecord,
  ThreadToolInvocationSummary,
} from "@pwragent/shared";
import { PopoutIcon } from "../../../icons";
import type { ThreadLinkSource } from "../../../lib/thread-links";
import { TranscriptCommandOutput } from "../TranscriptCommandOutput";
import { detailMatchesInvocationItem } from "../tool-call-details";
import { formatTokenCount } from "./subagent-format";
import {
  formatCompactCount,
  formatTimestamp,
  RailSummaryRow,
} from "./context-rail-shared";

type ToolCallsPanelProps = {
  entries?: AppServerThreadEntry[];
  loadingDetailItemId?: string;
  onAnalyzeHistory?: () => void;
  onOpenIncidentExplorer?: () => void;
  onRequestInvocationDetails?: (invocation: ThreadToolInvocationRecord) => void;
  onScrollToTurn?: (turnId: string, turnTimeMs?: number) => void;
  threadLinkSource?: ThreadLinkSource;
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

export const ToolCallsPanel = memo(function ToolCallsPanel(props: ToolCallsPanelProps) {
  const [expandedSummary, setExpandedSummary] = useState<string>();
  const [expandedInvocation, setExpandedInvocation] = useState<string>();
  const accounting = props.toolAccounting;
  const totals = aggregateToolAccounting(accounting);
  const detailsByItemId = useMemo(
    () => collectCommandDetails(
      props.entries ?? [],
      accounting?.invocations ?? [],
    ),
    [accounting?.invocations, props.entries],
  );

  return (
    <section className="context-panel__section tool-calls-panel">
      <div className="tool-calls-panel__heading">
        <h3>Tool calls</h3>
        {/* Named for the window it opens rather than "Explore", and built at
            rail scale: a 34px `.button` beside a 14px heading outweighed the
            heading it sat next to. */}
        <button
          className="context-panel__section-action"
          onClick={props.onOpenIncidentExplorer}
          type="button"
        >
          <PopoutIcon size={11} aria-hidden="true" />
          Tool Output Incidents
        </button>
      </div>
      {totals ? (
        <div className="rail-summary-card tool-call-summary-card">
          <div className="rail-summary-card__header">
            <span className="rail-summary-card__eyebrow">Tool output</span>
            <span className="rail-summary-card__meta">
              {totals.invocationCount.toLocaleString()} invocation
              {totals.invocationCount === 1 ? "" : "s"}
            </span>
          </div>
          <div className="rail-summary-card__headline">
            <span className="rail-summary-card__primary">
              {formatCompactCount(totals.estimatedOutputTokens)} est. tokens
            </span>
            <span className="rail-summary-card__secondary">
              {formatCharacterCount(totals.outputChars)}
            </span>
          </div>
          <div className="rail-summary-card__caption">
            {totals.outputLines.toLocaleString()} output line
            {totals.outputLines === 1 ? "" : "s"}
          </div>
          <div className="rail-summary-card__section">
            <span className="rail-summary-card__section-title">Diagnostics</span>
            <RailSummaryRow
              label="Warning-like lines"
              value={totals.warningLines.toLocaleString()}
            />
            <RailSummaryRow
              label="Error-like lines"
              value={totals.errorLines.toLocaleString()}
            />
            {totals.noisyInvocationCount > 0 ? (
              <RailSummaryRow
                label="Noisy calls"
                value={totals.noisyInvocationCount.toLocaleString()}
              />
            ) : null}
          </div>
        </div>
      ) : (
        <div className="context-empty">
          <p>No tool calls recorded yet.</p>
          <button
            className="button button--ghost"
            onClick={props.onAnalyzeHistory}
            type="button"
          >
            Analyze history
          </button>
        </div>
      )}

      {accounting?.alerts.length ? (
        <ul className="context-list context-list--cards tool-call-alert-list">
          {accounting.alerts.map((alert) => (
            <li key={alert.alertId} className="rail-card tool-call-alert">
              <p className="rail-card__title">
                {alert.kind === "noisy-polling"
                  ? "Repeated queued checks"
                  : "Large tool output"}
              </p>
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
                      loadingDetailItemId={props.loadingDetailItemId}
                      onExpandedInvocationChange={setExpandedInvocation}
                      onRequestInvocationDetails={props.onRequestInvocationDetails}
                      onScrollToTurn={props.onScrollToTurn}
                      threadLinkSource={props.threadLinkSource}
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
});

function ToolInvocationList(props: {
  detailsByItemId: Map<string, AppServerThreadActivityDetail>;
  expandedInvocation?: string;
  invocations: ThreadToolInvocationRecord[];
  loadingDetailItemId?: string;
  onExpandedInvocationChange: (invocationId: string | undefined) => void;
  onRequestInvocationDetails?: (invocation: ThreadToolInvocationRecord) => void;
  onScrollToTurn?: (turnId: string, turnTimeMs?: number) => void;
  threadLinkSource?: ThreadLinkSource;
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
          const loadingDetail =
            props.loadingDetailItemId === invocation.itemId;
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
                  onClick={() => {
                    if (!expanded && !transcriptDetail) {
                      props.onRequestInvocationDetails?.(invocation);
                    }
                    props.onExpandedInvocationChange(
                      expanded ? undefined : invocation.invocationId,
                    );
                  }}
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
                  {transcriptDetail ? (
                    <TranscriptCommandOutput
                      detail={transcriptDetail}
                      threadLinkSource={props.threadLinkSource}
                    />
                  ) : (
                    <p
                      className="tool-call-instance__detail-status"
                      aria-live="polite"
                    >
                      {loadingDetail
                        ? "Loading captured output…"
                        : "Captured output is unavailable in transcript history."}
                    </p>
                  )}
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
  invocations: ThreadToolInvocationRecord[],
): Map<string, AppServerThreadActivityDetail> {
  const detailsByItemId = new Map<string, AppServerThreadActivityDetail>();
  const itemIds = [...new Set(invocations.map((invocation) => invocation.itemId))]
    .sort((left, right) => right.length - left.length);
  for (const entry of entries) {
    if (entry.type !== "activity") {
      continue;
    }
    for (const detail of entry.details) {
      if (!detail.command) {
        continue;
      }
      const itemId = itemIds.find((candidate) =>
        detailMatchesInvocationItem(detail.id, candidate),
      );
      if (!itemId) {
        continue;
      }
      const current = detailsByItemId.get(itemId);
      if (
        !current
        || (current.command?.output === undefined
          && detail.command.output !== undefined)
      ) {
        detailsByItemId.set(itemId, detail);
      }
    }
  }
  return detailsByItemId;
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
