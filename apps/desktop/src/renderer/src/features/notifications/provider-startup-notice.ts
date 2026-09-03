import type { BackendSummary } from "@pwragent/shared";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export const NO_STARTUP_BACKEND_NOTICE_ID = "provider-startup:no-backend";

/** Settings sub-screen for a backend kind, under Settings → AI Providers. */
function providerSettingsRoute(kind: BackendSummary["kind"]): string {
  return kind.startsWith("acp:") ? kind.slice("acp:".length) : kind;
}

/**
 * The provider this notice should speak for: the one that reported a reason
 * for being unavailable, else whichever backend the profile has at all.
 *
 * Naming a provider matters because `!startupBackend` means "nothing is
 * selectable", not "Codex is broken". On a profile whose only agent is an ACP
 * one, hardcoding Codex would send the operator to a provider they never
 * configured while the actually-missing agent went unnamed.
 */
function resolveNoticeProvider(
  backends: readonly BackendSummary[],
): BackendSummary | undefined {
  return (
    backends.find((backend) => backend.unavailableReason?.trim())
    ?? backends[0]
  );
}

/**
 * Shown when a profile that has already completed onboarding lands with no
 * selectable provider.
 *
 * This case used to reopen the first-run wizard, which is wrong twice over:
 * `[onboarding] completed = true` says the operator already made every choice
 * that wizard asks for, and the condition that triggers it is a provider
 * health problem, not a missing setup. The wizard also takes the whole window,
 * so a provider that failed to launch looked like a profile that had been
 * reset.
 *
 * The notice keeps the operator on their threads, names what is actually
 * wrong, and points at the pane that can fix it. Setup stays reachable as a
 * secondary action for the genuine case of an operator who skipped the wizard
 * and never installed a CLI.
 */
export function buildNoStartupBackendNotice(params: {
  backends: readonly BackendSummary[];
  onDismiss: () => void;
  onOpenProviderSettings: (settingsRoute: string) => void;
  onRunSetup: () => void;
}): AppNoticeToastNotice {
  const provider = resolveNoticeProvider(params.backends);
  const reason = provider?.unavailableReason?.trim();
  const route = providerSettingsRoute(provider?.kind ?? "codex");
  return {
    actions: [
      {
        label: "Open AI Providers",
        onClick: () => params.onOpenProviderSettings(route),
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
    onDismiss: params.onDismiss,
    title: "No agent backend is available",
    message:
      "PwrAgent could not start a coding agent for this profile. Your threads"
      + " are still here — check the provider's status in Settings.",
    ...(reason && provider
      ? { copyText: reason, detail: `${provider.label}: ${reason}` }
      : {}),
    tone: "warning",
  };
}
