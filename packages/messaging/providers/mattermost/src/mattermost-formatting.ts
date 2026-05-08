import {
  layoutMessagingActionRows,
  type MessagingActionLayoutPolicy,
  type MessagingCapabilityProfile,
  type MessagingContentPart,
  type MessagingMarkdownPolicy,
  type MessagingSurfaceAction,
  type MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";

/**
 * Per-post message body limit: 16,383 multi-byte characters
 * (Mattermost product-limits page).
 */
export const MATTERMOST_MESSAGE_TEXT_LIMIT = 16_383;

/**
 * Per-action `integration.context` size budget. Mattermost imposes a 300 KB
 * cap on the entire post payload (`ServiceSettings.MaximumPayloadSizeBytes`,
 * default 300_000 since 9.7.2). We pick a per-action ceiling that leaves
 * comfortable headroom for many buttons in a single post.
 */
export const MATTERMOST_INTEGRATION_CONTEXT_LIMIT_BYTES = 16_000;

/**
 * Mattermost button styles. The platform accepts several string keywords
 * plus arbitrary hex/theme values (discouraged). Map our generic styles
 * onto the keyword set.
 */
export type MattermostButtonStyle =
  | "good"
  | "warning"
  | "danger"
  | "default"
  | "primary"
  | "success";

export type MattermostInteractiveAction = {
  id: string;
  name: string;
  type: "button";
  style?: MattermostButtonStyle;
  integration: {
    url: string;
    context: Record<string, unknown>;
  };
};

export type MattermostMessageAttachment = {
  pretext?: string;
  text?: string;
  title?: string;
  color?: string;
  actions?: MattermostInteractiveAction[];
  image_url?: string;
};

export type MattermostPostBody = {
  message: string;
  /** When set, threaded reply under this parent post. */
  root_id?: string;
  file_ids?: string[];
  props?: {
    attachments?: MattermostMessageAttachment[];
    [key: string]: unknown;
  };
};

/**
 * Sanitize a `MessagingSurfaceAction.id` for Mattermost's strictly
 * alphanumeric action-id route constraint.
 *
 * The server registers the action callback route as
 * `/api/v4/posts/{post_id}/actions/{action_id:[A-Za-z0-9]+}` — the
 * `[A-Za-z0-9]+` regex on `action_id` rejects EVERYTHING outside ASCII
 * alphanumerics. Underscores, dashes, dots, colons all cause Go's
 * router to fall through to the not-found handler, returning a bare
 * 404 the moment a user clicks the button. (Verified against an
 * upstream "not found handler triggered" 404 on
 * `/api/v4/posts/.../actions/command_resume`.)
 *
 * Strategy: drop every non-alphanumeric character. If the result is
 * empty (the input was all symbols), fall back to `act<len>` so the id
 * stays non-empty and deterministic. Producers should choose ids
 * unique under this projection — `confirm_yes` and `confirmyes` would
 * collide here.
 */
export function sanitizeMattermostActionId(rawId: string): string {
  const stripped = rawId.replace(/[^A-Za-z0-9]/g, "");
  if (stripped.length > 0) {
    return stripped;
  }
  return `act${rawId.length}`;
}

/**
 * Map our generic `MessagingActionStyle` onto Mattermost's keyword set.
 * Mattermost has no "navigation"-equivalent style so it falls through to
 * `default`.
 */
export function styleForMattermostAction(
  action: MessagingSurfaceAction,
): MattermostButtonStyle | undefined {
  switch (action.style) {
    case "primary":
      return "primary";
    case "danger":
      return "danger";
    case "secondary":
    case "navigation":
    case undefined:
      return "default";
    default:
      return "default";
  }
}

/**
 * Extract the action list a producer placed on this intent kind.
 * Mirrors `actionsForDiscordIntent` / `actionsForTelegramIntent`.
 */
export function actionsForMattermostIntent(
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

/**
 * Build the `props.attachments[].actions[]` payload for a Mattermost
 * interactive message. Returns `undefined` when there are no actions to
 * render, so the caller can omit `props.attachments` altogether.
 *
 * Each rendered action carries:
 * - a sanitized `id`
 * - the user-visible label as `name`, capped to the profile's
 *   `maxLabelLength`
 * - `integration.url` set to the adapter's HTTP callback endpoint
 * - `integration.context` with the opaque handle, HMAC, and a small
 *   amount of routing metadata that the callback server uses to
 *   reverse-lookup the semantic action
 *
 * Defensive caps from the profile fire even though producers should
 * already have applied them via `applyActionCapabilityLimits`. The
 * adapter is the last line of defense against malformed intents.
 */
export function buildMattermostActions(params: {
  actions: MessagingSurfaceAction[];
  buildCallbackContext: (action: MessagingSurfaceAction) => Record<string, unknown>;
  callbackUrl: string;
  capabilityProfile: MessagingCapabilityProfile;
  layout?: MessagingActionLayoutPolicy;
}): MattermostInteractiveAction[] | undefined {
  const profile = params.capabilityProfile;
  const maxActions = profile.actions?.maxActions ?? 25;
  const maxLabelLength = profile.actions?.maxLabelLength ?? 40;
  const items = params.actions
    .filter((action) => !action.disabled)
    .slice(0, maxActions)
    .map((action, index) => ({
      action,
      component: {
        // Mattermost routes interactive callbacks by URL path
        // (`/api/v4/posts/{post_id}/actions/{action_id:[A-Za-z0-9]+}`)
        // and matches the FIRST action in `props.attachments[].actions[]`
        // whose `id` matches that path. Producers commonly reuse the
        // same `action.id` across many chips and differentiate via
        // `action.value` (Telegram's `callback_data` and Discord's
        // `custom_id` carry per-chip payloads directly, so they don't
        // care). For Mattermost we MUST give each chip a unique URL id
        // — otherwise every click on the picker resolves to the first
        // chip's `integration.context`, silently binding the wrong
        // thread/project/etc. The slot index suffix is enough; the
        // original raw `action.id` stays in `integration.context.actionId`,
        // so HMAC and handle resolution are unaffected.
        id: `${sanitizeMattermostActionId(action.id)}${index}`,
        name:
          action.label.length > maxLabelLength
            ? action.label.slice(0, maxLabelLength)
            : action.label,
        type: "button" as const,
        ...(styleForMattermostAction(action)
          ? { style: styleForMattermostAction(action) }
          : {}),
        integration: {
          url: params.callbackUrl,
          context: params.buildCallbackContext(action),
        },
      } satisfies MattermostInteractiveAction,
    }));

  if (items.length === 0) {
    return undefined;
  }

  // Mattermost auto-flows buttons within an attachment; layout hints are
  // advisory. We honor row hints only to keep the framework's promise that
  // hints are "take or leave" — providers without `supportsLayoutHints` may
  // ignore them entirely.
  const layoutColumns = params.layout?.columns;
  if (typeof layoutColumns === "number" && layoutColumns > 0) {
    return layoutMessagingActionRows(items, {
      defaultColumns: layoutColumns,
      maxColumns: layoutColumns,
    }).flat();
  }
  return items.map((item) => item.component);
}

/**
 * Render text content for an outbound intent. Mattermost speaks Markdown
 * (a CommonMark + GFM superset), so most intents just concatenate text
 * parts as-is. Image/file parts are stripped from the body (they ride out
 * via `file_ids` / attachment `image_url`).
 */
export function textForMattermostIntent(intent: MessagingSurfaceIntent): string {
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
      const question =
        intent.questions[intent.currentIndex] ?? intent.questions[0];
      return [question?.header, question?.question]
        .filter((value): value is string => Boolean(value))
        .join("\n");
    }
    case "approval":
      return [intent.title, intent.body].join("\n\n");
    case "confirmation":
      return [intent.title, intent.body].join("\n\n");
    case "error":
      return [intent.title, intent.body].join("\n\n");
    case "dismiss":
      return "";
    default:
      return "";
  }
}

function renderContentParts(parts: MessagingContentPart[]): string {
  return parts
    .map((part) => renderContentPart(part))
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
}

function renderContentPart(part: MessagingContentPart): string | undefined {
  if (part.type === "text") {
    return renderMarkdownPolicy(part.text, part.markdown ?? "plain");
  }
  if (part.type === "image") {
    return part.alt ? part.alt : undefined;
  }
  return [part.name, part.description, part.url]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

function renderMarkdownPolicy(
  text: string,
  policy: MessagingMarkdownPolicy,
): string {
  // Mattermost natively renders Markdown (CommonMark + GFM superset).
  // For "plain" we still pass-through; the platform doesn't auto-format
  // bare URLs unless link-preview is enabled, which is acceptable.
  return text;
}

/**
 * Truncate a Mattermost post body to the platform's character limit.
 * Used as a last-resort safety net when a producer emits a long message.
 */
export function clampMattermostMessage(text: string): string {
  return text.length > MATTERMOST_MESSAGE_TEXT_LIMIT
    ? `${text.slice(0, MATTERMOST_MESSAGE_TEXT_LIMIT - 1)}…`
    : text;
}
