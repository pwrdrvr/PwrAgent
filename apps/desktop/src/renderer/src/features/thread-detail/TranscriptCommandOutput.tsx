import { useMemo, useState } from "react";
import type { AppServerThreadActivityDetail } from "@pwragent/shared";
import { copyText } from "../../lib/copy-text";

type TranscriptCommandOutputProps = {
  detail: AppServerThreadActivityDetail;
};

const PREVIEW_LINE_LIMIT = 12;
const PREVIEW_CHARACTER_LIMIT = 3_000;

export function TranscriptCommandOutput(props: TranscriptCommandOutputProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const command = props.detail.command;
  const output = useMemo(() => sanitizeCommandOutput(command?.output), [command?.output]);
  if (!command) {
    return null;
  }

  const preview = buildOutputPreview(output, isExpanded);
  const statusText = formatCommandStatus(props.detail);
  const sourceLabel = isAgentCommand(command.rawCommand) ? "Agent" : "Shell";

  return (
    <div className="transcript-command">
      <div className="transcript-command__meta">
        <span className="transcript-command__source">{sourceLabel}</span>
        {statusText ? (
          <span className="transcript-command__status">{statusText}</span>
        ) : null}
      </div>
      <div className="transcript-command__actions">
        <button
          type="button"
          className="button button--ghost transcript-command__copy"
          onClick={() => {
            void copyText(command.displayCommand);
          }}
        >
          Copy command
        </button>
        {output ? (
          <button
            type="button"
            className="button button--ghost transcript-command__copy"
            onClick={() => {
              void copyText(output);
            }}
          >
            Copy output
          </button>
        ) : null}
      </div>
      {command.cwd ? (
        <p className="transcript-command__cwd" title={command.cwd}>
          {command.cwd}
        </p>
      ) : null}
      <pre className="transcript-command__block">
        <code>{`$ ${command.displayCommand}`}</code>
      </pre>
      <div className="transcript-command__output" aria-label={`${props.detail.label} output`}>
        {preview.text ? <pre><code>{preview.text}</code></pre> : <p>No output captured.</p>}
      </div>
      {preview.isTruncated ? (
        <button
          type="button"
          className="button button--ghost transcript-command__toggle"
          aria-expanded={isExpanded}
          onClick={() => {
            setIsExpanded((current) => !current);
          }}
        >
          {isExpanded ? "Show less" : preview.summary}
        </button>
      ) : null}
    </div>
  );
}

function isAgentCommand(rawCommand: string | undefined): boolean {
  return rawCommand === "spawnAgent" ||
    rawCommand === "wait" ||
    rawCommand === "sendInput" ||
    rawCommand === "resumeAgent" ||
    rawCommand === "closeAgent";
}

function sanitizeCommandOutput(value: string | undefined): string {
  return (value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "\uFFFD");
}

function buildOutputPreview(
  output: string,
  isExpanded: boolean,
): { isTruncated: boolean; summary: string; text: string } {
  if (isExpanded || output.length <= PREVIEW_CHARACTER_LIMIT) {
    const lines = output.split("\n");
    if (isExpanded || lines.length <= PREVIEW_LINE_LIMIT) {
      return { isTruncated: false, summary: "", text: output };
    }
  }

  const lines = output.split("\n");
  const lineLimited = lines.length > PREVIEW_LINE_LIMIT;
  const characterLimited = output.length > PREVIEW_CHARACTER_LIMIT;
  const visibleText = lineLimited
    ? lines.slice(0, PREVIEW_LINE_LIMIT).join("\n")
    : output.slice(0, PREVIEW_CHARACTER_LIMIT);
  const omittedLines = lineLimited ? lines.length - PREVIEW_LINE_LIMIT : 0;
  const omittedChars = characterLimited ? output.length - visibleText.length : 0;
  const summary = lineLimited
    ? `Show ${omittedLines.toLocaleString()} more line${omittedLines === 1 ? "" : "s"}`
    : `Show ${omittedChars.toLocaleString()} more character${omittedChars === 1 ? "" : "s"}`;
  return {
    isTruncated: true,
    summary,
    text: `${visibleText}\n... ${lineLimited
      ? `${omittedLines.toLocaleString()} line${omittedLines === 1 ? "" : "s"} omitted`
      : `${omittedChars.toLocaleString()} character${omittedChars === 1 ? "" : "s"} omitted`}`,
  };
}

function formatCommandStatus(detail: AppServerThreadActivityDetail): string | undefined {
  const parts: string[] = [];
  if (detail.status === "completed") {
    parts.push(detail.command?.exitCode && detail.command.exitCode !== 0 ? "Failed" : "Success");
  } else if (detail.status === "failed") {
    parts.push("Failed");
  } else if (detail.status === "in_progress") {
    parts.push("Running");
  } else if (detail.status === "cancelled") {
    parts.push("Cancelled");
  }

  if (typeof detail.command?.durationMs === "number") {
    parts.push(`ran for ${formatDuration(detail.command.durationMs)}`);
  }

  return parts.join(" · ") || undefined;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${Math.round(durationMs)}ms`;
  }
  const seconds = durationMs / 1_000;
  return seconds >= 10 ? `${seconds.toFixed(0)}s` : `${seconds.toFixed(1)}s`;
}
