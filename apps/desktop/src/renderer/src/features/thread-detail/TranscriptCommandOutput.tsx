import { useMemo, useState } from "react";
import {
  isAppServerBackendKind,
  parseThreadUrl,
  type AppServerSkillSummary,
  formatPathRelativeToDirectories,
  type AppServerThreadActivityDetail,
  type DesktopApplicationsSnapshot,
  type MarkdownFileViewerContext,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { copyText } from "../../lib/copy-text";
import { useThreadLinks, type ResolvedThreadLink } from "../../lib/thread-links";
import { ThreadChip } from "./ThreadChip";
import { ThreadMarkdown } from "./ThreadMarkdown";
import { TranscriptSubAgentCall } from "./TranscriptSubAgentCall";

type TranscriptCommandOutputProps = {
  applications?: DesktopApplicationsSnapshot;
  desktopApi?: Pick<
    DesktopApi,
    "copyText" | "openApplication" | "openMarkdownFileViewer" | "readMarkdownFile"
  >;
  detail: AppServerThreadActivityDetail;
  directoryPaths?: string[];
  fileViewerContext?: MarkdownFileViewerContext;
  skills?: AppServerSkillSummary[];
};

const PREVIEW_LINE_LIMIT = 12;
const PREVIEW_CHARACTER_LIMIT = 3_000;

export function TranscriptCommandOutput(props: TranscriptCommandOutputProps) {
  if (props.detail.command?.subAgent) {
    return <TranscriptSubAgentCall detail={props.detail} />;
  }

  return <GenericTranscriptCommandOutput {...props} />;
}

type ThreadToolMessage = {
  id?: string;
  messageUrl?: string;
  role?: string;
  text: string;
};

type ThreadToolPresentation = {
  fallbackLabel: string;
  link?: ResolvedThreadLink;
  messages: ThreadToolMessage[];
  prompt?: string;
  tool: "read_thread" | "send_message_to_thread";
};

export function isThreadReferenceToolDetail(
  detail: AppServerThreadActivityDetail,
): boolean {
  const identifier = detail.command?.rawCommand
    ?? detail.command?.displayCommand.split("\n", 1)[0]
    ?? "";
  return /(?:^|[/.])(?:read_thread|send_message_to_thread)$/i.test(identifier.trim());
}

export function TranscriptThreadToolActivity(props: {
  applications?: DesktopApplicationsSnapshot;
  createdAt?: number;
  desktopApi?: TranscriptCommandOutputProps["desktopApi"];
  detail: AppServerThreadActivityDetail;
  expanded: boolean;
  fileViewerContext?: MarkdownFileViewerContext;
  skills?: AppServerSkillSummary[];
  onExpandedChange: (expanded: boolean) => void;
}) {
  const threadLinks = useThreadLinks();
  const presentation = useMemo(
    () => buildThreadToolPresentation(props.detail, threadLinks),
    [props.detail, threadLinks],
  );
  if (!presentation) {
    return <TranscriptCommandOutput {...props} />;
  }

  const actionLabel = presentation.tool === "send_message_to_thread"
    ? "Message sent to"
    : "Read thread";
  const statusText = formatCommandStatus(props.detail);
  return (
    <aside className="transcript-activity transcript-thread-tool">
      <header className="transcript-thread-tool__header">
        <button
          type="button"
          className="transcript-thread-tool__toggle"
          aria-expanded={props.expanded}
          onClick={() => props.onExpandedChange(!props.expanded)}
        >
          <span className="transcript-activity__chevron" aria-hidden="true" />
          <span className="transcript-thread-tool__action">{actionLabel}</span>
        </button>
        {presentation.link ? (
          <ThreadChip
            fallbackLabel={presentation.fallbackLabel}
            link={presentation.link}
            onOpen={threadLinks?.show ?? (() => undefined)}
          />
        ) : (
          <span className="chip thread-chip">#{presentation.fallbackLabel}</span>
        )}
        <span className="transcript-thread-tool__meta">
          {statusText}
          {props.createdAt ? (
            <time>
              {new Intl.DateTimeFormat(undefined, {
                hour: "numeric",
                minute: "2-digit",
              }).format(props.createdAt)}
            </time>
          ) : null}
        </span>
      </header>
      {props.expanded ? (
        <div className="transcript-thread-tool__body">
          {presentation.prompt ? (
            <section className="transcript-thread-tool__message">
              <p className="transcript-thread-tool__role">Sent message</p>
              <ThreadMarkdown
                applications={props.applications}
                desktopApi={props.desktopApi}
                fileViewerContext={props.fileViewerContext}
                skills={props.skills}
                text={presentation.prompt}
                variant="summary"
              />
            </section>
          ) : null}
          {presentation.messages.map((message, index) => {
            const messageLink = resolveThreadToolLink(
              message.messageUrl,
              threadLinks,
            );
            return (
              <section
                key={message.id ?? `${message.role ?? "message"}:${index}`}
                className="transcript-thread-tool__message"
              >
                <div className="transcript-thread-tool__message-header">
                  <p className="transcript-thread-tool__role">
                    {formatThreadToolMessageRole(message.role)}
                  </p>
                  {messageLink && threadLinks ? (
                    <button
                      type="button"
                      className="button button--ghost transcript-thread-tool__message-link"
                      onClick={() => threadLinks.show(messageLink)}
                    >
                      Open message
                    </button>
                  ) : null}
                </div>
                <ThreadMarkdown
                  applications={props.applications}
                  desktopApi={props.desktopApi}
                  fileViewerContext={props.fileViewerContext}
                  skills={props.skills}
                  text={message.text}
                  variant="summary"
                />
              </section>
            );
          })}
          {!presentation.prompt && presentation.messages.length === 0 ? (
            <p className="transcript-thread-tool__empty">
              No message text was returned.
            </p>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function buildThreadToolPresentation(
  detail: AppServerThreadActivityDetail,
  threadLinks: ReturnType<typeof useThreadLinks>,
): ThreadToolPresentation | undefined {
  const command = detail.command;
  if (!command || !isThreadReferenceToolDetail(detail)) {
    return undefined;
  }
  const identifier = command.rawCommand ?? command.displayCommand.split("\n", 1)[0] ?? "";
  const tool = identifier.trim().toLowerCase().endsWith("send_message_to_thread")
    ? "send_message_to_thread"
    : "read_thread";
  const args = parseJsonPayload(command.displayCommand);
  const output = parseJsonPayload(command.output);
  const result = readRecord(output?.read) ?? output;
  const backendValue = readString(result, "backend") ?? readString(args, "backend");
  const threadId = readString(result, "threadId") ?? readString(args, "threadId");
  const instanceId = readString(result, "instanceId") ?? readString(args, "instanceId");
  if (!threadId) {
    return undefined;
  }
  const title = readString(result, "title")
    ?? markdownLinkLabel(readString(result, "threadLink"))
    ?? threadId;
  const preferredUrl = tool === "send_message_to_thread"
    ? readString(result, "messageUrl") ?? readString(result, "threadUrl")
    : readString(result, "threadUrl");
  let link = resolveThreadToolLink(preferredUrl, threadLinks);
  if (!link && threadLinks && backendValue && isAppServerBackendKind(backendValue)) {
    link = threadLinks.resolve({
      backend: backendValue,
      ...(instanceId ? { instanceId } : {}),
      ...(tool === "send_message_to_thread"
        ? { messageId: readString(result, "messageId") }
        : {}),
      threadId,
    });
  }

  const rawMessages = Array.isArray(result?.messages)
    ? result.messages
    : Array.isArray(result?.entries)
      ? result.entries.filter((entry) => readString(readRecord(entry), "type") === "message")
      : [];
  const messages = rawMessages.flatMap((value): ThreadToolMessage[] => {
    const message = readRecord(value);
    const text = readString(message, "text");
    if (!text) {
      return [];
    }
    return [{
      id: readString(message, "id"),
      messageUrl: readString(message, "messageUrl"),
      role: readString(message, "role"),
      text,
    }];
  });
  return {
    fallbackLabel: title,
    link,
    messages,
    ...(tool === "send_message_to_thread"
      ? {
          prompt:
            readString(args, "prompt")
            ?? readString(result, "promptPreview"),
        }
      : {}),
    tool,
  };
}

function resolveThreadToolLink(
  value: string | undefined,
  threadLinks: ReturnType<typeof useThreadLinks>,
): ResolvedThreadLink | undefined {
  const ref = value ? parseThreadUrl(value) : undefined;
  return ref && threadLinks ? threadLinks.resolve(ref) : undefined;
}

function parseJsonPayload(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  const objectStart = value.indexOf("{");
  if (objectStart < 0) {
    return undefined;
  }
  try {
    return readRecord(JSON.parse(value.slice(objectStart)));
  } catch {
    return undefined;
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function markdownLinkLabel(value: string | undefined): string | undefined {
  const match = value?.match(/^\[([^\]]+)]\(pwragent:\/\//i);
  return match?.[1]?.replace(/\\([\\[\]])/g, "$1").trim() || undefined;
}

function formatThreadToolMessageRole(role: string | undefined): string {
  if (role === "assistant") {
    return "Assistant";
  }
  if (role === "user") {
    return "User";
  }
  return role ? `${role[0]?.toUpperCase()}${role.slice(1)}` : "Message";
}

function GenericTranscriptCommandOutput(props: TranscriptCommandOutputProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const command = props.detail.command;
  const output = useMemo(() => sanitizeCommandOutput(command?.output), [command?.output]);
  if (!command) {
    return null;
  }

  const preview = buildOutputPreview(output, isExpanded);
  const statusText = formatCommandStatus(props.detail);
  const source =
    command.source ??
    (isAgentCommand(command.rawCommand) ? "agent" : "shell");
  const sourceLabel =
    source === "agent" ? "Agent" : source === "tool" ? "Tool" : "Shell";
  const fullCommand =
    source === "shell"
      ? command.rawCommand ?? command.displayCommand
      : command.displayCommand;
  const displayCwd = command.cwd
    ? formatPathRelativeToDirectories(command.cwd, props.directoryPaths)
    : undefined;

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
            void copyText(fullCommand);
          }}
        >
          {source === "tool" ? "Copy invocation" : "Copy command"}
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
          {displayCwd}
        </p>
      ) : null}
      <pre className="transcript-command__block">
        <code>
          {source === "tool" ? fullCommand : `$ ${fullCommand}`}
        </code>
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
  const normalizedNewlines = (value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  let sanitized = "";
  for (const character of normalizedNewlines) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isDisallowedControl =
      codePoint <= 0x08
      || codePoint === 0x0b
      || codePoint === 0x0c
      || (codePoint >= 0x0e && codePoint <= 0x1f)
      || codePoint === 0x7f;
    sanitized += isDisallowedControl ? "\uFFFD" : character;
  }
  return sanitized;
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
