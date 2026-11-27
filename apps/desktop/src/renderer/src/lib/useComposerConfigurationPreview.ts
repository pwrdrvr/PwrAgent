import { useLayoutEffect } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { NavigationSelectionState } from "./navigation-query-state";

// Each entry references only fields from the owner's byte-bounded configuration.
// History pages, queue payloads and transcript data have their own lifetimes.
const MAX_COMPOSER_PREVIEWS = 32;
export type ComposerConfigurationPreview = Pick<NavigationThreadSummary,
  "codexEnvironmentOptions" | "codexEnvironmentRuntime" | "codexSkillProfile" | "primaryGitRepository">;

export function useComposerConfigurationPreview(
  previews: Map<string, ComposerConfigurationPreview> | undefined,
  selectionKey: string | undefined,
  selection: NavigationSelectionState | undefined,
  selectedRow: NavigationThreadSummary | undefined,
): ComposerConfigurationPreview | undefined {
  const thread = selection?.detail?.thread;
  const identity = selection?.detail?.identity;
  const readiness = selection?.readiness;
  const { codexEnvironmentOptions, codexEnvironmentRuntime, codexSkillProfile, primaryGitRepository } = thread ?? {};
  useLayoutEffect(() => {
    if (!previews || !selectionKey) return;
    if (readiness === "failed" || (identity && identity !== "present")) {
      previews.delete(selectionKey);
    } else if (identity === "present" && (readiness === "ready" || previews.has(selectionKey))) {
      // A same-thread owner event can update the environment while the
      // confirming read is in flight. Retain the event's configuration too.
      previews.delete(selectionKey);
      previews.set(selectionKey, { codexEnvironmentOptions, codexEnvironmentRuntime, codexSkillProfile, primaryGitRepository });
      if (previews.size > MAX_COMPOSER_PREVIEWS) previews.delete(previews.keys().next().value!);
    }
  }, [codexEnvironmentOptions, codexEnvironmentRuntime, codexSkillProfile, identity, previews, primaryGitRepository, readiness, selectionKey]);
  if (!selectionKey || !selectedRow || selection?.detail || readiness === "failed"
    || (selectedRow.federation?.peerStatus && selectedRow.federation.peerStatus !== "connected")) return undefined;
  return previews?.get(selectionKey);
}
