import type {
  MessagingActionLayoutPolicy,
  MessagingCapabilityProfile,
  MessagingContentPart,
  MessagingSurfaceAction,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import { layoutMessagingActionRows } from "@pwragent/messaging-interface";

export const DISCORD_COMPONENT_CUSTOM_ID_LIMIT_BYTES = 100;
export const DISCORD_MESSAGE_CONTENT_LIMIT = 2000;

export type DiscordButtonComponent = {
  custom_id: string;
  disabled?: boolean;
  label: string;
  style: 1 | 2 | 3 | 4;
  type: 2;
};

export type DiscordActionRowComponent = {
  components: DiscordButtonComponent[];
  type: 1;
};

export function sanitizeDiscordContent(text: string): string {
  return text
    .replace(/@everyone/g, "@ everyone")
    .replace(/@here/g, "@ here")
    .replace(/<@!?(\d+)>/g, "@user:$1")
    .replace(/<@&(\d+)>/g, "@role:$1");
}

export function splitDiscordContent(text: string): string[] {
  const sanitized = sanitizeDiscordContent(text);
  if (sanitized.length <= DISCORD_MESSAGE_CONTENT_LIMIT) {
    return [sanitized];
  }

  const chunks: string[] = [];
  let current = "";

  for (const segment of splitPreservingLines(sanitized)) {
    const next = current ? `${current}${segment}` : segment;
    if (next.length <= DISCORD_MESSAGE_CONTENT_LIMIT) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(withContinuation(current));
      current = "";
    }

    if (segment.length <= DISCORD_MESSAGE_CONTENT_LIMIT) {
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

export function textForDiscordIntent(intent: MessagingSurfaceIntent): string {
  switch (intent.kind) {
    case "activity":
      return "";
    case "message":
      return intent.parts.map(renderContentPart).filter(Boolean).join("\n\n");
    case "stream_update":
      return intent.text;
    case "status":
      return intent.text;
    case "progress":
      return [intent.label, intent.detail].filter(Boolean).join("\n");
    case "thread_picker":
      return intent.prompt;
    case "project_picker":
      return intent.prompt;
    case "single_select":
      return intent.prompt;
    case "multi_select":
      return intent.prompt;
    case "questionnaire": {
      const question = intent.questions[intent.currentIndex] ?? intent.questions[0];
      return [question?.header, question?.question].filter(Boolean).join("\n");
    }
    case "approval":
      return [intent.title, intent.body].join("\n\n");
    case "confirmation":
      return [intent.title, intent.body].join("\n\n");
    case "error":
      return [intent.title, intent.body].join("\n\n");
    case "dismiss":
      return "";
  }
}

export function actionsForDiscordIntent(
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

export function buildDiscordComponents(
  actions: MessagingSurfaceAction[],
  createCustomId: (action: MessagingSurfaceAction) => string,
  layout?: MessagingActionLayoutPolicy,
  profile?: MessagingCapabilityProfile,
): DiscordActionRowComponent[] | undefined {
  // Defensive caps. Producers should already have applied these via
  // applyActionCapabilityLimits, but the adapter enforces Discord's hard
  // limits as a safety net. Read from profile so the numbers stay in sync.
  const maxActions = profile?.actions?.maxActions ?? 25;
  const maxLabelLength = profile?.actions?.maxLabelLength ?? 80;
  const maxColumns = profile?.actions?.maxActionsPerRow ?? 5;
  const maxRows = profile?.actions?.maxRows ?? 5;
  const items = actions
    .filter((action) => !action.disabled)
    .slice(0, maxActions)
    .map((action) => ({
      action,
      component: {
        custom_id: createCustomId(action),
        label: action.label.slice(0, maxLabelLength),
        style: styleForAction(action),
        type: 2 as const,
      },
    }));

  if (items.length === 0) {
    return undefined;
  }

  return layoutMessagingActionRows(items, {
    defaultColumns: layout?.columns,
    maxColumns,
    maxRows,
  }).map((components) => ({
    components,
    type: 1,
  }));
}

function renderContentPart(part: MessagingContentPart): string {
  if (part.type === "text") {
    return part.text;
  }

  if (part.type === "image") {
    return [part.alt, part.url].filter(Boolean).join("\n");
  }

  return [part.name, part.description, part.url].filter(Boolean).join("\n");
}

function styleForAction(action: MessagingSurfaceAction): 1 | 2 | 3 | 4 {
  switch (action.style) {
    case "primary":
      return 1;
    case "danger":
      return 4;
    case "navigation":
      return 2;
    case "secondary":
    default:
      return 2;
  }
}

function splitPreservingLines(text: string): string[] {
  return text.match(/[^\n]+(?:\n+|$)|\n+/g) ?? [text];
}

function splitOversizedSegment(segment: string): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const character of segment) {
    if (`${current}${character}`.length > DISCORD_MESSAGE_CONTENT_LIMIT) {
      chunks.push(withContinuation(current));
      current = character;
    } else {
      current = `${current}${character}`;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function withContinuation(text: string): string {
  const marker = "\n[continued]";
  return `${text.slice(0, DISCORD_MESSAGE_CONTENT_LIMIT - marker.length)}${marker}`;
}
