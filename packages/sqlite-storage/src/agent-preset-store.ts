import { randomUUID } from "node:crypto";
import type { AgentPreset, AgentPresetDefaults, SaveAgentPresetRequest } from "@pwragent/shared/contracts/agent-presets";
import type { StateDb } from "./state-db.js";

const AGENT_PRESETS_KEY = "agentPresets";
const MAX_PRESETS = 100;

export function listAgentPresets(stateDb: StateDb): AgentPreset[] {
  const raw = stateDb.getMeta(AGENT_PRESETS_KEY);
  if (raw === undefined) return [];

  const presets: unknown = JSON.parse(raw);
  if (!Array.isArray(presets)) throw new Error("Saved Agent presets are unreadable.");
  return presets.map((preset: SaveAgentPresetRequest) => {
    if (typeof preset?.id !== "string" || !preset.id) throw new Error("Saved Agent preset has no ID.");
    return { id: preset.id, ...validatePresetDefaults(preset) };
  });
}

export function saveAgentPreset(stateDb: StateDb, request: SaveAgentPresetRequest): AgentPreset {
  const defaults = validatePresetDefaults(request);
  return stateDb.raw.transaction(() => {
    const presets = listAgentPresets(stateDb);
    const index = presets.findIndex((preset) => preset.id === request.id);
    if (request.id !== undefined && index < 0) throw new Error("This Agent preset no longer exists.");
    if (presets.some((preset) => preset.id !== request.id && preset.name.toLowerCase() === defaults.name.toLowerCase())) {
      throw new Error("An Agent preset already has this name.");
    }

    const saved = {
      id: request.id ?? randomUUID(),
      ...defaults,
      ...(request.preserveMessagingAvailability === true
        ? { availableInMessaging: presets[index]?.availableInMessaging } : {}),
    };
    if (index < 0) {
      if (presets.length >= MAX_PRESETS) throw new Error(`You can save up to ${MAX_PRESETS} Agent presets.`);
      presets.push(saved);
    } else {
      presets[index] = saved;
    }
    stateDb.setMeta(AGENT_PRESETS_KEY, JSON.stringify(presets));
    return saved;
  }).immediate();
}

export function deleteAgentPreset(stateDb: StateDb, id: string): void {
  stateDb.raw.transaction(() => {
    const presets = listAgentPresets(stateDb);
    const remaining = presets.filter((preset) => preset.id !== id);
    if (remaining.length !== presets.length) {
      stateDb.setMeta(AGENT_PRESETS_KEY, JSON.stringify(remaining));
    }
  }).immediate();
}

function validatePresetDefaults(input: AgentPresetDefaults): AgentPresetDefaults {
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 120) throw new Error("Enter an Agent name of 1 to 120 characters.");
  if (input.instructions !== undefined && (typeof input.instructions !== "string" || input.instructions.length > 65_536)) {
    throw new Error("Agent instructions must be at most 65,536 characters.");
  }
  if (!Array.isArray(input.mcpConnectionIds) || input.mcpConnectionIds.length > 100
    || input.mcpConnectionIds.some((id) => typeof id !== "string" || !id || id.length > 256)) {
    throw new Error("Invalid Agent preset connection selection.");
  }
  return {
    name,
    instructions: input.instructions?.trim() || undefined,
    mcpConnectionIds: [...new Set(input.mcpConnectionIds)],
    ...(input.availableInMessaging === true ? { availableInMessaging: true as const } : {}),
  };
}
