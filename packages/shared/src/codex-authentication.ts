export function isCodexAuthenticationFailure(message: string): boolean {
  return /Codex is logged out\. Please sign in|invalid_refresh_token|refresh_token_(?:expired|reused|invalidated)|access token could not be refreshed|could not (?:parse your authentication|validate your refresh) token/i.test(message)
    || (/401\s+Unauthorized/i.test(message)
      && /(?:https?|wss):\/\/chatgpt\.com\/backend-api\/(?:codex|wham)\//i.test(message));
}

