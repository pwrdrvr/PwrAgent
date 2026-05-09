import {
  clipMessagingValidationError,
  sanitizeMessagingContactHandle,
  sanitizeMessagingContactLabel,
  type MessagingContactLookupRequest,
  type MessagingContactLookupResult,
} from "@pwragent/messaging-interface";
import type { SlackMessagingConfig } from "./slack-config.ts";
import { createSlackApi } from "./slack-adapter.ts";

export async function resolveContact(
  config: Pick<SlackMessagingConfig, "botToken">,
  request: MessagingContactLookupRequest,
): Promise<MessagingContactLookupResult> {
  if (!config.botToken) {
    return { status: "unset", id: request.id };
  }
  if (request.kind !== "user" && request.kind !== "workspace") {
    return {
      status: "unsupported",
      id: request.id,
      errorMessage: `Slack cannot resolve ${request.kind} contacts.`,
    };
  }

  try {
    const api = createSlackApi(config.botToken);
    if (request.kind === "workspace") {
      const auth = await api.authTest();
      if (auth.team_id !== request.id) {
        return {
          status: "not_found",
          id: request.id,
          errorMessage:
            "The configured Slack bot token belongs to a different workspace.",
        };
      }
      return {
        status: "ok",
        id: request.id,
        displayName: sanitizeOptionalContactLabel(auth.team) ?? request.id,
        detail: "workspace",
      };
    }

    const user = await api.usersInfo?.({ user: request.id });
    if (!user) {
      return {
        status: "not_found",
        id: request.id,
        errorMessage: "Slack user was not found or users.info is unavailable.",
      };
    }
    const handle = formatContactHandle(user.name);
    return {
      status: "ok",
      id: request.id,
      displayName:
        sanitizeOptionalContactLabel(user.profile?.display_name)
        ?? sanitizeOptionalContactLabel(user.profile?.real_name)
        ?? sanitizeOptionalContactLabel(user.real_name)
        ?? sanitizeOptionalContactLabel(user.name)
        ?? request.id,
      handle,
      detail: "user",
    };
  } catch (error) {
    return lookupFailure(request.id, error);
  }
}

function sanitizeOptionalContactLabel(value: string | undefined): string | undefined {
  const sanitized = sanitizeMessagingContactLabel(value);
  return sanitized || undefined;
}

function formatContactHandle(value: string | undefined): string | undefined {
  const sanitized = sanitizeMessagingContactHandle(value);
  return sanitized ? `@${sanitized}` : undefined;
}

function lookupFailure(id: string, error: unknown): MessagingContactLookupResult {
  const message = error instanceof Error ? error.message : String(error);
  const status =
    /missing_scope|not_allowed_token_type|user_not_found|team_not_found|not_authed|invalid_auth/i
      .test(message)
      ? "not_found"
      : "failed";
  return {
    status,
    id,
    errorMessage: clipMessagingValidationError(message),
  };
}
