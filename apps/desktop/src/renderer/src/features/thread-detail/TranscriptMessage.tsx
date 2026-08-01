import {
  memo,
  useMemo,
  useState,
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import type {
  DesktopApplicationsSnapshot,
  AppServerSkillSummary,
  AppServerThreadImagePart,
  AppServerThreadMessageEntry,
  AppServerThreadMessageOrigin,
  AppServerThreadMessagePart,
  MarkdownFileViewerContext,
  ThreadSubAgentSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  formatMessagingPlatformName,
  MESSAGING_PLATFORM_ICONS,
} from "../../lib/messaging-platform-branding";
import { useThreadLinks, type ResolvedThreadLink } from "../../lib/thread-links";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { ThreadChip } from "./ThreadChip";
import { TranscriptImage } from "./TranscriptImage";
import { ThreadMarkdown } from "./ThreadMarkdown";
import { TranscriptCopyButton } from "./TranscriptCopyButton";
import { SubAgentDetailsModal } from "./context-panels/SubAgentDetailsModal";
import { RailStatusChip } from "./context-panels/RailStatusChip";
import { subAgentTone } from "./context-panels/subagent-format";

type TranscriptMessageProps = {
  applications?: DesktopApplicationsSnapshot;
  desktopApi?: Pick<
    DesktopApi,
    "copyText" | "openApplication" | "openMarkdownFileViewer" | "readMarkdownFile"
  >;
  fileViewerContext?: MarkdownFileViewerContext;
  message: AppServerThreadMessageEntry;
  parentThreadId: string;
  skills: AppServerSkillSummary[];
  subAgents?: ThreadSubAgentSummary[];
  onOpenImage?: (image: AppServerThreadImagePart) => void;
};

export const TranscriptMessage = memo(function TranscriptMessage(props: TranscriptMessageProps) {
  const threadLinks = useThreadLinks();
  const sourceThreadLink = props.message.origin?.sourceThread
    ? threadLinks?.resolve(props.message.origin.sourceThread)
    : undefined;
  const contentParts =
    props.message.parts && props.message.parts.length > 0
      ? props.message.parts
      : props.message.text
        ? [{ type: "text", text: props.message.text } satisfies AppServerThreadMessagePart]
        : [];
  const messageCopyText = useMemo(
    () => buildMessageCopyText(props.message, contentParts),
    [contentParts, props.message]
  );
  const messageSegments = groupMessageParts(contentParts).flatMap(splitMarkdownTableSegment);
  const [monitorExpanded, setMonitorExpanded] = useState(false);
  const [monitorDetailsOpen, setMonitorDetailsOpen] = useState(false);
  const monitorOrigin = props.message.origin?.subAgent;
  const monitorSubAgent = useMemo(
    () => props.subAgents?.find(
      (subAgent) => subAgent.monitorId === monitorOrigin?.monitorId,
    ),
    [monitorOrigin?.monitorId, props.subAgents],
  );

  if (
    props.message.origin?.kind === "sub-agent"
    && monitorOrigin?.kind === "monitor"
  ) {
    const statusTone = subAgentTone(monitorSubAgent?.status ?? monitorOrigin.outcome);
    return (
      <article
        className="transcript-message transcript-message--injected transcript-message--monitor-result"
      >
        {renderMessageHeader({
          continuation: false,
          desktopApi: props.desktopApi,
          message: props.message,
          sourceThreadLink,
          threadLinks,
          text: messageCopyText,
        })}
        <div className="transcript-monitor-result__summary">
          <button
            type="button"
            className="transcript-monitor-result__toggle"
            aria-expanded={monitorExpanded}
            onClick={() => setMonitorExpanded((current) => !current)}
          >
            <span
              aria-hidden="true"
              className="transcript-monitor-result__chevron"
            />
            <span>Monitor sub-agent completed</span>
          </button>
          <RailStatusChip
            alert={statusTone === "error"}
            tone={statusTone}
          >
            {monitorOutcomeLabel(monitorOrigin.outcome)}
          </RailStatusChip>
          {monitorSubAgent ? (
            <button
              type="button"
              className="button button--ghost transcript-monitor-result__details"
              onClick={() => setMonitorDetailsOpen(true)}
            >
              Details
            </button>
          ) : null}
        </div>
        {monitorExpanded ? (
          <div className="transcript-monitor-result__content">
            {messageSegments.map((segment, index) =>
              renderMessageSegment({
                segment,
                index,
                applications: props.applications,
                desktopApi: props.desktopApi,
                fileViewerContext: props.fileViewerContext,
                onOpenImage: props.onOpenImage,
                skills: props.skills,
              }),
            )}
          </div>
        ) : null}
        {monitorDetailsOpen && monitorSubAgent ? (
          <SubAgentDetailsModal
            defaultBackend={
              monitorSubAgent.backend
              ?? props.message.origin.sourceThread?.backend
              ?? "codex"
            }
            parentThreadId={props.parentThreadId}
            subAgent={monitorSubAgent}
            onClose={() => setMonitorDetailsOpen(false)}
          />
        ) : null}
      </article>
    );
  }

  if (messageSegments.length === 0) {
    return (
      <article
        className={`transcript-message ${messageToneClass(props.message)}`}
      >
        {renderMessageHeader({
          continuation: false,
          desktopApi: props.desktopApi,
          message: props.message,
          sourceThreadLink,
          threadLinks,
          text: messageCopyText,
        })}
      </article>
    );
  }

  return (
    <>
      {messageSegments.map((segment, index) => (
        <article
          className={[
            "transcript-message",
            messageToneClass(props.message),
            segment.type === "table" ? "transcript-message--table" : undefined,
            segment.type === "table" && segment.wide
              ? "transcript-message--table-wide"
              : undefined,
            index > 0 ? "transcript-message--continuation" : undefined,
          ]
            .filter(Boolean)
            .join(" ")}
          key={`${props.message.id}:${index}`}
        >
          {renderMessageHeader({
            continuation: index > 0,
            desktopApi: props.desktopApi,
            message: props.message,
            sourceThreadLink,
            threadLinks,
            text: messageCopyText,
          })}
          <div className="transcript-message__text">
            {renderMessageSegment({
              segment,
              index,
              applications: props.applications,
              desktopApi: props.desktopApi,
              fileViewerContext: props.fileViewerContext,
              onOpenImage: props.onOpenImage,
              skills: props.skills,
            })}
          </div>
        </article>
      ))}
    </>
  );
});

TranscriptMessage.displayName = "TranscriptMessage";

type MessagePartSegment =
  | { type: "text"; part: Exclude<AppServerThreadMessagePart, AppServerThreadImagePart> }
  | { type: "table"; text: string; wide: boolean }
  | { type: "images"; parts: AppServerThreadImagePart[]; startIndex: number };

function groupMessageParts(parts: AppServerThreadMessagePart[]): MessagePartSegment[] {
  const segments: MessagePartSegment[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.type === "image") {
      const existingSegment = segments[segments.length - 1];
      if (existingSegment?.type === "images") {
        existingSegment.parts.push(part);
        continue;
      }

      segments.push({
        type: "images",
        parts: [part],
        startIndex: index
      });
      continue;
    }

    segments.push({
      type: "text",
      part
    });
  }

  return segments;
}

function splitMarkdownTableSegment(segment: MessagePartSegment): MessagePartSegment[] {
  if (segment.type !== "text") {
    return [segment];
  }

  const referenceDefinitions = extractMarkdownReferenceDefinitions(segment.part.text);
  const blocks = splitMarkdownTableBlocks(segment.part.text);
  if (blocks.length === 1 && blocks[0]?.type === "text") {
    return [segment];
  }

  const segments: MessagePartSegment[] = [];
  for (const block of blocks) {
    if (block.type === "table" && isWideMarkdownTable(block.text)) {
      segments.push({
        type: "table",
        text: withMarkdownReferenceDefinitions(block.text, referenceDefinitions),
        wide: true,
      });
      continue;
    }

    if (isOnlyMarkdownReferenceDefinitions(block.text)) {
      continue;
    }

    appendTextSegment(segments, block.text);
  }

  return segments;
}

type MarkdownBlock = { type: "text" | "table"; text: string };

function splitMarkdownTableBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.split("\n");
  const blocks: MarkdownBlock[] = [];
  let textBuffer: string[] = [];
  let inFence = false;
  let fenceMarker: string | undefined;
  let index = 0;

  const flushText = (): void => {
    const text = trimBlankMarkdownLines(textBuffer).join("\n");
    textBuffer = [];
    if (text) {
      blocks.push({ type: "text", text });
    }
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const fence = line.match(/^\s{0,3}(```+|~~~+)/);
    if (fence) {
      const marker = fence[1]?.[0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = undefined;
      }
      textBuffer.push(line);
      index += 1;
      continue;
    }

    if (
      !inFence &&
      isMarkdownTableHeader(line) &&
      isMarkdownTableDelimiter(lines[index + 1] ?? "")
    ) {
      flushText();
      const tableLines = [line, lines[index + 1] ?? ""];
      index += 2;
      while (index < lines.length && isMarkdownTableRow(lines[index] ?? "")) {
        tableLines.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ type: "table", text: tableLines.join("\n") });
      continue;
    }

    textBuffer.push(line);
    index += 1;
  }

  flushText();
  return blocks;
}

function isMarkdownTableHeader(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && splitTableCells(trimmed).length >= 2;
}

function isMarkdownTableDelimiter(line: string): boolean {
  const cells = splitTableCells(line.trim());
  return (
    cells.length >= 2 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
  );
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed !== "" &&
    trimmed.includes("|") &&
    splitTableCells(trimmed).length >= 2
  );
}

function splitTableCells(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isWideMarkdownTable(table: string): boolean {
  const [header = "", , ...rows] = table.split("\n");
  const columnCount = splitTableCells(header).length;
  const longestRowLength = rows.reduce(
    (longest, row) => Math.max(longest, row.length),
    header.length
  );
  return columnCount >= 4 || longestRowLength > 140;
}

function trimBlankMarkdownLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") {
    start += 1;
  }
  while (end > start && lines[end - 1]?.trim() === "") {
    end -= 1;
  }

  return lines.slice(start, end);
}

function extractMarkdownReferenceDefinitions(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => /^\s{0,3}\[[^\]]+\]:\s+\S/.test(line));
}

function withMarkdownReferenceDefinitions(table: string, definitions: string[]): string {
  if (definitions.length === 0) {
    return table;
  }

  return `${table}\n\n${definitions.join("\n")}`;
}

function isOnlyMarkdownReferenceDefinitions(markdown: string): boolean {
  const meaningfulLines = markdown
    .split("\n")
    .filter((line) => line.trim() !== "");

  return (
    meaningfulLines.length > 0 &&
    meaningfulLines.every((line) => /^\s{0,3}\[[^\]]+\]:\s+\S/.test(line))
  );
}

function appendTextSegment(segments: MessagePartSegment[], text: string): void {
  const previous = segments[segments.length - 1];
  if (previous?.type === "text") {
    previous.part.text = `${previous.part.text}\n\n${text}`;
    return;
  }

  segments.push({ type: "text", part: { type: "text", text } });
}

function renderMessageSegment(params: {
  applications?: DesktopApplicationsSnapshot;
  desktopApi?: Pick<
    DesktopApi,
    "copyText" | "openApplication" | "openMarkdownFileViewer" | "readMarkdownFile"
  >;
  fileViewerContext?: MarkdownFileViewerContext;
  segment: MessagePartSegment;
  index: number;
  onOpenImage?: (image: AppServerThreadImagePart) => void;
  skills: AppServerSkillSummary[];
}): ReactNode {
  if (params.segment.type === "images") {
    const imageSegment = params.segment;

    return (
      <div key={`images:${params.index}`} className="transcript-message__image-grid">
        {imageSegment.parts.map((imagePart, imageIndex) => (
          <TranscriptImageTile
            key={`image:${imageSegment.startIndex + imageIndex}:${imagePart.url}`}
            desktopApi={params.desktopApi}
            imagePart={imagePart}
            imageNumber={imageSegment.startIndex + imageIndex + 1}
            onOpenImage={params.onOpenImage}
          />
        ))}
      </div>
    );
  }

  return (
    <ThreadMarkdown
      key={`text:${params.index}`}
      applications={params.applications}
      className="transcript-message__text-block"
      desktopApi={params.desktopApi}
      fileViewerContext={params.fileViewerContext}
      skills={params.skills}
      text={params.segment.type === "table" ? params.segment.text : params.segment.part.text}
    />
  );
}

function TranscriptImageTile(props: {
  desktopApi?: Pick<DesktopApi, "copyText">;
  imagePart: AppServerThreadImagePart;
  imageNumber: number;
  onOpenImage?: (image: AppServerThreadImagePart) => void;
}): ReactNode {
  const [failed, setFailed] = useState(false);
  const sourceLabel = useMemo(
    () => formatTranscriptImageSourceLabel(props.imagePart.url),
    [props.imagePart.url]
  );

  if (failed) {
    return (
      <div className="transcript-message__image-fallback">
        <div className="transcript-message__image-fallback-main">
          <span className="transcript-message__image-fallback-title">Image failed to load</span>
          <code
            className="transcript-message__image-fallback-path"
            title={sourceLabel}
          >
            {sourceLabel}
          </code>
        </div>
        <TranscriptCopyButton
          className="transcript-copy-button--image-path"
          copiedLabel="Copied image path"
          desktopApi={props.desktopApi}
          label="Copy image path"
          text={sourceLabel}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      className="transcript-message__image-button"
      aria-label={`Expand transcript image ${props.imageNumber}`}
      onClick={() => {
        props.onOpenImage?.(props.imagePart);
      }}
    >
      <TranscriptImage
        className="transcript-message__image-preview"
        src={props.imagePart.url}
        alt={props.imagePart.alt ?? "Transcript image"}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </button>
  );
}

function formatTranscriptImageSourceLabel(url: string): string {
  const transcriptImageSourceUrl = decodeTranscriptImageProtocolUrl(url);
  if (transcriptImageSourceUrl) {
    return formatTranscriptImageSourceLabel(transcriptImageSourceUrl);
  }

  if (!url.startsWith("file://")) {
    return url;
  }

  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    const stripped = url.replace(/^file:\/\//, "");
    try {
      return decodeURIComponent(stripped);
    } catch {
      return stripped;
    }
  }
}

function decodeTranscriptImageProtocolUrl(url: string): string | undefined {
  if (!url.startsWith("pwragent-image://file/")) {
    return undefined;
  }

  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return undefined;
  }
}

function renderMessageHeader(params: {
  continuation: boolean;
  desktopApi?: Pick<DesktopApi, "copyText">;
  message: AppServerThreadMessageEntry;
  sourceThreadLink?: ResolvedThreadLink;
  threadLinks: ReturnType<typeof useThreadLinks>;
  text: string;
}): ReactNode {
  if (params.continuation) {
    return null;
  }

  const attributionClassName = params.message.origin?.kind === "sub-agent"
    ? "transcript-message__attribution transcript-message__attribution--stacked"
    : "transcript-message__attribution";

  return (
    <header className="transcript-message__header">
      <span className={attributionClassName}>
        <span className="transcript-message__role">
          {labelForMessage(params.message)}
        </span>
        {params.sourceThreadLink && params.threadLinks ? (
          <ThreadChip
            fallbackLabel={params.message.origin?.sourceThread?.title}
            link={params.sourceThreadLink}
            onOpen={params.threadLinks.show}
          />
        ) : params.message.origin?.sourceThread?.title ? (
          <span className="transcript-message__source">
            {params.message.origin.sourceThread.title}
          </span>
        ) : null}
        {params.message.origin?.kind === "messaging"
          && params.message.origin.messaging ? (
            <MessagingOriginChip origin={params.message.origin.messaging} />
          ) : null}
      </span>
      <span className="transcript-message__header-actions">
        {params.text ? (
          <TranscriptCopyButton
            className="transcript-copy-button--message"
            copiedLabel="Copied message"
            desktopApi={params.desktopApi}
            label="Copy message"
            text={params.text}
          />
        ) : null}
        {params.message.createdAt ? (
          <time className="transcript-message__time">
            {new Intl.DateTimeFormat(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit"
            }).format(params.message.createdAt)}
          </time>
        ) : null}
      </span>
    </header>
  );
}

function MessagingOriginChip(props: {
  origin: NonNullable<AppServerThreadMessageOrigin["messaging"]>;
}) {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const Icon = MESSAGING_PLATFORM_ICONS[props.origin.platform];
  const platform = formatMessagingPlatformName(props.origin.platform);
  const surfaceParts = messagingOriginSurfaceParts(props.origin);
  const surface = surfaceParts.join(" / ");
  const actor = formatMessagingOriginActor(props.origin.actor);
  const description = `${platform}: ${surface} · ${actor.detail}`;
  const sourceUrl = safeMessagingSourceUrl(props.origin.sourceUrl);
  const tooltipText = [
    platform,
    surface,
    actor.detail,
    sourceUrl ? `Open in ${platform}` : undefined,
  ].filter(Boolean).join("\n");
  const content = (
    <>
      <span
        aria-hidden="true"
        className="transcript-message__messaging-platform"
      >
        {Icon ? (
          <Icon size={12} />
        ) : (
          <span className="transcript-message__messaging-platform-fallback">
            {props.origin.platform.slice(0, 2)}
          </span>
        )}
      </span>
      <span className="transcript-message__messaging-surface">
        {surfaceParts.map((part, index) => (
          <span
            className="transcript-message__messaging-surface-segment"
            key={`${index}:${part}`}
          >
            {index > 0 ? (
              <span
                aria-hidden="true"
                className="transcript-message__messaging-surface-divider"
              >
                {" / "}
              </span>
            ) : null}
            <span className="transcript-message__messaging-surface-label">
              {part}
            </span>
          </span>
        ))}
      </span>
      <span
        aria-hidden="true"
        className="transcript-message__messaging-separator"
      >
        ·
      </span>
      <span className="transcript-message__messaging-actor">{actor.label}</span>
    </>
  );
  const sharedProps = {
    "aria-label": description,
    className: "chip transcript-message__messaging-origin",
    onBlur: tooltip.hide,
    onFocus: (event: FocusEvent<HTMLElement>) =>
      tooltip.show(event.currentTarget, tooltipText),
    onMouseEnter: (event: MouseEvent<HTMLElement>) =>
      tooltip.show(event.currentTarget, tooltipText),
    onMouseLeave: tooltip.hide,
  };

  return (
    <>
      {sourceUrl ? (
        <a
          {...sharedProps}
          href={sourceUrl}
          onClick={tooltip.hide}
          rel="noreferrer"
          target="_blank"
        >
          {content}
        </a>
      ) : (
        <span {...sharedProps} tabIndex={0}>
          {content}
        </span>
      )}
      {tooltip.tooltipNode}
    </>
  );
}

function safeMessagingSourceUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function messagingOriginSurfaceParts(
  origin: NonNullable<AppServerThreadMessageOrigin["messaging"]>,
): string[] {
  const title = origin.surface.title?.trim();
  const parent = origin.surface.parentTitle?.trim();
  const ancestor = origin.surface.ancestorTitle?.trim();

  switch (origin.surface.kind) {
    case "dm":
      return [title || "Direct message"];
    case "topic":
      return messagingSurfaceParts([parent, title], "Topic");
    case "thread":
      return messagingSurfaceParts([
        ancestor,
        parent ? `#${parent}` : undefined,
        title,
      ], "Thread");
    case "channel":
      if (origin.platform === "telegram") {
        return [title || parent || "Group"];
      }
      if (ancestor && parent) {
        return messagingSurfaceParts(
          [ancestor, `#${parent}`, title],
          "Channel",
        );
      }
      return messagingSurfaceParts([
        ancestor || parent,
        title ? `#${title}` : undefined,
      ], "Channel");
  }
}

function messagingSurfaceParts(
  parts: Array<string | undefined>,
  fallback: string,
): string[] {
  const available = parts.filter((part): part is string => Boolean(part));
  return available.length > 0 ? available : [fallback];
}

function formatMessagingOriginActor(
  actor: NonNullable<AppServerThreadMessageOrigin["messaging"]>["actor"],
): { detail: string; label: string } {
  const displayName = actor.displayName?.trim();
  const username = actor.username?.trim().replace(/^@/, "");
  const usernameLabel = username ? `@${username}` : undefined;
  const label =
    displayName
    || usernameLabel
    || actor.phoneNumber?.trim()
    || actor.platformUserId;
  return {
    label,
    detail: displayName && usernameLabel
      ? `${displayName} (${usernameLabel})`
      : label,
  };
}

function messageToneClass(message: AppServerThreadMessageEntry): string {
  return message.origin
    ? "transcript-message--injected"
    : `transcript-message--${message.role}`;
}

function labelForMessage(message: AppServerThreadMessageEntry): string {
  if (message.role === "assistant") {
    return "Assistant";
  }
  return message.origin ? labelForOrigin(message.origin) : "User";
}

function labelForOrigin(origin: AppServerThreadMessageOrigin): string {
  if (origin.kind === "agent") {
    return "Agent";
  }
  if (origin.kind === "automation") {
    return "Automation";
  }
  if (origin.kind === "messaging") {
    return "Messaging";
  }
  if (origin.kind === "sub-agent") {
    return origin.subAgent?.kind === "monitor"
      ? "Monitor sub-agent"
      : "Sub-agent";
  }
  return "PwrAgent";
}

function monitorOutcomeLabel(
  outcome: NonNullable<AppServerThreadMessageOrigin["subAgent"]>["outcome"],
): string {
  switch (outcome) {
    case "success":
      return "Success";
    case "failure":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function buildMessageCopyText(
  message: AppServerThreadMessageEntry,
  parts: AppServerThreadMessagePart[]
): string {
  if (typeof message.text === "string" && message.text.length > 0) {
    return message.text;
  }

  return parts
    .filter((part): part is Exclude<AppServerThreadMessagePart, AppServerThreadImagePart> =>
      part.type !== "image"
    )
    .map((part) => part.text)
    .join("\n\n");
}
