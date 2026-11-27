import {
  DECISION_JEV_ENDPOINT,
  decisionProvidersReadiness,
  resolveDecisionModelSettings,
  type DecisionProviderId,
  type DecisionProvidersReadiness,
  type DesktopDecisionModelSettings,
} from "@pwragent/shared/decision-models";
import type { RegisteredDecisionProvider } from "@pwragent/shared/openai-decisions";
import type { SystemOneTarget } from "../decision/system-one";

/** What the decisions tools read from Settings. Keys are read per request. */
export type DecisionSettingsReader = {
  resolveOpenAIDecisionsApiKey: () => Promise<string | undefined>;
  resolveDecisionModelSettings: () => DesktopDecisionModelSettings;
  resolveDecisionApiKey: (provider: DecisionProviderId) => Promise<string | undefined>;
  /** Presence only: picking a default never decrypts a key. */
  hasOpenAIDecisionsApiKey: () => Promise<boolean>;
  hasDecisionApiKey: (provider: DecisionProviderId) => Promise<boolean>;
  /** Whether OpenAI Decisions is on, and its dashboard ids. */
  resolveOpenAIDecisionsSettings: () => { enabled?: boolean; organizationId?: string; projectId?: string };
};

/** Whether Settings lets agents use a provider. Every provider is on by default. */
export function isDecisionProviderEnabled(
  settings: Pick<DecisionSettingsReader, "resolveDecisionModelSettings" | "resolveOpenAIDecisionsSettings">,
  provider: RegisteredDecisionProvider,
): boolean {
  if (provider === "openai") return settings.resolveOpenAIDecisionsSettings().enabled !== false;
  return resolveDecisionModelSettings(settings.resolveDecisionModelSettings()).enabled[provider];
}

/** The saved Jev or local decision model, as Settings → AI Providers holds it. */
export async function readSystemOneTarget(
  settings: DecisionSettingsReader,
  provider: "jev" | "local",
): Promise<SystemOneTarget | undefined> {
  const resolved = resolveDecisionModelSettings(settings.resolveDecisionModelSettings());
  const apiKey = (await settings.resolveDecisionApiKey(provider))?.trim() || undefined;
  if (provider === "jev") {
    // Jev needs a key; its model defaults to jev-latest when none is saved.
    return apiKey ? { endpoint: DECISION_JEV_ENDPOINT, model: resolved.jevModel, apiKey } : undefined;
  }
  return {
    endpoint: resolved.localEndpoint,
    model: resolved.localModel,
    ...(apiKey ? { apiKey } : {}),
  };
}

/**
 * The provider for a registration that names none, among the providers that
 * are on: OpenAI when its key is saved, else the decision model picked under
 * Defaults → Decisions, else Jev when only its key is saved, else the first
 * provider that is on, so register can ask for its key. With every provider
 * off it returns OpenAI, and register refuses it as off.
 */
export async function resolveDefaultDecisionProvider(
  settings: DecisionSettingsReader,
): Promise<RegisteredDecisionProvider> {
  // One read of each section, so a single pick sees one set of switches.
  const resolved = resolveDecisionModelSettings(settings.resolveDecisionModelSettings());
  const openaiOn = settings.resolveOpenAIDecisionsSettings().enabled !== false;
  const on = (provider: RegisteredDecisionProvider) => provider === "openai" ? openaiOn : resolved.enabled[provider];
  if (on("openai") && await settings.hasOpenAIDecisionsApiKey()) return "openai";
  // `model` is already "off" when the chosen provider is off.
  const chosen = resolved.model;
  if (chosen === "jev" || chosen === "local") return chosen;
  if (on("jev") && await settings.hasDecisionApiKey("jev")) return "jev";
  return (["openai", "jev", "local"] as const).find(on) ?? "openai";
}

/**
 * Current readiness of OpenAI Decisions, TypeSafe Jev, and local Clef.
 * Reads only settings and secret presence, never decrypting any key.
 */
export async function readDecisionProvidersReadiness(
  settings: DecisionSettingsReader,
): Promise<DecisionProvidersReadiness> {
  const [openaiKey, jevKey] = await Promise.all([
    settings.hasOpenAIDecisionsApiKey(),
    settings.hasDecisionApiKey("jev"),
  ]);
  return decisionProvidersReadiness({
    decisionModels: settings.resolveDecisionModelSettings(),
    openaiEnabled: settings.resolveOpenAIDecisionsSettings().enabled !== false,
    openaiKey,
    jevKey,
  });
}
