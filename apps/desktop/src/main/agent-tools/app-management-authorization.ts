import type { AppServerThreadMessageOrigin, PwrAgentAppManagementContext } from "@pwragent/shared";

export type AppManagementAuthorizationPorts = {
  isActive(context: PwrAgentAppManagementContext): boolean;
  isToolAllowed(): boolean;
  isAgent(context: PwrAgentAppManagementContext): Promise<boolean>;
  readOrigin(context: PwrAgentAppManagementContext): Promise<AppServerThreadMessageOrigin | undefined>;
  authorizeActor(context: PwrAgentAppManagementContext, origin: AppServerThreadMessageOrigin): Promise<boolean>;
};

/** Model text, a handoff, or a missing actor must never confer lifecycle authority. */
export async function authorizeAppManagement(
  ports: AppManagementAuthorizationPorts,
  context: PwrAgentAppManagementContext,
  discovery = false,
): Promise<boolean> {
  try {
    if (!context.backend || !context.threadId || (!discovery && (!context.turnId || !ports.isActive(context)))
      || !ports.isToolAllowed() || !await ports.isAgent(context)) return false;
    const origin = await ports.readOrigin(context);
    if (!origin?.causalMessagingSource || origin.causalMessagingAmbiguous) return false;
    if (!await ports.authorizeActor(context, origin)) return false;
    // Agent designation, containment and the active caller can change during provider authorization.
    return ports.isToolAllowed() && await ports.isAgent(context) && (discovery || ports.isActive(context));
  } catch { return false; }
}
