import {
  layoutMessagingActionRows,
  type MessagingActionLayoutPolicy,
  type MessagingCapabilityProfile,
  type MessagingContentPart,
  type MessagingSurfaceAction,
  type MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";

// Feishu/Lark custom bot messages document a 150 KB payload ceiling.
// Keep normal message text far below that and let producers fit rich
// surfaces safely. Interactive card text modules are still clipped below.
export const FEISHU_MESSAGE_TEXT_LIMIT = 30_000;
export const FEISHU_CARD_TEXT_LIMIT = 8_000;
export const FEISHU_BUTTON_LABEL_LIMIT = 20;
export const FEISHU_BUTTON_VALUE_LIMIT = 2_000;

export type FeishuTextObject =
  | { tag: "plain_text"; content: string }
  | { tag: "lark_md"; content: string };

export type FeishuCardElement =
  | {
      tag: "div";
      text: FeishuTextObject;
    }
  | {
      tag: "action";
      actions: FeishuButtonElement[];
      layout?: "bisected" | "flow";
    };

export type FeishuButtonElement = {
  tag: "button";
  text: { tag: "plain_text"; content: string };
  type?: "default" | "primary" | "danger";
  value: Record<string, string>;
};

export type FeishuInteractiveCard = {
  config?: {
    update_multi?: boolean;
    wide_screen_mode?: boolean;
  };
  elements: FeishuCardElement[];
  header?: {
    template?: "blue" | "green" | "red" | "turquoise" | "yellow";
    title: { tag: "plain_text"; content: string };
  };
};

export function actionsForFeishuIntent(
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

export function buildFeishuActionElements(params: {
  actions: MessagingSurfaceAction[];
  buildCallbackValue: (action: MessagingSurfaceAction) => string;
  capabilityProfile: MessagingCapabilityProfile;
  layout?: MessagingActionLayoutPolicy;
}): FeishuCardElement[] {
  const profile = params.capabilityProfile;
  const maxActions = profile.actions?.maxActions ?? 20;
  const maxColumns = profile.actions?.maxActionsPerRow ?? 4;
  const maxRows = profile.actions?.maxRows;
  const maxLabelLength =
    profile.actions?.maxLabelLength ?? FEISHU_BUTTON_LABEL_LIMIT;
  const items = params.actions
    .filter((action) => !action.disabled)
    .slice(0, maxActions)
    .map((action) => ({
      action,
      component: {
        tag: "button" as const,
        text: {
          tag: "plain_text" as const,
          content: truncateFeishuPlainText(action.label, maxLabelLength),
        },
        type: styleForFeishuAction(action),
        value: {
          handle: params.buildCallbackValue(action),
        },
      } satisfies FeishuButtonElement,
    }));

  if (items.length === 0) {
    return [];
  }

  const rows = layoutMessagingActionRows(items, {
    defaultColumns: params.layout?.columns,
    maxColumns,
    ...(maxRows !== undefined ? { maxRows } : {}),
  });

  return rows.map((actions) => ({
    tag: "action" as const,
    actions,
    layout: actions.length <= 2 ? "bisected" : "flow",
  }));
}

export function buildFeishuCardForIntent(params: {
  actionElements?: FeishuCardElement[];
  intent: MessagingSurfaceIntent;
  text: string;
}): FeishuInteractiveCard {
  const elements: FeishuCardElement[] = [];
  const body = clampFeishuCardText(markdownToFeishuMarkdown(params.text));
  if (body) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: body,
      },
    });
  }
  if (params.intent.kind === "progress" && params.intent.value !== undefined) {
    elements.push({
      tag: "div",
      text: {
        tag: "plain_text",
        content: `Progress: ${params.intent.value}/${params.intent.max ?? 100}`,
      },
    });
  }
  elements.push(...(params.actionElements ?? []));

  return {
    config: { update_multi: true, wide_screen_mode: true },
    elements,
    header: headerForIntent(params.intent),
  };
}

export function textForFeishuIntent(intent: MessagingSurfaceIntent): string {
  switch (intent.kind) {
    case "message":
      return renderContentParts(intent.parts);
    case "stream_update":
      return intent.text;
    case "status":
      return intent.text;
    case "progress":
      return [intent.label, intent.detail]
        .filter((value): value is string => Boolean(value))
        .join("\n");
    case "thread_picker":
    case "project_picker":
      return [intent.prompt, intent.fallbackText]
        .filter((value): value is string => Boolean(value))
        .join("\n\n");
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

export function clampFeishuMessage(text: string): string {
  return text.length <= FEISHU_MESSAGE_TEXT_LIMIT
    ? text
    : text.slice(0, FEISHU_MESSAGE_TEXT_LIMIT);
}

export function clampFeishuCardText(text: string): string {
  const suffix = "...";
  return text.length <= FEISHU_CARD_TEXT_LIMIT
    ? text
    : `${text.slice(0, FEISHU_CARD_TEXT_LIMIT - suffix.length)}${suffix}`;
}

export function markdownToFeishuMarkdown(markdown: string): string {
  return markdown.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "[$1]($2)");
}

export function sanitizeFeishuActionId(rawId: string): string {
  const sanitized = rawId.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_");
  const trimmed = sanitized.replace(/^_+|_+$/g, "");
  return (trimmed || `act_${rawId.length}`).slice(0, 120);
}

export function styleForFeishuAction(
  action: MessagingSurfaceAction,
): "default" | "primary" | "danger" {
  if (action.style === "primary") return "primary";
  if (action.style === "danger") return "danger";
  return "default";
}

export function truncateFeishuPlainText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 3) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 3)}...`;
}

function headerForIntent(
  intent: MessagingSurfaceIntent,
): FeishuInteractiveCard["header"] | undefined {
  if (intent.kind === "status") {
    return {
      template:
        intent.status === "failed"
          ? "red"
          : intent.status === "completed"
            ? "green"
            : "blue",
      title: { tag: "plain_text", content: "PwrAgent" },
    };
  }
  if (intent.kind === "error") {
    return {
      template: "red",
      title: { tag: "plain_text", content: intent.title || "PwrAgent" },
    };
  }
  return undefined;
}

function renderContentParts(parts: readonly MessagingContentPart[]): string {
  return parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image") return part.alt ?? "[image]";
      if (part.type === "file") return part.description ?? part.name;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}
