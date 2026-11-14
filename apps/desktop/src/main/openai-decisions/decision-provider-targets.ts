import {
  DECISION_JEV_ENDPOINT,
  resolveDecisionModelSettings,
  type DecisionProviderId,
  type DesktopDecisionModelSettings,
} from "@pwragent/shared";
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
};

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
 * The provider for a registration that names none: OpenAI when its key is
 * saved, else the decision model picked under Defaults → Decisions, else Jev
 * when only its key is saved, else OpenAI (invoke then asks for a key).
 */
export async function resolveDefaultDecisionProvider(
  settings: DecisionSettingsReader,
): Promise<RegisteredDecisionProvider> {
  if (await settings.hasOpenAIDecisionsApiKey()) return "openai";
  const chosen = resolveDecisionModelSettings(settings.resolveDecisionModelSettings()).model;
  if (chosen === "jev" || chosen === "local") return chosen;
  if (await settings.hasDecisionApiKey("jev")) return "jev";
  return "openai";
}
