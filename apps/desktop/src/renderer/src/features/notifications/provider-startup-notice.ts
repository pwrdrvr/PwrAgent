import type { BackendSummary } from "@pwragent/shared/contracts/backend";
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
 * Why no provider can start a thread, as one line naming the provider, or
 * `undefined` when none reported a reason.
 */
export function noStartupBackendDetail(
  backends: readonly BackendSummary[],
): string | undefined {
  const provider = resolveNoticeProvider(backends);
  const reason = provider?.unavailableReason?.trim();
  return reason && provider ? `${provider.label}: ${reason}` : undefined;
}

/**
 * Where startup's landing decision stands for a window. `pane-shown`: the
 * empty main pane is the agent setup and no notice is up; `notice-shown`: a
 * thread covers that pane, so the no-backend notice is up.
 */
export type StartupLandingState = "pending" | "pane-shown" | "notice-shown" | "complete";

/**
 * The landing step once discovery has answered that no provider can start a
 * thread. The main pane's agent setup is the landing whenever nothing is
 * selected, so the notice is for a selected thread only: a thread restored at
 * startup, or one selected later from the pane. It is shown once per
 * landing; dismissing it returns the decision to `pending`.
 */
export function landWithoutBackend(
  state: StartupLandingState,
  threadSelected: boolean,
): { state: StartupLandingState; showNotice: boolean } {
  if (state === "complete" || state === "notice-shown") {
    return { state, showNotice: false };
  }
  return threadSelected
    ? { state: "notice-shown", showNotice: true }
    : { state: "pane-shown", showNotice: false };
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
    ...(provider?.kind === "codex"
      ? { coalescing: { key: "codex-launch", priority: 0 } }
      : {}),
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
