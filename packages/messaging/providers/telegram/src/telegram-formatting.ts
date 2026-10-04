import type {
  MessagingActionLayoutPolicy,
  MessagingCapabilityProfile,
  MessagingContentPart,
  MessagingMarkdownPolicy,
  MessagingResponseAttribution,
  MessagingSurfaceAction,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import {
  formatMessagingQuestionnaireText,
  layoutMessagingActionRows,
  messagingQuestionnaireActions,
} from "@pwragent/messaging-interface";
import type { MarkedToken, Token, Tokens } from "marked";
import { lexTelegramMarkdown, type TelegramMarkdownToken } from "./telegram-markdown.ts";

export const TELEGRAM_CALLBACK_DATA_LIMIT_BYTES = 64;
export const TELEGRAM_MESSAGE_TEXT_LIMIT = 4096;
export const TELEGRAM_RICH_MESSAGE_TEXT_LIMIT = 32768;

export type TelegramRichMessageMedia = {
  id: string;
  media: { type: "photo" | "document"; media: string | Uint8Array; filename?: string };
};

export type TelegramRichMessageMediaPart = TelegramRichMessageMedia & { partIndex: number };
export type TelegramInputRichMessage = { html: string; media?: TelegramRichMessageMedia[] };
type TelegramMediaToken = { type: "telegram_media"; raw: string; id: string; mediaType: "photo" | "document"; caption: string };
type TelegramRenderToken = MarkedToken | TelegramMarkdownToken | TelegramMediaToken;

export type TelegramInlineKeyboardButton = {
  text: string;
  callback_data: string;
};

export type TelegramInlineKeyboardMarkup = {
  inline_keyboard: TelegramInlineKeyboardButton[][];
};

export function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderTelegramHtml(
  text: string,
  policy: MessagingMarkdownPolicy = "plain",
): string {
  if (policy === "plain") {
    return escapeTelegramHtml(text);
  }

  return renderBlocks(lexTelegramMarkdown(text), "regular");
}

export function splitTelegramHtml(text: string): string[] {
  if (Buffer.byteLength(text, "utf8") <= TELEGRAM_MESSAGE_TEXT_LIMIT) {
    return hasVisibleTelegramHtml(text) ? [text] : [];
  }

  const chunks: string[] = [];
  const stack: Array<{ open: string; close: string }> = [];
  let current = "";
  let bytes = 0;
  let closingBytes = 0;
  // Generated tags and entities are atomic; close and reopen formatting at
  // each boundary so a long code block, link or quote remains valid HTML.
  for (const [segment] of text.matchAll(/<\/?[a-z][^>]*>|&(?:amp|lt|gt|quot|#\d+|#x[a-f\d]+);|[\s\S]/giu)) {
    const tag = /^<(\/)?([a-z]+)/i.exec(segment);
    const close = tag && !tag[1] ? `</${tag[2]}>` : undefined;
    const nextClosingBytes = closingBytes
      + (close ? Buffer.byteLength(close, "utf8") : 0)
      - (tag?.[1] ? Buffer.byteLength(stack.at(-1)?.close ?? "", "utf8") : 0);
    const segmentBytes = Buffer.byteLength(segment, "utf8");
    if (bytes + segmentBytes + nextClosingBytes > TELEGRAM_MESSAGE_TEXT_LIMIT) {
      chunks.push(current + stack.toReversed().map((entry) => entry.close).join(""));
      current = stack.map((entry) => entry.open).join("");
      bytes = Buffer.byteLength(current, "utf8");
    }
    current += segment;
    bytes += segmentBytes;
    if (close) {
      stack.push({ open: segment, close });
    } else if (tag?.[1]) {
      stack.pop();
    }
    closingBytes = nextClosingBytes;
  }
  if (current) chunks.push(current);
  return chunks.filter(hasVisibleTelegramHtml);
}

function hasVisibleTelegramHtml(text: string): boolean {
  return text.replace(/<[^>]*>/g, "").replace(/&#(x[\da-f]+|\d+);/gi, (_match, value: string) => {
    const point = value[0]?.toLowerCase() === "x"
      ? Number.parseInt(value.slice(1), 16)
      : Number.parseInt(value, 10);
    return point <= 0x10ffff ? String.fromCodePoint(point) : "\ufffd";
  }).trim().length > 0;
}

/** Structured content uses the rich endpoint; regular HTML remains the API fallback. */
export function richMessageForTelegramText(
  text: string,
  policy: MessagingMarkdownPolicy = "plain",
  attribution?: MessagingResponseAttribution,
): TelegramInputRichMessage | undefined {
  if (policy === "plain" || Buffer.byteLength(text, "utf8") > TELEGRAM_RICH_MESSAGE_TEXT_LIMIT) {
    return undefined;
  }
  return richMessageFromTokens(lexTelegramMarkdown(text), attribution);
}

function richMessageFromTokens(
  tokens: Token[],
  attribution?: MessagingResponseAttribution,
  media?: TelegramRichMessageMedia[],
): TelegramInputRichMessage | undefined {
  const stats = { blocks: 0, structured: false, valid: true };
  inspectRichTokens(tokens, stats);
  const attributionHtml = telegramAttributionHtml(attribution);
  if (attributionHtml) stats.blocks += 1;
  if (!stats.valid || stats.blocks > 500 || (media?.length ?? 0) > 50) return undefined;
  const body = renderBlocks(tokens, "rich");
  if (!stats.structured && Buffer.byteLength(renderBlocks(tokens, "regular").trim(), "utf8") <= TELEGRAM_MESSAGE_TEXT_LIMIT) return undefined;
  const html = [body, attributionHtml ? `<footer>${attributionHtml}</footer>` : ""]
    .filter(Boolean).join("\n");
  // Counting source bytes (including tags) is deliberately conservative.
  return Buffer.byteLength(html, "utf8") <= TELEGRAM_RICH_MESSAGE_TEXT_LIMIT
    ? { html, ...(media?.length ? { media } : {}) }
    : undefined;
}

export function richMessageForTelegramIntent(
  intent: MessagingSurfaceIntent,
  mediaParts: TelegramRichMessageMediaPart[] = [],
): TelegramInputRichMessage | undefined {
  if (intent.kind !== "message"
    || intent.parts.some((part, index) => part.type !== "text" && !mediaParts.some((media) => media.partIndex === index))
    || (mediaParts.length > 0 && !intent.parts.some((part) => part.type === "text" && part.text.trim()))) {
    return undefined;
  }
  // Do not reinterpret plain parts as Markdown when combining content.
  const tokens = intent.parts.flatMap((part, index): Token[] => {
    if (part.type !== "text") {
      const media = mediaParts.find((entry) => entry.partIndex === index)!;
      const caption = part.type === "image" ? part.alt ?? ""
        : [part.name, part.description].filter(Boolean).join(" — ");
      return [{ type: "telegram_media", raw: "", id: media.id, mediaType: media.media.type, caption }];
    }
    return part.markdown && part.markdown !== "plain"
      ? lexTelegramMarkdown(part.text, `part-${index}-fn`)
      : [{
          type: "paragraph",
          raw: part.text,
          text: part.text,
          tokens: [{ type: "text", raw: part.text, text: part.text }],
        }];
  });
  return richMessageFromTokens(tokens, intent.attribution, mediaParts.map(({ id, media }) => ({ id, media })));
}

function telegramAttributionHtml(attribution: MessagingResponseAttribution | undefined): string {
  const label = [attribution?.label, attribution?.hint]
    .map((value) => value?.replace(/\s+/g, " ").trim())
    .filter(Boolean).join(" · ");
  return label ? `<i>${escapeTelegramHtml(label)}</i>` : "";
}

function withTelegramAttribution(text: string, attribution: MessagingResponseAttribution | undefined): string {
  const attributionHtml = telegramAttributionHtml(attribution);
  return attributionHtml && hasVisibleTelegramHtml(text)
    ? `${text}\n\n${attributionHtml}`
    : text;
}

export function textForTelegramIntent(intent: MessagingSurfaceIntent): string {
  switch (intent.kind) {
    case "activity":
      return "";
    case "message":
      return withTelegramAttribution(
        intent.parts.map(renderContentPart).filter(Boolean).join("\n\n"),
        intent.attribution,
      );
    case "stream_update":
      return withTelegramAttribution(
        renderTelegramHtml(intent.text, intent.markdown ?? "plain"),
        intent.attribution,
      );
    case "working_card":
      return renderTelegramHtml(intent.fallbackText ?? "Working update", "plain");
    case "status":
      return renderTelegramHtml(intent.text, "plain");
    case "progress":
      return renderTelegramHtml(
        [intent.label, intent.detail].filter(Boolean).join("\n"),
        "plain",
      );
    case "thread_picker":
      return renderTelegramHtml(intent.prompt, "plain");
    case "project_picker":
      return renderTelegramHtml(intent.prompt, "plain");
    case "single_select":
      return renderTelegramHtml(intent.prompt, "plain");
    case "multi_select":
      return renderTelegramHtml(intent.prompt, "plain");
    case "questionnaire":
      return renderTelegramHtml(formatMessagingQuestionnaireText(intent), "plain");
    case "review":
      return renderTelegramHtml([intent.title, intent.body].join("\n\n"), "plain");
    case "approval":
      return renderTelegramHtml([intent.title, intent.body].join("\n\n"), "markdown");
    case "confirmation":
      return renderTelegramHtml([intent.title, intent.body].join("\n\n"), "plain");
    case "error":
      return renderTelegramHtml([intent.title, intent.body].join("\n\n"), "plain");
    case "dismiss":
      return "";
  }
}

export function actionsForTelegramIntent(
  intent: MessagingSurfaceIntent,
): MessagingSurfaceAction[] {
  switch (intent.kind) {
    case "thread_picker":
    case "project_picker":
      return intent.page.actions;
    case "single_select":
      return intent.choices;
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

export function buildTelegramKeyboard(
  actions: MessagingSurfaceAction[],
  createCallbackData: (action: MessagingSurfaceAction) => string,
  layout?: MessagingActionLayoutPolicy,
  profile?: MessagingCapabilityProfile,
): TelegramInlineKeyboardMarkup | undefined {
  // Defensive caps. Producers should already have applied these via
  // applyActionCapabilityLimits; the adapter enforces Telegram's hard
  // limits as a safety net. Read from profile so the numbers stay in sync.
  const maxActions = profile?.actions?.maxActions ?? 100;
  const maxLabelLength = profile?.actions?.maxLabelLength ?? 64;
  const maxColumns = profile?.actions?.maxActionsPerRow ?? 8;
  const items = actions
    .filter((action) => !action.disabled)
    .slice(0, maxActions)
    .map((action) => {
      const callbackData = createCallbackData(action);
      assertOpaqueTelegramCallbackHandle(callbackData);
      return {
        action,
        component: {
          text: action.label.length > maxLabelLength
            ? action.label.slice(0, maxLabelLength)
            : action.label,
          callback_data: callbackData,
        },
      };
    });

  if (items.length === 0) {
    return undefined;
  }

  return {
    inline_keyboard: layoutMessagingActionRows(items, {
      defaultColumns: layout?.columns ?? 1,
      maxColumns,
    }),
  };
}

function assertOpaqueTelegramCallbackHandle(callbackData: string): void {
  if (!/^tg:[A-Za-z0-9_-]{18}$/.test(callbackData)) {
    throw new Error("Telegram callback_data must be an opaque persisted handle.");
  }
}

function renderContentPart(part: MessagingContentPart): string {
  if (part.type === "text") {
    return renderTelegramHtml(part.text, part.markdown);
  }

  if (part.type === "image") {
    return part.alt ? renderTelegramHtml(part.alt, "plain") : "";
  }

  return renderTelegramHtml(
    [part.name, part.description, part.url].filter(Boolean).join("\n"),
    "plain",
  );
}

type TelegramHtmlMode = "regular" | "rich";

function renderBlocks(tokens: Token[], mode: TelegramHtmlMode, inQuote = false): string {
  return tokens.map((item) => {
    const token = item as TelegramRenderToken;
    switch (token.type) {
      case "telegram_details": {
        const summary = renderInline(token.summary, mode);
        const body = renderBlocks(token.tokens, mode, inQuote);
        return mode === "rich" ? `<details${token.open ? " open" : ""}><summary>${summary}</summary>${body}</details>`
          : `${wrapInline("<b>", "</b>", summary, mode)}\n\n${body}`;
      }
      case "telegram_math_block":
        return mode === "rich" ? `<tg-math-block>${escapeTelegramHtml(token.text)}</tg-math-block>`
          : `<pre><code>${escapeTelegramHtml(token.text)}</code></pre>`;
      case "telegram_footnote_definition":
        return token.number === undefined ? escapeTelegramHtml(token.raw.trim()) : "";
      case "telegram_footnote": {
        const text = renderInline(token.tokens, mode);
        return mode === "rich" ? `<p><tg-reference name="${token.anchor}">[${token.number}] ${text}</tg-reference></p>`
          : `[${token.number}] ${text}`;
      }
      case "telegram_media": {
        const media = token.mediaType === "photo" ? `<img src="tg://photo?id=${token.id}"/>`
          : `<tg-document src="tg://document?id=${token.id}"></tg-document>`;
        return `<figure>${media}${token.caption ? `<figcaption>${escapeTelegramHtml(token.caption)}</figcaption>` : ""}</figure>`;
      }
      case "space":
      case "def":
        return "";
      case "paragraph":
      case "text": {
        const text = token.tokens ? renderInline(token.tokens, mode) : escapeTelegramHtml(token.text);
        return mode === "rich" && token.type === "paragraph" ? `<p>${text}</p>` : text;
      }
      case "heading": {
        const text = renderInline(token.tokens, mode);
        return mode === "rich" ? `<h${token.depth}>${text}</h${token.depth}>`
          : wrapInline("<b>", "</b>", text, mode);
      }
      case "code": {
        const language = token.lang?.split(/\s/)[0];
        if (mode === "rich" && language === "math") return `<tg-math-block>${escapeTelegramHtml(token.text)}</tg-math-block>`;
        const attribute = language && /^[a-zA-Z0-9_+.-]{1,64}$/.test(language)
          ? ` class="language-${language}"`
          : "";
        return `<pre><code${attribute}>${escapeTelegramHtml(token.text)}</code></pre>`;
      }
      case "blockquote": {
        let text = renderBlocks(token.tokens, mode, true);
        // Regular quotes cannot contain other quotes, code or link entities.
        // Retain their text and the quote rather than emitting invalid nesting.
        if (mode === "regular") {
          text = text.replace(/<\/?(?:pre|code|a)(?:\s[^>]*)?>/g, "");
          if (inQuote) return text;
        }
        return `<blockquote>${text}</blockquote>`;
      }
      case "list":
        return renderList(token, mode, inQuote);
      case "table":
        return renderTable(token, mode);
      case "hr":
        return mode === "rich" ? "<hr/>" : "—";
      default:
        // Source HTML is data, never an instruction to create Telegram tags.
        return escapeTelegramHtml(token.raw);
    }
  }).filter(Boolean).join(mode === "rich" ? "\n" : "\n\n");
}

function renderInline(tokens: Token[], mode: TelegramHtmlMode): string {
  return tokens.map((item) => {
    const token = item as TelegramRenderToken;
    switch (token.type) {
      case "telegram_math":
        return mode === "rich" ? `<tg-math>${escapeTelegramHtml(token.text)}</tg-math>`
          : `<code>${escapeTelegramHtml(token.text)}</code>`;
      case "telegram_footnote_reference":
        return token.number === undefined ? escapeTelegramHtml(token.raw)
          : mode === "rich" ? `<a href="#${token.anchor}">[${token.number}]</a>` : `[${token.number}]`;
      case "strong":
      case "em":
      case "del": {
        const tag = token.type === "strong" ? "b" : token.type === "em" ? "i" : "s";
        return wrapInline(`<${tag}>`, `</${tag}>`, renderInline(token.tokens, mode), mode);
      }
      case "codespan":
        return `<code>${escapeTelegramHtml(token.text)}</code>`;
      case "link": {
        const label = renderInline(token.tokens, mode);
        // GFM also creates link tokens for bare URLs, email addresses and
        // www-prefixed filenames. Only source link syntax creates anchors.
        if (!token.raw.startsWith("[") && !token.raw.startsWith("<")) return label;
        // Local paths and unsafe protocols remain readable text. Cap attribute
        // size so reopening a link cannot exhaust a regular message's budget.
        const href = escapeTelegramHtml(token.href).replace(/"/g, "&quot;");
        if (!/^(https?:\/\/|tg:\/\/|mailto:|tel:)/i.test(token.href)
          || Buffer.byteLength(href, "utf8") > 1024) return label;
        return wrapInline(`<a href="${href}">`, "</a>", label, mode);
      }
      case "image":
        return escapeTelegramHtml(token.text);
      case "br":
        return mode === "rich" ? "<br>" : "\n";
      case "text":
        return token.tokens ? renderInline(token.tokens, mode) : escapeTelegramHtml(token.text);
      case "escape":
      case "html":
        return escapeTelegramHtml(token.text);
      default:
        return escapeTelegramHtml(token.raw);
    }
  }).join("");
}

function wrapInline(open: string, close: string, text: string, mode: TelegramHtmlMode): string {
  if (mode === "rich") return `${open}${text}${close}`;
  // Regular code entities cannot overlap bold, italic or link entities.
  return text.split(/(<code>[\s\S]*?<\/code>)/g).map((part) =>
    part.startsWith("<code>") ? part : part ? `${open}${part}${close}` : "",
  ).join("");
}

function renderList(list: Tokens.List, mode: TelegramHtmlMode, inQuote: boolean): string {
  const items = list.items.map((item, index) => {
    const text = renderBlocks(item.tokens, mode, inQuote);
    if (mode === "rich") {
      const checkbox = item.task ? `<input type="checkbox"${item.checked ? " checked" : ""}>` : "";
      return `<li>${checkbox}${text}</li>`;
    }
    const marker = item.task ? (item.checked ? "☑" : "☐")
      : list.ordered ? `${Number(list.start) + index}.` : "•";
    // Layout indentation belongs to the list, not to the copyable code.
    const indented = text.split(/(<pre>[\s\S]*?<\/pre>)/g).map((part, index) =>
      index % 2 === 1 ? part : part.replace(/\n/g, "\n  "),
    ).join("");
    return `${marker} ${indented}`;
  });
  if (mode === "regular") return items.join("\n");
  const tag = list.ordered ? "ol" : "ul";
  const start = list.ordered && list.start !== 1 ? ` start="${list.start}"` : "";
  return `<${tag}${start}>${items.join("")}</${tag}>`;
}

function renderTable(table: Tokens.Table, mode: TelegramHtmlMode): string {
  if (mode === "rich") {
    const row = (cells: Tokens.TableCell[], tag: "th" | "td") => `<tr>${cells.map((cell, index) => {
      const align = table.align[index] ? ` align="${table.align[index]}"` : "";
      return `<${tag}${align}>${renderInline(cell.tokens, mode)}</${tag}>`;
    }).join("")}</tr>`;
    return `<table bordered striped compact>${row(table.header, "th")}${table.rows.map((cells) => row(cells, "td")).join("")}</table>`;
  }
  const headers = table.header.map((cell, index) =>
    renderInline(cell.tokens, mode) || `Column ${index + 1}`,
  );
  if (table.rows.length === 0) return headers.join(" · ");
  // One record per item, with labelled fields instead of a horizontal grid.
  return table.rows.map((cells) => {
    const title = renderInline(cells[0]?.tokens ?? [], mode);
    const fields = cells.slice(1).map((cell, index) =>
      `  ${headers[index + 1]}: ${renderInline(cell.tokens, mode)}`,
    );
    return [`• ${title || "—"}`, ...fields].join("\n");
  }).join("\n\n");
}

function inspectRichTokens(
  tokens: Token[],
  stats: { blocks: number; structured: boolean; valid: boolean },
  depth = 0,
  inline = false,
): void {
  if (depth >= 16) {
    stats.valid = false;
    return;
  }
  for (const item of tokens) {
    const token = item as TelegramRenderToken;
    switch (token.type) {
      case "telegram_details":
        stats.structured = true;
        stats.blocks += 1;
        inspectRichTokens(token.summary, stats, depth + 1, true);
        break;
      case "telegram_math":
        stats.structured = true;
        break;
      case "telegram_math_block":
      case "telegram_footnote":
      case "telegram_media":
        stats.structured = true;
        stats.blocks += token.type === "telegram_media" ? 2 : 1;
        break;
      case "telegram_footnote_definition":
        if (token.number === undefined) stats.blocks += 1;
        break;
      case "heading":
        stats.structured = true;
        stats.blocks += 1;
        break;
      case "table":
        stats.structured = true;
        stats.valid &&= token.header.length <= 20;
        stats.blocks += 2 + token.rows.length;
        for (const cells of [token.header, ...token.rows]) {
          for (const cell of cells) inspectRichTokens(cell.tokens, stats, depth + 2, true);
        }
        break;
      case "list":
        stats.structured = true;
        stats.blocks += 1 + token.items.length;
        for (const entry of token.items) inspectRichTokens(entry.tokens, stats, depth + 2);
        break;
      case "paragraph":
      case "blockquote":
      case "code":
      case "hr":
      case "text":
      case "html":
        stats.structured ||= token.type === "blockquote" || token.type === "code";
        if (!inline) stats.blocks += 1;
        break;
    }
    if ("tokens" in token && token.tokens) {
      inspectRichTokens(token.tokens, stats, depth + 1, token.type !== "blockquote" && token.type !== "telegram_details");
    }
  }
}
