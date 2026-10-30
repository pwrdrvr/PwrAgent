import { normalizeNavigationResumeState, type NavigationResumeState } from "@pwragent/shared";
import { readRendererFederationTarget } from "./federation-window";

export function readBridgedNavigationResumeState(): NavigationResumeState | undefined {
  if (typeof window === "undefined" || readRendererFederationTarget()) return undefined;
  return normalizeNavigationResumeState((window as unknown as {
    __pwragentNavigationPreferences?: { resumeState?: unknown };
  }).__pwragentNavigationPreferences?.resumeState);
}
