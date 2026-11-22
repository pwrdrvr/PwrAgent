import {
  decisionProvidersReadiness,
  type DecisionProviderReadiness,
  type DecisionProvidersReadiness,
  type DecisionRunProvider,
} from "@pwragent/shared/decision-models";
import type {
  DesktopSettingsSecretState,
  DesktopSettingsSnapshot,
} from "@pwragent/shared/contracts/settings";
import type { DesktopSettingsState } from "../../settings/useDesktopSettings";

/** What the Decisions tab reads from and writes to the profile's Settings. */
export type DecisionSetupSettings = Pick<
  DesktopSettingsState,
  "snapshot" | "saving" | "replaceSecret" | "clearSecret" | "writeConfig"
>;

/** Settings → AI Providers screens, by the focus ids the Settings screen opens at. */
export const DECISION_SETUP_FOCUS: Record<DecisionRunProvider, string> = {
  openai: "openai-decisions",
  jev: "decision-jev",
  local: "decision-local",
};

const UNSET_SECRET: DesktopSettingsSecretState = { configured: false, source: "unset", writable: false };

/** Each provider's readiness, from the Settings snapshot the window already holds. */
export function decisionSetupReadiness(
  snapshot: DesktopSettingsSnapshot | undefined,
): DecisionProvidersReadiness | undefined {
  if (!snapshot) return undefined;
  const secrets = decisionSetupSecrets(snapshot);
  return decisionProvidersReadiness({
    decisionModels: snapshot.models.decisionModels,
    openaiEnabled: snapshot.models.openaiDecisions?.enabled !== false,
    openaiKey: snapshot.models.openaiDecisions?.apiKey?.configured === true,
    jevKey: secrets.jevApiKey.configured,
  });
}

export function decisionSetupSecrets(snapshot: DesktopSettingsSnapshot) {
  return {
    jevApiKey: snapshot.models.decisionSecrets?.jevApiKey ?? UNSET_SECRET,
    unset: UNSET_SECRET,
  };
}

/** Ready, Needs key, Not chosen, Off. */
export function decisionReadinessLabel(entry: DecisionProviderReadiness): string {
  if (!entry.enabled) return "Off";
  if (entry.ready) return "Ready";
  return entry.missing === "choice" ? "Not chosen" : "Needs key";
}
