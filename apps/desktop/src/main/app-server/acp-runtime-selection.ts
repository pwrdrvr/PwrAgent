import { findAcpMirroredModeConfigOption } from "@pwragent/shared/acp-permission-mode";
import type {
  BackendAcpRuntimeCapabilities,
  BackendAcpSessionRuntimeState,
} from "@pwragent/shared/contracts/backend";
import {
  findAcpThoughtLevelConfigOption,
  type AcpRuntimeClient,
} from "./acp-backend-adapter";

/**
 * Writes a new session's runtime selection: config values, then its mode,
 * then its model.
 *
 * `capabilities` is the agent's cached menu, which another session reported.
 * Each mode write, whether ACP session modes or a mode config option such as
 * Grok's `permission_mode`, is checked against the new session's own menu: a
 * mode it does not list falls back, never upward, and never fails the start.
 *
 * `reasoningEffort` is sent with `runtime.currentModelId`, so it must be a
 * level of that model. On Kimi the model decides which levels exist, and a
 * level chosen for another model is refused with -32602.
 */
export async function applyAcpRuntimeSelection(params: {
  capabilities: BackendAcpRuntimeCapabilities | undefined;
  client: Pick<AcpRuntimeClient, "setRuntimeOption">;
  sessionId: string;
  runtime: BackendAcpSessionRuntimeState | undefined;
  reasoningEffort?: string;
}): Promise<void> {
  const { capabilities, client, sessionId, runtime, reasoningEffort } = params;
  // A thought level is only valid for the model the session holds, so the
  // model's option has to be written first. `configValues` carries whatever
  // insertion order earlier merges left, and a level measured against the
  // agent's default model is dropped by the session's own menu.
  const thoughtLevelOptionId = findAcpThoughtLevelConfigOption(capabilities)?.id;
  // A mode the mirrored option does not list goes through session/set_mode.
  const mirroredOption = findAcpMirroredModeConfigOption(capabilities);
  const modeConfigOption = mirroredOption?.values.some((value) => value.value === runtime?.currentModeId)
    ? mirroredOption
    : undefined;
  // Legacy mode selectors mirror currentModeId. The independent permission
  // config owns its value in configValues; currentModeId remains planning.
  const configValues = Object.entries({
    ...runtime?.configValues,
    ...(modeConfigOption && runtime?.currentModeId
      ? { [modeConfigOption.id]: runtime.currentModeId }
      : {}),
  }).sort(
    ([left], [right]) =>
      Number(left === thoughtLevelOptionId)
      - Number(right === thoughtLevelOptionId),
  );
  const modeOptionIds = new Set(
    capabilities?.configOptions
      ?.filter((option) => option.category === "mode")
      .map((option) => option.id),
  );
  for (const [optionId, value] of configValues) {
    await client.setRuntimeOption?.({
      sessionId,
      source: "configOption",
      optionId,
      value,
      ...(modeOptionIds.has(optionId) ? { sessionStartMode: true as const } : {}),
    });
  }
  if (runtime?.currentModeId && !modeConfigOption) {
    await client.setRuntimeOption?.({
      sessionId,
      source: "mode",
      optionId: "mode",
      value: runtime.currentModeId,
      sessionStartMode: true,
    });
  }
  if (runtime?.currentModelId) {
    await client.setRuntimeOption?.({
      sessionId,
      source: "model",
      optionId: "model",
      value: runtime.currentModelId,
      reasoningEffort,
    });
  }
}
