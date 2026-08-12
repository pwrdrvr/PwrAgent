import {
  formatMessagingQuestionnaireText,
  layoutMessagingActionRows,
  messagingQuestionnaireActions,
  splitTextForDelivery,
  type MessagingActionLayoutPolicy,
  type MessagingCapabilityProfile,
  type MessagingContentPart,
  type MessagingSurfaceAction,
  type MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";

/**
 * Slack recommends messages stay under 4,000 characters and truncates
 * above 40,000 characters. We use the hard truncation limit for the
 * capability profile so producers can still fit rich status surfaces.
 * Source: Slack `chat.postMessage` docs, "Truncating content".
 */
export const SLACK_MESSAGE_TEXT_LIMIT = 40_000;

/**
 * Slack text objects in section blocks cap `text` at 3,000 characters.
 * Source: Slack Block Kit `section` block reference.
 */
export const SLACK_SECTION_TEXT_LIMIT = 3_000;

/**
 * Slack standard-Markdown blocks accept up to 12,000 characters cumulatively
 * per message. We emit at most one Markdown block per message, so the block
 * and message limits are the same for this adapter.
 * Source: Slack Block Kit `markdown` block reference.
 */
export const SLACK_MARKDOWN_TEXT_LIMIT = 12_000;

/**
 * Slack messages support up to 50 blocks. Source: Slack Block Kit
 * `blocks` reference.
 */
export const SLACK_MESSAGE_BLOCK_LIMIT = 50;

export type SlackTextObject = {
  type: "mrkdwn" | "plain_text";
  text: string;
  emoji?: boolean;
  verbatim?: boolean;
};

export type SlackSectionBlock = {
  type: "section";
  block_id?: string;
  text: SlackTextObject;
};

export type SlackMarkdownBlock = {
  type: "markdown";
  text: string;
};

export type SlackImageBlock = {
  type: "image";
  image_url: string;
  alt_text: string;
  title?: SlackTextObject & { type: "plain_text" };
};

export type SlackContextBlock = {
  type: "context";
  block_id?: string;
  elements: SlackTextObject[];
};

export type SlackButtonElement = {
  type: "button";
  action_id: string;
  text: SlackTextObject & { type: "plain_text" };
  value: string;
  style?: "primary" | "danger";
};

export type SlackActionsBlock = {
  type: "actions";
  block_id?: string;
  elements: SlackButtonElement[];
};

export type SlackBlock =
  | SlackActionsBlock
  | SlackContextBlock
  | SlackImageBlock
  | SlackMarkdownBlock
  | SlackSectionBlock;

export type SlackPostBody = {
  blocks?: SlackBlock[];
  channel: string;
  reply_broadcast?: boolean;
  text: string;
  thread_ts?: string;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
};

export function actionsForSlackIntent(
  intent: MessagingSurfaceIntent,
): MessagingSurfaceAction[] {
  switch (intent.kind) {
    case "thread_picker":
    case "project_picker":
      return intent.page.actions;
    case "single_select":
    case "multi_select":
      return intent.choices;
    case "questionnaire":
      return messagingQuestionnaireActions(intent);
    case "review":
      return intent.actions;
    case "approval":
      return intent.decisions;
    case "confirmation":
      return intent.actions;
    case "status":
      return intent.actions ?? [];
    default:
      return [];
  }
}

export function buildSlackActionBlocks(params: {
  actions: MessagingSurfaceAction[];
  buildCallbackValue: (action: MessagingSurfaceAction) => string;
  capabilityProfile: MessagingCapabilityProfile;
  layout?: MessagingActionLayoutPolicy;
}): SlackActionsBlock[] | undefined {
  const profile = params.capabilityProfile;
  const maxActions = profile.actions?.maxActions ?? 25;
  const maxColumns = profile.actions?.maxActionsPerRow ?? 5;
  const maxRows = profile.actions?.maxRows;
  const maxLabelLength = profile.actions?.maxLabelLength ?? 75;
  const items = params.actions
    .filter((action) => !action.disabled)
    .slice(0, maxActions)
    .map((action, index) => ({
      action,
      component: {
        type: "button" as const,
        action_id: `${sanitizeSlackActionId(action.id)}_${index}`,
        text: {
          type: "plain_text" as const,
          text: truncateSlackPlainText(action.label, maxLabelLength),
          emoji: true,
        },
        value: params.buildCallbackValue(action),
        ...(styleForSlackAction(action)
          ? { style: styleForSlackAction(action) }
          : {}),
      } satisfies SlackButtonElement,
    }));

  if (items.length === 0) {
    return undefined;
  }

  const rows = layoutMessagingActionRows(items, {
    defaultColumns: params.layout?.columns,
    maxColumns,
    ...(maxRows !== undefined ? { maxRows } : {}),
  });

  return rows.map((row, index) => ({
    type: "actions" as const,
    block_id: `actions_${index}`,
    elements: row,
  }));
}

export function buildSlackBlocksForIntent(params: {
  actionBlocks?: SlackActionsBlock[];
  intent: MessagingSurfaceIntent;
  text: string;
}): SlackBlock[] {
  const standardMarkdown = usesSlackStandardMarkdown(params.intent);
  const body = standardMarkdown
    ? clampSlackMarkdownText(params.text)
    : clampSlackSectionText(markdownToSlackMrkdwn(params.text));
  const blocks: SlackBlock[] = body
    ? [
        standardMarkdown
          ? {
              type: "markdown",
              text: body,
            }
          : {
              type: "section",
              text: {
                type: "mrkdwn",
                text: body,
              },
            },
      ]
    : [];

  if (params.intent.kind === "progress" && params.intent.value !== undefined) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Progress: ${params.intent.value}/${params.intent.max ?? 100}`,
        },
      ],
    });
  }

  if (params.intent.kind === "message" && params.intent.attribution) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "plain_text",
          text: truncateSlackPlainText(
            [params.intent.attribution.label, params.intent.attribution.hint]
              .filter((value): value is string => Boolean(value))
              .join(" · "),
            2_000,
          ),
          emoji: true,
        },
      ],
    });
  }

  if (params.intent.kind === "message") {
    for (const [index, part] of params.intent.parts.entries()) {
      if (part.type !== "image" || !/^https:\/\//iu.test(part.url)) {
        continue;
      }
      const alt = part.alt?.trim() || `Assistant image ${index + 1}`;
      blocks.push({
        type: "image",
        image_url: part.url,
        alt_text: truncateSlackPlainText(alt, 2_000),
        title: {
          type: "plain_text",
          text: truncateSlackPlainText(alt, 2_000),
        },
      });
    }
  }

  if (params.actionBlocks) {
    blocks.push(...params.actionBlocks);
  }

  return blocks.slice(0, SLACK_MESSAGE_BLOCK_LIMIT);
}

export function textForSlackIntent(intent: MessagingSurfaceIntent): string {
  switch (intent.kind) {
    case "message":
      return renderContentParts(intent.parts);
    case "stream_update":
      return intent.text;
    case "working_card":
      return intent.fallbackText ?? "Working update";
    case "status":
      return intent.text;
    case "progress":
      return [intent.label, intent.detail]
        .filter((value): value is string => Boolean(value))
        .join("\n");
    case "thread_picker":
    case "project_picker":
      return intent.prompt;
    case "single_select":
    case "multi_select":
      return intent.prompt;
    case "questionnaire":
      return formatMessagingQuestionnaireText(intent);
    case "review":
      return [intent.title, intent.body].filter(Boolean).join("\n\n");
    case "approval":
      return [intent.title, intent.body].filter(Boolean).join("\n\n");
    case "confirmation":
      return [intent.title, intent.body].filter(Boolean).join("\n\n");
    case "error":
      return [intent.title, intent.body].filter(Boolean).join("\n\n");
    case "activity":
      return intent.state === "active" ? "Working..." : "";
    case "dismiss":
      return "";
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}

export function clampSlackMessage(text: string): string {
  if (text.length <= SLACK_MESSAGE_TEXT_LIMIT) {
    return text;
  }
  return text.slice(0, SLACK_MESSAGE_TEXT_LIMIT);
}

export function clampSlackSectionText(text: string): string {
  if (text.length <= SLACK_SECTION_TEXT_LIMIT) {
    return text;
  }
  return `${text.slice(0, SLACK_SECTION_TEXT_LIMIT - 1)}…`;
}

export function clampSlackMarkdownText(text: string): string {
  if (text.length <= SLACK_MARKDOWN_TEXT_LIMIT) {
    return text;
  }
  return `${text.slice(0, SLACK_MARKDOWN_TEXT_LIMIT - 1)}…`;
}

/**
 * Assistant content explicitly marked as canonical Markdown can be handed to
 * Slack's standard-Markdown block. Slack translates that block into native
 * rich-text/table blocks, preserving GFM tables that legacy `mrkdwn` leaves as
 * literal pipes. Other surface intents keep their existing `mrkdwn` rendering
 * because buttons, pickers, and compact status cards already rely on it.
 */
export function usesSlackStandardMarkdown(intent: MessagingSurfaceIntent): boolean {
  if (intent.kind === "stream_update") {
    return intent.markdown === "markdown";
  }
  if (intent.kind === "message") {
    return intent.parts.some(
      (part) => part.type === "text" && part.markdown === "markdown",
    );
  }
  return false;
}

export function splitSlackTextForDelivery(
  intent: MessagingSurfaceIntent,
  text: string,
): string[] {
  if (usesSlackStandardMarkdown(intent)) {
    return splitSlackStandardMarkdown(text, SLACK_MARKDOWN_TEXT_LIMIT);
  }
  return splitTextForDelivery(text, {
    limit: SLACK_SECTION_TEXT_LIMIT,
    measureText: (value) => markdownToSlackMrkdwn(value).length,
  });
}

type SlackMarkdownSegment = {
  text: string;
  type: "fence" | "table" | "text";
};

/**
 * Split a standard-Markdown document without stranding table rows or fenced
 * code in independent Slack messages. Ordinary prose still uses the shared
 * boundary-aware splitter. Oversized tables repeat their header and delimiter;
 * oversized fences close and reopen around every chunk.
 */
export function splitSlackStandardMarkdown(
  markdown: string,
  limit = SLACK_MARKDOWN_TEXT_LIMIT,
): string[] {
  const safeLimit = Math.max(1, Math.floor(limit));
  if (!markdown) {
    return [];
  }
  if (markdown.length <= safeLimit) {
    return [markdown];
  }

  const referenceDefinitions = extractSlackMarkdownReferenceDefinitions(markdown);
  const pieces = splitSlackMarkdownSegments(markdown).flatMap((segment) =>
    splitOversizedSlackMarkdownSegment(segment, safeLimit, referenceDefinitions)
  );
  const chunks: string[] = [];
  let pending = "";
  for (const piece of pieces) {
    const combined = pending ? `${pending}\n\n${piece}` : piece;
    if (combined.length <= safeLimit) {
      pending = combined;
      continue;
    }
    if (pending) {
      chunks.push(pending);
    }
    pending = piece;
  }
  if (pending) {
    chunks.push(pending);
  }
  return chunks;
}

function splitSlackMarkdownSegments(markdown: string): SlackMarkdownSegment[] {
  const lines = markdown.split("\n");
  const segments: SlackMarkdownSegment[] = [];
  let textBuffer: string[] = [];
  let index = 0;

  const flushText = (): void => {
    const text = trimBlankMarkdownLines(textBuffer).join("\n");
    textBuffer = [];
    if (text) {
      segments.push({ text, type: "text" });
    }
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const fence = parseSlackMarkdownFence(line);
    if (fence) {
      flushText();
      const fenceLines = [line];
      index += 1;
      while (index < lines.length) {
        const nextLine = lines[index] ?? "";
        fenceLines.push(nextLine);
        index += 1;
        if (isClosingSlackMarkdownFence(nextLine, fence)) {
          break;
        }
      }
      segments.push({ text: fenceLines.join("\n"), type: "fence" });
      continue;
    }

    if (
      isSlackMarkdownTableHeader(line)
      && isSlackMarkdownTableDelimiter(lines[index + 1] ?? "")
    ) {
      flushText();
      const tableLines = [line, lines[index + 1] ?? ""];
      index += 2;
      while (index < lines.length && isSlackMarkdownTableRow(lines[index] ?? "")) {
        tableLines.push(lines[index] ?? "");
        index += 1;
      }
      segments.push({ text: tableLines.join("\n"), type: "table" });
      continue;
    }

    textBuffer.push(line);
    index += 1;
  }

  flushText();
  return segments;
}

function splitOversizedSlackMarkdownSegment(
  segment: SlackMarkdownSegment,
  limit: number,
  referenceDefinitions: string[],
): string[] {
  if (segment.type === "table") {
    const definitions = referencedSlackMarkdownDefinitions(
      segment.text,
      referenceDefinitions,
    );
    const withDefinitions = appendSlackMarkdownReferenceDefinitions(
      segment.text,
      definitions,
    );
    if (withDefinitions.length <= limit) {
      return [withDefinitions];
    }
    return splitOversizedSlackMarkdownTable(segment.text, limit, definitions);
  }
  if (segment.text.length <= limit) {
    return [segment.text];
  }
  if (segment.type === "fence") {
    return splitOversizedSlackMarkdownFence(segment.text, limit);
  }
  return splitTextForDelivery(segment.text, { limit, measure: "chars" });
}

function splitOversizedSlackMarkdownTable(
  table: string,
  limit: number,
  referenceDefinitions: string[],
): string[] {
  const [header = "", delimiter = "", ...rows] = table.split("\n");
  const prefix = `${header}\n${delimiter}`;
  const suffix = referenceDefinitions.length > 0
    ? `\n\n${referenceDefinitions.join("\n")}`
    : "";
  const tableLimit = limit - suffix.length;
  if (!header || !delimiter || prefix.length >= tableLimit) {
    return splitTextForDelivery(table, { limit, measure: "chars" });
  }

  const chunks: string[] = [];
  let current = prefix;
  for (const row of rows) {
    const candidate = `${current}\n${row}`;
    if (candidate.length <= tableLimit) {
      current = candidate;
      continue;
    }
    if (current !== prefix) {
      chunks.push(`${current}${suffix}`);
      current = prefix;
    }
    if (`${prefix}\n${row}`.length <= tableLimit) {
      current = `${prefix}\n${row}`;
      continue;
    }
    chunks.push(
      ...splitOversizedSlackMarkdownTableRow(
        row,
        prefix,
        suffix,
        tableLimit,
      ),
    );
  }
  if (current !== prefix) {
    chunks.push(`${current}${suffix}`);
  }
  return chunks;
}

function splitOversizedSlackMarkdownTableRow(
  row: string,
  prefix: string,
  suffix: string,
  tableLimit: number,
): string[] {
  const cells = splitSlackMarkdownTableCells(row);
  const emptyRow = renderSlackMarkdownTableRow(cells.map(() => ""));
  const contentBudget = tableLimit - prefix.length - emptyRow.length - 1;
  if (cells.length === 0 || contentBudget < cells.length) {
    return splitTextForDelivery(row, {
      limit: Math.max(1, tableLimit),
      measure: "chars",
    });
  }

  const cellLimit = Math.max(1, Math.floor(contentBudget / cells.length));
  const cellChunks = cells.map((cell) => {
    const chunks = splitTextForDelivery(cell, {
      limit: cellLimit,
      measure: "chars",
    });
    return chunks.length > 0 ? chunks : [""];
  });
  const rowCount = Math.max(...cellChunks.map((chunks) => chunks.length));
  return Array.from({ length: rowCount }, (_, index) => {
    const continuation = renderSlackMarkdownTableRow(
      cellChunks.map((chunks) => chunks[index] ?? ""),
    );
    return `${prefix}\n${continuation}${suffix}`;
  });
}

function splitOversizedSlackMarkdownFence(fence: string, limit: number): string[] {
  const lines = fence.split("\n");
  const opening = lines[0] ?? "```";
  const parsed = parseSlackMarkdownFence(opening);
  if (!parsed) {
    return splitTextForDelivery(fence, { limit, measure: "chars" });
  }
  const hasClosing = isClosingSlackMarkdownFence(lines.at(-1) ?? "", parsed);
  const closing = parsed.marker;
  const content = lines.slice(1, hasClosing ? -1 : undefined).join("\n");
  const contentLimit = limit - opening.length - closing.length - 2;
  if (contentLimit < 1) {
    return splitTextForDelivery(fence, { limit, measure: "chars" });
  }
  return splitTextForDelivery(content, {
    limit: contentLimit,
    measure: "chars",
  }).map((chunk) => `${opening}\n${chunk}\n${closing}`);
}

function parseSlackMarkdownFence(
  line: string,
): { character: "`" | "~"; length: number; marker: string } | undefined {
  const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
  const marker = match?.[1];
  if (!marker) {
    return undefined;
  }
  const character = marker[0];
  if (character !== "`" && character !== "~") {
    return undefined;
  }
  return { character, length: marker.length, marker };
}

function isClosingSlackMarkdownFence(
  line: string,
  fence: { character: "`" | "~"; length: number },
): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length >= fence.length
    && [...trimmed].every((character) => character === fence.character)
  );
}

function isSlackMarkdownTableHeader(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && splitSlackMarkdownTableCells(trimmed).length >= 2;
}

function isSlackMarkdownTableDelimiter(line: string): boolean {
  const cells = splitSlackMarkdownTableCells(line.trim());
  return (
    cells.length >= 2
    && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
  );
}

function isSlackMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed !== ""
    && trimmed.includes("|")
    && splitSlackMarkdownTableCells(trimmed).length >= 2
  );
}

function splitSlackMarkdownTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index] ?? "";
    if (character === "\\" && index + 1 < trimmed.length) {
      cell += `${character}${trimmed[index + 1] ?? ""}`;
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

function renderSlackMarkdownTableRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
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

function extractSlackMarkdownReferenceDefinitions(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => /^\s{0,3}\[[^\]]+\]:\s+\S/.test(line));
}

function referencedSlackMarkdownDefinitions(
  table: string,
  definitions: string[],
): string[] {
  const normalizedTable = table.toLocaleLowerCase();
  return definitions.filter((definition) => {
    const label = definition.match(/^\s{0,3}\[([^\]]+)\]:/)?.[1];
    return label
      ? normalizedTable.includes(`[${label.toLocaleLowerCase()}]`)
      : false;
  });
}

function appendSlackMarkdownReferenceDefinitions(
  table: string,
  definitions: string[],
): string {
  return definitions.length > 0
    ? `${table}\n\n${definitions.join("\n")}`
    : table;
}

/**
 * Small canonical-markdown to Slack mrkdwn adapter. This intentionally
 * handles the common producer output only; deeper Markdown rendering
 * belongs in a future shared renderer if more providers need dialect
 * transforms.
 */
export function markdownToSlackMrkdwn(markdown: string): string {
  return escapeSlackMrkdwnPreservingLinks(markdown)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*");
}

export function sanitizeSlackActionId(rawId: string): string {
  const sanitized = rawId.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_");
  const trimmed = sanitized.replace(/^_+|_+$/g, "");
  return (trimmed || `act_${rawId.length}`).slice(0, 240);
}

export function styleForSlackAction(
  action: MessagingSurfaceAction,
): "primary" | "danger" | undefined {
  switch (action.style) {
    case "primary":
      return "primary";
    case "danger":
      return "danger";
    case "secondary":
    case "navigation":
    case undefined:
      return undefined;
    default:
      return undefined;
  }
}

function renderContentParts(parts: MessagingContentPart[]): string {
  return parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "file") return part.description ?? part.name;
      if (part.type === "image") return part.alt ?? "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function truncateSlackPlainText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  if (limit <= 1) {
    return text.slice(0, limit);
  }
  return `${text.slice(0, limit - 1)}…`;
}

function escapeSlackMrkdwnPreservingLinks(text: string): string {
  let output = "";
  let cursor = 0;
  const linkPattern = /\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/g;
  for (const match of text.matchAll(linkPattern)) {
    const index = match.index ?? 0;
    output += escapeSlackSpecials(text.slice(cursor, index));
    output += match[0];
    cursor = index + match[0].length;
  }
  output += escapeSlackSpecials(text.slice(cursor));
  return output;
}

function escapeSlackSpecials(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
