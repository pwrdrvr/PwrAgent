import { resolveAgentPresetConnections } from "@pwragent/shared/contracts/agent-presets";
import type { MessagingBrowseSessionRecord } from "@pwragent/messaging-interface";
import type { MessagingBackendBridge } from "./messaging-adapter";
import { isNewAgentThreadLaunchAction } from "./messaging-resume-browser";

export function listMessagingAgentPresets(
  backend: Pick<MessagingBackendBridge, "listAgentPresets">,
  session: MessagingBrowseSessionRecord,
) {
  if (!isNewAgentThreadLaunchAction(session.launchAction)
    || !session.selectedProject || session.selectedProject.federationTarget?.scope === "remote") return [];
  return (backend.listAgentPresets?.() ?? []).filter((preset) => preset.availableInMessaging === true);
}

export async function resolveMessagingAgentPreset(
  backend: Pick<MessagingBackendBridge, "listAgentPresets" | "listAgentPresetConnections">,
  session: MessagingBrowseSessionRecord,
) {
  if (!session.agentPresetId) return undefined;
  const preset = listMessagingAgentPresets(backend, session).find((item) => item.id === session.agentPresetId);
  if (!preset) return undefined;
  const connections = await backend.listAgentPresetConnections?.() ?? [];
  const { selected, skipped } = resolveAgentPresetConnections(preset.mcpConnectionIds, connections);
  const names = new Map(connections.map(({ id, displayName }) => [id, displayName]));
  return {
    agent: { name: preset.name, instructions: preset.instructions },
    connectionIds: selected,
    selectedNames: selected.map((id) => names.get(id) ?? id),
    skippedNames: skipped.map((id) => names.get(id) ?? id),
  };
}
