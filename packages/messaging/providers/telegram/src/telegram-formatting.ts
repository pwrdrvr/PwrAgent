import type {
  MessagingActionLayoutPolicy,
  MessagingCapabilityProfile,
  MessagingContentPart,
  MessagingMarkdownPolicy,
  MessagingSurfaceAction,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import {
  formatMessagingQuestionnaireText,
  layoutMessagingActionRows,
  messagingQuestionnaireActions,
} from "@pwragent/messaging-interface";
import { Lexer, type MarkedToken, type Token, type Tokens } from "marked";

export const TELEGRAM_CALLBACK_DATA_LIMIT_BYTES = 64;
export const TELEGRAM_MESSAGE_TEXT_LIMIT = 4096;
export const TELEGRAM_RICH_MESSAGE_TEXT_LIMIT = 32768;

export type TelegramInputRichMessage = { html: string };

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

  return renderBlocks(Lexer.lex(text, { gfm: true }), "regular");
}

export function splitTelegramHtml(text: string): string[] {
  if (Buffer.byteLength(text, "utf8") <= TELEGRAM_MESSAGE_TEXT_LIMIT) {
    return [text];
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
  return chunks;
}

/** Rich content is supplementary: clients have no capability handshake. */
export function richMessageForTelegramText(
  text: string,
  policy: MessagingMarkdownPolicy = "plain",
): TelegramInputRichMessage | undefined {
  if (policy === "plain" || Buffer.byteLength(text, "utf8") > TELEGRAM_RICH_MESSAGE_TEXT_LIMIT) {
    return undefined;
  }
  return richMessageFromTokens(Lexer.lex(text, { gfm: true }));
}

function richMessageFromTokens(tokens: Token[]): TelegramInputRichMessage | undefined {
  const stats = { blocks: 0, structured: false, valid: true };
  inspectRichTokens(tokens, stats);
  if (!stats.structured || !stats.valid || stats.blocks > 500) return undefined;
  const html = renderBlocks(tokens, "rich");
  // Counting source bytes (including tags) is deliberately conservative.
  return Buffer.byteLength(html, "utf8") <= TELEGRAM_RICH_MESSAGE_TEXT_LIMIT
    ? { html }
    : undefined;
}

export function richMessageForTelegramIntent(
  intent: MessagingSurfaceIntent,
): TelegramInputRichMessage | undefined {
  if (intent.kind !== "message" || intent.parts.some((part) => part.type !== "text")) {
    return undefined;
  }
  // Do not reinterpret plain parts as Markdown when combining content.
  const tokens = intent.parts.flatMap((part): Token[] => {
    if (part.type !== "text") return [];
    return part.markdown && part.markdown !== "plain"
      ? Lexer.lex(part.text, { gfm: true })
      : [{
          type: "paragraph",
          raw: part.text,
          text: part.text,
          tokens: [{ type: "text", raw: part.text, text: part.text }],
        }];
  });
  return richMessageFromTokens(tokens);
}

export function textForTelegramIntent(intent: MessagingSurfaceIntent): string {
  switch (intent.kind) {
    case "activity":
      return "";
    case "message":
      return intent.parts.map(renderContentPart).filter(Boolean).join("\n\n");
    case "stream_update":
      return renderTelegramHtml(intent.text, intent.markdown ?? "plain");
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
    const token = item as MarkedToken;
    switch (token.type) {
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
    const token = item as MarkedToken;
    switch (token.type) {
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
    return `${marker} ${text.replace(/\n/g, "\n  ")}`;
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
    const token = item as MarkedToken;
    switch (token.type) {
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
        stats.structured ||= token.items.some((entry) => entry.task);
        stats.blocks += 1 + token.items.length;
        for (const entry of token.items) inspectRichTokens(entry.tokens, stats, depth + 2);
        break;
      case "paragraph":
      case "blockquote":
      case "code":
      case "hr":
      case "text":
      case "html":
        if (!inline) stats.blocks += 1;
        break;
    }
    if ("tokens" in token && token.tokens) {
      inspectRichTokens(token.tokens, stats, depth + 1, token.type !== "blockquote");
    }
  }
}
