import { Suspense, lazy, useState, type ReactNode } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import type { ClaudeSignInControls } from "../notifications/useClaudeSignIn";
import type { DesktopSettingsState } from "../settings/useDesktopSettings";

const LazyAgentSetupPane = lazy(async () => ({
  default: (await import("./AgentSetupPane")).AgentSetupPane,
}));

export type NoAgentLanding = {
  /**
   * Startup found no agent that can start a thread (`true`), or one
   * answered (`false`). React's state setter, so it is stable.
   */
  set: (active: boolean) => void;
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
  const [active, setActive] = useState(false);
  return {
    set: setActive,
    threadViewProps: active && params.settings.snapshot
      ? agentSetupThreadViewProps(params)
      : {},
  };
}

function agentSetupThreadViewProps(
  params: Parameters<typeof useNoAgentLanding>[0],
): NoAgentLanding["threadViewProps"] {
  return {
    emptyTitle: "Get started",
    emptyContent: (
      <Suspense fallback={null}>
        <LazyAgentSetupPane
          settings={params.settings}
          desktopApi={params.desktopApi}
          claudeSignIn={params.claudeSignIn}
          onOpenProviderSettings={() => params.openSettingsSection("models")}
        />
      </Suspense>
    ),
  };
}
