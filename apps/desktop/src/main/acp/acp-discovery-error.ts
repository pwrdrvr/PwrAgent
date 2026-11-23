export function acpDiscoveryActionRequiredMessage(
  registryId: string,
  error: string | undefined,
): string | undefined {
  if (
    registryId === "antigravity"
    && /^(?:json-rpc error \(-32000\):\s*)?Authentication required\.?$/.test(error ?? "")
  ) {
    return "Antigravity requires sign-in. Run agy in your terminal and sign in, then click Refresh under Re-probe.";
  }
  // Gemini CLI also uses the generic ACP auth error code, so match the
  // account-specific message, including errors cached by earlier versions.
  if (
    registryId === "gemini"
    && /(?:^|:\s*)This client is no longer supported for Gemini Code Assist for individuals\.(?:\s|$)/.test(error ?? "")
  ) {
    return "Google ended Gemini CLI access for consumer Google accounts. Set up Antigravity in AI Providers, or run /auth in Gemini CLI to switch to an eligible Code Assist Standard or Enterprise account or a paid Gemini API key. After switching, click Refresh under Re-probe.";
  }
  return undefined;
}
