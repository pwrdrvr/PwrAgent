export function isCodexAuthenticationFailure(message: string): boolean {
  return /Codex is logged out\. Please sign in|invalid_refresh_token|refresh_token_(?:expired|reused|invalidated)|access token could not be refreshed|could not (?:parse your authentication|validate your refresh) token/i.test(message)
    || (/401\s+Unauthorized/i.test(message)
      && /(?:https?|wss):\/\/chatgpt\.com\/backend-api\/(?:codex|wham)\//i.test(message));
}

/**
 * Codex withheld a response until the account signs in again with a hardware
 * key. The App Server has no typed signal for this: Codex sends the provider's
 * text with `codexErrorInfo: "cyberPolicy"`. Both must agree, so an unrelated
 * policy refusal or a tool error that mentions hardware keys is not mistaken
 * for it. This is not a logged-out account (`isCodexAuthenticationFailure`):
 * the profile's credentials still work for every other request.
 */
export function isCodexHardwareKeyReauthenticationRequired(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  if (record.codexErrorInfo !== "cyberPolicy") return false;
  const message = typeof record.message === "string" ? record.message : "";
  return /\bhardware[\s-]+(?:security[\s-]+)?keys?\b/i.test(message)
    && /\bre-?authenticat|\bsign(?:ed)?[\s-]+in\s+again\b|\bnot\s+authenticated\b/i.test(message);
}
