import {
  decisionProvidersReadiness,
  type DecisionProviderReadiness,
  type DecisionProvidersReadiness,
  type DecisionRunProvider,
} from "@pwragent/shared/decision-models";
import type { DesktopSettingsSnapshot } from "@pwragent/shared/contracts/settings";
import { decisionSecrets } from "../../settings/DecisionModelSettings";
import { openAIDecisionsEnabled, openAIDecisionsKeyState } from "../../settings/OpenAIDecisionsSettings";
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

/** Each provider's readiness, from the Settings snapshot the window already holds. */
export function decisionSetupReadiness(
  snapshot: DesktopSettingsSnapshot | undefined,
): DecisionProvidersReadiness | undefined {
  if (!snapshot) return undefined;
  return decisionProvidersReadiness({
    decisionModels: snapshot.models.decisionModels,
    openaiEnabled: openAIDecisionsEnabled(snapshot),
    openaiKey: openAIDecisionsKeyState(snapshot).configured,
    jevKey: decisionSecrets(snapshot).jevApiKey.configured,
  });
}

/** Ready, Needs key, Not chosen, Off. */
export function decisionReadinessLabel(entry: DecisionProviderReadiness): string {
  if (!entry.enabled) return "Off";
  if (entry.ready) return "Ready";
  return entry.missing === "choice" ? "Not chosen" : "Needs key";
}
