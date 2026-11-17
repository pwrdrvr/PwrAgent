import type { AppServerThreadMessageOrigin, PwrAgentAppManagementContext } from "@pwragent/shared";

export type AppManagementAuthorizationPorts = {
  /** Only a host-bound, already accepted lifecycle operation may outlive its turn. */
  allowCompleted?: boolean;
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
    if (!context.backend || !context.threadId || (!discovery && (!context.turnId || (!ports.allowCompleted && !ports.isActive(context))))
      || !ports.isToolAllowed() || !await ports.isAgent(context)) return false;
    const origin = await ports.readOrigin(context);
    if (!origin?.causalMessagingSource || origin.causalMessagingAmbiguous) return false;
    if (!await ports.authorizeActor(context, origin)) return false;
    // A steer can change the actor while provider authorization or overlay reads await.
    if (!ports.isToolAllowed() || !await ports.isAgent(context) || (!discovery && !ports.allowCompleted && !ports.isActive(context))) return false;
    const current = await ports.readOrigin(context);
    return !current?.causalMessagingAmbiguous
      && JSON.stringify(current?.causalMessagingSource) === JSON.stringify(origin.causalMessagingSource)
      && ports.isToolAllowed() && (discovery || ports.allowCompleted === true || ports.isActive(context));
  } catch { return false; }
}
