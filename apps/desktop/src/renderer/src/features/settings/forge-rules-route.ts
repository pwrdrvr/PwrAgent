/**
 * Settings → Git → Agent forge tools routes. Kept apart from the pane so App
 * and the sidebar can link to a project's rules without loading the lazily
 * imported Settings screen.
 */

/** The Agent forge tools card's `sectionId` slug on the Git pane. */
export const FORGE_AGENT_TOOLS_SECTION_ID = "agent-forge-tools";

const FORGE_RULES_ROUTE_PREFIX = `${FORGE_AGENT_TOOLS_SECTION_ID}:`;

/**
 * The Git route `sub` that scrolls to Agent forge tools with one
 * repository's project rules open. The repository is `host/owner/repo`.
 */
export function encodeForgeRulesRoute(repository: string): string {
  return `${FORGE_RULES_ROUTE_PREFIX}${repository}`;
}

/**
 * Split a Git route `sub` into the section to bring into view and the
 * repository to open. Any other `sub` passes through unchanged.
 */
export function decodeForgeRulesRoute(sub: string | undefined): {
  sectionId: string | undefined;
  repository?: string;
} {
  if (!sub?.startsWith(FORGE_RULES_ROUTE_PREFIX)) return { sectionId: sub };
  const repository = sub.slice(FORGE_RULES_ROUTE_PREFIX.length).trim();
  return {
    sectionId: FORGE_AGENT_TOOLS_SECTION_ID,
    ...(repository ? { repository } : {}),
  };
}
