import {
  layoutMessagingActionRows,
  type MessagingActionLayoutPolicy,
  type MessagingCapabilityProfile,
  type MessagingContentPart,
  type MessagingSurfaceAction,
  type MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";

export const LINE_MESSAGE_TEXT_LIMIT = 5_000;
export const LINE_POSTBACK_DATA_LIMIT_CHARS = 300;
export const LINE_ACTION_LABEL_LIMIT = 20;
export const LINE_QUICK_REPLY_ITEM_LIMIT = 13;
const LINE_DEFAULT_ACTION_COLUMNS = 2;

const LINE_POSTBACK_HANDLE_PATTERN = /^line:[A-Za-z0-9_-]{18}$/;
const LINE_POSTBACK_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export type LineTextMessage = {
  type: "text";
  text: string;
};

export type LineImageMessage = {
  type: "image";
  originalContentUrl: string;
  previewImageUrl: string;
};

export type LineFlexMessage = {
  type: "flex";
  altText: string;
  contents: LineFlexBubble;
};

export type LineFlexBubble = {
  type: "bubble";
  body?: LineFlexBox;
  footer?: LineFlexBox;
};

export type LineFlexBox = {
  type: "box";
  layout: "horizontal" | "vertical";
  contents: LineFlexComponent[];
  spacing?: "none" | "xs" | "sm" | "md" | "lg" | "xl" | "xxl";
};

export type LineFlexComponent =
  | LineFlexBox
  | {
      type: "button";
      action: {
        type: "postback";
        label: string;
        data: string;
        displayText?: string;
      };
      style?: "link" | "primary" | "secondary";
    }
  | {
      type: "text";
      text: string;
      wrap?: boolean;
      weight?: "bold" | "regular";
    };

export type LineMessage = LineFlexMessage | LineImageMessage | LineTextMessage;

export function actionsForLineIntent(
  intent: MessagingSurfaceIntent,
): MessagingSurfaceAction[] {
  switch (intent.kind) {
    case "thread_picker":
    case "project_picker":
      return intent.page.actions;
    case "single_select":
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

export function buildLineActionBubble(params: {
  actions: MessagingSurfaceAction[];
  buildPostbackData: (action: MessagingSurfaceAction) => string;
  capabilityProfile: MessagingCapabilityProfile;
  layout?: MessagingActionLayoutPolicy;
  title: string;
}): LineFlexMessage | undefined {
  const profile = params.capabilityProfile;
  const maxActions = profile.actions?.maxActions ?? LINE_QUICK_REPLY_ITEM_LIMIT;
  const maxColumns = profile.actions?.maxActionsPerRow ?? 4;
  const maxRows = profile.actions?.maxRows ?? 4;
  const maxLabelLength = profile.actions?.maxLabelLength ?? LINE_ACTION_LABEL_LIMIT;
  const items = params.actions
    .filter((action) => !action.disabled)
    .slice(0, maxActions)
    .map((action) => {
      const postbackData = params.buildPostbackData(action);
      assertOpaqueLinePostbackData(postbackData);
      return {
        action,
        component: {
          type: "button" as const,
          style: styleForLineAction(action),
          action: {
            type: "postback" as const,
            label: truncateLineText(action.label, maxLabelLength),
            data: postbackData,
            displayText: truncateLineText(action.fallbackText ?? action.label, 300),
          },
        },
      };
    });

  if (items.length === 0) {
    return undefined;
  }

  const rows = layoutMessagingActionRows(items, {
    defaultColumns: params.layout?.columns
      ?? resolveLineDefaultActionColumns(items.length, maxColumns),
    maxColumns,
    maxRows,
  }).map((row) => ({
    type: "box" as const,
    layout: row.length > 1 ? "horizontal" as const : "vertical" as const,
    contents: row,
    spacing: "sm" as const,
  }));

  return {
    type: "flex",
    altText: truncateLineText(params.title || "PwrAgent actions", 400),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: truncateLineText(params.title || "PwrAgent", 120),
            wrap: true,
            weight: "bold",
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: rows,
        spacing: "sm",
      },
    },
  };
}

function resolveLineDefaultActionColumns(actionCount: number, maxColumns: number): number {
  if (actionCount <= 1) {
    return 1;
  }
  return Math.min(LINE_DEFAULT_ACTION_COLUMNS, maxColumns);
}

export function textForLineIntent(intent: MessagingSurfaceIntent): string {
  switch (intent.kind) {
    case "message":
      return renderContentParts(intent.parts);
    case "stream_update":
      return intent.stream.isFinal ? intent.text : "";
    case "status":
      return intent.text;
    case "progress":
      return [intent.label, intent.detail]
        .filter((value): value is string => Boolean(value))
        .join("\n");
    case "thread_picker":
    case "project_picker":
      return intent.fallbackText || intent.prompt;
    case "single_select":
    case "multi_select":
      return [intent.prompt, intent.fallbackText]
        .filter((value): value is string => Boolean(value))
        .join("\n\n");
    case "questionnaire": {
      const question = intent.questions[intent.currentIndex] ?? intent.questions[0];
      return [question?.header, question?.question]
        .filter((value): value is string => Boolean(value))
        .join("\n\n");
    }
    case "approval":
    case "confirmation":
      return [intent.title, intent.body].filter(Boolean).join("\n\n");
    case "error":
      return [intent.title, intent.body].filter(Boolean).join("\n\n");
    case "activity":
      return "";
    case "dismiss":
      return "";
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}

export function imageMessagesForLineIntent(
  intent: MessagingSurfaceIntent,
): LineImageMessage[] {
  if (intent.kind !== "message") return [];
  return intent.parts.flatMap((part) => {
    if (part.type !== "image" || !isHttpsUrl(part.url)) return [];
    return [{
      type: "image" as const,
      originalContentUrl: part.url,
      previewImageUrl: part.url,
    }];
  });
}

export function clampLineMessage(text: string): string {
  return truncateLineText(text, LINE_MESSAGE_TEXT_LIMIT);
}

export function truncateLineText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= 1) return text.slice(0, limit);
  return `${text.slice(0, limit - 1)}…`;
}

export function styleForLineAction(
  action: MessagingSurfaceAction,
): "link" | "primary" | "secondary" {
  switch (action.style) {
    case "primary":
      return "primary";
    case "danger":
    case "secondary":
      return "secondary";
    case "navigation":
    case undefined:
      return "link";
    default:
      return "link";
  }
}

function renderContentParts(parts: MessagingContentPart[]): string {
  return parts.map(renderContentPart).filter(Boolean).join("\n\n");
}

function assertOpaqueLinePostbackData(data: string): void {
  if (data.length > LINE_POSTBACK_DATA_LIMIT_CHARS) {
    throw new Error("LINE postback data exceeds provider limit.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error("LINE postback data must be an opaque persisted handle.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LINE postback data must be an opaque persisted handle.");
  }

  const record = parsed as {
    h?: unknown;
    s?: unknown;
    t?: unknown;
    v?: unknown;
  };
  if (
    record.v !== 1 ||
    typeof record.h !== "string" ||
    !LINE_POSTBACK_HANDLE_PATTERN.test(record.h) ||
    typeof record.t !== "number" ||
    !Number.isFinite(record.t) ||
    typeof record.s !== "string" ||
    !LINE_POSTBACK_SIGNATURE_PATTERN.test(record.s)
  ) {
    throw new Error("LINE postback data must be an opaque persisted handle.");
  }
}

function renderContentPart(part: MessagingContentPart): string {
  if (part.type === "text") {
    return part.text;
  }
  if (part.type === "image") {
    return part.alt ?? "";
  }
  return [part.name, part.description, part.url].filter(Boolean).join("\n");
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
