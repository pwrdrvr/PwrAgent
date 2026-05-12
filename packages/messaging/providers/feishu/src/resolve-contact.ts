import type {
  MessagingContactLookupRequest,
  MessagingContactLookupResult,
} from "@pwragent/messaging-interface";
import type { FeishuCredentialValidationConfig } from "./validate-credentials.ts";
import {
  validateFeishuChatId,
  validateFeishuOpenId,
  validateFeishuTenantKey,
} from "./validate-ids.ts";

export type FeishuContactLookupRequest = {
  id: string;
  kind: "user" | "chat" | "tenant";
};

export async function resolveContact(
  _config: FeishuCredentialValidationConfig,
  request: MessagingContactLookupRequest | FeishuContactLookupRequest,
): Promise<MessagingContactLookupResult> {
  const validation =
    request.kind === "user"
      ? validateFeishuOpenId(request.id)
      : request.kind === "tenant"
        ? validateFeishuTenantKey(request.id)
        : validateFeishuChatId(request.id);
  if (!validation.ok) {
    return {
      status: "failed",
      id: request.id,
      errorMessage: `Invalid Feishu ${request.kind} ID: ${validation.reason}`,
    };
  }
  return {
    status: "unsupported",
    id: request.id,
    errorMessage: "Feishu contact lookup is not available yet.",
  };
}
