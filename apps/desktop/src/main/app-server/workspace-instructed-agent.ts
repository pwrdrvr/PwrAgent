import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import type { ThreadOverlayState } from "@pwragent/shared/contracts/navigation";
import type { NavigationLaunchpadAgent } from "@pwragent/shared/contracts/navigation";

type AgentOverlayStore = {
  getThreadOverlayState?(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<ThreadOverlayState | undefined>;
  setThreadAgent?(params: {
    backend: AppServerBackendKind;
    threadId: string;
    agent: NavigationLaunchpadAgent | null;
  }): Promise<ThreadOverlayState>;
};

/**
 * Record that an existing thread's Agent instructions reach the model from an
 * instruction file in its own workspace, so no backend sends them a second
 * time. A manager thread created before the marker existed gets it the next
 * time it is opened: one write, then none.
 *
 * Only the marker changes. The Agent's name and stored text stay as they are,
 * a thread with no Agent stays without one, and a queued Agent change is left
 * for its own turn boundary.
 */
export async function markAgentInstructionsDeliveredByWorkspaceFile(
  overlayStore: AgentOverlayStore,
  identity: { backend: AppServerBackendKind; threadId: string },
): Promise<void> {
  if (!overlayStore.getThreadOverlayState || !overlayStore.setThreadAgent) return;
  const overlay = await overlayStore.getThreadOverlayState(identity);
  const agent = overlay?.agent;
  if (!agent || agent.instructionsDelivery === "workspace-file" || overlay?.queuedAgentChange) {
    return;
  }
  await overlayStore.setThreadAgent({
    ...identity,
    agent: {
      name: agent.name,
      instructions: agent.instructions,
      instructionsDelivery: "workspace-file",
    },
  });
}
