import { Suspense, lazy, useCallback, useState, type ReactNode } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import type { ClaudeSignInControls } from "../notifications/useClaudeSignIn";
import type { DesktopSettingsState } from "../settings/useDesktopSettings";

const LazyAgentSetupPane = lazy(async () => ({
  default: (await import("./AgentSetupPane")).AgentSetupPane,
}));

/** Startup found no agent that can start a thread; `detail` says why. */
export type NoAgentLandingState = { detail?: string };

export type NoAgentLanding = {
  /**
   * The landing (no agent can start a thread), or `null` once one answered.
   * Stable, and a repeat of the current value renders nothing.
   */
  set: (landing: NoAgentLandingState | null) => void;
  /** Spread into the thread view's props: the agent setup as its empty state. */
  threadViewProps: { emptyTitle?: string; emptyContent?: ReactNode };
};

/**
 * The main window's no-agent landing. While it is set, the empty main pane
 * is the agent setup rather than "Select a thread", so a profile with no
 * agent always shows its next step. It clears when an agent answers and the
 * window lands on that agent's composer.
 */
export function useNoAgentLanding(params: {
  settings: DesktopSettingsState;
  desktopApi?: DesktopApi;
  claudeSignIn?: ClaudeSignInControls;
  openSettingsSection: (section: "models") => void;
}): NoAgentLanding {
  const [landing, setLanding] = useState<NoAgentLandingState | null>(null);
  const set = useCallback((next: NoAgentLandingState | null): void => {
    setLanding((current) => (
      current === next || (current && next && current.detail === next.detail)
        ? current
        : next
    ));
  }, []);
  return {
    set,
    threadViewProps: landing && params.settings.snapshot
      ? agentSetupThreadViewProps(params, landing)
      : {},
  };
}

function agentSetupThreadViewProps(
  params: Parameters<typeof useNoAgentLanding>[0],
  landing: NoAgentLandingState,
): NoAgentLanding["threadViewProps"] {
  return {
    emptyTitle: "Get started",
    emptyContent: (
      <Suspense fallback={null}>
        <LazyAgentSetupPane
          settings={params.settings}
          desktopApi={params.desktopApi}
          claudeSignIn={params.claudeSignIn}
          unavailableDetail={landing.detail}
          onOpenProviderSettings={() => params.openSettingsSection("models")}
        />
      </Suspense>
    ),
  };
}
