import type { BackendSummary } from "@pwragent/shared";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export const NO_STARTUP_BACKEND_NOTICE_ID = "provider-startup:no-backend";

/**
 * Shown when a profile that has already completed onboarding lands with no
 * selectable provider.
 *
 * This case used to reopen the first-run wizard, which is wrong twice over:
 * `[onboarding] completed = true` says the operator already made every choice
 * that wizard asks for, and the condition that triggers it is a provider
 * health problem, not a missing setup. The wizard also takes the whole window,
 * so a Codex that failed to launch looked like a profile that had been reset.
 *
 * The notice keeps the operator on their threads, names what is actually
 * wrong, and points at the pane that can fix it. Setup stays reachable as a
 * secondary action for the genuine case of an operator who skipped the wizard
 * and never installed a CLI.
 */
export function buildNoStartupBackendNotice(params: {
  codex?: BackendSummary;
  onOpenCodexSettings: () => void;
  onRunSetup: () => void;
}): AppNoticeToastNotice {
  const reason = params.codex?.unavailableReason?.trim();
  return {
    actions: [
      {
        label: "Open AI Providers",
        onClick: params.onOpenCodexSettings,
        tone: "primary",
      },
      {
        label: "Run setup",
        onClick: params.onRunSetup,
        tone: "secondary",
      },
    ],
    autoDismiss: false,
    id: NO_STARTUP_BACKEND_NOTICE_ID,
    title: "No agent backend is available",
    message:
      "PwrAgent could not start a coding agent for this profile. Your threads"
      + " are still here — check the provider's status in Settings.",
    ...(reason ? { detail: `Codex: ${reason}` } : {}),
    ...(reason ? { copyText: reason } : {}),
    tone: "warning",
  };
}
