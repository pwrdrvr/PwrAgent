import path from "node:path";
import type { AgentEvent } from "@pwragent/shared";
import type { MessagingArtifact } from "./messaging-artifact-renderer.js";

const DEFAULT_MAX_MARKDOWN_FILE_BYTES = 50 * 1024;
const DEFAULT_MAX_PREVIEW_CHARS = 1_000;
const DEFAULT_MAX_PREVIEW_LINES = 20;

export type MessagingMarkdownFileAttachmentSelection = {
  attachmentName: string;
  markdown: string;
  path: string;
  previewMarkdown: string;
  previewTruncated: boolean;
  sizeBytes: number;
};

export type MessagingMarkdownFileAttachmentSelectorOptions = {
  maxBytes?: number;
  maxPreviewChars?: number;
  maxPreviewLines?: number;
};

type PreviewSelection = {
  text: string;
  truncated: boolean;
};

export class MessagingMarkdownFileAttachmentSelector {
  private readonly maxBytes: number;
  private readonly maxPreviewChars: number;
  private readonly maxPreviewLines: number;

  constructor(options: MessagingMarkdownFileAttachmentSelectorOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_MARKDOWN_FILE_BYTES;
    this.maxPreviewChars = options.maxPreviewChars ?? DEFAULT_MAX_PREVIEW_CHARS;
    this.maxPreviewLines = options.maxPreviewLines ?? DEFAULT_MAX_PREVIEW_LINES;
  }

  selectFromBackendEvent(
    event: AgentEvent,
  ): MessagingMarkdownFileAttachmentSelection | undefined {
    if (event.notification.method !== "item/completed") {
      return undefined;
    }
    const params = event.notification.params as { item?: unknown };
    return this.selectFromCompletedItem(params.item);
  }

  selectFromCompletedItem(
    item: unknown,
  ): MessagingMarkdownFileAttachmentSelection | undefined {
    const itemRecord = readRecord(item);
    if (!itemRecord) {
      return undefined;
    }
    if (normalizeToken(readString(itemRecord, "type")) !== "filechange") {
      return undefined;
    }
    if (
      readString(itemRecord, "status") === "failed"
      || itemRecord.success === false
    ) {
      return undefined;
    }

    const changes = Array.isArray(itemRecord.changes)
      ? itemRecord.changes
          .map((entry) => readRecord(entry))
          .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      : [];
    if (changes.length !== 1) {
      return undefined;
    }

    const change = changes[0]!;
    const changeKind = readRecord(change.kind);
    if (normalizeFileChangeKind(changeKind ?? change) !== "add") {
      return undefined;
    }

    const markdownPath = readString(change, "path");
    if (!markdownPath || !isMarkdownFilePath(markdownPath)) {
      return undefined;
    }

    const markdown = extractAddedMarkdown(change, changeKind);
    if (markdown === undefined) {
      return undefined;
    }

    const sizeBytes = new TextEncoder().encode(markdown).byteLength;
    if (sizeBytes >= this.maxBytes) {
      return undefined;
    }

    const preview = selectMarkdownPreview(markdown, {
      maxChars: this.maxPreviewChars,
      maxLines: this.maxPreviewLines,
    });
    return {
      attachmentName: markdownAttachmentName(markdownPath),
      markdown,
      path: markdownPath,
      previewMarkdown: preview.text,
      previewTruncated: preview.truncated,
      sizeBytes,
    };
  }
}

export function artifactFromMarkdownFileSelection(
  selection: MessagingMarkdownFileAttachmentSelection,
): MessagingArtifact {
  return {
    attachmentDescription: `Full Markdown file: ${selection.path}`,
    attachmentName: selection.attachmentName,
    kind: "markdown_file",
    markdown: selection.markdown,
    preferAttachment: true,
    preserveMarkdown: true,
    previewMarkdown: selection.previewMarkdown,
    previewTruncated: selection.previewTruncated,
    summary: `Added ${selection.path} (${formatByteSize(selection.sizeBytes)})`,
    title: "Markdown file added",
  };
}

export function selectMarkdownPreview(
  markdown: string,
  params: { maxChars: number; maxLines: number },
): PreviewSelection {
  const maxChars = Math.max(0, Math.trunc(params.maxChars));
  const maxLines = Math.max(0, Math.trunc(params.maxLines));
  if (markdown.length === 0 || maxChars === 0 || maxLines === 0) {
    return {
      text: "",
      truncated: markdown.length > 0,
    };
  }

  let index = 0;
  let lines = 0;
  while (index < markdown.length && index < maxChars && lines < maxLines) {
    const nextNewline = markdown.indexOf("\n", index);
    const lineEnd = nextNewline === -1 ? markdown.length : nextNewline + 1;
    const nextIndex = Math.min(lineEnd, maxChars);
    if (nextIndex <= index) {
      break;
    }
    index = nextIndex;
    if (nextNewline !== -1 && nextNewline + 1 <= nextIndex) {
      lines += 1;
    } else if (nextNewline === -1 || nextIndex < lineEnd) {
      break;
    }
  }

  if (index === 0 && markdown.length > 0) {
    index = Math.min(markdown.length, maxChars);
  }

  return {
    text: markdown.slice(0, index).trimEnd(),
    truncated: index < markdown.length,
  };
}

function extractAddedMarkdown(
  change: Record<string, unknown>,
  changeKind: Record<string, unknown> | undefined,
): string | undefined {
  const content =
    readStringAllowEmpty(changeKind, "content")
    ?? readStringAllowEmpty(change, "content");
  if (content !== undefined) {
    return content;
  }

  const diff =
    readStringAllowEmpty(changeKind, "unified_diff")
    ?? readStringAllowEmpty(changeKind, "unifiedDiff")
    ?? readStringAllowEmpty(change, "diff")
    ?? readStringAllowEmpty(change, "patch")
    ?? readStringAllowEmpty(change, "unifiedDiff")
    ?? readStringAllowEmpty(change, "unified_diff");
  if (diff === undefined) {
    return undefined;
  }
  return looksLikeUnifiedDiff(diff) ? addedContentFromUnifiedDiff(diff) : diff;
}

function addedContentFromUnifiedDiff(diff: string): string {
  const lines: string[] = [];
  for (const line of diff.split("\n")) {
    if (
      line.startsWith("+++")
      || line.startsWith("diff --git ")
      || line.startsWith("index ")
      || line.startsWith("new file mode ")
      || line.startsWith("@@ ")
      || line.startsWith("\\")
    ) {
      continue;
    }
    if (line.startsWith("+")) {
      lines.push(line.slice(1));
    }
  }
  return lines.join("\n");
}

function looksLikeUnifiedDiff(text: string): boolean {
  return /(^|\n)(diff --git |--- |\+\+\+ |@@ )/.test(text);
}

function normalizeFileChangeKind(
  record: Record<string, unknown>,
): "add" | "delete" | "update" {
  const raw = readString(record, "type") ?? readString(record, "kind");
  const normalized = raw?.trim().toLowerCase();
  return normalized === "add"
    || normalized === "delete"
    || normalized === "update"
    ? normalized
    : "update";
}

function isMarkdownFilePath(filePath: string): boolean {
  return filePath.trim().toLowerCase().endsWith(".md");
}

function markdownAttachmentName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const basename = path.posix.basename(normalized) || "artifact.md";
  const safe = basename.replace(/[\x00-\x1f\x7f/\\]/g, "_").trim();
  return safe.toLowerCase().endsWith(".md") ? safe : `${safe || "artifact"}.md`;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringAllowEmpty(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function normalizeToken(value: string | undefined): string {
  return value?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
}

function formatByteSize(bytes: number): string {
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}
