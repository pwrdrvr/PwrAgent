/**
 * Two products answer to "Grok" in this app, and each has its own release
 * page. Shared by the settings pane and the update notices so neither can
 * point an operator at the other channel's page.
 */

/** Where an operator updates a vendor Grok install. Never a PwrAgent build. */
export const XAI_GROK_UPDATE_URL = "https://x.ai/build";

/** The public release page for one PwrAgent-built Grok tag. */
export function managedGrokReleaseUrl(
  repository: string,
  tag: string,
): string {
  return `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`;
}
