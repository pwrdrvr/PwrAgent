import { messagingApi } from "@line/bot-sdk";
import {
  MESSAGING_CREDENTIAL_VALIDATION_ERROR_LIMIT,
  type MessagingCredentialValidationResult,
} from "@pwragent/messaging-interface";

export type LineCredentialValidationConfig = {
  channelAccessToken: string;
};

export async function validateCredentials(
  config: LineCredentialValidationConfig,
): Promise<MessagingCredentialValidationResult> {
  const startedAt = Date.now();
  if (!config.channelAccessToken) {
    return {
      status: "unset",
      testedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    const client = new messagingApi.MessagingApiClient({
      channelAccessToken: config.channelAccessToken,
    });
    const botInfo = await client.getBotInfo();
    return {
      status: "ok",
      testedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      account: botInfo.displayName ?? botInfo.basicId ?? botInfo.userId,
      detail: botInfo.userId,
    };
  } catch (error) {
    return {
      status: "failed",
      testedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      errorMessage: clipError(error),
    };
  }
}

function clipError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.length <= MESSAGING_CREDENTIAL_VALIDATION_ERROR_LIMIT) {
    return message;
  }
  return `${message.slice(0, MESSAGING_CREDENTIAL_VALIDATION_ERROR_LIMIT - 1)}…`;
}
