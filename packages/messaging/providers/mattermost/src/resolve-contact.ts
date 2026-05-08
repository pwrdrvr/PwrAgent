import {
  clipMessagingValidationError,
  sanitizeMessagingContactHandle,
  sanitizeMessagingContactLabel,
  type MessagingContactLookupRequest,
  type MessagingContactLookupResult,
} from "@pwragent/messaging-interface";
import type { MattermostMessagingConfig } from "./mattermost-config.ts";

const DEFAULT_TIMEOUT_MS = 8_000;

type MattermostLookupUser = {
  first_name?: string;
  id?: string;
  last_name?: string;
  nickname?: string;
  username?: string;
};

export type MattermostResolveContactOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export async function resolveContact(
  config: Pick<MattermostMessagingConfig, "botToken" | "serverUrl">,
  request: MessagingContactLookupRequest,
  options: MattermostResolveContactOptions = {},
): Promise<MessagingContactLookupResult> {
  if (!config.botToken || !config.serverUrl) {
    return { status: "unset", id: request.id };
  }
  if (request.kind !== "user") {
    return {
      status: "unsupported",
      id: request.id,
      errorMessage: `Mattermost cannot resolve ${request.kind} contacts.`,
    };
  }

  const url = buildUserUrl(config.serverUrl, request.id);
  if (!url) {
    return {
      status: "failed",
      id: request.id,
      errorMessage: clipMessagingValidationError(
        `Invalid Mattermost server URL: ${config.serverUrl}`,
      ),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.botToken}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await safeReadText(response);
      return {
        status: response.status === 403 || response.status === 404
          ? "not_found"
          : "failed",
        id: request.id,
        errorMessage: clipMessagingValidationError(
          `HTTP ${response.status} ${response.statusText || ""} ${body}`.trim(),
        ),
      };
    }
    const user = (await response.json()) as MattermostLookupUser;
    const handle = formatContactHandle(user.username);
    return {
      status: "ok",
      id: request.id,
      displayName: formatMattermostDisplayName(user),
      handle,
      detail: "user",
    };
  } catch (error) {
    return {
      status: "failed",
      id: request.id,
      errorMessage: clipMessagingValidationError(
        error instanceof Error ? error.message : String(error),
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildUserUrl(serverUrl: string, userId: string): string | undefined {
  try {
    const base = new URL(serverUrl);
    return new URL(`/api/v4/users/${encodeURIComponent(userId)}`, base)
      .toString();
  } catch {
    return undefined;
  }
}

function formatMattermostDisplayName(
  user: MattermostLookupUser,
): string | undefined {
  const fullName = [
    sanitizeOptionalContactLabel(user.first_name),
    sanitizeOptionalContactLabel(user.last_name),
  ].filter(Boolean).join(" ");
  const name = sanitizeOptionalContactLabel(user.nickname)
    || fullName
    || undefined;
  const username = sanitizeOptionalContactLabel(user.username);
  const handle = formatContactHandle(user.username);
  if (name && handle && name !== username) return `${name} (${handle})`;
  return name ?? handle ?? sanitizeOptionalContactLabel(user.id);
}

function sanitizeOptionalContactLabel(value: string | undefined): string | undefined {
  const sanitized = sanitizeMessagingContactLabel(value);
  return sanitized || undefined;
}

function formatContactHandle(value: string | undefined): string | undefined {
  const sanitized = sanitizeMessagingContactHandle(value);
  return sanitized ? `@${sanitized}` : undefined;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 200);
  } catch {
    return "";
  }
}
