import type {
  MessagingActionLayoutPolicy,
  MessagingContentPart,
  MessagingMarkdownPolicy,
  MessagingSurfaceAction,
  MessagingSurfaceIntent,
} from "@pwragnt/messaging-interface";
import { layoutMessagingActionRows } from "@pwragnt/messaging-interface";

export const TELEGRAM_CALLBACK_DATA_LIMIT_BYTES = 64;
export const TELEGRAM_MESSAGE_TEXT_LIMIT = 4096;

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

  return renderMarkdownishTelegramHtml(text);
}

export function splitTelegramHtml(text: string): string[] {
  if (Buffer.byteLength(text, "utf8") <= TELEGRAM_MESSAGE_TEXT_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  let current = "";

  for (const segment of splitPreservingParagraphBreaks(text)) {
    const next = current ? `${current}${segment}` : segment;
    if (Buffer.byteLength(next, "utf8") <= TELEGRAM_MESSAGE_TEXT_LIMIT) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current.trimEnd());
      current = "";
    }

    if (Buffer.byteLength(segment, "utf8") <= TELEGRAM_MESSAGE_TEXT_LIMIT) {
      current = segment;
      continue;
    }

    chunks.push(...splitOversizedSegment(segment));
  }

  if (current) {
    chunks.push(current.trimEnd());
  }

  return chunks.filter(Boolean);
}

export function textForTelegramIntent(intent: MessagingSurfaceIntent): string {
  switch (intent.kind) {
    case "activity":
      return "";
    case "message":
      return intent.parts.map(renderContentPart).filter(Boolean).join("\n\n");
    case "stream_update":
      return renderTelegramHtml(intent.text, intent.markdown ?? "plain");
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
    case "questionnaire": {
      const question = intent.questions[intent.currentIndex] ?? intent.questions[0];
      return renderTelegramHtml(
        [question?.header, question?.question].filter(Boolean).join("\n"),
        "plain",
      );
    }
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
    case "questionnaire": {
      const question = intent.questions[intent.currentIndex] ?? intent.questions[0];
      return question?.options ?? [];
    }
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
): TelegramInlineKeyboardMarkup | undefined {
  const items = actions
    .filter((action) => !action.disabled)
    .map((action) => ({
      action,
      component: {
        text: action.label,
        callback_data: createCallbackData(action),
      },
    }));

  if (items.length === 0) {
    return undefined;
  }

  return {
    inline_keyboard: layoutMessagingActionRows(items, {
      defaultColumns: layout?.columns ?? 1,
      maxColumns: 8,
    }),
  };
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

function renderMarkdownishTelegramHtml(text: string): string {
  const segments: string[] = [];
  const lines = text.split(/\r?\n/);
  let codeLines: string[] = [];

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      if (codeLines.length > 0) {
        segments.push(`<pre><code>${escapeTelegramHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
      } else {
        codeLines.push("");
      }
      continue;
    }

    if (codeLines.length > 0) {
      codeLines.push(line);
      continue;
    }

    segments.push(renderInlineCode(line));
  }

  if (codeLines.length > 0) {
    segments.push(`<pre><code>${escapeTelegramHtml(codeLines.join("\n"))}</code></pre>`);
  }

  return segments.join("\n").replace(/<pre><code>\n/g, "<pre><code>");
}

function renderInlineCode(line: string): string {
  return escapeTelegramHtml(line).replace(/`([^`]+)`/g, (_match, code: string) => {
    return `<code>${code}</code>`;
  });
}

function splitPreservingParagraphBreaks(text: string): string[] {
  const matches = text.match(/[^\n]+(?:\n+|$)|\n+/g);
  return matches ?? [text];
}

function splitOversizedSegment(segment: string): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const character of segment) {
    const next = `${current}${character}`;
    if (Buffer.byteLength(next, "utf8") > TELEGRAM_MESSAGE_TEXT_LIMIT) {
      chunks.push(current);
      current = character;
    } else {
      current = next;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}
