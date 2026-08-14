import { WebClient } from "@slack/web-api";
import {
  clipMessagingValidationError,
  type MessagingCredentialValidationResult,
  type SlackCredentialValidationConfig,
} from "@pwragent/messaging-interface";

export type { SlackCredentialValidationConfig };

export type SlackAuthTestResult = {
  team?: string;
  team_id?: string;
  url?: string;
  user?: string;
  user_id?: string;
};

export type SlackValidateCredentialsOptions = {
  authTest?: () => Promise<SlackAuthTestResult>;
  openSocketConnection?: () => Promise<unknown>;
};

export const SLACK_CREDENTIAL_ERROR = {
  missingBotToken:
    "Paste the Bot User OAuth Token from Slack → Install App. It starts with xoxb-.",
  missingAppToken:
    "Socket Mode needs an App-Level Token (xapp-) with connections:write, generated under Basic Information.",
  invalidBotToken:
    "Slack rejected the bot token. Reinstall the app and paste the new xoxb- token.",
  socketFailed:
    "The bot token is valid, but PwrAgent could not open Slack Socket Mode. Check that Socket Mode is enabled and the xapp- token has connections:write.",
} as const;

export async function validateCredentials(
  config: SlackCredentialValidationConfig,
  options: SlackValidateCredentialsOptions = {},
): Promise<MessagingCredentialValidationResult> {
  const startedAt = Date.now();
  if (!config.botToken) {
    return {
      status: "unset",
      durationMs: 0,
      testedAt: startedAt,
      errorMessage: SLACK_CREDENTIAL_ERROR.missingBotToken,
    };
  }

  let account: string | undefined;
  let workspace: string | undefined;
  try {
    const authTest =
      options.authTest
      ?? (async () => {
        const client = new WebClient(config.botToken);
        return await client.auth.test();
      });
    const result = await authTest();
    account = result.user ?? result.user_id ?? "unknown";
    workspace = result.team ?? hostFromUrl(result.url) ?? result.team_id;
  } catch {
    return {
      status: "failed",
      durationMs: Date.now() - startedAt,
      testedAt: Date.now(),
      errorMessage: clipMessagingValidationError(
        SLACK_CREDENTIAL_ERROR.invalidBotToken,
      ),
    };
  }

  if (!config.appToken?.trim()) {
    return {
      status: "failed",
      durationMs: Date.now() - startedAt,
      testedAt: Date.now(),
      account,
      detail: workspace,
      errorMessage: clipMessagingValidationError(
        SLACK_CREDENTIAL_ERROR.missingAppToken,
      ),
    };
  }

  try {
    const openSocketConnection =
      options.openSocketConnection
      ?? (async () => {
        const client = new WebClient(config.appToken);
        return await client.apps.connections.open();
      });
    await openSocketConnection();
    return {
      status: "ok",
      durationMs: Date.now() - startedAt,
      testedAt: Date.now(),
      account,
      detail: formatOkDetail(workspace),
    };
  } catch {
    return {
      status: "failed",
      durationMs: Date.now() - startedAt,
      testedAt: Date.now(),
      account,
      detail: workspace,
      errorMessage: clipMessagingValidationError(
        SLACK_CREDENTIAL_ERROR.socketFailed,
      ),
    };
  }
}

function formatOkDetail(workspace: string | undefined): string {
  return workspace ? `${workspace} · Socket Mode ok` : "Socket Mode ok";
}

function hostFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
