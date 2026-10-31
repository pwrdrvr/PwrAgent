import type { BackendSummary, CodexSpeed, ThreadTodoModelSettings } from "@pwragent/shared";
import { codexSpeedOptions } from "@pwragent/shared";
import { formatBackendLabel } from "../../lib/backend-label";

export function formatTodoDispatchSettings(settings: ThreadTodoModelSettings, backends: BackendSummary[]): string {
  const summary = backends.find((entry) => entry.kind === settings.backend);
  const model = summary?.launchpadOptions?.models?.find((entry) => entry.id === settings.model);
  return [formatBackendLabel(settings.backend, backends), model?.label ?? settings.model ?? "Default model",
    settings.reasoningEffort].filter(Boolean).join(" · ");
}

export function todoDispatchRecentResolves(settings: ThreadTodoModelSettings, backends: BackendSummary[]): boolean {
  const backend = backends.find((entry) => entry.kind === settings.backend && entry.available && entry.capabilities.createThread);
  if (!backend) return false;
  const models = backend.launchpadOptions?.models ?? [];
  const model = settings.model ? models.find((entry) => entry.id === settings.model)
    : models.find((entry) => entry.current) ?? models[0];
  if (settings.model && !model) return false;
  if (!settings.reasoningEffort) return true;
  if (model?.supportsReasoning === false) return false;
  const efforts = model?.reasoningEfforts ?? backend.launchpadOptions?.reasoningEfforts ?? [];
  return efforts.length === 0
    || efforts.some((effort) => effort.toLowerCase() === settings.reasoningEffort!.toLowerCase());
}

/** Custom changes choose valid defaults for the new provider/model. */
export function customTodoDispatchSettings(backend: BackendSummary, modelId?: string, effort?: string): ThreadTodoModelSettings {
  const models = backend.launchpadOptions?.models ?? [];
  const model = models.find((entry) => entry.id === modelId) ?? models.find((entry) => entry.current) ?? models[0];
  const efforts = model?.supportsReasoning === false ? [] : model?.reasoningEfforts ?? backend.launchpadOptions?.reasoningEfforts ?? [];
  const reasoningEffort = efforts.includes(effort ?? "") ? effort
    : model?.defaultReasoningEffort && efforts.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort
    : efforts.includes("high") ? "high" : efforts[0];
  return { backend: backend.kind, model: model?.id, reasoningEffort };
}

/** How a handoff's settings were fitted to a machine's catalog. */
export type TodoDispatchFit = "kept" | "effort" | "model" | "provider";

/**
 * The settings a handoff starts with on a machine whose catalog may differ
 * from the card owner's. Same provider and model when that machine has
 * them; else that provider's default model; else the first provider there
 * that can start a thread. Undefined while the catalog is empty, which
 * cannot refute anything, or when nothing there can start a thread.
 */
export function fitTodoDispatchSettings(
  settings: ThreadTodoModelSettings,
  backends: readonly BackendSummary[] | undefined,
): { settings: ThreadTodoModelSettings; fit: TodoDispatchFit } | undefined {
  const providers = (backends ?? []).filter((entry) => entry.available && entry.capabilities.createThread);
  if (providers.length === 0) return undefined;
  const same = providers.find((entry) => entry.kind === settings.backend);
  if (same) {
    const models = same.launchpadOptions?.models ?? [];
    if (models.length === 0 || todoDispatchRecentResolves(settings, [same])) return { settings, fit: "kept" };
    if (settings.model && models.some((entry) => entry.id === settings.model)) {
      return { settings: customTodoDispatchSettings(same, settings.model, settings.reasoningEffort), fit: "effort" };
    }
    return { settings: customTodoDispatchSettings(same, undefined, settings.reasoningEffort), fit: "model" };
  }
  return { settings: customTodoDispatchSettings(providers[0]!, undefined, settings.reasoningEffort), fit: "provider" };
}

/**
 * The speeds a Codex handoff can start at on a machine, and the one it
 * starts at. Undefined for providers without speeds. A peer start carries
 * only fast mode, so Ultrafast is offered for starts on the card's owner.
 */
export function todoDispatchSpeed(params: {
  backend: BackendSummary | undefined;
  model?: string;
  fastAllowed: boolean;
  onOwner: boolean;
  preferred?: CodexSpeed;
}): { options: CodexSpeed[]; speed: CodexSpeed; locked?: "settings" | "model" } | undefined {
  const { backend } = params;
  if (backend?.kind !== "codex") return undefined;
  const models = backend.launchpadOptions?.models ?? [];
  const model = params.model
    ? models.find((entry) => entry.id === params.model)
    : models.find((entry) => entry.current) ?? models[0];
  const options = codexSpeedOptions(model, params.fastAllowed, backend.launchpadOptions?.supportsFastMode ?? false)
    .filter((speed) => params.onOwner || speed !== "ultrafast");
  const speed = params.preferred && options.includes(params.preferred) ? params.preferred : "standard";
  return {
    options,
    speed,
    ...(options.length > 1 ? {} : { locked: params.fastAllowed ? "model" as const : "settings" as const }),
  };
}

/** A machine a handoff can start on, as the card's Machine menu lists it. */
export type TodoDispatchMachine = {
  /** `local` for this window's own machine, else its instance id. */
  key: string;
  label: string;
  /** What Start thread sends when this is not the card's owner. */
  instanceId?: string;
  available: boolean;
  /** Why it cannot be picked. */
  unavailableReason?: string;
  /** It runs this build's to-do dispatch: Where, environment and speed. */
  dispatchTarget: boolean;
};

export const LOCAL_DISPATCH_MACHINE = "local";

/**
 * The card's owner first, then every other machine this window knows. A
 * card that lives on a peer can also start on this window's own machine,
 * when this window knows its own instance id.
 */
export function todoDispatchMachines(params: {
  ownerInstanceId?: string;
  ownerLabel?: string;
  peers: readonly { instanceId: string; label: string; availability?: string; dispatchTarget?: boolean }[];
  local?: { instanceId?: string; label?: string };
}): { owner: TodoDispatchMachine; machines: TodoDispatchMachine[] } {
  const ownerKey = params.ownerInstanceId ?? LOCAL_DISPATCH_MACHINE;
  const ownerPeer = params.ownerInstanceId
    ? params.peers.find((peer) => peer.instanceId === params.ownerInstanceId)
    : undefined;
  const owner: TodoDispatchMachine = {
    key: ownerKey,
    label: (params.ownerInstanceId ? ownerPeer?.label ?? params.ownerLabel : params.local?.label) ?? "This machine",
    available: true,
    dispatchTarget: params.ownerInstanceId ? ownerPeer?.dispatchTarget === true : true,
  };
  const others: TodoDispatchMachine[] = [];
  if (params.ownerInstanceId && params.local?.instanceId) {
    others.push({
      key: LOCAL_DISPATCH_MACHINE,
      label: params.local.label ?? "This machine",
      instanceId: params.local.instanceId,
      available: true,
      dispatchTarget: true,
    });
  }
  for (const peer of params.peers) {
    if (peer.instanceId === params.ownerInstanceId || peer.instanceId === params.local?.instanceId) continue;
    const available = peer.availability === undefined || peer.availability === "available";
    others.push({
      key: peer.instanceId,
      label: peer.label,
      instanceId: peer.instanceId,
      available,
      ...(available ? {} : { unavailableReason: peer.availability === "offline" ? "Offline" : "Unsupported" }),
      dispatchTarget: peer.dispatchTarget === true,
    });
  }
  // An older owner ignores everything but the model, so its card offers
  // no other machine.
  return { owner, machines: owner.dispatchTarget ? [owner, ...others] : [owner] };
}
