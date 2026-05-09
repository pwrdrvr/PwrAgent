import { WebClient } from "@slack/web-api";
import {
  clipMessagingValidationError,
  type MessagingCredentialValidationResult,
} from "@pwragent/messaging-interface";

export type SlackCredentialValidationConfig = {
  botToken: string;
};

export type SlackValidateCredentialsOptions = {
  authTest?: () => Promise<{ team?: string; team_id?: string; url?: string; user?: string; user_id?: string }>;
};

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
    };
  }

  try {
    const authTest =
      options.authTest
      ?? (async () => {
        const client = new WebClient(config.botToken);
        return await client.auth.test();
      });
    const result = await authTest();
    return {
      status: "ok",
      durationMs: Date.now() - startedAt,
      testedAt: Date.now(),
      account: result.user ?? result.user_id ?? "unknown",
      detail: result.team ?? hostFromUrl(result.url) ?? result.team_id,
    };
  } catch (error) {
    return {
      status: "failed",
      durationMs: Date.now() - startedAt,
      testedAt: Date.now(),
      errorMessage: clipMessagingValidationError(
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

function hostFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
