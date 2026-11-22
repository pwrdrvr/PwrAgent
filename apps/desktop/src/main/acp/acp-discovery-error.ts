/**
 * Gemini CLI uses the generic ACP auth error code for this rejection. Match
 * the account-specific message so other account and provider failures keep
 * their existing behavior, including errors already cached before this fix.
 */
export function geminiConsumerDeprecationMessage(
  registryId: string,
  error: string | undefined,
): string | undefined {
  if (
    registryId !== "gemini"
    || !/(?:^|:\s*)This client is no longer supported for Gemini Code Assist for individuals\.(?:\s|$)/.test(error ?? "")
  ) {
    return undefined;
  }
  return "Google ended Gemini CLI access for consumer Google accounts. Use Antigravity CLI in your terminal, or run /auth in Gemini CLI to switch to an eligible Code Assist Standard or Enterprise account or a paid Gemini API key. After switching, click Refresh under Re-probe.";
}
