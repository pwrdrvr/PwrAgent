import {
  layoutMessagingActionRows,
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

export type SlackBlock = SlackActionsBlock | SlackContextBlock | SlackSectionBlock;

export type SlackPostBody = {
  blocks?: SlackBlock[];
  channel: string;
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
  const body = clampSlackSectionText(markdownToSlackMrkdwn(params.text));
  const blocks: SlackBlock[] = body
    ? [
        {
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
      if (part.type === "image") return "[image]";
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
