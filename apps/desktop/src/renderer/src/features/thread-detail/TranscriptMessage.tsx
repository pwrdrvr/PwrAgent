import { memo, type ReactNode } from "react";
import type {
  DesktopApplicationsSnapshot,
  AppServerSkillSummary,
  AppServerThreadImagePart,
  AppServerThreadMessageEntry,
  AppServerThreadMessagePart,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { TranscriptImage } from "./TranscriptImage";
import { ThreadMarkdown } from "./ThreadMarkdown";

type TranscriptMessageProps = {
  applications?: DesktopApplicationsSnapshot;
  desktopApi?: Pick<DesktopApi, "openApplication">;
  message: AppServerThreadMessageEntry;
  skills: AppServerSkillSummary[];
  onOpenImage?: (image: AppServerThreadImagePart) => void;
};

export const TranscriptMessage = memo(function TranscriptMessage(props: TranscriptMessageProps) {
  const contentParts =
    props.message.parts && props.message.parts.length > 0
      ? props.message.parts
      : props.message.text
        ? [{ type: "text", text: props.message.text } satisfies AppServerThreadMessagePart]
        : [];
  const messageSegments = groupMessageParts(contentParts).flatMap(splitMarkdownTableSegment);

  if (messageSegments.length === 0) {
    return (
      <article
        className={`transcript-message transcript-message--${props.message.role}`}
      >
        {renderMessageHeader(props.message, false)}
      </article>
    );
  }

  return (
    <>
      {messageSegments.map((segment, index) => (
        <article
          className={[
            "transcript-message",
            `transcript-message--${props.message.role}`,
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
          {renderMessageHeader(props.message, index > 0)}
          <div className="transcript-message__text">
            {renderMessageSegment({
              segment,
              index,
              applications: props.applications,
              desktopApi: props.desktopApi,
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
  desktopApi?: Pick<DesktopApi, "openApplication">;
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
          <button
            key={`image:${imageSegment.startIndex + imageIndex}`}
            type="button"
            className="transcript-message__image-button"
            aria-label={`Expand transcript image ${imageSegment.startIndex + imageIndex + 1}`}
            onClick={() => {
              params.onOpenImage?.(imagePart);
            }}
          >
            <TranscriptImage
              className="transcript-message__image-preview"
              src={imagePart.url}
              alt={imagePart.alt ?? "Transcript image"}
              loading="lazy"
            />
          </button>
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
      skills={params.skills}
      text={params.segment.type === "table" ? params.segment.text : params.segment.part.text}
    />
  );
}

function renderMessageHeader(
  message: AppServerThreadMessageEntry,
  continuation: boolean
): ReactNode {
  if (continuation) {
    return null;
  }

  return (
    <header className="transcript-message__header">
      <span className="transcript-message__role">{labelForRole(message.role)}</span>
      {message.createdAt ? (
        <time className="transcript-message__time">
          {new Intl.DateTimeFormat(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit"
          }).format(message.createdAt)}
        </time>
      ) : null}
    </header>
  );
}

function labelForRole(role: AppServerThreadMessageEntry["role"]): string {
  if (role === "assistant") {
    return "Assistant";
  }
  return "User";
}
