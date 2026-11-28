import { useEffect, useRef } from "react";
import type { DesktopSettingsSnapshot } from "@pwragent/shared/contracts/settings";
import type { DesktopApi } from "../../lib/desktop-api";
import type { ClaudeSignInControls } from "../notifications/useClaudeSignIn";
import type { DesktopSettingsState } from "../settings/useDesktopSettings";
import { AgentList, useGetStartedAgents } from "./GetStarted";

/**
 * The main window's empty state while this profile has no agent that can
 * start a thread. It is Get started's agent list in place, so a profile that
 * skipped setup, or whose agent went away, always shows its next step (Install
 * Codex, Sign in with ChatGPT) instead of an empty pane and a warning.
 *
 * It needs no Start: once an agent answers, the app lands on its composer by
 * itself.
 */
export function AgentSetupPane(props: {
  settings: DesktopSettingsState;
  desktopApi?: DesktopApi;
  claudeSignIn?: ClaudeSignInControls;
  onOpenProviderSettings: () => void;
}) {
  const agents = useGetStartedAgents({
    settings: props.settings,
    desktopApi: props.desktopApi,
    separateLogin: false,
    codexAuthProfile: profileCodexLogin(props.settings.snapshot),
  });

  // An in-app Claude Code sign-in ends when its CLI exits, which can come
  // after the window regains focus. Check again then.
  const claudeSigningIn = props.claudeSignIn?.signingIn ?? false;
  const wasClaudeSigningIn = useRef(claudeSigningIn);
  const refreshAgents = agents.refresh;
  useEffect(() => {
    if (wasClaudeSigningIn.current && !claudeSigningIn) void refreshAgents();
    wasClaudeSigningIn.current = claudeSigningIn;
  }, [claudeSigningIn, refreshAgents]);

  const ready = agents.rows.some((row) => row.state.kind === "ready");

  return (
    <div className="agent-setup-pane" data-testid="agent-setup-pane">
      <div className="agent-setup-pane__content">
        <header className="get-started__head">
          <h2 className="get-started__title">
            {ready ? "Your agent is ready." : "Set up an agent to start."}
          </h2>
          <p className="get-started__sub">
            PwrAgent runs coding agents on this computer. Install one and sign
            in with the account you already have; each provider bills you for
            its own usage.
          </p>
        </header>
        <AgentList
          agents={agents}
          desktopApi={props.desktopApi}
          claudeSignIn={props.claudeSignIn}
        />
        <div className="agent-setup-pane__more">
          <button
            type="button"
            className="get-started__btn get-started__btn--link"
            onClick={props.onOpenProviderSettings}
          >
            More agent options in Settings
          </button>
        </div>
      </div>
    </div>
  );
}

/** The Codex login this profile runs Codex with, as Settings → Codex picks it. */
export function profileCodexLogin(snapshot: DesktopSettingsSnapshot | undefined): string {
  const profiles = snapshot?.models.codex.profiles?.profiles ?? [];
  return (
    profiles.find((candidate) => candidate.selected)
    ?? profiles.find((candidate) => candidate.name === "")
  )?.name ?? "";
}
