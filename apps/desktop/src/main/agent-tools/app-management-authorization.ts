import type { AppServerThreadMessageOrigin } from "@pwragent/shared/contracts/normalized-app-server";
import type { PwrAgentAppManagementContext } from "@pwragent/shared/contracts/app-tools";
import type { DynamicToolPermissionResult } from "../messaging/messaging-agent-tool-service";

export type AppManagementAuthorizationPorts = {
  /** Only a host-bound, already accepted lifecycle operation may outlive its turn. */
  allowCompleted?: boolean;
  isActive(context: PwrAgentAppManagementContext): boolean;
  isToolAllowed(): boolean;
  isAgent(context: PwrAgentAppManagementContext): Promise<boolean>;
  readOrigin(context: PwrAgentAppManagementContext): Promise<AppServerThreadMessageOrigin | undefined>;
  actorDenial(context: PwrAgentAppManagementContext, origin: AppServerThreadMessageOrigin): Promise<string | null>;
};

/** Model text, a handoff, or a missing actor must never confer lifecycle authority. */
export async function appManagementDenial(
  ports: AppManagementAuthorizationPorts,
  context: PwrAgentAppManagementContext,
  discovery = false,
): Promise<string | null> {
  const isCurrent = () => discovery || (Boolean(context.turnId)
    && (ports.allowCompleted === true || ports.isActive(context)));
  const inactive = "App management requires an active turn on the owning thread.";
  const unavailable = "App management is disabled on this owner.";
  const notAgent = "App management requires a persisted Agent designation.";
  try {
    if (!context.backend || !context.threadId || !isCurrent()) return inactive;
    if (!ports.isToolAllowed()) return unavailable;
    if (!await ports.isAgent(context)) return notAgent;
    const origin = await ports.readOrigin(context);
    if (origin?.causalMessagingAmbiguous) return "The messaging actor for this turn is ambiguous. Start a new turn from the authorized messaging account.";
    if (!origin?.causalMessagingSource) return "This turn has no retained messaging actor. Start a new turn from the authorized messaging account.";
    const denied = await ports.actorDenial(context, origin);
    if (denied !== null) return denied;
    // A steer can change the actor while provider authorization or overlay reads await.
    if (!ports.isToolAllowed()) return unavailable;
    if (!await ports.isAgent(context)) return notAgent;
    if (!isCurrent()) return inactive;
    const current = await ports.readOrigin(context);
    if (current?.causalMessagingAmbiguous
      || JSON.stringify(current?.causalMessagingSource) !== JSON.stringify(origin.causalMessagingSource)) {
      return "The messaging actor changed during app management authorization. Start a new turn from the authorized messaging account.";
    }
    if (!ports.isToolAllowed()) return unavailable;
    return isCurrent() ? null : inactive;
  } catch {
    return "PwrAgent could not verify app management authorization.";
  }
}

export function agentToolPermissionDeniedMessage(tool: string, denied: string): string {
  return tool === "manage_pwragent" ? denied
    : `The messaging user who started this turn lacks permission for this tool (${denied}).`;
}

export function appManagementActorDenial(result: DynamicToolPermissionResult | undefined): string | null {
  if (result?.allowed) return null;
  if (result?.rbacNotEnforced === true) {
    return "App management requires messaging RBAC enforcement. The local operator can review Settings → Access Control.";
  }
  switch (result?.permission) {
    case "tools.instance_management":
    case "tools.instance_lifecycle":
      return `The messaging actor lacks ${result.permission}. The local operator can review Settings → Access Control.`;
    case "federation.remote_control":
      return "PwrAgent could not authorize this lifecycle request through the messaging owner.";
    default:
      return "PwrAgent could not verify current messaging access for this lifecycle request.";
  }
}
