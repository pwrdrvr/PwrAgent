import { useLayoutEffect, useMemo } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "./desktop-api";
import { threadSummaryIdentityKey } from "./federated-thread-events";
import { navigationThreadSelectionKey, type NavigationSelectionState } from "./navigation-query-state";

// Each entry references only fields from the owner's byte-bounded configuration.
// History pages, queue payloads and transcript data have their own lifetimes.
const MAX_COMPOSER_PREVIEWS = 32;
type ComposerPreview = Pick<NavigationThreadSummary,
  "codexEnvironmentOptions" | "codexEnvironmentRuntime" | "codexSkillProfile" | "primaryGitRepository">;

export function useComposerConfigurationPreview(
  desktopApi: DesktopApi | undefined,
  selection: NavigationSelectionState | undefined,
  selectedRow: NavigationThreadSummary | undefined,
): ComposerPreview | undefined {
  const previews = useMemo(() => new Map<string, ComposerPreview>(), [desktopApi]);
  const thread = selection?.detail?.thread;
  const identity = selection?.detail?.identity;
  const readiness = selection?.readiness;
  const selectionKey = selection && navigationThreadSelectionKey(selection.ref);
  useLayoutEffect(() => {
    if (!selectionKey) return;
    if (readiness === "failed" || (identity && identity !== "present")) {
      previews.delete(selectionKey);
    } else if (thread && identity === "present") {
      previews.delete(selectionKey);
      previews.set(selectionKey, {
        codexEnvironmentOptions: thread.codexEnvironmentOptions,
        codexEnvironmentRuntime: thread.codexEnvironmentRuntime,
        codexSkillProfile: thread.codexSkillProfile,
        primaryGitRepository: thread.primaryGitRepository,
      });
      if (previews.size > MAX_COMPOSER_PREVIEWS) previews.delete(previews.keys().next().value!);
    }
  }, [identity, previews, readiness, selectionKey, thread]);
  if (!selectedRow || selection?.detail || readiness === "failed" || selectedRow.archivedAt !== undefined
    || (selectedRow.federation?.peerStatus && selectedRow.federation.peerStatus !== "connected")) return undefined;
  return previews.get(threadSummaryIdentityKey(selectedRow));
}
