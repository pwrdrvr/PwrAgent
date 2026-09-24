/**
 * Which Slack credential a box holds. Slack shows the bot token, the
 * app-level token, and the signing secret on two different pages, and
 * operators paste one into another's box. Secret boxes save on blur, so the
 * mix-up is caught here, before the keychain, with the name of the value that
 * was pasted rather than a bare "invalid".
 */
export type SlackCredentialKind = "bot" | "app" | "signing";

function describePasted(value: string): string | undefined {
  if (value.startsWith("xoxb-")) return "the Bot User OAuth Token (xoxb-)";
  if (value.startsWith("xapp-")) return "an App-Level Token (xapp-)";
  if (value.startsWith("xoxp-")) return "a User OAuth Token (xoxp-)";
  if (value.startsWith("xox")) return "a Slack token";
  return undefined;
}

export function slackCredentialProblem(
  kind: SlackCredentialKind,
  value: string,
): string | undefined {
  const pasted = describePasted(value);
  if (kind === "bot") {
    if (value.startsWith("xoxb-")) return undefined;
    return pasted
      ? `That is ${pasted}. The Bot User OAuth Token starts with xoxb-.`
      : "The Bot User OAuth Token starts with xoxb-.";
  }
  if (kind === "app") {
    if (value.startsWith("xapp-")) return undefined;
    return pasted
      ? `That is ${pasted}. The App-Level Token starts with xapp-.`
      : "The App-Level Token starts with xapp-.";
  }
  // The signing secret has no prefix. Only a token is recognizably wrong.
  return pasted
    ? `That is ${pasted}. The Signing Secret is under Basic Information → App Credentials.`
    : undefined;
}
